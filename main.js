const {
  MarkdownRenderChild,
  MarkdownRenderer,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SuggestModal,
  TFile,
  normalizePath,
  requestUrl
} = require("obsidian");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const { shell } = require("electron");

function isClientAuthCertificateError(error) {
  return /ERR_SSL_CLIENT_AUTH_CERT_NEEDED|SSL_CLIENT_AUTH_CERT_NEEDED/i.test(
    `${String(error?.code || "")} ${String(error?.message || error || "")}`
  );
}

function nodeHttpsRequest(options) {
  return new Promise((resolve, reject) => {
    const requestBody = options.body == null ? null : Buffer.from(String(options.body));
    const headers = { ...(options.headers || {}) };
    if (requestBody && !Object.keys(headers).some((key) => key.toLowerCase() === "content-length")) {
      headers["Content-Length"] = String(requestBody.byteLength);
    }
    const request = https.request(options.url, {
      method: options.method || "GET",
      headers
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString("utf8");
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON response */ }
        const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        resolve({ status: Number(response.statusCode || 0), headers: response.headers || {}, text, json, arrayBuffer });
      });
    });
    request.setTimeout(30_000, () => request.destroy(new Error("ServiceNow 요청 시간이 초과되었습니다.")));
    request.on("error", reject);
    if (requestBody) request.write(requestBody);
    request.end();
  });
}

function formatMarkdownListEntry(prefix, content) {
  const lines = String(content || "").trim().split(/\r?\n/);
  const startsWithBlockMarkdown = /^(?:[-*+]\s+|\d+[.)]\s+|>\s*|```|~~~)/.test(lines[0] || "");
  if (startsWithBlockMarkdown) {
    return [`${String(prefix || "").trimEnd()}`, ...lines.map((line) => `    ${line}`)].join("\n");
  }
  const first = lines.shift() || "";
  return [`${prefix}${first}`, ...lines.map((line) => `    ${line}`)].join("\n");
}

function stripWorkLogEntryPrefix(raw, dateTime) {
  const remainder = String(raw || "").replace(String(dateTime || ""), "");
  if (/^\s*:\s*/.test(remainder)) return remainder.replace(/^\s*:\s*/, "").trim();
  return remainder.replace(/^[\s*_`~:.,]+/, "").trim();
}

function mergeDeploymentFinishField(frontmatter) {
  if (!frontmatter || !Object.prototype.hasOwnProperty.call(frontmatter, "deployment_finish")) return false;
  const deploymentFinish = String(frontmatter.deployment_finish || "").trim();
  if (deploymentFinish) frontmatter["배포일"] = deploymentFinish;
  delete frontmatter.deployment_finish;
  return true;
}

function extractTicketWorkLogs(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  let start = -1;
  let level = 0;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})\s+(.+)$/);
    if (!heading || !normalizedHeadingText(heading[2]).includes("작업일지")) continue;
    start = index;
    level = heading[1].length;
    break;
  }
  if (start < 0) return [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})\s+(.+)$/);
    if (heading && heading[1].length <= level) {
      end = index;
      break;
    }
  }
  const entries = [];
  let current = null;
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index];
    const topLevel = line.match(/^[-*+]\s+(.+)$/);
    if (topLevel) {
      if (current) entries.push(current);
      current = { raw: topLevel[1].trim(), index: entries.length, startLine: index, endLine: index + 1 };
    } else if (current && line.trim()) {
      current.raw += `\n${line.replace(/^\s{1,4}/, "")}`;
      current.endLine = index + 1;
    } else if (current) {
      current.endLine = index + 1;
    }
  }
  if (current) entries.push(current);
  return entries.map((entry) => {
    const dateTime = entry.raw.match(/\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?/)?.[0] || "";
    const contentMarkdown = stripWorkLogEntryPrefix(entry.raw, dateTime);
    return { ...entry, dateTime, contentMarkdown };
  });
}

function richInlineMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
  if (!(node instanceof HTMLElement)) return "";
  const inner = [...node.childNodes].map(richInlineMarkdown).join("");
  if (node.tagName === "BR") return "\n";
  if (node.tagName === "A") return `[${inner || node.textContent || node.getAttribute("href")}](${node.getAttribute("href") || ""})`;
  if (node.tagName === "STRONG" || node.tagName === "B") return `**${inner}**`;
  if (node.tagName === "EM" || node.tagName === "I") return `*${inner}*`;
  if (node.tagName === "S" || node.tagName === "DEL") return `~~${inner}~~`;
  if (node.tagName === "CODE" && node.parentElement?.tagName !== "PRE") return `\`${inner}\``;
  return inner;
}

function richBlockMarkdown(node, depth = 0) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
  if (!(node instanceof HTMLElement)) return "";
  if (node.tagName === "PRE") return `\n\n\`\`\`\n${node.textContent || ""}\n\`\`\`\n\n`;
  if (node.tagName === "UL" || node.tagName === "OL") {
    return [...node.children].filter((child) => child.tagName === "LI").map((item, index) => {
      const nested = [...item.children].filter((child) => child.tagName === "UL" || child.tagName === "OL");
      const inline = [...item.childNodes].filter((child) => !(child instanceof HTMLElement && (child.tagName === "UL" || child.tagName === "OL")))
        .map(richInlineMarkdown).join("").trim();
      const checkbox = item.querySelector(":scope > input[type='checkbox']");
      const marker = checkbox ? `- [${checkbox.checked ? "x" : " "}]` : node.tagName === "OL" ? `${index + 1}.` : "-";
      const continuation = nested.map((child) => richBlockMarkdown(child, depth + 1).trimEnd().split("\n").map((line) => `    ${line}`).join("\n")).join("\n");
      return `${marker} ${inline}${continuation ? `\n${continuation}` : ""}`;
    }).join("\n") + "\n";
  }
  if (/^H[1-6]$/.test(node.tagName)) return `${"#".repeat(Number(node.tagName[1]))} ${richInlineMarkdown(node)}\n\n`;
  if (node.tagName === "P" || node.tagName === "DIV") return `${[...node.childNodes].map(richBlockMarkdown).join("")}\n\n`;
  return [...node.childNodes].map((child) => richBlockMarkdown(child, depth)).join("");
}

function markdownFromRichEditor(editor) {
  return [...editor.childNodes].map(richBlockMarkdown).join("").replace(/\n{3,}/g, "\n\n").trim();
}

function createRichMarkdownEditor(app, component, parent, initialValue = "", sourcePath = "", placeholder = "") {
  const editor = parent.createDiv({ cls: "clt-rich-markdown-editor markdown-rendered" });
  editor.contentEditable = "true";
  editor.setAttr("role", "textbox");
  editor.setAttr("aria-multiline", "true");
  editor.setAttr("data-placeholder", placeholder);
  Object.defineProperty(editor, "value", {
    get: () => markdownFromRichEditor(editor),
    set: (value) => {
      editor.empty();
      const markdown = String(value || "");
      if (markdown) void MarkdownRenderer.render(app, markdown, editor, sourcePath, component);
    }
  });
  editor.value = initialValue;
  editor.addEventListener("keydown", (event) => {
    if (event.key !== " ") return;
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    const block = anchor instanceof HTMLElement ? anchor : anchor?.parentElement;
    const line = block?.closest?.("p, div, li") || editor;
    const value = String(line.textContent || "").trim();
    if (value === "```") {
      event.preventDefault();
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.appendChild(document.createElement("br"));
      pre.appendChild(code);
      line.replaceWith(pre);
      const codeRange = document.createRange();
      codeRange.selectNodeContents(code);
      codeRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(codeRange);
      return;
    }
    if (value !== "-" && value !== "*" && value !== "1.") return;
    event.preventDefault();
    line.textContent = "";
    const range = document.createRange();
    range.selectNodeContents(line);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand(value === "1." ? "insertOrderedList" : "insertUnorderedList", false);
  });
  const replaceTypedSuffix = (pattern, createNode) => {
    const selection = window.getSelection();
    const textNode = selection?.anchorNode;
    if (!(textNode instanceof Text) || !editor.contains(textNode)) return;
    const beforeCaret = textNode.data.slice(0, selection.anchorOffset);
    const match = beforeCaret.match(pattern);
    if (!match) return;
    const range = document.createRange();
    range.setStart(textNode, selection.anchorOffset - match[0].length);
    range.setEnd(textNode, selection.anchorOffset);
    range.deleteContents();
    const node = createNode(match);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  editor.addEventListener("keyup", (event) => {
    if (event.key === "`") {
      replaceTypedSuffix(/`([^`\n]+)`$/, (match) => {
        const code = document.createElement("code");
        code.textContent = match[1];
        return code;
      });
    } else if (event.key === ")") {
      replaceTypedSuffix(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/, (match) => {
        const link = document.createElement("a");
        link.textContent = match[1];
        link.href = match[2];
        return link;
      });
    }
  });
  editor.addEventListener("paste", (event) => {
    const value = event.clipboardData?.getData("text/plain")?.trim() || "";
    if (!/^https?:\/\/\S+$/.test(value)) return;
    event.preventDefault();
    document.execCommand("insertHTML", false, `<a href="${value.replace(/"/g, "&quot;")}">${value}</a>`);
  });
  editor.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a") : null;
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
    const href = String(link.href || link.getAttribute("href") || "").trim();
    if (/^https?:\/\//i.test(href)) void shell.openExternal(href);
  });
  return editor;
}

// BEGIN GENERATED DASHBOARD ASSET
const EMBEDDED_DASHBOARD_GZIP_BASE64 = "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";
// END GENERATED DASHBOARD ASSET

// Organization-specific analysis templates are loaded from an optional local organization pack.
const PLUGIN_ID = "servicenow-manage";
const LEGACY_PLUGIN_ID = "clt-servicenow-worknotes";
const ACCESS_TOKEN_KEY = `${PLUGIN_ID}-access-token`;
const REFRESH_TOKEN_KEY = `${PLUGIN_ID}-refresh-token`;
const GOOGLE_ACCESS_TOKEN_KEY = `${PLUGIN_ID}-google-access-token`;
const GOOGLE_REFRESH_TOKEN_KEY = `${PLUGIN_ID}-google-refresh-token`;
const GOOGLE_CLIENT_SECRET_KEY = `${PLUGIN_ID}-google-client-secret`;
const FIRST_RUN_SETUP_VERSION = 1;
const DEFAULT_SETTINGS = {
  setupWizardVersion: 0,
  todoWorkflow: [],
  rootFolder: "ServiceNow",
  instanceUrl: "",
  authMode: "bearer",
  clientId: "",
  oauthScope: "",
  redirectUri: "http://127.0.0.1:42813/oauth/callback",
  workNotesFolder: "",
  autoCreateWorkNotes: true,
  autoDocumentSearchOnNewTicket: true,
  autoStatusSync: false,
  statusSyncTime: "09:00",
  lastStatusSyncDate: "",
  autoSync: false,
  syncAtTopOfHour: true,
  catchUpOnOpen: true,
  tokenExpiresAt: 0,
  connectedAt: "",
  googleAccountEmail: "",
  googleClientId: "",
  googleTokenExpiresAt: 0,
  googleConnectedAt: "",
  googleDriveContentAccess: false,
  googleGrantedScopes: "",
  organizationFeaturesEnabled: false,
  enableDocumentAutomation: false,
  changeRequestTable: "change_request",
  serviceRequestTable: "u_service_call",
  incidentTable: "incident",
  koreanHolidays: "",
  autoHolidaySync: true,
  holidayCache: {},
  lastHolidaySyncDate: ""
};

const DEFAULT_TODO_WORKFLOW = [
  { key: "pending", label: "진행 전", icon: "○", enabled: true },
  { key: "in-progress", label: "진행 중", icon: "◐", enabled: true },
  { key: "waiting", label: "Pending · 대기", icon: "⏸", enabled: true },
  { key: "done", label: "완료", icon: "✓", enabled: true }
];

function normalizeTodoWorkflow(value) {
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const original = DEFAULT_TODO_WORKFLOW.find(status => status.key === item?.key);
    if (!original || seen.has(original.key)) continue;
    seen.add(original.key);
    result.push({ ...original, label: String(item.label || "").trim().slice(0, 60) || original.label, enabled: item.enabled !== false });
  }
  for (const original of DEFAULT_TODO_WORKFLOW) if (!seen.has(original.key)) result.push({ ...original });
  return result;
}

function fillTodoStatusSelect(select, plugin, desired, preserveDisabled = false) {
  const workflow = plugin.getTodoWorkflow();
  select.replaceChildren();
  const enabled = workflow.filter(status => status.enabled);
  const current = workflow.find(status => status.key === desired);
  if (preserveDisabled && current && !current.enabled) {
    const option = document.createElement("option");
    option.value = current.key;
    option.textContent = `${current.label} (사용 안 함 · 기존 상태)`;
    option.disabled = true;
    select.appendChild(option);
  }
  for (const status of enabled) {
    const option = document.createElement("option");
    option.value = status.key;
    option.textContent = `${status.icon} ${status.label}`;
    select.appendChild(option);
  }
  select.value = current?.enabled || (preserveDisabled && current) ? desired : enabled[0].key;
  return select.value;
}

const CR_STATES = [
  "New", "Assess", "Authorize", "Scheduled", "Implement", "Review", "Closed", "Cancelled"
];
const SR_STATES = [
  "New", "Open", "In Progress", "Pending", "Resolved", "Closed", "Cancelled"
];
const STATUS_GUIDES = { CR: {}, SR: {} };
const CR_SLA = {};
const TABLE_BY_PREFIX = {
  CR: "change_request",
  SR: "u_service_call",
  IN: "incident"
};

function cleanInstanceUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function cleanBearerToken(value) {
  return String(value || "").trim().replace(/^Bearer\s+/i, "").trim();
}

function normalizeTicketId(value) {
  const match = String(value || "").replace(/\s+/g, "").toUpperCase().match(/^(CR|SR|INC)\d+$/);
  return match ? match[0] : "";
}

function normalizeMeetingTicketIds(value) {
  const values = Array.isArray(value) ? value : [value];
  const normalized = values.flatMap((item) => {
    if (Array.isArray(item)) return item;
    return String(item || "").split(/[\n,]/);
  }).map((item) => normalizeTicketId(String(item || "").replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0]))
    .filter(Boolean);
  return [...new Set(normalized)];
}

function tableForTicket(ticketId, tables = TABLE_BY_PREFIX) {
  return tables[String(ticketId || "").slice(0, 2)] || "";
}

function fieldValue(field) {
  if (field === null || field === undefined) return "";
  if (typeof field === "object") {
    return String(field.display_value ?? field.value ?? "");
  }
  return String(field);
}

function rawFieldValue(field) {
  if (field === null || field === undefined) return "";
  if (typeof field === "object") return String(field.value ?? field.display_value ?? "");
  return String(field);
}

function normalizedServiceNowFieldName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function serviceNowField(record, candidates, options = {}) {
  const entries = Object.entries(record || {});
  const byName = new Map(entries.map(([key, value]) => [normalizedServiceNowFieldName(key), value]));
  for (const candidate of candidates) {
    const field = byName.get(normalizedServiceNowFieldName(candidate));
    if (field !== undefined) return options.raw ? rawFieldValue(field).trim() : fieldValue(field).trim();
  }
  return "";
}

function cleanChoiceValue(value) {
  const text = String(value || "").trim();
  return /^(?:--\s*)?none(?:\s*--)?$/i.test(text) ? "" : text;
}

function extractTicketMetadata(record) {
  const category = cleanChoiceValue(serviceNowField(record, ["u_category", "category"]));
  const criteria = Object.entries(record || {})
    .map(([key, value]) => {
      const match = normalizedServiceNowFieldName(key).match(/^(?:u)?(?:category)?criterion(\d+)$/);
      return match ? { order: Number(match[1]), value: cleanChoiceValue(fieldValue(value)) } : null;
    })
    .filter((item) => item?.value)
    .sort((left, right) => left.order - right.order);
  const serviceCategory = [...new Set([category, ...criteria.map((item) => item.value)].filter(Boolean))].join(" / ");
  return {
    shortDescription: serviceNowField(record, ["short_description", "u_short_description"]),
    ticketCreator: serviceNowField(record, ["u_ticket_creator", "ticket_creator", "u_creator", "creator", "opened_by", "created_by", "sys_created_by"]),
    ticketRequester: serviceNowField(record, ["u_ticket_requester", "ticket_requester", "u_requester", "requester", "requested_by", "requested_for", "caller_id", "opened_by"]),
    serviceNowCreated: serviceNowField(record, ["sys_created_on", "opened_at", "u_create_date", "create_date", "u_created_date"], { raw: true }),
    purpose: serviceNowField(record, ["u_purpose", "purpose", "u_service_purpose", "service_purpose"]),
    serviceNowPriority: serviceNowField(record, ["priority", "u_priority"]),
    assignmentGroup: serviceNowField(record, ["assignment_group"]),
    assignedTo: serviceNowField(record, ["assigned_to"]),
    serviceNowCategory: serviceCategory,
    serviceNowUpdated: serviceNowField(record, ["sys_updated_on"], { raw: true }),
    estimatedQaCompletionDate: serviceNowField(record, [
      "u_estimated_qa_completion_date",
      "estimated_qa_completion_date",
      "u_estimated_qa_completion",
      "estimated_qa_completion",
      "u_est_qa_comp_date",
      "u_est_qa_completion_date",
      "u_estimated_qa_date",
      "u_estimated_qa_end_date"
    ]),
    targetQaCompletionDate: serviceNowField(record, [
      "u_target_qa_completion_date",
      "target_qa_completion_date",
      "u_target_qa_completion",
      "target_qa_completion",
      "u_qa_comp_date",
      "u_tgt_qa_completion_date",
      "u_target_qa_date",
      "u_target_qa_end_date"
    ]),
    actualReleaseDate: serviceNowField(record, [
      "u_actual_release_date",
      "actual_release_date",
      "u_actual_release",
      "actual_release",
      "work_end",
      "u_work_end",
      "u_rel_date",
      "u_release_date"
    ]),
    deploymentFinish: serviceNowField(record, [
      "end_date",
      "u_deployment_finish",
      "deployment_finish",
      "u_deployment_finish_date",
      "deployment_finish_date"
    ]),
    uiInterfaceIds: serviceNowField(record, [
      "u_ui_i_f_id",
      "ui_i_f_id",
      "u_ui_if_id",
      "ui_if_id",
      "u_screen_id",
      "screen_id"
    ])
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function hashId(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex").slice(0, 20);
}

function protectUrls(text) {
  const urls = [];
  const masked = String(text || "").replace(/https?:\/\/[^\s<>()\[\]{}"']+/gi, (url) => {
    const token = `__SNM_URL_${urls.length}__`;
    urls.push(url);
    return token;
  });
  return { masked, urls };
}

function restoreUrls(text, urls) {
  let restored = String(text || "");
  urls.forEach((url, index) => {
    restored = restored.replaceAll(`__SNM_URL_${index}__`, url);
  });
  const missing = urls.filter((url) => !restored.includes(url));
  if (missing.length) {
    restored = [restored.trimEnd(), ...missing].filter(Boolean).join("\n");
  }
  return restored;
}

function localIsoDateTime(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function localIsoDate(date = new Date()) {
  return localIsoDateTime(date).slice(0, 10);
}

function addCalendarDays(start, count) {
  const result = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  result.setDate(result.getDate() + count);
  return result;
}

function addWorkingDays(start, count, holidays) {
  const result = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  let added = 0;
  while (added < count) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6 && !holidays.has(localIsoDate(result))) added++;
  }
  return result;
}

function utcServiceNowToKst(value) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return raw;
  const date = new Date(raw.replace(" ", "T") + "Z");
  if (Number.isNaN(date.getTime())) return raw;
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 19).replace("T", " ");
}

function parseWorkNotes(rawWorkNotes) {
  const raw = String(rawWorkNotes || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return [];
  const segments = raw
    .split(/\n\n(?=\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  return segments.flatMap((segment) => {
    const timeMatch = segment.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    if (!timeMatch) return [];
    const headerMatch = segment.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+-\s+(.+?)\s+\(([^)]+)\)/);
    const author = headerMatch ? headerMatch[1].trim() : "";
    return [{
      id: `work-note-${hashId(segment)}`,
      time: timeMatch[1],
      type: "Work Note",
      author,
      content: segment,
      priority: 1,
      url: ""
    }];
  });
}

function buildJournalWorkNotes(rows) {
  return (rows || []).flatMap((item) => {
    const value = fieldValue(item.value).trim();
    if (!value) return [];
    const time = utcServiceNowToKst(fieldValue(item.sys_created_on).trim());
    const author = fieldValue(item.sys_created_by).trim();
    const content = `${time}${author ? ` - ${author}` : ""} (Work notes)\n${value}`;
    return [{
      id: `work-note-${hashId(content)}`,
      time,
      type: "Work Note",
      author,
      content,
      priority: 1,
      url: ""
    }];
  }).sort((left, right) => String(right.time).localeCompare(String(left.time)));
}

function mergeEntries(workNotes, attachments) {
  return [...workNotes, ...attachments].sort((a, b) => {
    if (a.time > b.time) return -1;
    if (a.time < b.time) return 1;
    return (a.priority || 9) - (b.priority || 9);
  });
}

function parseWikiLink(value) {
  const text = String(value || "").trim();
  const match = text.match(/^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/);
  return match ? match[1].trim() : "";
}

function extractDescriptionLinks(description) {
  const text = String(description || "").replace(/\r\n/g, "\n");
  const candidates = [];
  const seen = new Set();
  text.split("\n").forEach((line) => {
    const urls = line.match(/https?:\/\/[^\s<>"']+/gi) || [];
    urls.forEach((rawUrl) => {
      const url = rawUrl.replace(/[),.;]+$/, "");
      if (seen.has(url)) return;
      seen.add(url);
      const label = line.replace(rawUrl, "").replace(/\s+/g, " ").trim().replace(/[-:]+$/, "").trim();
      candidates.push({
        type: "BS",
        name: label || `Detailed Description 링크 ${candidates.length + 1}`,
        url,
        modifiedTime: "",
        source: "ServiceNow Detailed Description"
      });
    });
  });
  return candidates;
}

function defaultWorkNotesTemplate() {
  return `---\n` +
    `id: "{{ticketId}}-WORKNOTES"\n` +
    `category: Work Notes\n` +
    `ticket: "{{ticketId}}"\n` +
    `parent: "[[{{parentName}}]]"\n` +
    `last_synced:\n` +
    `sync_status: Not connected\n` +
    `---\n` +
    `# {{ticketId}} 워킹노트\n\n` +
    `\`\`\`servicenow-manage\n` +
    `ticket: {{ticketId}}\n` +
    `\`\`\`\n\n` +
    `## 개인 메모\n\n` +
    `이 영역은 자유롭게 작성할 수 있습니다. 플러그인이 덮어쓰지 않습니다.\n`;
}

function defaultAiPromptTemplate() {
  return "CR_TEMPLATE.md 기준으로 진행해줘.\n\n" +
    "CR No:\n\nShort Description:\n\nLong Description:\n\n" +
    "My Position:\nTicket coordinator / analyst\n" +
    "Current Service now Status :\n\nService now Working note(시간순):\n\n----\n\n" +
    "SR_TEMPLATE.md 기준으로 진행해줘.\n\n" +
    "SR No:\n\nShort Description:\n\nLong Description:\n\n" +
    "My Position:\nTicket coordinator / analyst\n" +
    "Current Service now Status :\n\nService now Working note(시간순):\n";
}

function bundledAnalysisTemplate() {
  return "";
}

function cleanDashboardFrontmatter(markdown) {
  let text = String(markdown || "").replace(/^\uFEFF/, "");
  const dvIndex = text.indexOf("```dataviewjs");
  if (dvIndex < 0) return text;
  let preBlock = text.slice(0, dvIndex).trim();
  const rest = text.slice(dvIndex);
  if (!preBlock) return rest;

  const fmMatch = preBlock.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const fmContent = fmMatch[1].trim();
    return fmContent ? `---\n${fmContent}\n---\n\n${rest}` : rest;
  }
  return rest;
}

function upgradeDashboardRuntime(markdown, bundledDashboard) {
  let current = cleanDashboardFrontmatter(String(markdown || ""));
  const bundled = cleanDashboardFrontmatter(String(bundledDashboard || ""));
  if (!current || !bundled) return current;

  const hasCurrentRuntime = current.includes('const DASHBOARD_RUNTIME_VERSION = "2.10.1";');
  const hasWaitingRuntime = current.includes('key: "waiting", label: "Pending · 대기"')
    && current.includes("function readTodoWaiting(");
  const hasTodoWorkflowRuntime = current.includes("function activeTodoStatuses(");
  const hasLegacyDeploymentFinish = current.includes('{ key: "deploymentFinish", label: "Deployment Finish"');
  const sharedPluginDeclarations = current.match(/const\s+sharedPlugin\s*=/g) || [];
  if (hasCurrentRuntime && hasWaitingRuntime && hasTodoWorkflowRuntime && current.includes("selectedTodoStatuses") && sharedPluginDeclarations.length <= 2 && !hasLegacyDeploymentFinish) return current;
  const currentStart = current.indexOf("```dataviewjs");
  const currentEnd = current.lastIndexOf("```");
  const bundledStart = bundled.indexOf("```dataviewjs");
  const bundledEnd = bundled.lastIndexOf("```");
  if (currentStart < 0 || currentEnd <= currentStart || bundledStart < 0 || bundledEnd <= bundledStart) {
    return current;
  }
  const bundledBlock = bundled.slice(bundledStart, bundledEnd + 3);
  return `${current.slice(0, currentStart)}${bundledBlock}${current.slice(currentEnd + 3)}`;
}

function upgradeDashboardPopupFieldGrid(markdown) {
  let next = String(markdown || "");
  if (!next || next.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.8";') || next.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.7";') || next.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.6";') || next.includes(".opus-popup-field-grid")) return next;
  next = next
    .replace(`.opus-filter-panel {\n    right: 0;\n    width: 260px;\n}`, `.opus-filter-panel {\n    right: 0;\n    width: min(760px, calc(100vw - 70px));\n    max-height: min(560px, 72vh);\n    overflow-y: auto;\n}`)
    .replace(`.opus-sort-panel {\n    right: 35px;\n    width: 260px;\n}`, `.opus-sort-panel {\n    right: 35px;\n    width: min(760px, calc(100vw - 70px));\n    max-height: min(560px, 72vh);\n    overflow-y: auto;\n}`)
    .replace(`.opus-popup-field {\n    display: flex;`, `.opus-popup-field-grid {\n    display: grid;\n    grid-template-columns: repeat(4, minmax(0, 1fr));\n    gap: 5px;\n}\n\n.opus-popup-field {\n    display: flex;`)
    .replace(`    width: 100%;\n    padding: 7px 8px;\n    border: 0;\n    border-radius: 5px;\n    background: transparent;`, `    width: 100%;\n    min-width: 0;\n    min-height: 34px;\n    padding: 7px 9px;\n    border: 1px solid var(--background-modifier-border);\n    border-radius: 7px;\n    background: var(--background-secondary);`)
    .replace(`    text-align: left;\n    cursor: pointer;\n}`, `    text-align: left;\n    cursor: pointer;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}`)
    .replace(`.opus-popup-field.disabled {\n    color: var(--text-faint);\n    cursor: default;\n}`, `.opus-popup-field.disabled {\n    color: var(--text-faint);\n    background: var(--background-secondary-alt);\n    opacity: 0.58;\n    cursor: default;\n}`)
    .replace(`@media (max-width: 900px) {\n    .opus-field-list {`, `@media (max-width: 900px) {\n    .opus-popup-field-grid {\n        grid-template-columns:\n            repeat(3, minmax(0, 1fr));\n    }\n\n    .opus-field-list {`)
    .replace(`    .opus-field-list {\n        grid-template-columns: 1fr;\n    }\n}\n\`;`, `    .opus-field-list {\n        grid-template-columns: 1fr;\n    }\n\n    .opus-popup-field-grid {\n        grid-template-columns:\n            repeat(2, minmax(0, 1fr));\n    }\n}\n\n@media (max-width: 430px) {\n    .opus-popup-field-grid {\n        grid-template-columns: 1fr;\n    }\n}\n\`;`)
    .replaceAll(`    filterMenu.appendChild(title);\n\n    for (const column of columns) {`, `    filterMenu.appendChild(title);\n\n    const grid =\n        document.createElement("div");\n\n    grid.className =\n        "opus-popup-field-grid";\n\n    filterMenu.appendChild(grid);\n\n    for (const column of columns) {`)
    .replaceAll(`    sortMenu.appendChild(title);\n\n    for (const column of columns) {`, `    sortMenu.appendChild(title);\n\n    const grid =\n        document.createElement("div");\n\n    grid.className =\n        "opus-popup-field-grid";\n\n    sortMenu.appendChild(grid);\n\n    for (const column of columns) {`)
    .replace("        filterMenu.appendChild(button);", "        grid.appendChild(button);")
    .replace("        sortMenu.appendChild(button);", "        grid.appendChild(button);");
  return next;
}

function upgradeDashboardTodoCreation(markdown, bundledDashboard) {
  let current = upgradeDashboardPopupFieldGrid(String(markdown || ""));
  const bundled = String(bundledDashboard || "");
  if (!current || !bundled || current.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.6";') || current.includes("function openTodoCreateModal(")) return current;
  if (!current.includes("const ROOT_FOLDER") || !current.includes("전체 업무 현황")) return current;

  const slice = (source, startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = start >= 0 ? source.indexOf(endMarker, start + startMarker.length) : -1;
    return start >= 0 && end > start ? source.slice(start, end) : "";
  };
  const replaceSection = (target, startMarker, endMarker) => {
    const replacement = slice(bundled, startMarker, endMarker);
    const existing = slice(current, startMarker, endMarker);
    if (replacement && existing) current = current.replace(existing, replacement);
  };
  const insertBefore = (marker, snippet) => {
    if (snippet && !current.includes(snippet.trim().slice(0, 48)) && current.includes(marker)) {
      current = current.replace(marker, `${snippet}${marker}`);
    }
  };

  replaceSection("extractTodos", "function extractTodos(", "\nasync function readTodos(");

  const todoHelpers = slice(
    bundled,
    "function appendTodoToMarkdown(",
    "\n\n// ================================================================\n// 8."
  );
  insertBefore("// ================================================================\n// 8.", `${todoHelpers}\n\n`);

  const boardActionCss = slice(bundled, ".opus-todo-board-actions {", ".opus-todo-group-toggle {");
  insertBefore(".opus-todo-group-toggle {", boardActionCss);
  const overdueCss = slice(bundled, ".opus-todo-card.overdue {", ".opus-todo-card-ticket {");
  insertBefore(".opus-todo-card-ticket {", overdueCss);
  const todoFormCss = slice(bundled, ".opus-todo-card-timing {", ".opus-todo-status-select {");
  insertBefore(".opus-todo-status-select {", todoFormCss);

  replaceSection("file cell", "        case \"file\":", "\n\n        case \"cr\":");

  const todoModal = slice(bundled, "function openTodoCreateModal(", "function openWorkLogModal(");
  insertBefore("function openWorkLogModal(", todoModal);

  const tableBinding = slice(
    bundled,
    "    tableArea\n        .querySelectorAll(\n            \"[data-todo-add-index]\"",
    "\n}\n\n\nasync function changeTodoStatus("
  );
  insertBefore("\n}\n\n\nasync function changeTodoStatus(", `\n${tableBinding}`);

  replaceSection("todo card", "function createTodoCard(", "function renderTodoBoard(");
  replaceSection("todo board", "function renderTodoBoard(", "function renderAll(");
  return current;
}

function upgradeDashboardControlVisibility(markdown, bundledDashboard) {
  let current = String(markdown || "");
  const bundled = String(bundledDashboard || "");
  if (!current || !bundled || current.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.6";') || current.includes("showAppliedControls:")) return current;
  if (!current.includes("const ROOT_FOLDER") || !current.includes("전체 업무 현황")) return current;

  const slice = (source, startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = start >= 0 ? source.indexOf(endMarker, start + startMarker.length) : -1;
    return start >= 0 && end > start ? source.slice(start, end) : "";
  };
  const insertBefore = (marker, snippet) => {
    if (snippet && current.includes(marker)) current = current.replace(marker, `${snippet}${marker}`);
  };

  current = current
    .replace(
      "        todoGroupByTicket: true,\n\n        filters: [],",
      "        todoGroupByTicket: true,\n\n        showAppliedControls: true,\n\n        filters: [],"
    )
    .replace(
      "            filters:\n                Array.isArray(saved.filters)",
      "            showAppliedControls:\n                typeof saved.showAppliedControls === \"boolean\"\n                    ? saved.showAppliedControls\n                    : defaults.showAppliedControls,\n\n            filters:\n                Array.isArray(saved.filters)"
    );

  insertBefore(
    "const fieldButton = dv.el(",
    slice(bundled, "const controlVisibilityButton = dv.el(", "const fieldButton = dv.el(")
  );
  insertBefore(
    ".opus-control-chip {",
    slice(bundled, ".opus-control-visibility-button {", ".opus-control-chip {")
  );
  insertBefore(
    "// ================================================================\n// 25.",
    slice(bundled, "function renderControlVisibilityButton(", "// ================================================================\n// 25.")
  );

  const bundledVisibilityBlock = slice(
    bundled,
    "    const showControlBar =",
    "    sortButton.classList.toggle("
  );
  if (bundledVisibilityBlock) {
    current = current.replace(
      "    controlBar.classList.toggle(\"opus-hidden\", !tableMode);\n\n",
      bundledVisibilityBlock
    );
  }

  insertBefore(
    "fieldButton.addEventListener(",
    slice(bundled, "controlVisibilityButton.addEventListener(", "fieldButton.addEventListener(")
  );
  return current;
}

function upgradeDashboardTodoDetails(markdown, bundledDashboard) {
  let current = String(markdown || "");
  const bundled = String(bundledDashboard || "");
  if (!current || !bundled || current.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.6";')) return current;
  if (
    current.includes("function openTodoDetailModal(")
    && current.includes("clt-todo-completed:")
    && current.includes("todoSearchKeyword:")
  ) return current;
  if (!current.includes("const ROOT_FOLDER") || !current.includes("전체 업무 현황")) return current;

  const slice = (source, startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = start >= 0 ? source.indexOf(endMarker, start + startMarker.length) : -1;
    return start >= 0 && end > start ? source.slice(start, end) : "";
  };
  const replaceSection = (startMarker, endMarker) => {
    const existing = slice(current, startMarker, endMarker);
    const replacement = slice(bundled, startMarker, endMarker);
    if (existing && replacement) current = current.replace(existing, replacement);
  };
  const insertBefore = (marker, snippet, sentinel) => {
    if (snippet && current.includes(marker) && !current.includes(sentinel)) {
      current = current.replace(marker, `${snippet}${marker}`);
    }
  };

  current = current
    .replace(
      "        todoGroupByTicket: true,\n\n        showAppliedControls: true,",
      "        todoGroupByTicket: true,\n\n        todoSearchKeyword: \"\",\n\n        todoQuickView: \"all\",\n\n        showAppliedControls: true,"
    )
    .replace(
      "            showAppliedControls:\n                typeof saved.showAppliedControls === \"boolean\"",
      "            todoSearchKeyword:\n                typeof saved.todoSearchKeyword === \"string\"\n                    ? saved.todoSearchKeyword\n                    : defaults.todoSearchKeyword,\n\n            todoQuickView:\n                [\"all\", \"open\", \"today\", \"overdue\", \"done\"].includes(saved.todoQuickView)\n                    ? saved.todoQuickView\n                    : defaults.todoQuickView,\n\n            showAppliedControls:\n                typeof saved.showAppliedControls === \"boolean\""
    );

  replaceSection("function extractTodos(", "// ================================================================\n// 8.");
  insertBefore(
    ".opus-todo-board-actions {",
    slice(bundled, ".opus-todo-board-guide {", ".opus-todo-board-actions {"),
    ".opus-todo-board-guide {"
  );
  insertBefore(
    ".opus-file-cell-actions {",
    slice(bundled, ".opus-todo-completed-badge {", ".opus-file-cell-actions {"),
    ".opus-todo-completed-badge {"
  );
  replaceSection("function openTodoCreateModal(", "function openWorkLogModal(");
  replaceSection("function createTodoCard(", "function renderAll(");
  return current;
}

function upgradeDashboardTodoSummaryColumn(markdown, bundledDashboard) {
  let current = String(markdown || "");
  const bundled = String(bundledDashboard || "");
  if (!current || !bundled || current.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.6";') || current.includes('key: "todoSummary"')) return current;
  if (!current.includes("const ROOT_FOLDER") || !current.includes("전체 업무 현황")) return current;

  const slice = (source, startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = start >= 0 ? source.indexOf(endMarker, start + startMarker.length) : -1;
    return start >= 0 && end > start ? source.slice(start, end) : "";
  };
  const todoColumn = slice(bundled, '    {\n        key: "todoSummary",', '    {\n        key: "serviceNow",');
  const serviceNowMarker = '    {\n        key: "serviceNow",';
  if (todoColumn && current.includes(serviceNowMarker)) {
    current = current.replace(serviceNowMarker, `${todoColumn}${serviceNowMarker}`);
  }

  current = current
    .replace("    file: 96,", "    file: 52,")
    .replace("    lastChecked: 92,\n    serviceNow:", "    lastChecked: 92,\n    todoSummary: 116,\n    serviceNow:")
    .replaceAll("column.value(item.page)", "column.value(item.page, item)")
    .replace("column.value(page);", "column.value(page, item);")
    .replace(
      "column.value(\n                            item.page\n                        )",
      "column.value(\n                            item.page,\n                            item\n                        )"
    );

  const currentFileCell = slice(current, '        case "file":', '\n\n        case "cr":');
  const bundledFileCell = slice(bundled, '        case "file":', '\n\n        case "cr":');
  if (currentFileCell && bundledFileCell) current = current.replace(currentFileCell, bundledFileCell);

  const summaryCss = slice(bundled, ".opus-todo-summary-cell {", ".opus-todo-create-modal {");
  const legacyFileCss = slice(current, ".opus-file-cell-actions {", ".opus-todo-create-modal {");
  if (summaryCss && legacyFileCss) {
    current = current.replace(legacyFileCss, summaryCss);
  } else if (summaryCss && !current.includes(".opus-todo-summary-cell {") && current.includes(".opus-todo-create-modal {")) {
    current = current.replace(".opus-todo-create-modal {", `${summaryCss}.opus-todo-create-modal {`);
  }
  return current;
}

function upgradeDashboardSharedTodoModal(markdown, bundledDashboard) {
  let current = String(markdown || "");
  const bundled = String(bundledDashboard || "");
  if (!current || !bundled || current.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.6";') || current.includes('app.plugins.getPlugin("servicenow-manage")')) return current;
  const marker = "function openTodoCreateModal(preselectedItem = null) {\n";
  const bundledStart = bundled.indexOf(marker);
  const bundledBodyStart = bundledStart >= 0 ? bundledStart + marker.length : -1;
  const delegationEndMarker = "    const backdrop = document.createElement(\"div\");";
  const bundledEnd = bundledBodyStart >= 0 ? bundled.indexOf(delegationEndMarker, bundledBodyStart) : -1;
  if (!current.includes(marker) || bundledBodyStart < 0 || bundledEnd < 0) return current;
  const delegation = bundled.slice(bundledBodyStart, bundledEnd);
  return current.replace(marker, `${marker}${delegation}`);
}

function upgradeDashboardFieldOrdering(markdown, bundledDashboard) {
  let current = String(markdown || "");
  const bundled = String(bundledDashboard || "");
  if (!current || !bundled || current.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.6";')) return current;
  if (!current.includes("const ROOT_FOLDER") || !current.includes("전체 업무 현황")) return current;
  if (
    current.includes("columnOrder:")
    && current.includes("opus-field-drag-handle")
    && current.includes("function bindColumnReorder(")
    && current.includes("opus-filter-display-toggle")
    && current.includes(".opus-filter-display-toggle {")
    && current.includes("padding: 11px 8px 5px")
    && current.includes("showAppliedFilters:")
    && current.includes("showAppliedSorts:")
    && current.includes("적용된 필터 조건을 표 위에 표시")
    && current.includes("적용된 정렬 조건을 표 위에 표시")
    && current.includes("data-todo-ticket-id=")
    && current.includes("function handleTodoQuickAddClick(")
    && current.includes("openTodoDetailEntryModal")
    && current.includes("data-todo-list-ticket-id=")
    && current.includes("function openTicketTodoListModal(")
    && current.includes("function handleTodoListClick(")
    && !current.includes("const controlVisibilityButton =")
    && !current.includes("opus-header-drag-handle")
  ) return current;

  const slice = (source, startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = start >= 0 ? source.indexOf(endMarker, start + startMarker.length) : -1;
    return start >= 0 && end > start ? source.slice(start, end) : "";
  };
  const replaceSection = (startMarker, endMarker) => {
    const existing = slice(current, startMarker, endMarker);
    const replacement = slice(bundled, startMarker, endMarker);
    if (existing && replacement) current = current.replace(existing, replacement);
  };
  const removeSection = (startMarker, endMarker) => {
    const existing = slice(current, startMarker, endMarker);
    if (existing) current = current.replace(existing, "");
  };

  current = current.replace(/const SETTINGS_SCHEMA_VERSION = \d+;/, "const SETTINGS_SCHEMA_VERSION = 9;");
  current = current.replace(/todoSummary:\s*\d+,/, "todoSummary: 142,");
  replaceSection("function createDefaultSettings()", "function loadSettings()");
  replaceSection("function loadSettings()", "function saveSettings()");
  replaceSection("function getVisibleColumns()", "let settings = loadSettings();");
  replaceSection(".opus-field-option {", ".opus-row-height-section {");
  replaceSection(".opus-popup-field-grid {", ".opus-popup-field {");
  replaceSection(".opus-todo-summary-cell {", ".opus-todo-create-modal {");
  replaceSection("function renderTemporaryChecks(", "// ================================================================\n// 23.");
  replaceSection("function renderFilterMenu()", "// ================================================================\n// 21.");
  replaceSection("function renderSortMenu()", "// ================================================================\n// 22.");
  replaceSection("function renderControlBar()", "// ================================================================\n// 25.");
  replaceSection("function formatCell(", "// ================================================================\n// 18.");
  replaceSection("function openTodoCreateModal(", "function openTodoDetailModal(");
  replaceSection("function openTodoDetailModal(", "function openWorkLogModal(");
  replaceSection("function handleTodoQuickAddClick(", "// ================================================================\n// 28-1.");
  replaceSection("function renderTable()", "// ================================================================\n// 28-1.");
  replaceSection("    const showControlBar =", '    controlBar.classList.toggle("opus-hidden", !showControlBar);');
  replaceSection("function createHeaderHtml(", "function bindColumnResize(");
  removeSection(".opus-control-visibility-button {", ".opus-control-chip {");
  removeSection("const controlVisibilityButton = dv.el(", "const fieldButton = dv.el(");
  removeSection("function renderControlVisibilityButton()", "// ================================================================\n// 25.");
  removeSection("controlVisibilityButton.addEventListener(", "fieldButton.addEventListener(");
  current = current
    .replace('    controlVisibilityButton.classList.toggle("opus-hidden", !tableMode);\n', "")
    .replace("    renderControlVisibilityButton();\n", "");
  if (!current.includes('draggable="true"') && current.includes('            data-column-key="${escapeAttribute(column.key)}"')) {
    current = current.replace(
      '            data-column-key="${escapeAttribute(column.key)}"',
      '            data-column-key="${escapeAttribute(column.key)}"\n            draggable="true"'
    );
  }
  if (!current.includes("function bindColumnReorder(")) {
    const reorderBinding = slice(bundled, "function bindColumnReorder(", "function renderTable()");
    if (reorderBinding && current.includes("function renderTable()")) {
      current = current.replace("function renderTable()", `${reorderBinding}function renderTable()`);
    }
  }
  if (!current.includes("    bindColumnReorder(table);") && current.includes("    bindColumnResize(table);")) {
    current = current.replace("    bindColumnResize(table);", "    bindColumnResize(table);\n    bindColumnReorder(table);");
  }
  return current;
}

function upgradeDashboardTodoPagination(markdown, bundledDashboard) {
  let current = String(markdown || "");
  const bundled = String(bundledDashboard || "");
  if (!current || !bundled || current.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.6";')) return current;
  if (!current.includes("const TODO_PAGE_SIZE = 10;")) return current;
  if (!current.includes("const TODO_STATUSES = [") || !current.includes("function renderAll()")) return current;

  const slice = (source, startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = start >= 0 ? source.indexOf(endMarker, start + startMarker.length) : -1;
    return start >= 0 && end > start ? source.slice(start, end) : "";
  };
  const existingBoard = slice(current, "const TODO_STATUSES = [", "function renderAll()");
  const bundledBoard = slice(bundled, "const TODO_STATUSES = [", "function renderAll()");
  if (existingBoard && bundledBoard) current = current.replace(existingBoard, bundledBoard);

  if (!current.includes(".opus-todo-load-more {") && current.includes(".opus-todo-ticket-group +")) {
    const paginationCss = slice(bundled, ".opus-todo-load-more {", ".opus-todo-ticket-group +");
    if (paginationCss) current = current.replace(".opus-todo-ticket-group +", `${paginationCss}.opus-todo-ticket-group +`);
  }
  return current;
}

function summarizeTicketNotices(entries) {
  const items = Array.isArray(entries) ? entries : [];
  const ticketCount = new Set(items.map((item) => item.ticketId).filter(Boolean)).size;
  const labels = {
    worknotes: "워킹노트 생성·갱신",
    status: "상태·작업예정일 갱신",
    documents: "문서 연결"
  };
  const counts = new Map();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) || 0) + 1);
  const details = [...counts.entries()]
    .map(([kind, count]) => `${labels[kind] || "기타 변경"} ${count}건`);
  const failed = items.filter((item) => item.failed).length;
  return `티켓 ${ticketCount || items.length}건이 자동 변경되었습니다.${details.length ? ` · ${details.join(" · ")}` : ""}${failed ? ` · 실패 ${failed}건` : ""}`;
}

function defaultTicketTemplate() {
  return `---\n` +
    `id: "{{ticketId}}"\n` +
    `category: "{{category}}"\n` +
    `status:\n` +
    `purpose:\n` +
    `short_description:\n` +
    `priority:\n` +
    `service_now_priority:\n` +
    `ticket_creator:\n` +
    `ticket_requester:\n` +
    `service_now_created:\n` +
    `assignment_group:\n` +
    `assigned_person:\n` +
    `service_now_category:\n` +
    `service_now_updated:\n` +
    `estimated_qa_completion_date:\n` +
    `target_qa_completion_date:\n` +
    `actual_release_date:\n` +
    `배포일:\n` +
    `ui_interface_id:\n` +
    `change_complexity:\n` +
    `작업예정일:\n` +
    `status_changed:\n` +
    `sla_basis:\n` +
    `마지막확인:\n` +
    `서비스나우:\n` +
    `jira:\n` +
    `BS:\n` +
    `BS-한글:\n` +
    `FS:\n` +
    `DS:\n` +
    `ut:\n` +
    `관련 문서:\n` +
    `테스트 문서:\n` +
    `워킹노트:\n` +
    `created: "{{now}}"\n` +
    `updated: "{{now}}"\n` +
    `---\n` +
    `\`\`\`clt-ticket-status\n` +
    `ticket: {{ticketId}}\n` +
    `\`\`\`\n\n` +
    `## 📝 작업 일지\n\n` +
    `\`\`\`clt-ticket-worklog-actions\n` +
    `ticket: {{ticketId}}\n` +
    `\`\`\`\n\n` +
    `## 🗓️ 회의록\n\n` +
    `\`\`\`clt-ticket-meeting-actions\n` +
    `ticket: {{ticketId}}\n` +
    `\`\`\`\n\n` +
    `## ✅ To-Do\n\n` +
    `\`\`\`clt-ticket-todo-actions\n` +
    `ticket: {{ticketId}}\n` +
    `\`\`\`\n`;
}

function fillTemplate(template, values) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replace(
      new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g"),
      String(value ?? "")
    ),
    String(template || "")
  );
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replacePromptField(prompt, label, nextLabel, value) {
  const pattern = new RegExp(
    `(${escapeRegExp(label)}\\s*:\\s*\\r?\\n)[\\s\\S]*?(?=\\r?\\n${escapeRegExp(nextLabel)}\\s*:)`,
    "i"
  );
  return String(prompt || "").replace(pattern, (_match, heading) =>
    `${heading}${String(value || "").trim()}\n`
  );
}

function selectAiPromptTemplate(source, category) {
  const text = String(source || "");
  const crIndex = text.search(/CR_TEMPLATE\.md\s*기준/i);
  const srIndex = text.search(/SR_TEMPLATE\.md\s*기준/i);
  if (category === "CR" && crIndex >= 0) {
    return text.slice(crIndex, srIndex > crIndex ? srIndex : text.length).replace(/\s*-{4,}\s*$/, "").trim();
  }
  if (category === "SR" && srIndex >= 0) return text.slice(srIndex).trim();
  return "";
}

function replacePromptWorkingNotes(prompt, value) {
  const pattern = /(Service now Working note\(시간순\)\s*:[ \t]*)(?:\r?\n)?[\s\S]*?(?=\r?\n[ \t]*첨부한|$)/i;
  return String(prompt || "").replace(pattern, (_match, heading) =>
    `${heading}\n${String(value || "").trim() || "(확인된 워킹노트 없음)"}\n`
  );
}

function buildAiEnvironmentInstructions(category, paths = {}) {
  const type = String(category || "").toUpperCase() === "SR" ? "SR" : "CR";
  const templateName = `${type}_TEMPLATE.md`;
  const templatePath = paths.templatePath || templateName;
  const ticketPath = paths.ticketPath || "현재 Obsidian 티켓 노트";
  const assetsPath = paths.assetsPath || "티켓 노트의 assets 폴더";
  return [
    "작업 환경 및 Obsidian 사용 지침:",
    `- 이 요청의 기준 문서는 ${templateName}입니다. 제목만 보고 기준을 추측하지 말고 반드시 문서 내용을 읽어 적용하세요.`,
    "- Codex, Claude Code, Antigravity CLI처럼 로컬 파일과 저장소에 접근할 수 있는 환경이라면 먼저 현재 작업공간/저장소에서 같은 이름의 기준 문서를 찾으세요.",
    `- 현재 작업공간에 없다면 Obsidian Vault의 기준 문서 '${templatePath}'를 읽으세요. 작업공간에 보존할 수 있다면 기존 파일을 덮어쓰지 않는 조건으로 ${templateName} 이름으로 복사해 이후 작업에서도 재사용하세요.`,
    `- 이후 사용자가 '${templateName} 활용', '${templateName} 기준'이라고 말하면 저장해 둔 동일 기준 문서를 다시 읽고 적용하세요. 이번 대화에서도 계속 동일하게 적용하세요.`,
    `- Obsidian을 업무 정보의 기준 저장소로 사용하세요. 먼저 티켓 노트 '${ticketPath}'를 읽고, 노트에 연결된 워킹노트와 '${assetsPath}'의 문서를 함께 확인하세요.`,
    `- 일반 ChatGPT/Claude 웹 채팅처럼 로컬 Obsidian에 접근할 수 없는 환경이라면 사용자가 ${templateName}, 티켓 노트, 워킹노트 및 분석 문서를 직접 첨부해야 합니다. 첨부되지 않은 파일을 읽었다고 가정하지 말고 필요한 파일을 요청하세요.`,
    "- 채팅에 첨부된 기준 문서는 해당 대화 전체에서 계속 적용하고, 첨부된 티켓/문서만 근거로 분석하세요."
  ].join("\n");
}

function googleDriveFileId(value) {
  const text = String(value || "").trim();
  const linkMatch = text.match(/https?:\/\/[^\s)\]]+/);
  const target = linkMatch ? linkMatch[0] : text;
  const pathMatch = target.match(/\/d\/([A-Za-z0-9_-]+)/);
  if (pathMatch) return pathMatch[1];
  const queryMatch = target.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (queryMatch) return queryMatch[1];
  try {
    const url = new URL(target);
    return url.searchParams.get("id") || "";
  } catch (_) {
    if (/^[A-Za-z0-9_-]{20,}$/.test(target)) return target;
    return "";
  }
}

function googleDownloadFormat(mimeType, originalName = "") {
  const nativeFormats = {
    "application/vnd.google-apps.document": {
      exportMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extension: ".docx"
    },
    "application/vnd.google-apps.spreadsheet": {
      exportMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: ".xlsx"
    },
    "application/vnd.google-apps.presentation": {
      exportMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      extension: ".pptx"
    },
    "application/vnd.google-apps.drawing": {
      exportMime: "application/pdf",
      extension: ".pdf"
    }
  };
  if (nativeFormats[mimeType]) return { ...nativeFormats[mimeType], native: true };
  const extension = String(originalName || "").match(/(\.[A-Za-z0-9]{1,10})$/)?.[1] || ".bin";
  return { exportMime: "", extension, native: false };
}

function safeFileName(value) {
  return String(value || "").replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim();
}

function parseMeetingDate(value, fallback = new Date()) {
  const source = String(value || "");
  const fileMatch = source.match(/(20\d{2})[_/-](\d{1,2})[_/-](\d{1,2})(?:[ T_]+(\d{1,2})[_:](\d{2}))?/);
  const koreanMatch = source.match(/(20\d{2})\s*년?\s*(\d{1,2})월\s*(\d{1,2})일/);
  const match = fileMatch || koreanMatch;
  if (!match) return localIsoDateTime(fallback).slice(0, 16);
  const [, year, month, day, hour = "00", minute = "00"] = match;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${minute}`;
}

function cleanMeetingTitle(value, ticketId = "") {
  const cleaned = String(value || "")
    .replace(/\.(?:md|txt|pdf)$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+-\s+Gemini가 작성한 회의록.*$/i, "")
    .replace(/\s+-\s+20\d{2}[\s\S]*$/, "")
    .replace(/^#+\s*/, "")
    .replace(/\*\*/g, "")
    .trim();
  return cleaned || `${normalizeTicketId(ticketId)} 회의`;
}

function meetingSection(markdown, heading, nextHeadings = []) {
  const alternatives = [heading, ...nextHeadings].map(escapeRegExp).join("|");
  const pattern = new RegExp(`^#{2,4}\\s+(?:\\*\\*)?(?:${alternatives})(?:\\*\\*)?\\s*$`, "im");
  const match = pattern.exec(String(markdown || ""));
  if (!match) return "";
  const rest = String(markdown || "").slice(match.index + match[0].length);
  const boundary = rest.search(/^#{1,4}\s+(?:\*\*)?(?:📝\s*회의록|📖\s*스크립트|요약|결정|다음 단계|상세\s*정보)(?:\*\*)?\s*$/im);
  return (boundary >= 0 ? rest.slice(0, boundary) : rest).trim();
}

function buildMeetingNoteMarkdown({ ticketId, ticketIds = [], sourceName, sourceText, meetingDate, title, pdfPath = "", sourceDriveId = "" }) {
  const linkedTicketIds = normalizeMeetingTicketIds(ticketIds.length ? ticketIds : ticketId);
  const normalized = linkedTicketIds[0] || "";
  const raw = String(sourceText || "").replace(/\r\n/g, "\n").trim();
  const sourceTitle = raw.match(/^##\s+(?:\*\*)?(.+?)(?:\*\*)?\s*$/m)?.[1] || sourceName;
  const resolvedTitle = cleanMeetingTitle(title || sourceTitle, normalized);
  const resolvedDate = meetingDate || parseMeetingDate(`${sourceName}\n${raw}`);
  const displayDate = resolvedDate.replace("T", " ");
  const summary = meetingSection(raw, "요약");
  const decisions = meetingSection(raw, "결정");
  const nextSteps = meetingSection(raw, "다음 단계");
  const details = meetingSection(raw, "상세정보", ["상세 정보"]);
  const scriptIndex = raw.search(/^#\s+(?:\*\*)?📖\s*스크립트/m);
  const script = scriptIndex >= 0 ? raw.slice(scriptIndex).replace(/^#\s+(?:\*\*)?📖\s*스크립트(?:\*\*)?\s*/m, "").trim() : "";
  const participantLine = raw.match(/^초대됨\s+(.+)$/m)?.[1]?.trim() || "";
  const recordLine = raw.match(/^회의 기록\s+(.+)$/m)?.[1]?.trim() || "";
  const calendarLine = raw.match(/^첨부파일\s+(.+)$/m)?.[1]?.trim() || "";
  const sourceLink = pdfPath ? `[[${pdfPath}|PDF 원본]]` : `\`${sourceName || "업로드 파일"}\``;
  const sections = [];
  if (summary) sections.push(`> [!abstract] 회의 핵심\n${summary.split("\n").map((line) => `> ${line}`).join("\n")}`);
  if (decisions) sections.push(`## ✅ 결정 사항\n\n${decisions.replace(/^##\s+의견 일치\s*/m, "")}`);
  if (nextSteps) sections.push(`## 🎯 다음 단계\n\n${nextSteps}`);
  if (details) sections.push(`## 🔎 상세 논의\n\n${details}`);
  if (script) sections.push(`## 📖 전체 스크립트\n\n> [!note]- 스크립트 펼치기\n${script.split("\n").map((line) => `> ${line}`).join("\n")}`);
  if (!sections.length && raw) sections.push(`## 🧾 회의 내용\n\n${raw}`);
  const ticketsYaml = linkedTicketIds.length
    ? `tickets:\n${linkedTicketIds.map((id) => `  - "${id}"`).join("\n")}\nParents:\n${linkedTicketIds.map((id) => `  - "[[${id}]]"`).join("\n")}\n`
    : "tickets: []\n";
  return `---\n` +
    `${normalized ? `ticket: "${normalized}"\nParent: "[[${normalized}]]"\n` : `ticket: ""\n`}` +
    ticketsYaml +
    `type: meeting-minutes\n` +
    `meeting_date: "${resolvedDate}"\n` +
    `meeting_kind: gemini\n` +
    `source_name: "${String(sourceName || "").replace(/"/g, "'")}"\n` +
    `${sourceDriveId ? `source_drive_id: "${String(sourceDriveId).replace(/"/g, "'")}"\n` : ""}` +
    `${pdfPath ? `source_pdf: "[[${pdfPath}]]"\n` : ""}` +
    `created: "${localIsoDateTime().replace(" ", "T").slice(0, 16)}"\n` +
    `cssclasses:\n  - clt-meeting-note\n` +
    `---\n\n` +
    `# 🗓️ ${resolvedTitle}\n\n` +
    `> [!info] 회의 정보\n` +
    `> | 구분 | 내용 |\n> |---|---|\n` +
    `> | 일시 | ${displayDate} |\n` +
    `> | 관련 티켓 | ${linkedTicketIds.length ? linkedTicketIds.map((id) => `[[${id}|${id}]]`).join(" · ") : "티켓 없음"} |\n` +
    `> | 참석자 | ${participantLine || "확인 필요"} |\n` +
    `> | 원본 | ${sourceLink} |\n` +
    `${calendarLine ? `> | 일정 | ${calendarLine} |\n` : ""}` +
    `${recordLine ? `> | 기록 | ${recordLine} |\n` : ""}` +
    `\n${sections.join("\n\n")}\n`;
}

function extractTicketFocusedMeetingContent(markdown, ticketId) {
  const normalized = normalizeTicketId(ticketId);
  const source = String(markdown || "").replace(/\r\n/g, "\n");
  if (!normalized || !source.trim()) return source.trim();
  const lines = source.split("\n");
  const boundaryPattern = /^\s*(?:#{1,6}\s+|\d+[.)]\s+|[-*+]\s+)?((?:CR|SR|INC)\d+)\b/i;
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const boundary = lines[index].match(boundaryPattern);
    if (!boundary || normalizeTicketId(boundary[1]) !== normalized) continue;
    let end = index + 1;
    while (end < lines.length) {
      const next = lines[end].match(boundaryPattern);
      if (next && normalizeTicketId(next[1]) !== normalized) break;
      end += 1;
    }
    blocks.push(lines.slice(index, end).join("\n").trim());
    index = end - 1;
  }
  if (!blocks.length) {
    const paragraphs = source.split(/\n\s*\n/);
    paragraphs.forEach((paragraph, index) => {
      if (!new RegExp(`\\b${escapeRegExp(normalized)}\\b`, "i").test(paragraph)) return;
      blocks.push(paragraphs.slice(Math.max(0, index - 1), Math.min(paragraphs.length, index + 2)).join("\n\n").trim());
    });
  }
  const unique = [...new Set(blocks.filter(Boolean))];
  return unique.length
    ? `# ${normalized} 관련 발췌\n\n${unique.join("\n\n---\n\n")}`
    : `# ${normalized} 관련 발췌\n\n이 공유 회의록에서 ${normalized}가 명시된 구간을 찾지 못했습니다. 다른 티켓의 내용으로 추론하지 마세요.`;
}

function buildMeetingAnalysisPrompt({ ticketId, meetings, ticketPath, outputFolder, baseline = null }) {
  const ordered = [...(meetings || [])].sort((left, right) =>
    String(left.meetingDate || "").localeCompare(String(right.meetingDate || ""))
  );
  const start = String(baseline?.meetingStart || baseline?.meetingDate || ordered[0]?.meetingDate || "").slice(0, 10) || "시작일";
  const end = String(ordered.at(-1)?.meetingDate || baseline?.meetingEnd || baseline?.meetingDate || "").slice(0, 10) || "종료일";
  const sources = ordered.map((meeting, index) => [
    `## 회의록 ${index + 1} · ${meeting.meetingDate || "일시 미지정"} · ${meeting.title}`,
    `Obsidian 경로: ${meeting.file?.path || ""}`,
    "",
    String(meeting.content || "(파일 내용을 직접 읽으세요.)").trim()
  ].join("\n")).join("\n\n---\n\n");
  const baselineSource = baseline ? [
    "이전 분석 자료:",
    `분석 범위: ${baseline.meetingStart || "시작일 미지정"} ~ ${baseline.meetingEnd || baseline.meetingDate || "종료일 미지정"}`,
    `Obsidian 경로: ${baseline.file?.path || ""}`,
    "",
    String(baseline.content || "(파일 내용을 직접 읽으세요.)").trim(),
    "",
    "새로 추가된 회의록 원문:"
  ] : ["선택된 회의록 원문:"];
  return [
    `${ticketId} 회의록 종합 분석 요청`,
    "",
    `분석 기간: ${start} ~ ${end}`,
    `티켓 원본 노트: ${ticketPath}`,
    "",
    baseline
      ? "이전 분석 자료를 기준점으로 사용하고 새로 추가된 회의록만 이어서 분석하세요. 이전 분석을 처음부터 재작성하지 말고, 새 회의로 인해 변경된 결정·미결 사항·위험·할 일을 반영한 최신 누적 분석본을 만드세요."
      : "아래 회의록을 반드시 오래된 순서부터 모두 읽고, 시간 흐름에 따른 논의 변화와 현재 결론을 한 문서만으로 파악할 수 있게 분석하세요.",
    "추측하지 말고 회의록에 명시된 사실, 결정, 미결 사항을 구분하세요. 서로 충돌하는 내용은 날짜와 발언 근거를 함께 표시하세요.",
    `공유 회의록에는 여러 티켓이 포함될 수 있습니다. ${ticketId}가 명시된 발췌만 분석하고 다른 티켓의 논의는 결론이나 할 일에 포함하지 마세요. 관련성이 불명확하면 '확인 필요'로 남기세요.`,
    "",
    ...baselineSource,
    sources,
    "",
    "필수 구성:",
    "1. Executive Summary - 현재 상황과 가장 중요한 결론",
    "2. Timeline - 회의별 주요 논의, 변경점, 결정사항을 날짜순으로 정리",
    "3. Confirmed Decisions - 확정된 결정과 결정일",
    "4. Open Questions and Risks - 미확정 사항, 충돌, 일정·테스트·운영 리스크",
    "5. Action Items - 할 일, 담당자, 목표일, 근거 회의. 불명확하면 확인 필요로 표시",
    "6. Current Status - 지금 바로 알아야 할 상태와 다음 확인 순서",
    "",
    "Obsidian 저장 지침:",
    `- 결과를 '${outputFolder}' 폴더에 '${start} ~ ${end} 회의록 분석.md' 이름으로 직접 저장하세요. 같은 파일이 있으면 덮어쓰지 말고 번호를 붙이세요.`,
    `- YAML frontmatter에 ticket, Parent: "[[${ticketId}]]", type: meeting-minutes, meeting_kind: analysis, meeting_start, meeting_end, meeting_date, source_name: AI 회의록 분석, cssclasses: [clt-meeting-analysis-note]를 넣으세요.`,
    `- ticket은 '${ticketId}', meeting_start는 '${start}', meeting_end와 meeting_date는 '${end}'입니다.`,
    "- 각 핵심 판단에는 근거가 된 회의 날짜와 원본 회의록 위키링크를 표시하세요.",
    "- 저장이 끝나면 생성한 파일 경로와 아직 확인이 필요한 항목만 간단히 보고하세요."
  ].join("\n");
}

function documentTypeFromFileName(value) {
  const match = String(value || "").toUpperCase().match(/(?:^|[_\s-])(BS|FS|DS|UT)(?=[_\s.-]|$)/);
  return match?.[1] || "";
}

function isStandardBsFileName(ticketId, value) {
  const normalized = normalizeTicketId(ticketId);
  return new RegExp(`^${escapeRegExp(normalized)}(?:_|\\s+)BS\\s+-\\s+.+`, "i")
    .test(String(value || "").trim());
}

function standardBsBaseName(ticketId, value) {
  const original = safeFileName(value).slice(0, 100) || "원본";
  return isStandardBsFileName(ticketId, original)
    ? original
    : `${normalizeTicketId(ticketId)}_BS - ${original}`;
}

function wikiLinkTarget(value) {
  const match = String(value || "").trim().match(/^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]$/);
  return match ? normalizePath(match[1].trim()) : "";
}

function isLocalBsWikiLink(value, assetsFolder) {
  const target = wikiLinkTarget(value);
  const folder = normalizePath(String(assetsFolder || "")).replace(/\/$/, "");
  if (!target || !folder || !target.startsWith(`${folder}/`)) return false;
  const basename = target.split("/").pop()?.replace(/\.[^.]+$/, "") || "";
  return documentTypeFromFileName(basename) === "BS" && !/BS[-_\s]*한글/i.test(basename);
}

function isImageAttachment(fileName, contentType = "") {
  if (String(contentType || "").toLowerCase().startsWith("image/")) return true;
  return /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(String(fileName || ""));
}

function isVideoAttachment(fileName, contentType = "") {
  if (String(contentType || "").toLowerCase().startsWith("video/")) return true;
  return /\.(?:mp4|webm|ogv|mov|m4v)$/i.test(String(fileName || ""));
}

function workNoteContextSnippet(entry) {
  if (!entry) return "없음";
  const content = String(entry.content || "").replace(/\s+/g, " ").trim();
  const clipped = content.length > 320 ? `${content.slice(0, 320)}…` : content;
  return [entry.time, entry.author, clipped].filter(Boolean).join(" · ") || "내용 없음";
}

function serviceNowImageContext(ticket) {
  const entries = [...(ticket?.entries || [])].sort((left, right) =>
    String(left.time || "").localeCompare(String(right.time || ""))
  );
  return entries.flatMap((entry, index) => {
    if (entry.type !== "Attachment" || !entry.localPath || !isImageAttachment(entry.content, entry.contentType)) return [];
    const before = entries.slice(0, index).reverse().find((item) => item.type === "Work Note");
    const after = entries.slice(index + 1).find((item) => item.type === "Work Note");
    return [{ entry, before, after }];
  });
}

function serviceNowAttachmentId(entry) {
  const direct = String(entry?.attachmentId || "").trim();
  if (direct) return direct;
  try {
    return new URL(String(entry?.url || "")).searchParams.get("sys_id") || "";
  } catch (_) {
    return String(entry?.url || "").match(/[?&]sys_id=([^&#]+)/i)?.[1] || "";
  }
}

function adaptPromptToAvailableDocuments(prompt, availableTypes, hasBsTranslation = false) {
  const types = ["BS", "FS", "DS", "UT"].filter((type) => availableTypes.includes(type));
  let next = String(prompt || "")
    .replace(/\s*첨부한\s+BS\s*,\s*FS\s*,\s*DS\s*,\s*UT를\s+분석해줘\./i, "")
    .replace(/\s*첨부 문서가 없다면\s*,?\s*그 이전 단계이니 워킹 노트를 중점으로 파악해줘\./i, "")
    .replace(/\s*그리고 해당 채팅에서 매 채팅마다 항상 옵시디언 메모용 현재 상태 한 줄 요약을 적어줘\./i, "")
    .replace(/\s*추가로\s+BS를\s+한글로\s+번역해서[\s\S]*?링크해줘\./i, "")
    .trim();
  const instructions = [
    "",
    "분석 요청:",
    types.length
      ? `- 첨부되었거나 아래 경로로 제공된 ${types.join(", ")} 문서를 분석해 주세요.`
      : "- 현재 확인된 첨부 문서가 없으므로 이전 단계로 판단하고 ServiceNow Working Notes를 중점적으로 파악해 주세요.",
    "- 문서 일부가 없거나 접근할 수 없다면 확인 가능한 문서와 ServiceNow Working Notes를 우선 분석하고, 꼭 필요한 파일만 사용자에게 첨부를 요청하세요.",
    "- 이 채팅의 매 답변 마지막에는 Obsidian 메모용 ‘현재 상태 한 줄 요약’을 항상 작성해 주세요."
  ];
  if (types.includes("BS")) {
    instructions.push(
      hasBsTranslation
        ? "- 기존 BS-한글 번역본을 원본 BS와 페이지 단위로 대조하세요. Markdown/`.docx.md` 요약본이거나, 원본에 있는 표·이미지·스크린샷·도표가 빠졌거나, 원문이 과도하게 축약됐다면 완료본으로 인정하지 말고 아래 PDF 기준으로 다시 만드세요."
        : "- BS를 한국어로 번역한 별도 문서를 만들어 주세요. 로컬 파일 수정이 가능한 환경이라면 파일명을 ‘<티켓번호> BS-한글 - <원래제목>.pdf’ 형식으로 assets 폴더에 저장하고 티켓 노트의 ‘BS-한글’ 필드에 PDF를 링크하세요. 로컬 파일 수정이 불가능한 채팅 AI라면 사용자가 저장할 수 있는 번역 결과와 원본 시각자료 보존 방법을 제공하세요.",
      "- BS-한글은 요약문이 아니라 시각 문서 번역본입니다. 원본 전체 페이지를 읽고 표·이미지·스크린샷·도표·캡션·각주·링크와 섹션 순서를 보존한 한국어 PDF로 만드세요. 사용자가 명시하지 않는 한 Markdown, `.docx.md`, 텍스트 요약을 최종 산출물로 만들지 마세요.",
      "- 직접 원문 위에 번역하기 어렵다면 읽기 좋은 새 한국어 PDF로 재구성하되, 원본의 모든 시각자료를 관련 번역 문맥 옆에 포함하세요. 분석·리스크·ITO 의견은 번역 본문을 대체하지 말고 별도 부록으로 구분하세요.",
      "- 번역은 문장별 직역이 아니라 OPUS/eBooking 업무 문맥에 맞는 자연스러운 한국어로 작성하세요. 같은 용어는 문서 전체에서 동일하게 번역하고, 화면명·필드명·메시지·코드·수치·비교 연산자·조건 분기는 원문과 정확히 일치시킨 뒤 필요한 경우 원문을 괄호로 병기하세요.",
      "- 원문에 없는 결론, 기대효과, 위험, 화면 존재 여부 또는 '이미지가 없다' 같은 판단을 번역 본문에 새로 만들지 마세요. 원본 양식의 안내 문구와 실제 요구사항을 구분하고, 빈 페이지나 빈 항목은 임의 내용으로 채우지 마세요.",
      "- 최종 검수에서는 (1) 모든 요구사항과 조건/예외의 의미 정확성, (2) 용어 일관성, (3) 자연스러운 한국어, (4) 원본 시각자료와의 대응, (5) 원문에 없는 내용의 추가 여부를 별도로 확인하세요. 하나라도 충족하지 못하면 완료로 보고하지 말고 수정하세요.",
      "- 완료 전 결과 PDF의 모든 페이지를 렌더링해 육안 검수하고 원본과 페이지 단위로 비교하여 누락된 표·이미지·요구사항, 잘림, 겹침, 깨진 한글이 없는지 확인하세요."
    );
  }
  return `${next}\n${instructions.join("\n")}`.trim();
}

function classifyPromptDocuments(documentValues, failures = {}) {
  const types = ["BS", "FS", "DS", "UT"];
  return {
    availableTypes: types.filter((type) => Boolean(documentValues?.[type]?.local)),
    inaccessibleTypes: types.filter((type) =>
      Boolean(documentValues?.[type]?.link) && !documentValues?.[type]?.local
    ),
    failures: Object.fromEntries(types
      .filter((type) => failures?.[type])
      .map((type) => [type, String(failures[type])]))
  };
}

function repairTemplatePlaceholders(template) {
  let next = String(template || "");
  const repairNestedPlaceholder = (field, placeholder) => {
    const pattern = new RegExp(
      `^${field}:\\s*\\r?\\n[ \\t]+["']?\\{\\s*${placeholder}\\s*\\}["']?:\\s*$`,
      "gmi"
    );
    next = next.replace(pattern, `${field}: "{{${placeholder}}}"`);
  };
  repairNestedPlaceholder("id", "ticketId");
  repairNestedPlaceholder("category", "category");
  repairNestedPlaceholder("created", "now");
  repairNestedPlaceholder("updated", "now");
  return next.replace(/\{\{\s*(ticketId|category|now|parentName)\s*\}\}/g, "{{$1}}");
}

function normalizedHeadingText(value) {
  return String(value || "").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

function matchTodoHeading(line) {
  const match = String(line || "").match(/^(#{1,6})\s+(.+)$/);
  return match && normalizedHeadingText(match[2]).includes("todo") ? match : null;
}

function appendEntryToMarkdownSection(markdown, headingText, entry) {
  const lines = String(markdown || "").split(/\r?\n/);
  const target = normalizedHeadingText(headingText);
  let headingIndex = -1;
  let headingLevel = 2;
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^(#{1,6})\s+(.+)$/);
    if (!match || !normalizedHeadingText(match[2]).includes(target)) continue;
    headingIndex = index;
    headingLevel = match[1].length;
    break;
  }
  if (headingIndex < 0) return `${String(markdown || "").trimEnd()}\n\n## ${headingText}\n\n${entry}\n`;
  let end = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index++) {
    const match = lines[index].match(/^(#{1,6})\s+(.+)$/);
    if (match && match[1].length <= headingLevel) { end = index; break; }
  }
  while (end > headingIndex + 1 && !lines[end - 1].trim()) end--;
  lines.splice(end, 0, entry);
  return `${lines.join("\n").replace(/\n*$/, "")}\n`;
}

function ensureSectionActionBlock(markdown, ticketId, headingText, language) {
  const source = String(markdown || "");
  if (new RegExp(`\`\`\`${language}\\b`).test(source)) return source;
  const lines = source.split(/\r?\n/);
  const target = normalizedHeadingText(headingText);
  const block = [
    `\`\`\`${language}`,
    `ticket: ${ticketId}`,
    "\`\`\`"
  ];
  const headingIndex = lines.findIndex((line) => {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    return match && normalizedHeadingText(match[2]).includes(target);
  });
  if (headingIndex < 0) {
    return `${source.trimEnd()}\n\n## ${headingText}\n\n${block.join("\n")}\n`;
  }
  lines.splice(headingIndex + 1, 0, "", ...block, "");
  return `${lines.join("\n").replace(/\n*$/, "")}\n`;
}

class StateModal extends SuggestModal {
  constructor(app, states, onChoose) {
    super(app);
    this.states = states;
    this.onChoose = onChoose;
    this.setPlaceholder("ServiceNow 상태를 선택하세요");
  }
  getSuggestions(query) {
    const normalized = String(query || "").toLowerCase();
    return this.states.filter((state) => state.toLowerCase().includes(normalized));
  }
  renderSuggestion(state, el) { el.setText(state); }
  onChooseSuggestion(state) { this.onChoose(state); }
}

class NewTicketModal extends Modal {
  constructor(app, onSubmit) {
    super(app);
    this.onSubmit = onSubmit;
  }
  onOpen() {
    this.contentEl.empty();
    this.titleEl.setText("새 CR/SR 티켓 노트 만들기");
    this.contentEl.createEl("p", { text: "티켓 번호를 입력하면 표준 폴더·원본 노트·워킹노트를 자동 생성합니다." });
    const input = this.contentEl.createEl("input", { type: "text", placeholder: "예: CR0000000 또는 SR0000000" });
    input.style.width = "100%";
    input.style.marginBottom = "16px";
    input.addEventListener("input", () => {
      const cleaned = input.value.replace(/\s+/g, "").toUpperCase();
      if (input.value !== cleaned) input.value = cleaned;
    });
    const submit = () => {
      const ticketId = normalizeTicketId(input.value);
      if (!ticketId || !/^(CR|SR)/.test(ticketId)) return new Notice("올바른 CR/SR 티켓 번호를 입력하세요.");
      this.close();
      this.onSubmit(ticketId);
    };
    const button = this.contentEl.createEl("button", { text: "티켓 노트 만들기", cls: "mod-cta" });
    button.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") submit(); });
    window.setTimeout(() => input.focus(), 50);
  }
  onClose() { this.contentEl.empty(); }
}

class ConfirmActionModal extends Modal {
  constructor(app, title, message, onConfirm, confirmText = "확인하고 이동", failureLabel = "처리") {
    super(app);
    this.modalTitle = title;
    this.message = message;
    this.onConfirm = onConfirm;
    this.confirmText = confirmText;
    this.failureLabel = failureLabel;
  }
  onOpen() {
    this.contentEl.empty();
    this.titleEl.setText(this.modalTitle);
    this.contentEl.createEl("p", { text: this.message });
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    const cancel = actions.createEl("button", { text: "취소" });
    cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { text: this.confirmText, cls: "mod-cta" });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        await this.onConfirm();
        this.close();
      } catch (error) {
        new Notice(`${this.failureLabel} 실패: ${error.message || error}`, 9000);
        confirm.disabled = false;
      }
    });
  }
  onClose() { this.contentEl.empty(); }
}

class StatusGuideModal extends Modal {
  constructor(app, plugin, ticketId, category, status, guide) {
    super(app);
    this.plugin = plugin;
    this.ticketId = ticketId;
    this.category = category;
    this.status = status;
    this.guide = guide;
  }

  onOpen() {
    this.modalEl.addClass("clt-status-guide-modal");
    this.contentEl.empty();
    this.titleEl.setText(`${this.ticketId} 현재 상태 업무 가이드`);
    const heading = this.contentEl.createDiv({ cls: "clt-status-guide-heading" });
    heading.createSpan({ cls: `clt-status-guide-category ${this.category.toLowerCase()}`, text: this.category });
    heading.createEl("strong", { text: this.status || "상태 미확인" });

    if (!this.guide) {
      this.contentEl.createDiv({
        cls: "clt-status-guide-empty",
        text: `${this.category}의 '${this.status || "미확인"}' 상태에 등록된 업무 가이드가 없습니다.`
      });
    } else {
      this.contentEl.createDiv({ cls: "clt-status-guide-meaning", text: this.guide.meaning });
      const overview = this.contentEl.createDiv({ cls: "clt-status-guide-overview" });
      [
        ["일반적인 다음 단계", this.guide.next],
        ["주 담당", this.guide.owner],
        ["SLA / TAT", this.guide.target]
      ].filter(([, value]) => value).forEach(([label, value]) => {
        const card = overview.createDiv({ cls: "clt-status-guide-overview-card" });
        card.createSpan({ text: label });
        card.createEl("strong", { text: value });
      });
      this.contentEl.createEl("h4", { text: "현재 단계에서 확인할 일" });
      const checklist = this.contentEl.createEl("ul", { cls: "clt-status-guide-checklist" });
      for (const action of this.guide.actions || []) {
        const item = checklist.createEl("li");
        item.createSpan({ cls: "clt-status-guide-check", text: "☐" });
        item.createSpan({ text: action });
      }
      if (this.guide.alert) {
        this.contentEl.createDiv({ cls: "clt-status-guide-alert", text: this.guide.alert });
      }
      const workNoteTemplates = Array.isArray(this.guide.workNoteTemplates)
        ? this.guide.workNoteTemplates.filter((template) => String(template?.content || "").trim())
        : [];
      if (workNoteTemplates.length) {
        this.contentEl.createEl("h4", { text: "Working Note 템플릿" });
        const templateList = this.contentEl.createDiv({ cls: "clt-status-guide-templates" });
        for (const [index, template] of workNoteTemplates.entries()) {
          const card = templateList.createDiv({ cls: "clt-status-guide-template" });
          const toolbar = card.createDiv({ cls: "clt-status-guide-template-toolbar" });
          toolbar.createEl("strong", { text: String(template.title || `템플릿 ${index + 1}`) });
          const copyTemplate = toolbar.createEl("button", { text: "문구 복사" });
          const content = String(template.content || "").trim();
          copyTemplate.addEventListener("click", async () => {
            try {
              await navigator.clipboard.writeText(content);
              new Notice(`${String(template.title || "Working Note")} 문구를 복사했습니다.`);
            } catch (error) {
              new Notice(`Working Note 문구 복사 실패: ${error.message || error}`, 8000);
            }
          });
          card.createEl("pre", { text: content });
          if (template.note) card.createDiv({ cls: "clt-status-guide-template-note", text: String(template.note) });
        }
      }
    }

    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    if (this.guide) {
      const copy = actions.createEl("button", { text: "체크리스트 복사" });
      copy.addEventListener("click", async () => {
        const lines = [
          `${this.ticketId} | ${this.category} | ${this.status}`,
          `다음 단계: ${this.guide.next || "미정"}`,
          `주 담당: ${this.guide.owner || "미정"}`,
          ...(this.guide.target ? [`SLA/TAT: ${this.guide.target}`] : []),
          "",
          ...(this.guide.actions || []).map((action) => `- [ ] ${action}`),
          ...(this.guide.alert ? ["", `주의: ${this.guide.alert}`] : [])
        ];
        try {
          await navigator.clipboard.writeText(lines.join("\n"));
          new Notice("현재 상태 업무 체크리스트를 복사했습니다.");
        } catch (error) {
          new Notice(`체크리스트 복사 실패: ${error.message || error}`, 8000);
        }
      });
    }
    const fullGuideFile = this.plugin.statusGuideFile(this.category);
    if (fullGuideFile) {
      const fullGuide = actions.createEl("button", { text: `${this.category} 전체 가이드 열기` });
      fullGuide.addEventListener("click", () => this.plugin.openStatusGuideNote(this.category));
    }
    const close = actions.createEl("button", { text: "닫기", cls: "mod-cta" });
    close.addEventListener("click", () => this.close());
  }

  onClose() {
    this.modalEl.removeClass("clt-status-guide-modal");
    this.contentEl.empty();
  }
}

class TimedEntryModal extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options;
  }
  onOpen() {
    this.contentEl.empty();
    this.titleEl.setText(this.options.title);
    this.contentEl.createDiv({ cls: "clt-ticket-entry-time", text: `현재 시각: ${localIsoDateTime().slice(0, 16)}` });
    const previewHost = this.contentEl.createDiv({ cls: "clt-todo-entry-form clt-worklog-markdown-form" });
    const input = createRichMarkdownEditor(this.app, this, previewHost, "", this.options.sourcePath || "", this.options.placeholder);
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    const cancel = actions.createEl("button", { text: "취소" });
    cancel.addEventListener("click", () => this.close());
    const add = actions.createEl("button", { text: "추가", cls: "mod-cta" });
    const submit = async () => {
      const content = input.value.trim();
      if (!content) return new Notice(this.options.emptyMessage);
      add.disabled = true;
      add.setText("저장 중…");
      try {
        await this.options.onSubmit(content);
        this.close();
      } catch (error) {
        new Notice(`저장 실패: ${error.message || error}`, 9000);
        add.disabled = false;
        add.setText("추가");
      }
    };
    add.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") submit();
    });
    window.setTimeout(() => input.focus(), 50);
  }
  onClose() { this.contentEl.empty(); }
}

class MeetingImportModal extends Modal {
  constructor(app, plugin, ticketId, onImported = null, allowTicketSelection = false) {
    super(app);
    this.plugin = plugin;
    this.ticketId = normalizeTicketId(ticketId);
    this.onImported = onImported;
    this.allowTicketSelection = allowTicketSelection;
    this.selectedTicketIds = new Set(this.ticketId ? [this.ticketId] : []);
  }
  onOpen() {
    this.modalEl.addClass("clt-meeting-import-modal");
    this.contentEl.empty();
    this.titleEl.setText(this.allowTicketSelection ? "새 회의록 추가" : `${this.ticketId} 새 회의록 추가`);
    this.contentEl.createDiv({
      cls: "clt-meeting-import-lead",
      text: "Google Docs에서 마크다운(.md)으로 내려받아 등록하는 방식을 권장합니다. PDF는 원본 보관용으로 함께 선택할 수 있습니다."
    });
    const guide = this.contentEl.createDiv({ cls: "clt-meeting-format-guide" });
    guide.createDiv({ cls: "is-recommended", text: "권장 · Markdown — 제목, 체크박스, 링크, 스크립트 시간을 정확히 보존" });
    guide.createDiv({ text: "선택 · PDF — 보기 좋은 원본을 회의록 노트와 함께 보관" });
    const form = this.contentEl.createDiv({ cls: "clt-meeting-import-form" });
    const fileLabel = form.createEl("label", { cls: "clt-meeting-file-drop" });
    fileLabel.createDiv({ cls: "clt-meeting-file-icon", text: "⇧" });
    fileLabel.createEl("strong", { text: "1. 회의록 파일 선택" });
    fileLabel.createSpan({ text: ".md 또는 .txt 1개 + 선택 PDF 1개" });
    const fileInput = fileLabel.createEl("input", { type: "file" });
    fileInput.accept = ".md,.txt,.pdf,text/markdown,text/plain,application/pdf";
    fileInput.multiple = true;
    const selected = form.createDiv({ cls: "clt-meeting-selected-files", text: "선택된 파일 없음" });
    const ticketPicker = form.createDiv({ cls: "clt-meeting-ticket-picker is-hidden" });
    const ticketHeading = ticketPicker.createDiv({ cls: "clt-meeting-ticket-picker-heading" });
    ticketHeading.createEl("strong", { text: "2. 관련 티켓 선택" });
    const ticketCount = ticketHeading.createSpan();
    const ticketSearch = ticketPicker.createEl("input", { type: "search", placeholder: "CR/SR 번호 검색 · 여러 개 선택 가능" });
    const ticketList = ticketPicker.createDiv({ cls: "clt-meeting-ticket-options" });
    const ticketIds = this.plugin.rootTicketFiles().map((file) => this.plugin.rootTicketIdFromFile(file)).filter(Boolean).sort();
    const updateTicketSummary = () => {
      const count = this.selectedTicketIds.size;
      ticketCount.setText(count ? `${count}개 선택` : "티켓 없이 등록");
      titleInput.placeholder = count === 1 ? `${[...this.selectedTicketIds][0]} 회의` : "회의 제목";
    };
    const renderTicketOptions = () => {
      ticketList.empty();
      const needle = ticketSearch.value.trim().toUpperCase();
      const visible = ticketIds.filter((id) => !needle || id.includes(needle));
      visible.forEach((ticketId) => {
        const option = ticketList.createEl("label", { cls: "clt-meeting-ticket-option" });
        const checkbox = option.createEl("input", { type: "checkbox" });
        checkbox.checked = this.selectedTicketIds.has(ticketId);
        option.createSpan({ text: ticketId });
        checkbox.addEventListener("change", () => {
          checkbox.checked ? this.selectedTicketIds.add(ticketId) : this.selectedTicketIds.delete(ticketId);
          updateTicketSummary();
        });
      });
      if (!visible.length) ticketList.createDiv({ cls: "clt-meeting-ticket-empty", text: "일치하는 티켓이 없습니다." });
    };
    ticketSearch.addEventListener("input", renderTicketOptions);
    let titleEdited = false;
    fileInput.addEventListener("change", () => {
      selected.empty();
      const files = [...(fileInput.files || [])];
      if (!files.length) {
        selected.setText("선택된 파일 없음");
        ticketPicker.addClass("is-hidden");
      } else {
        files.forEach((file) => selected.createDiv({ text: `${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB` }));
        const textFile = files.find((file) => /\.(?:md|txt)$/i.test(file.name));
        if (textFile && !titleEdited) titleInput.value = textFile.name.replace(/\.(?:md|txt)$/i, "");
        ticketPicker.removeClass("is-hidden");
      }
    });
    const grid = form.createDiv({ cls: "clt-meeting-import-grid" });
    const titleLabel = grid.createEl("label");
    titleLabel.createSpan({ text: "회의 제목 (선택)" });
    const titleInput = titleLabel.createEl("input", { type: "text", placeholder: `${this.ticketId} 회의` });
    titleInput.addEventListener("input", () => { titleEdited = true; });
    const dateLabel = grid.createEl("label");
    dateLabel.createSpan({ text: "회의 일시 (선택)" });
    const dateInput = dateLabel.createEl("input", { type: "datetime-local" });
    dateInput.value = localIsoDateTime().replace(" ", "T").slice(0, 16);
    renderTicketOptions();
    updateTicketSummary();
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    const cancel = actions.createEl("button", { text: "취소" });
    cancel.addEventListener("click", () => this.close());
    const submit = actions.createEl("button", { text: "회의록 만들기", cls: "mod-cta" });
    submit.addEventListener("click", async () => {
      const files = [...(fileInput.files || [])];
      if (!files.length) return new Notice("회의록 Markdown 파일을 선택해 주세요.");
      submit.disabled = true;
      submit.setText("회의록 만드는 중…");
      try {
        const selectedTicketIds = [...this.selectedTicketIds];
        const note = await this.plugin.importMeetingFiles(selectedTicketIds, files, {
          title: titleInput.value.trim(), meetingDate: dateInput.value
        });
        this.close();
        if (typeof this.onImported === "function") await this.onImported(note);
        await this.app.workspace.getLeaf(false).openFile(note);
        new Notice(`${selectedTicketIds.length ? `티켓 ${selectedTicketIds.length}개에 연결된` : "티켓 없는"} 회의록을 만들었습니다.`);
      } catch (error) {
        new Notice(`회의록 생성 실패: ${error.message || error}`, 9000);
        submit.disabled = false;
        submit.setText("회의록 만들기");
      }
    });
  }
  onClose() {
    this.modalEl.removeClass("clt-meeting-import-modal");
    this.contentEl.empty();
  }
}

class DriveMeetingCandidateModal extends Modal {
  constructor(app, plugin, ticketId, onImported = null, multiTicketMode = false) {
    super(app);
    this.plugin = plugin;
    this.ticketId = normalizeTicketId(ticketId);
    this.onImported = onImported;
    this.selectedIds = new Set();
    this.selectedTicketIds = new Set(this.ticketId ? [this.ticketId] : []);
    this.multiTicketMode = multiTicketMode;
  }

  async onOpen() {
    this.modalEl.addClass("clt-meeting-drive-modal");
    this.titleEl.setText(this.multiTicketMode ? "복수 티켓 Google Drive 회의록 가져오기" : `${this.ticketId} Google Drive 회의록 가져오기`);
    this.contentEl.createDiv({
      cls: "clt-meeting-import-lead",
      text: `먼저 가져올 회의록을 선택한 뒤 관련 티켓을 선택합니다. 자동 검색은 '${this.ticketId}'와 'Gemini가 작성한 회의록'이 모두 포함된 Google Docs를 찾습니다.`
    });
    const searchBar = this.contentEl.createDiv({ cls: "clt-meeting-drive-search" });
    const searchInput = searchBar.createEl("input", { type: "search", placeholder: "Google Drive 파일 제목 직접 검색" });
    const searchButton = searchBar.createEl("button", { text: "직접 검색" });
    const resetButton = searchBar.createEl("button", { text: "자동 검색" });
    this.resultsEl = this.contentEl.createDiv({ cls: "clt-meeting-drive-results" });
    const runSearch = async (query = "") => {
      this.selectedIds.clear();
      this.resultsEl.empty();
      const loading = this.resultsEl.createDiv({ cls: "clt-meeting-empty", text: query ? `'${query}' 검색 중…` : "Google Drive에서 회의록을 찾는 중…" });
      searchButton.disabled = true;
      resetButton.disabled = true;
      try {
        const candidates = await this.plugin.searchGoogleDriveMeetingDocuments(this.ticketId, query);
        loading.remove();
        this.renderCandidates(candidates, Boolean(query));
      } catch (error) {
        console.error(`[ServiceNow Manage] ${this.ticketId} Drive 회의록 후보 표시 실패`, error);
        loading.setText(`회의록 검색 실패: ${error.message || error}`);
      } finally {
        searchButton.disabled = false;
        resetButton.disabled = false;
      }
    };
    searchButton.addEventListener("click", () => {
      const query = searchInput.value.trim();
      if (!query) return new Notice("검색할 Google Drive 파일 제목을 입력해 주세요.");
      void runSearch(query);
    });
    resetButton.addEventListener("click", () => { searchInput.value = ""; void runSearch(); });
    searchInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); searchButton.click(); } });
    try {
      await runSearch();
    } catch (error) {
      console.error(`[ServiceNow Manage] ${this.ticketId} Drive 회의록 후보 표시 실패`, error);
    }
  }

  renderCandidates(candidates, manualSearch = false) {
    const imported = new Set(this.plugin.listTicketMeetings(this.ticketId).map((meeting) => meeting.sourceDriveId).filter(Boolean));
    const list = this.resultsEl.createDiv({ cls: "clt-meeting-drive-candidates" });
    if (!candidates.length) {
      list.createDiv({ cls: "clt-meeting-empty", text: manualSearch ? "입력한 제목과 일치하는 Google Docs를 찾지 못했습니다." : "조건에 맞는 Gemini 회의록을 찾지 못했습니다." });
    }
    const linkedTickets = this.resultsEl.createDiv({ cls: "clt-meeting-ticket-picker is-hidden" });
    const linkedHeading = linkedTickets.createDiv({ cls: "clt-meeting-ticket-picker-heading" });
    linkedHeading.createEl("strong", { text: "2. 관련 티켓 선택" });
    const linkedCount = linkedHeading.createSpan();
    const linkedSearch = linkedTickets.createEl("input", { type: "search", placeholder: "추가로 연결할 CR/SR 검색" });
    const linkedOptions = linkedTickets.createDiv({ cls: "clt-meeting-ticket-options" });
    const allTicketIds = this.plugin.rootTicketFiles().map((file) => this.plugin.rootTicketIdFromFile(file)).filter(Boolean).sort();
    const updateLinkedSummary = () => linkedCount.setText(this.selectedTicketIds.size ? `${this.selectedTicketIds.size}개 선택` : "티켓 없이 등록");
    const renderLinkedOptions = () => {
      linkedOptions.empty();
      const needle = linkedSearch.value.trim().toUpperCase();
      allTicketIds.filter((id) => !needle || id.includes(needle)).forEach((ticketId) => {
        const option = linkedOptions.createEl("label", { cls: "clt-meeting-ticket-option" });
        const checkbox = option.createEl("input", { type: "checkbox" });
        checkbox.checked = this.selectedTicketIds.has(ticketId);
        option.createSpan({ text: ticketId });
        checkbox.addEventListener("change", () => {
          checkbox.checked ? this.selectedTicketIds.add(ticketId) : this.selectedTicketIds.delete(ticketId);
          updateLinkedSummary();
        });
      });
    };
    linkedSearch.addEventListener("input", renderLinkedOptions);
    updateLinkedSummary();
    renderLinkedOptions();
    const updateStep = () => this.selectedIds.size ? linkedTickets.removeClass("is-hidden") : linkedTickets.addClass("is-hidden");
    list.createDiv({ cls: "clt-meeting-step-label", text: "1. 가져올 회의록 선택" });
    for (const candidate of candidates) {
      const row = list.createEl("label", { cls: `clt-meeting-drive-candidate${imported.has(candidate.id) ? " is-imported" : ""}` });
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.disabled = imported.has(candidate.id);
      const body = row.createSpan({ cls: "clt-meeting-drive-candidate-body" });
      const heading = body.createSpan({ cls: "clt-meeting-drive-candidate-heading" });
      heading.createSpan({ cls: "clt-meeting-drive-candidate-name", text: String(candidate.name || "이름 없는 Google Docs") });
      if (imported.has(candidate.id)) heading.createSpan({ cls: "clt-meeting-type-badge is-imported", text: "추가됨" });
      body.createSpan({
        cls: "clt-meeting-drive-candidate-meta",
        text: `회의 일시 ${String(candidate.meetingDate || "확인 불가").replace("T", " ")} · 수정 ${candidate.modifiedTime || "확인 불가"}${candidate.owner ? ` · ${candidate.owner}` : ""}`
      });
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selectedIds.add(candidate.id);
        else this.selectedIds.delete(candidate.id);
        updateStep();
      });
      row.dataset.candidateId = candidate.id;
    }
    const actions = this.resultsEl.createDiv({ cls: "clt-sn-document-actions" });
    const cancel = actions.createEl("button", { text: "취소" });
    cancel.addEventListener("click", () => this.close());
    const submit = actions.createEl("button", { text: "선택한 회의록 추가", cls: "mod-cta" });
    submit.addEventListener("click", async () => {
      const selected = candidates.filter((candidate) => this.selectedIds.has(candidate.id));
      if (!selected.length) return new Notice("추가할 회의록을 선택해 주세요.");
      submit.disabled = true;
      submit.setText("회의록 가져오는 중…");
      try {
        let importedCount = 0;
        const warnings = [];
        for (const candidate of selected) {
          const result = await this.plugin.importGoogleDriveMeeting([...this.selectedTicketIds], candidate);
          if (result?.note) importedCount += 1;
          warnings.push(...(result?.warnings || []));
        }
        if (typeof this.onImported === "function") await this.onImported();
        this.close();
        new Notice(`티켓 ${this.selectedTicketIds.size}개에 회의록 ${importedCount}건을 추가했습니다.${warnings.length ? `\n${warnings.join("\n")}` : ""}`, 9000);
      } catch (error) {
        new Notice(`회의록 가져오기 실패: ${error.message || error}`, 9000);
        submit.disabled = false;
        submit.setText("선택한 회의록 추가");
      }
    });
  }

  onClose() {
    this.modalEl.removeClass("clt-meeting-drive-modal");
    this.contentEl.empty();
  }
}

class GlobalDriveMeetingTicketModal extends Modal {
  constructor(app, plugin, onImported = null) {
    super(app);
    this.plugin = plugin;
    this.onImported = onImported;
  }
  onOpen() {
    this.titleEl.setText("Drive 회의록을 가져올 티켓 선택");
    this.contentEl.createDiv({ cls: "clt-meeting-import-lead", text: "Drive 검색은 회의 제목의 티켓 번호를 기준으로 하므로 연결할 CR/SR을 먼저 선택해 주세요." });
    const select = this.contentEl.createEl("select");
    select.style.width = "100%";
    this.plugin.rootTicketFiles().map((file) => this.plugin.rootTicketIdFromFile(file)).filter(Boolean).sort().forEach((ticketId) => {
      select.createEl("option", { value: ticketId, text: ticketId });
    });
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    actions.createEl("button", { text: "취소" }).addEventListener("click", () => this.close());
    const openSearch = (multiTicketMode) => {
      const ticketId = normalizeTicketId(select.value);
      if (!ticketId) return new Notice("티켓을 선택해 주세요.");
      this.close();
      new DriveMeetingCandidateModal(this.app, this.plugin, ticketId, this.onImported, multiTicketMode).open();
    };
    const next = actions.createEl("button", { text: "단일 티켓 검색" });
    next.addEventListener("click", () => openSearch(false));
    const multi = actions.createEl("button", { text: "복수 티켓 선택하기", cls: "mod-cta" });
    multi.addEventListener("click", () => openSearch(true));
  }
  onClose() { this.contentEl.empty(); }
}

class MeetingAnalysisPromptModal extends Modal {
  constructor(app, plugin, ticketId) {
    super(app);
    this.plugin = plugin;
    this.ticketId = normalizeTicketId(ticketId);
  }

  onOpen() {
    this.modalEl.addClass("clt-meeting-analysis-modal");
    this.titleEl.setText(`${this.ticketId} AI 회의록 분석`);
    const allMeetings = this.plugin.listTicketMeetings(this.ticketId, "asc");
    const meetings = allMeetings.filter((meeting) => meeting.kind !== "analysis");
    const baseline = this.plugin.latestMeetingAnalysis(this.ticketId);
    let useBaseline = Boolean(baseline);
    this.contentEl.createDiv({
      cls: "clt-meeting-import-lead",
      text: "분석에 포함할 회의록을 선택하세요. 기본적으로 전체 회의록이 선택됩니다."
    });
    const list = this.contentEl.createDiv({ cls: "clt-meeting-analysis-picker" });
    const selectedPaths = new Set(meetings.map((meeting) => meeting.file.path));
    for (const meeting of meetings) {
      const row = list.createEl("label", { cls: "clt-meeting-analysis-option" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = true;
      const body = row.createSpan({ cls: "clt-meeting-drive-candidate-body" });
      const name = body.createSpan({ cls: "clt-meeting-drive-candidate-name", text: meeting.title });
      if (baseline && this.plugin.meetingCoveredByAnalysis(meeting, baseline)) {
        name.createSpan({ cls: "clt-meeting-type-badge is-analysis", text: "이미 분석됨" });
      }
      body.createSpan({ cls: "clt-meeting-drive-candidate-meta", text: String(meeting.meetingDate || "일시 미지정").replace("T", " ") });
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedPaths.add(meeting.file.path);
        else selectedPaths.delete(meeting.file.path);
      });
    }
    if (!meetings.length) list.createDiv({ cls: "clt-meeting-empty", text: "분석할 Gemini 회의록이 없습니다." });
    if (baseline) {
      const reuse = this.contentEl.createEl("label", { cls: "clt-meeting-analysis-reuse" });
      const checkbox = reuse.createEl("input", { type: "checkbox" });
      checkbox.checked = true;
      reuse.createSpan({ text: "기존 분석 자료를 기준으로 새 회의만 이어서 분석" });
      checkbox.addEventListener("change", () => { useBaseline = checkbox.checked; });
      this.contentEl.createDiv({
        cls: "clt-meeting-analysis-hint",
        text: "이미 분석된 회의록은 기존 분석 자료를 바탕으로 합니다. 이 옵션을 해제하면 선택한 원본 회의록 전체를 처음부터 다시 분석합니다."
      });
    }
    const details = this.contentEl.createEl("details", { cls: "clt-ai-prompt-details" });
    details.hidden = true;
    details.createEl("summary", { text: "AI 회의록 분석 프롬프트 펼치기" });
    const toolbar = details.createDiv({ cls: "clt-ai-prompt-toolbar" });
    const copy = toolbar.createEl("button", { text: "프롬프트 복사" });
    const content = details.createEl("pre", { cls: "clt-ai-prompt-content clt-meeting-analysis-prompt" });
    let prompt = "";
    copy.addEventListener("click", async () => {
      if (!prompt) return;
      await navigator.clipboard.writeText(prompt);
      new Notice("AI 회의록 분석 프롬프트를 복사했습니다.");
    });
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    const close = actions.createEl("button", { text: "닫기" });
    close.addEventListener("click", () => this.close());
    const generate = actions.createEl("button", { text: "프롬프트 생성", cls: "mod-cta" });
    generate.disabled = !meetings.length;
    generate.addEventListener("click", async () => {
      const selected = meetings.filter((meeting) => selectedPaths.has(meeting.file.path));
      if (!selected.length) return new Notice("분석할 회의록을 하나 이상 선택해 주세요.");
      generate.disabled = true;
      generate.setText("프롬프트 생성 중…");
      try {
        prompt = await this.plugin.generateMeetingAnalysisPrompt(this.ticketId, selected, { useBaseline });
        content.setText(prompt);
        details.hidden = false;
        details.open = true;
      } catch (error) {
        new Notice(`AI 회의록 분석 프롬프트 생성 실패: ${error.message || error}`, 9000);
      } finally {
        generate.disabled = false;
        generate.setText("프롬프트 생성");
      }
    });
  }

  onClose() {
    this.modalEl.removeClass("clt-meeting-analysis-modal");
    this.contentEl.empty();
  }
}

function extractMeetingActionItems(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,6}\s+(?:\d+[.)]\s*)?(?:Action Items|할\s*일|액션\s*아이템)/i.test(line.trim()));
  if (start < 0) return [];
  const level = (lines[start].match(/^(#+)/)?.[1] || "##").length;
  const section = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})\s+/);
    if (heading && heading[1].length <= level) break;
    section.push(lines[index]);
  }
  const clean = (value) => String(value || "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_all, target, label) => label || target)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`]/g, "")
    .trim();
  const items = [];
  const tableLines = section.filter((line) => /^\s*\|.*\|\s*$/.test(line));
  if (tableLines.length >= 2) {
    const rows = tableLines.map((line) => line.trim().slice(1, -1).split("|").map(clean));
    const headers = rows[0].map((value) => value.toLowerCase());
    const actionIndex = Math.max(0, headers.findIndex((value) => /할\s*일|action|task|내용/.test(value)));
    const ownerIndex = headers.findIndex((value) => /담당|owner|assignee/.test(value));
    const dueIndex = headers.findIndex((value) => /목표|기한|due|date/.test(value));
    for (const row of rows.slice(2)) {
      const title = clean(row[actionIndex]);
      if (!title || /^[-: ]+$/.test(title)) continue;
      items.push({ title, owner: ownerIndex >= 0 ? clean(row[ownerIndex]) : "", dueDate: dueIndex >= 0 ? clean(row[dueIndex]).match(/\d{4}-\d{2}-\d{2}/)?.[0] || "" : "" });
    }
  }
  if (!items.length) {
    for (const line of section) {
      const match = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?(.+?)\s*$/);
      if (match) items.push({ title: clean(match[1]), owner: "", dueDate: "" });
    }
  }
  return items.filter((item) => item.title);
}

class MeetingActionItemsModal extends Modal {
  constructor(app, plugin, ticketId, items) {
    super(app);
    this.plugin = plugin;
    this.ticketId = normalizeTicketId(ticketId);
    this.items = items;
  }

  onOpen() {
    this.modalEl.addClass("clt-meeting-action-modal");
    this.titleEl.setText(`${this.ticketId} Action Items를 To-Do로 만들기`);
    this.contentEl.createDiv({ cls: "clt-meeting-import-lead", text: "생성할 항목을 선택하고 목표일을 조정하세요. 모든 To-Do는 진행 전으로 등록됩니다." });
    const today = localIsoDateTime().slice(0, 10);
    const rows = this.items.map((item) => ({ ...item, selected: true, dueDate: item.dueDate || today }));
    const toolbar = this.contentEl.createDiv({ cls: "clt-meeting-action-toolbar" });
    const toggleAll = toolbar.createEl("input", { type: "checkbox", attr: { "aria-label": "전체 선택" } });
    toggleAll.checked = true;
    toolbar.createSpan({ text: "전체 선택" });
    const list = this.contentEl.createDiv({ cls: "clt-meeting-action-list" });
    const checkboxes = [];
    rows.forEach((item) => {
      const row = list.createDiv({ cls: "clt-meeting-action-row" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = true;
      checkboxes.push(checkbox);
      const body = row.createDiv({ cls: "clt-meeting-action-body" });
      body.createDiv({ cls: "clt-meeting-action-title", text: item.title });
      if (item.owner) body.createDiv({ cls: "clt-meeting-action-owner", text: `담당: ${item.owner}` });
      const date = row.createEl("input", { type: "date", attr: { "aria-label": `${item.title} 목표일` } });
      date.value = item.dueDate;
      checkbox.addEventListener("change", () => {
        item.selected = checkbox.checked;
        toggleAll.checked = checkboxes.every((box) => box.checked);
        toggleAll.indeterminate = !toggleAll.checked && checkboxes.some((box) => box.checked);
      });
      date.addEventListener("change", () => { item.dueDate = date.value || today; });
    });
    toggleAll.addEventListener("change", () => {
      rows.forEach((item, index) => { item.selected = toggleAll.checked; checkboxes[index].checked = toggleAll.checked; });
      toggleAll.indeterminate = false;
    });
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    actions.createEl("button", { text: "취소" }).addEventListener("click", () => this.close());
    const create = actions.createEl("button", { text: "일괄 생성", cls: "mod-cta" });
    create.addEventListener("click", async () => {
      const selected = rows.filter((item) => item.selected);
      if (!selected.length) return new Notice("생성할 Action Item을 선택해 주세요.");
      create.disabled = true;
      create.setText("생성 중…");
      try {
        const initialState = this.plugin.getTodoWorkflow().find(state => state.enabled);
        for (const item of selected) {
          const details = item.owner ? `회의 Action Item · 담당: ${item.owner}` : "회의 Action Item";
          await this.plugin.addTodoToTicket(this.ticketId, item.title, item.dueDate || today, initialState.key, details);
        }
        new Notice(`${this.ticketId}에 ${initialState.label} To-Do ${selected.length}건을 만들었습니다.`);
        this.close();
      } catch (error) {
        new Notice(`Action Items 일괄 생성 실패: ${error.message || error}`, 9000);
        create.disabled = false;
        create.setText("일괄 생성");
      }
    });
  }

  onClose() {
    this.modalEl.removeClass("clt-meeting-action-modal");
    this.contentEl.empty();
  }
}

class MeetingListModal extends Modal {
  constructor(app, plugin, ticketId) {
    super(app);
    this.plugin = plugin;
    this.ticketId = normalizeTicketId(ticketId);
    this.sortDirection = "desc";
    this.selectedKinds = new Set(["gemini", "analysis"]);
    this.eventRefs = [];
  }
  async onOpen() {
    this.modalEl.addClass("clt-meeting-list-modal");
    this.titleEl.setText(`${this.ticketId} 회의록`);
    await this.render();
    const refreshIfRelevant = (file, oldPath = "") => {
      if (!this.plugin.isMeetingFileRelevantToTicket(file, this.ticketId, oldPath)) return;
      window.setTimeout(() => this.render(), 120);
    };
    this.eventRefs = [
      [this.app.vault, this.app.vault.on("create", refreshIfRelevant)],
      [this.app.vault, this.app.vault.on("delete", refreshIfRelevant)],
      [this.app.vault, this.app.vault.on("rename", refreshIfRelevant)],
      [this.app.vault, this.app.vault.on("modify", refreshIfRelevant)],
      [this.app.metadataCache, this.app.metadataCache.on("changed", refreshIfRelevant)]
    ];
  }
  async render() {
    this.contentEl.empty();
    const toolbar = this.contentEl.createDiv({ cls: "clt-meeting-list-toolbar" });
    const count = toolbar.createDiv({ cls: "clt-meeting-list-count" });
    const actions = toolbar.createDiv({ cls: "clt-meeting-list-actions" });
    const sort = actions.createEl("button", { text: this.sortDirection === "desc" ? "최신순 ↓" : "오래된순 ↑" });
    sort.addEventListener("click", async () => {
      this.sortDirection = this.sortDirection === "desc" ? "asc" : "desc";
      await this.render();
    });
    const filter = actions.createEl("details", { cls: "clt-meeting-label-filter" });
    filter.createEl("summary", { text: "라벨 필터" });
    const filterMenu = filter.createDiv({ cls: "clt-meeting-label-filter-menu" });
    [["gemini", "Gemini 회의록"], ["analysis", "AI 회의록 분석"]].forEach(([kind, label]) => {
      const option = filterMenu.createEl("label");
      const checkbox = option.createEl("input", { type: "checkbox" });
      checkbox.checked = this.selectedKinds.has(kind);
      option.createSpan({ text: label });
      checkbox.addEventListener("change", () => {
        checkbox.checked ? this.selectedKinds.add(kind) : this.selectedKinds.delete(kind);
        void this.render();
      });
    });
    const drive = actions.createEl("button", { text: "Drive에서 가져오기" });
    drive.addEventListener("click", () => new DriveMeetingCandidateModal(this.app, this.plugin, this.ticketId, () => this.render()).open());
    const refresh = actions.createEl("button", { text: "새로고침", attr: { title: "회의록 목록 새로고침" } });
    refresh.addEventListener("click", () => this.render());
    const add = actions.createEl("button", { text: "＋ 파일로 추가", cls: "mod-cta" });
    add.addEventListener("click", () => new MeetingImportModal(this.app, this.plugin, this.ticketId, () => this.render()).open());
    const list = this.contentEl.createDiv({ cls: "clt-meeting-list" });
    const allMeetings = this.plugin.listTicketMeetings(this.ticketId, this.sortDirection);
    const meetings = allMeetings.filter((meeting) => this.selectedKinds.has(meeting.kind));
    count.setText(`${meetings.length}개의 회의 기록${meetings.length !== allMeetings.length ? ` · 전체 ${allMeetings.length}개` : ""}`);
    list.dataset.sortDirection = this.sortDirection;
    list.addEventListener("clt-meeting-deleted", () => this.render());
    this.plugin.renderMeetingCards(list, meetings, {
      emptyText: allMeetings.length
        ? "선택한 라벨에 해당하는 회의록이 없습니다. 라벨 필터를 변경해 주세요."
        : "아직 등록된 회의록이 없습니다. 위의 'Drive에서 가져오기' 또는 '＋ 파일로 추가'로 첫 회의록을 등록할 수 있습니다."
    });
  }
  onClose() {
    this.eventRefs.forEach(([emitter, eventRef]) => emitter?.offref?.(eventRef));
    this.eventRefs = [];
    this.modalEl.removeClass("clt-meeting-list-modal");
    this.contentEl.empty();
  }
}

class TodoEntryModal extends Modal {
  constructor(app, plugin, preselectedTicketId = "", onSaved = null, preselectedStatus = "pending") {
    super(app);
    this.plugin = plugin;
    this.preselectedTicketId = normalizeTicketId(preselectedTicketId);
    this.onSaved = onSaved;
    this.preselectedStatus = ["pending", "in-progress", "waiting", "done"].includes(preselectedStatus)
      ? preselectedStatus
      : "pending";
    this.selectedTicketId = "";
  }

  onOpen() {
    this.contentEl.empty();
    this.modalEl.addClass("clt-todo-entry-modal");
    this.titleEl.setText("☑ 새 To-Do 추가");

    const tickets = this.plugin.rootTicketFiles()
      .map((file) => {
        const ticketId = this.plugin.rootTicketIdFromFile(file);
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
        const ticket = this.plugin.data.tickets[ticketId] || {};
        return {
          ticketId,
          file,
          status: String(frontmatter.status || ticket.state || ""),
          title: String(ticket.shortDescription || frontmatter["Short Description"] || "")
        };
      })
      .filter((item) => item.ticketId)
      .sort((left, right) => left.ticketId.localeCompare(right.ticketId, "ko", { numeric: true }));

    if (tickets.some((item) => item.ticketId === this.preselectedTicketId)) {
      this.selectedTicketId = this.preselectedTicketId;
    }

    const ticketSection = this.contentEl.createDiv({ cls: "clt-todo-ticket-picker" });
    const ticketHeaderRow = ticketSection.createDiv({ cls: "clt-todo-ticket-header-row" });
    const ticketHeaderLabel = ticketHeaderRow.createDiv({ cls: "clt-todo-field-label", text: "티켓 · 필수" });
    const noTicketLabel = ticketHeaderRow.createEl("label", { cls: "clt-todo-no-ticket-toggle" });
    const noTicketCheckbox = noTicketLabel.createEl("input", { type: "checkbox" });
    noTicketLabel.createSpan({ text: "티켓 선택 안 함" });

    const search = ticketSection.createEl("input", {
      type: "search",
      cls: "clt-todo-ticket-search",
      placeholder: "티켓 번호 또는 제목 검색 · 예: 12"
    });
    if (this.selectedTicketId) search.value = this.selectedTicketId;
    const resultInfo = ticketSection.createDiv({ cls: "clt-todo-ticket-result-info" });
    const results = ticketSection.createDiv({ cls: "clt-todo-ticket-results" });

    const renderTickets = () => {
      if (noTicketCheckbox.checked) {
        ticketSection.addClass("is-disabled");
        ticketHeaderLabel.setText("티켓 · 선택 안 함");
        search.disabled = true;
        results.style.display = "none";
        resultInfo.setText("연결된 티켓 없이 일반 To-Do로 등록됩니다.");
        return;
      }
      ticketSection.removeClass("is-disabled");
      ticketHeaderLabel.setText("티켓 · 필수");
      search.disabled = false;
      results.style.display = "";
      const query = search.value.trim().toLowerCase();
      const filtered = tickets.filter((item) =>
        !query || [item.ticketId, item.title, item.status]
          .some((value) => String(value || "").toLowerCase().includes(query))
      );
      if (filtered.length === 1 && !this.selectedTicketId) this.selectedTicketId = filtered[0].ticketId;
      else if (!filtered.some((item) => item.ticketId === this.selectedTicketId)) this.selectedTicketId = "";
      results.empty();
      resultInfo.setText(`${filtered.length}개 티켓${this.selectedTicketId ? ` · ${this.selectedTicketId} 선택됨` : ""}`);
      if (!filtered.length) {
        results.createDiv({ cls: "clt-todo-ticket-empty", text: "검색되는 티켓이 없습니다." });
        return;
      }
      filtered.forEach((item) => {
        const button = results.createEl("button", { cls: "clt-todo-ticket-option" });
        if (item.ticketId === this.selectedTicketId) button.addClass("selected");
        const heading = button.createDiv({ cls: "clt-todo-ticket-option-heading" });
        heading.createSpan({ cls: "clt-todo-ticket-option-id", text: item.ticketId });
        if (item.status) heading.createSpan({ cls: "clt-todo-ticket-option-status", text: item.status });
        if (item.title) button.createDiv({ cls: "clt-todo-ticket-option-title", text: item.title });
        button.addEventListener("click", (event) => {
          event.preventDefault();
          this.selectedTicketId = item.ticketId;
          renderTickets();
        });
      });
    };
    noTicketCheckbox.addEventListener("change", () => {
      if (noTicketCheckbox.checked) this.selectedTicketId = "";
      renderTickets();
    });
    search.addEventListener("input", renderTickets);
    renderTickets();

    const form = this.contentEl.createDiv({ cls: "clt-todo-entry-form" });
    const contentLabel = form.createEl("label", { cls: "clt-todo-entry-field" });
    contentLabel.createSpan({ cls: "clt-todo-field-label", text: "제목 · 필수" });
    const content = contentLabel.createEl("textarea", {
      cls: "clt-ticket-entry-input",
      placeholder: "할 일의 제목을 입력하세요."
    });
    const detailLabel = form.createEl("label", { cls: "clt-todo-entry-field" });
    detailLabel.createSpan({ cls: "clt-todo-field-label", text: "상세 내용 · 선택" });
    const detail = createRichMarkdownEditor(this.app, this, detailLabel, "", "", "배경, 확인할 내용, 참고 링크 등을 입력하세요.");
    const resultLabel = form.createEl("label", { cls: "clt-todo-entry-field" });
    resultLabel.createSpan({ cls: "clt-todo-field-label", text: "처리 내용 · 선택" });
    const result = createRichMarkdownEditor(this.app, this, resultLabel, "", "", "실제로 처리한 내용이나 결과를 입력하세요.");
    const row = form.createDiv({ cls: "clt-todo-entry-row" });
    const dueLabel = row.createEl("label", { cls: "clt-todo-entry-field" });
    dueLabel.createSpan({ cls: "clt-todo-field-label", text: "완료 예정일 · 선택" });
    const dueFields = dueLabel.createDiv({ cls: "clt-todo-due-fields" });
    const dueDate = dueFields.createEl("input", { type: "date", attr: { "aria-label": "완료 예정일" } });
    const dueTime = dueFields.createEl("input", { type: "time", attr: { "aria-label": "완료 예정 시각" } });
    dueTime.disabled = true;
    dueDate.addEventListener("change", () => {
      dueTime.disabled = !dueDate.value;
      if (dueDate.value && !dueTime.value) dueTime.value = localIsoDateTime().slice(11, 16);
      if (!dueDate.value) dueTime.value = "";
    });
    const statusLabel = row.createEl("label", { cls: "clt-todo-entry-field" });
    statusLabel.createSpan({ cls: "clt-todo-field-label", text: "시작 상태" });
    const status = statusLabel.createEl("select");
    fillTodoStatusSelect(status, this.plugin, this.preselectedStatus);
    this.workflowRef = this.app.workspace?.on?.("servicenow-manage:todo-workflow-changed", () => {
      fillTodoStatusSelect(status, this.plugin, status.value);
      status.dispatchEvent(new Event("change"));
    });

    const waitingEditor = createTodoWaitingEditor(form, status);
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    const cancel = actions.createEl("button", { text: "취소" });
    cancel.addEventListener("click", () => this.close());
    const add = actions.createEl("button", { text: "To-Do 추가", cls: "mod-cta" });
    const submit = async () => {
      const isStandalone = noTicketCheckbox.checked || !this.selectedTicketId;
      if (!isStandalone && !this.selectedTicketId) {
        search.focus();
        return new Notice("티켓을 선택하거나 '티켓 선택 안 함'을 체크해 주세요.");
      }
      if (!content.value.trim()) {
        content.focus();
        return new Notice("할 일을 입력해 주세요.");
      }
      add.disabled = true;
      add.setText("추가 중…");
      try {
        if (isStandalone) {
          await this.plugin.addTodoToGeneral(
            content.value,
            composeTodoDueValue(dueDate.value, dueTime.value),
            status.value,
            detail.value,
            result.value,
            waitingEditor.values()
          );
          if (typeof this.onSaved === "function") await this.onSaved("");
          new Notice("To-Do를 추가했습니다.");
        } else {
          await this.plugin.addTodoToTicket(
            this.selectedTicketId,
            content.value,
            composeTodoDueValue(dueDate.value, dueTime.value),
            status.value,
            detail.value,
            result.value,
            waitingEditor.values()
          );
          if (typeof this.onSaved === "function") await this.onSaved(this.selectedTicketId);
          new Notice(`${this.selectedTicketId}에 To-Do를 추가했습니다.`);
        }
        this.close();
      } catch (error) {
        new Notice(`To-Do 추가 실패: ${error.message || error}`, 9000);
        add.disabled = false;
        add.setText("To-Do 추가");
      }
    };
    add.addEventListener("click", submit);
    content.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") submit();
    });
    window.setTimeout(() => this.preselectedTicketId ? content.focus() : search.focus(), 50);
  }

  onClose() {
    this.modalEl.removeClass("clt-todo-entry-modal");
    if (this.workflowRef) this.app.workspace.offref(this.workflowRef);
    this.contentEl.empty();
  }
}

function readTodoWaiting(raw) {
  const encoded = String(raw || "").match(/<!--\s*clt-todo-wait:([^>]*)\s*-->/i)?.[1]?.trim();
  try {
    const value = JSON.parse(decodeURIComponent(encoded || "%7B%7D"));
    return { waitingReason: String(value.reason || ""), followUpDate: String(value.followUp || ""),
      waitingSince: String(value.since || "") };
  } catch (_) { return { waitingReason: "", followUpDate: "", waitingSince: "" }; }
}

function todoWaitingChanges(task, changes, status, now) {
  return {
    waitingReason: String(changes.waitingReason ?? task.waitingReason ?? "").trim(),
    followUpDate: String(changes.followUpDate ?? task.followUpDate ?? "").trim(),
    waitingSince: status === "waiting" && (task.status !== "waiting" || !task.waitingSince)
      ? now : String(task.waitingSince || "")
  };
}

function todoWaitingMarker(value) {
  if (!value.waitingReason && !value.followUpDate && !value.waitingSince) return "";
  return ` <!-- clt-todo-wait:${encodeURIComponent(JSON.stringify({
    reason: value.waitingReason || "", followUp: value.followUpDate || "", since: value.waitingSince || ""
  }))} -->`;
}

function todoFollowUpInfo(task, now = new Date()) {
  if (task.status !== "waiting" || !task.followUpDate) return null;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return { needsFollowUp: task.followUpDate <= today,
    label: `${task.followUpDate <= today ? "확인 필요" : "다음 확인"} · ${task.followUpDate}` };
}

function renderTodoWaitingInfo(container, task) {
  if (task.status !== "waiting") return;
  const panel = document.createElement("div");
  panel.className = "snm-todo-waiting-info";
  const info = todoFollowUpInfo(task);
  if (info?.needsFollowUp) panel.classList.add("needs-follow-up");
  const reason = document.createElement("div");
  reason.className = "snm-todo-waiting-reason";
  reason.textContent = `⏸ ${task.waitingReason || "대기 사유를 추가해 주세요."}`;
  panel.appendChild(reason);
  const meta = document.createElement("div");
  meta.className = "snm-todo-waiting-meta";
  const since = String(task.waitingSince || "").slice(0, 10);
  meta.textContent = [since ? `대기 시작 ${since}` : "", info?.label || "다음 확인일 미지정"].filter(Boolean).join(" · ");
  panel.appendChild(meta);
  container.appendChild(panel);
}

function createTodoWaitingEditor(container, statusSelect, task = {}) {
  const panel = document.createElement("div");
  panel.className = "snm-todo-waiting-editor";
  const reasonLabel = document.createElement("label");
  reasonLabel.textContent = "대기 사유 · 선택";
  const reason = document.createElement("textarea");
  reason.placeholder = "예: CLV 답변 대기 / 고객 승인 대기";
  reason.value = task.waitingReason || "";
  reasonLabel.appendChild(reason);
  const dateLabel = document.createElement("label");
  dateLabel.textContent = "다음 확인일 · 선택 (완료 예정일과 별도)";
  const date = document.createElement("input");
  date.type = "date";
  date.value = task.followUpDate || "";
  dateLabel.appendChild(date);
  const note = document.createElement("small");
  note.textContent = "확인일이 오면 ‘확인 필요’로 표시합니다. 진행 재개는 사용자가 상태를 변경합니다.";
  panel.append(reasonLabel, dateLabel, note);
  container.appendChild(panel);
  const toggle = () => { panel.hidden = statusSelect.value !== "waiting"; };
  statusSelect.addEventListener("change", toggle);
  toggle();
  return { values: () => ({ waitingReason: reason.value, followUpDate: date.value }) };
}

function stripCltTodoMetadata(value) {
  return String(value || "")
    .replace(/\s*<!--\s*clt-todo:(?:pending|in-progress|waiting|done)\s*-->\s*/gi, " ")
    .replace(/\s*<!--\s*clt-todo-due:\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?\s*-->\s*/gi, " ")
    .replace(/\s*<!--\s*clt-todo-completed:[^>]+?\s*-->\s*/gi, " ")
    .replace(/\s*<!--\s*clt-todo-detail:[^>]*?\s*-->\s*/gi, " ")
    .replace(/\s*<!--\s*clt-todo-result:[^>]*?\s*-->\s*/gi, " ")
    .replace(/\s*<!--\s*clt-todo-wait:[^>]*?\s*-->\s*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function encodeTodoDetail(value) {
  return encodeURIComponent(String(value || "").trim());
}

function decodeTodoDetail(value) {
  try { return decodeURIComponent(String(value || "")); }
  catch (_) { return String(value || ""); }
}

function splitTodoDueValue(value) {
  const match = String(value || "").trim().match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?$/);
  return { date: match?.[1] || "", time: match?.[2] || "" };
}

function composeTodoDueValue(date, time) {
  const cleanDate = String(date || "").trim();
  const cleanTime = String(time || "").trim();
  return cleanDate ? `${cleanDate}${cleanTime ? `T${cleanTime}` : ""}` : "";
}

function formatTodoDueValue(value) {
  return String(value || "").replace("T", " ");
}

function todoVisualTone(task, nowValue = new Date()) {
  if (String(task?.status || "") === "done") return "done";
  const raw = String(task?.dueDate || "").trim();
  if (!raw) return "";
  const hasTime = raw.includes("T");
  const due = new Date(hasTime ? raw : `${raw}T23:59:59`);
  const now = new Date(nowValue);
  if (Number.isNaN(due.getTime()) || Number.isNaN(now.getTime())) return "";
  const remaining = due.getTime() - now.getTime();
  if (remaining < 0) return "overdue";
  if (remaining <= 86400000) return "urgent";
  if (remaining <= 259200000) return "soon";
  return "";
}

class ConfirmDeleteModal extends Modal {
  constructor(app, { ticketId, title, onConfirm }) {
    super(app);
    this.ticketId = ticketId;
    this.itemTitle = title;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    this.modalEl.addClass("clt-confirm-modal");
    this.titleEl.setText("To-Do 삭제");
    const panel = this.contentEl.createDiv({ cls: "clt-confirm-panel" });
    panel.createDiv({ cls: "clt-confirm-icon", text: "!" });
    const copy = panel.createDiv({ cls: "clt-confirm-copy" });
    copy.createEl("strong", { text: `${this.ticketId ? `${this.ticketId}의 ` : ""}To-Do를 삭제하시겠습니까?` });
    copy.createDiv({ cls: "clt-confirm-description", text: "삭제한 항목은 자동으로 복구되지 않습니다." });
    copy.createDiv({ cls: "clt-confirm-item", text: this.itemTitle || "(제목 없음)" });
    const actions = this.contentEl.createDiv({ cls: "clt-confirm-actions" });
    const cancel = actions.createEl("button", { text: "취소" });
    const confirm = actions.createEl("button", { text: "삭제", cls: "mod-warning" });
    cancel.addEventListener("click", () => this.close());
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      try {
        await this.onConfirm?.();
        this.close();
      } catch (error) {
        confirm.disabled = false;
        cancel.disabled = false;
        new Notice(`To-Do 삭제 실패: ${error.message || error}`, 9000);
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class TodoDetailEntryModal extends Modal {
  constructor(app, plugin, task, onSaved = null) {
    super(app);
    this.plugin = plugin;
    this.task = { ...task };
    this.onSaved = onSaved;
  }

  onOpen() {
    this.modalEl.addClass("clt-todo-detail-modal");
    this.render();
  }

  renderLinkedText(container, text) {
    container.empty();
    const value = String(text || "");
    const urlPattern = /https?:\/\/[^\s<>()]+/gi;
    let offset = 0;
    for (const match of value.matchAll(urlPattern)) {
      if (match.index > offset) container.appendText(value.slice(offset, match.index));
      const url = match[0].replace(/[.,;!?]+$/, "");
      const trailing = match[0].slice(url.length);
      const link = container.createEl("a", { text: url, href: url, cls: "clt-todo-detail-link" });
      link.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        shell.openExternal(url);
      });
      if (trailing) container.appendText(trailing);
      offset = match.index + match[0].length;
    }
    if (offset < value.length) container.appendText(value.slice(offset));
  }

  render() {
    this.contentEl.empty();
    this.titleEl.empty();
    const hasTicket = Boolean(this.task.ticketId);
    const title = this.titleEl.createSpan({ cls: "clt-todo-modal-title" });
    title.createSpan({ cls: "clt-todo-modal-icon", text: "✓" });
    title.createSpan({ text: hasTicket ? `${this.task.ticketId} To-Do` : "To-Do" });

    const layout = this.contentEl.createDiv({ cls: `clt-todo-detail-layout${hasTicket ? "" : " no-ticket"}` });

    if (hasTicket) {
      const context = layout.createEl("aside", { cls: "clt-todo-ticket-context" });
      const ticket = this.plugin.data.tickets?.[this.task.ticketId];
      context.createDiv({ cls: "clt-todo-context-label", text: "SHORT DESCRIPTION" });
      context.createEl("strong", {
        cls: "clt-todo-context-title",
        text: ticket?.shortDescription || "티켓 기본정보를 갱신하면 설명이 표시됩니다."
      });
      const statusLine = context.createDiv({ cls: "clt-todo-context-status" });
      statusLine.createSpan({ text: "ServiceNow 상태" });
      statusLine.createEl("strong", { text: ticket?.state || ticket?.status || "—" });
      if (ticket?.description) {
        const description = context.createEl("details", { cls: "clt-todo-context-details" });
        description.createEl("summary", { text: "Description 펼치기" });
        description.createEl("pre", { text: ticket.description });
      }
      const translatedShort = ticket?.translations?.shortDescription?.ko || "";
      const translatedDescription = ticket?.translations?.description?.ko || "";
      if (translatedShort || translatedDescription) {
        const translation = context.createEl("details", { cls: "clt-todo-context-details" });
        translation.createEl("summary", { text: "한국어 번역 펼치기" });
        translation.createEl("pre", { text: [translatedShort, translatedDescription].filter(Boolean).join("\n\n") });
      }
    }

    const editor = layout.createDiv({ cls: "clt-todo-detail-editor" });
    const form = editor.createDiv({ cls: "clt-todo-entry-form" });
    const contentLabel = form.createEl("label", { cls: "clt-todo-entry-field" });
    contentLabel.createSpan({ cls: "clt-todo-field-label", text: "제목" });
    const content = contentLabel.createEl("textarea", { cls: "clt-ticket-entry-input" });
    content.value = this.task.text || "";
    const detailLabel = form.createEl("label", { cls: "clt-todo-entry-field" });
    detailLabel.createSpan({ cls: "clt-todo-field-label", text: "상세 내용" });
    const detail = createRichMarkdownEditor(
      this.app,
      this,
      detailLabel,
      this.task.details || "",
      this.task.filePath || "",
      "배경, 확인할 내용, 참고 링크 등을 입력하세요."
    );
    const resultLabel = form.createEl("label", { cls: "clt-todo-entry-field" });
    resultLabel.createSpan({ cls: "clt-todo-field-label", text: "처리 내용" });
    const result = createRichMarkdownEditor(
      this.app,
      this,
      resultLabel,
      this.task.result || "",
      this.task.filePath || "",
      "실제로 처리한 내용이나 결과를 입력하세요."
    );
    const row = form.createDiv({ cls: "clt-todo-entry-row" });
    const statusLabel = row.createEl("label", { cls: "clt-todo-entry-field" });
    statusLabel.createSpan({ cls: "clt-todo-field-label", text: "상태" });
    const status = statusLabel.createEl("select");
    fillTodoStatusSelect(status, this.plugin, this.task.status, true);
    this.workflowRef = this.app.workspace?.on?.("servicenow-manage:todo-workflow-changed", () => {
      fillTodoStatusSelect(status, this.plugin, status.value, true);
      status.dispatchEvent(new Event("change"));
    });
    const dueLabel = row.createEl("label", { cls: "clt-todo-entry-field" });
    dueLabel.createSpan({ cls: "clt-todo-field-label", text: "완료 예정일" });
    const dueFields = dueLabel.createDiv({ cls: "clt-todo-due-fields" });
    const dueDate = dueFields.createEl("input", { type: "date", attr: { "aria-label": "완료 예정일" } });
    const dueTime = dueFields.createEl("input", { type: "time", attr: { "aria-label": "완료 예정 시각" } });
    const initialDue = splitTodoDueValue(this.task.dueDate);
    dueDate.value = initialDue.date;
    dueTime.value = initialDue.time;
    dueTime.disabled = !dueDate.value;
    dueDate.addEventListener("change", () => {
      dueTime.disabled = !dueDate.value;
      if (dueDate.value && !dueTime.value) dueTime.value = localIsoDateTime().slice(11, 16);
      if (!dueDate.value) dueTime.value = "";
    });

    const waitingEditor = createTodoWaitingEditor(form, status, this.task);
    renderTodoWaitingInfo(form, this.task);
    const readonly = editor.createDiv({ cls: "clt-todo-readonly-grid" });
    [["등록일", this.task.dateTime || "—"], ["완료일", this.task.completedAt || "—"]]
      .forEach(([label, value]) => {
        const item = readonly.createDiv({ cls: "clt-todo-readonly-item" });
        item.createSpan({ text: label });
        item.createEl("strong", { text: value });
      });

    const actions = editor.createDiv({ cls: "clt-sn-document-actions" });
    const remove = actions.createEl("button", { text: "삭제", cls: "mod-warning clt-todo-delete-button" });
    remove.addEventListener("click", () => {
      new ConfirmDeleteModal(this.app, {
        ticketId: this.task.ticketId || "",
        title: this.task.text || "",
        onConfirm: async () => {
          await this.plugin.deleteTodoTask(this.task);
          if (typeof this.onSaved === "function") await this.onSaved({ ...this.task, deleted: true });
          new Notice(`${this.task.ticketId || "To-Do"}를 삭제했습니다.`);
          this.close();
        }
      }).open();
    });
    const copy = actions.createEl("button", { text: "내용 복사" });
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText([content.value, detail.value, result.value].filter((value) => String(value || "").trim()).join("\n\n"));
      new Notice("To-Do 내용을 복사했습니다.");
    });
    const open = actions.createEl("button", { text: "원본 티켓 열기" });
    if (!hasTicket) {
      open.disabled = true;
      open.title = "연결된 티켓이 없습니다.";
    } else {
      open.addEventListener("click", async () => {
        const file = this.plugin.rootTicketFile(this.task.ticketId);
        if (!file) return;
        this.close();
        await this.app.workspace.getLeaf(false).openFile(file);
      });
    }
    const save = actions.createEl("button", { text: "저장", cls: "mod-cta" });
    save.addEventListener("click", async () => {
      if (!content.value.trim()) return new Notice("할 일을 입력해 주세요.");
      save.disabled = true;
      try {
        this.task = await this.plugin.updateTodoTaskDetails(this.task, {
          text: content.value,
          details: detail.value,
          result: result.value,
          ...waitingEditor.values(),
          dueDate: composeTodoDueValue(dueDate.value, dueTime.value),
          status: status.value
        });
        if (typeof this.onSaved === "function") await this.onSaved(this.task);
        new Notice(`${this.task.ticketId || "To-Do"}를 저장했습니다.`);
        this.close();
      } catch (error) {
        new Notice(`To-Do 저장 실패: ${error.message || error}`, 9000);
        save.disabled = false;
      }
    });
  }

  onClose() {
    this.modalEl.removeClass("clt-todo-detail-modal");
    if (this.workflowRef) this.app.workspace.offref(this.workflowRef);
    this.contentEl.empty();
  }
}

class WorkNotesRenderChild extends MarkdownRenderChild {
  constructor(containerEl, plugin, ticketId) {
    super(containerEl);
    this.plugin = plugin;
    this.ticketId = ticketId;
    this.state = { query: "", sort: "desc", from: "", to: "", type: "all", language: "original" };
  }

  onload() {
    this.plugin.registerView(this.ticketId, this);
    this.render();
    this.plugin.scheduleViewRefresh(this.ticketId, "work-notes");
  }

  onunload() {
    this.plugin.unregisterView(this.ticketId, this);
  }

  render() {
    const container = this.containerEl;
    container.empty();
    container.addClass("clt-sn-root");
    const ticket = this.plugin.data.tickets[this.ticketId];

    const header = container.createDiv({ cls: "clt-sn-header" });
    const headingBlock = header.createDiv({ cls: "clt-sn-heading" });
    headingBlock.createEl("h3", { text: `${this.ticketId} ServiceNow 워킹노트` });
    const statusText = ticket?.lastSyncedAt
      ? `마지막 갱신: ${ticket.lastSyncedAt}`
      : ticket?.lastError
        ? `갱신 실패: ${ticket.lastError}`
        : "ServiceNow 연결 후 갱신할 수 있습니다.";
    headingBlock.createDiv({ cls: "clt-sn-sync-status", text: statusText });

    const actions = header.createDiv({ cls: "clt-sn-actions" });
    const refresh = actions.createEl("button", { cls: "mod-cta", text: "지금 갱신" });
    refresh.addEventListener("click", async () => {
      refresh.disabled = true;
      refresh.setText("갱신 중…");
      try { await this.plugin.syncTicket(this.ticketId, { notify: true }); }
      finally { refresh.disabled = false; refresh.setText("지금 갱신"); }
    });
    const open = actions.createEl("button", { text: "ServiceNow 열기" });
    open.addEventListener("click", () => this.plugin.openTicketInBrowser(this.ticketId));
    const copy = actions.createEl("button", { text: "보이는 내용 복사" });
    copy.addEventListener("click", async () => {
      copy.disabled = true;
      copy.setText("복사 중…");
      try {
        await this.copyVisibleEntries();
      } finally {
        copy.disabled = false;
        copy.setText("보이는 내용 복사");
      }
    });
    const translate = actions.createEl("button", { cls: "clt-sn-translate-button", text: "선택 언어 번역" });
    translate.addEventListener("click", async () => {
      if (this.state.language === "original") {
        new Notice("필터에서 한국어 또는 베트남어를 먼저 선택하세요.");
        return;
      }
      translate.disabled = true;
      translate.setText("번역 중…");
      try { await this.plugin.translateTicket(this.ticketId, this.state.language, { notify: true }); }
      finally { translate.disabled = false; translate.setText("선택 언어 번역"); }
    });

    if (!ticket) {
      const empty = container.createDiv({ cls: "clt-sn-empty" });
      empty.createEl("p", { text: "아직 가져온 데이터가 없습니다." });
      const connect = empty.createEl("button", { text: "ServiceNow 연결" });
      connect.addEventListener("click", () => this.plugin.connectServiceNow());
      return;
    }

    const summary = container.createDiv({ cls: "clt-sn-summary" });
    const selectedLanguage = this.state.language === "original" ? "" : this.state.language;
    const translatedShortDescription = selectedLanguage
      ? ticket.translations?.shortDescription?.[selectedLanguage] || ""
      : "";
    const translatedDescription = selectedLanguage
      ? ticket.translations?.description?.[selectedLanguage] || ""
      : "";
    const shortSection = summary.createDiv({ cls: "clt-sn-summary-section" });
    shortSection.createDiv({ cls: "clt-sn-summary-label", text: "Short description" });
    shortSection.createDiv({
      cls: `clt-sn-summary-title${translatedShortDescription ? " clt-sn-translation" : ""}`,
      text: translatedShortDescription || ticket.shortDescription || "(제목 없음)"
    });
    if (translatedShortDescription) {
      const originalShortDescription = shortSection.createEl("details", { cls: "clt-sn-original" });
      originalShortDescription.createEl("summary", { text: "Short description 원문 보기" });
      originalShortDescription.createDiv({ text: ticket.shortDescription || "(제목 없음)" });
    } else if (selectedLanguage && ticket.shortDescription) {
      shortSection.createDiv({ cls: "clt-sn-translation-missing", text: "Short description이 아직 번역되지 않았습니다." });
    }
    if (ticket.description) {
      const descriptionSection = summary.createDiv({ cls: "clt-sn-summary-section clt-sn-description-section" });
      const descriptionHeader = descriptionSection.createDiv({ cls: "clt-sn-description-header" });
      descriptionHeader.createDiv({ cls: "clt-sn-summary-label", text: "Description" });
      const toggleDescription = descriptionHeader.createEl("button", { cls: "clt-sn-collapse-button", text: "내용 펼치기" });
      const descriptionBody = descriptionSection.createDiv({ cls: "clt-sn-description-body" });
      descriptionBody.style.display = "none";
      toggleDescription.addEventListener("click", () => {
        const isOpen = descriptionBody.style.display !== "none";
        descriptionBody.style.display = isOpen ? "none" : "block";
        toggleDescription.setText(isOpen ? "내용 펼치기" : "내용 접기");
      });
      descriptionBody.createEl("pre", {
        cls: translatedDescription ? "clt-sn-translation" : "",
        text: translatedDescription || ticket.description
      });
      if (translatedDescription) {
        const originalToggle = descriptionBody.createEl("button", { cls: "clt-sn-original-button", text: "원문 보기" });
        const originalDescription = descriptionBody.createEl("pre", { cls: "clt-sn-original-content", text: ticket.description });
        originalDescription.style.display = "none";
        originalToggle.addEventListener("click", () => {
          const isOpen = originalDescription.style.display !== "none";
          originalDescription.style.display = isOpen ? "none" : "block";
          originalToggle.setText(isOpen ? "원문 보기" : "원문 닫기");
        });
      } else if (selectedLanguage) {
        descriptionBody.createDiv({ cls: "clt-sn-translation-missing", text: "Description이 아직 번역되지 않았습니다." });
      }
    }

    this.renderFilters(container, ticket.entries || []);
    this.renderEntries(container, ticket.entries || []);
  }

  renderFilters(container, allEntries) {
    const filters = container.createDiv({ cls: "clt-sn-filters" });
    const search = filters.createEl("input", { type: "search", placeholder: "워킹노트 단어 또는 작성자 검색" });
    search.value = this.state.query;
    search.addEventListener("input", () => { this.state.query = search.value; this.renderEntries(container, allEntries); });

    const sort = filters.createEl("select");
    [["desc", "최신순"], ["asc", "오래된순"]].forEach(([value, label]) => {
      const option = sort.createEl("option", { value, text: label });
      option.selected = value === this.state.sort;
    });
    sort.addEventListener("change", () => { this.state.sort = sort.value; this.renderEntries(container, allEntries); });

    const type = filters.createEl("select");
    [["all", "전체 유형"], ["Work Note", "Work Note"], ["Attachment", "Attachment"]]
      .forEach(([value, label]) => {
        const option = type.createEl("option", { value, text: label });
        option.selected = value === this.state.type;
      });
    type.addEventListener("change", () => { this.state.type = type.value; this.renderEntries(container, allEntries); });

    const language = filters.createEl("select");
    [["original", "원문"], ["ko", "한국어"], ["vi", "베트남어"]].forEach(([value, label]) => {
      const option = language.createEl("option", { value, text: label });
      option.selected = value === this.state.language;
    });
    language.addEventListener("change", () => {
      const selectedLanguage = language.value;
      this.state.language = selectedLanguage;
      this.render();
      if (selectedLanguage !== "original") {
        void this.plugin.translateTicket(this.ticketId, selectedLanguage, { notify: true });
      }
    });

    const fromWrap = filters.createDiv({ cls: "clt-sn-date-field" });
    fromWrap.createEl("span", { text: "시작일" });
    const from = fromWrap.createEl("input", { type: "date" });
    from.value = this.state.from;
    from.addEventListener("change", () => { this.state.from = from.value; this.renderEntries(container, allEntries); });

    const toWrap = filters.createDiv({ cls: "clt-sn-date-field" });
    toWrap.createEl("span", { text: "종료일" });
    const to = toWrap.createEl("input", { type: "date" });
    to.value = this.state.to;
    to.addEventListener("change", () => { this.state.to = to.value; this.renderEntries(container, allEntries); });
  }

  filteredEntries(entries) {
    const query = this.state.query.trim().toLowerCase();
    return entries
      .filter((entry) => this.state.type === "all" || entry.type === this.state.type)
      .filter((entry) => !this.state.from || entry.time.slice(0, 10) >= this.state.from)
      .filter((entry) => !this.state.to || entry.time.slice(0, 10) <= this.state.to)
      .filter((entry) => {
        const translated = this.state.language === "original" ? "" : entry.translations?.[this.state.language] || "";
        return !query || `${entry.author || ""}\n${entry.type || ""}\n${entry.content || ""}\n${translated}`.toLowerCase().includes(query);
      })
      .sort((a, b) => this.state.sort === "asc" ? a.time.localeCompare(b.time) : b.time.localeCompare(a.time));
  }

  async copyVisibleEntries() {
    const ticket = this.plugin.data.tickets[this.ticketId];
    if (!ticket) {
      new Notice("복사할 워킹노트가 없습니다. 먼저 갱신해 주세요.");
      return;
    }
    const entries = this.filteredEntries(ticket.entries || []);
    if (!entries.length) {
      new Notice("현재 화면 조건에 맞는 워킹노트가 없습니다.");
      return;
    }
    const languageLabel = this.state.language === "ko"
      ? "한국어"
      : this.state.language === "vi" ? "베트남어" : "원문";
    const selectedLanguage = this.state.language === "original" ? "" : this.state.language;
    const shortDescription = selectedLanguage
      ? ticket.translations?.shortDescription?.[selectedLanguage] || ticket.shortDescription
      : ticket.shortDescription;
    const description = selectedLanguage
      ? ticket.translations?.description?.[selectedLanguage] || ticket.description
      : ticket.description;
    const lines = [
      `# ${this.ticketId} ServiceNow 워킹노트`,
      "",
      `Short description: ${shortDescription || "(제목 없음)"}`
    ];
    if (description) lines.push("", "Description:", description);
    lines.push(
      "",
      `표시 순서: ${this.state.sort === "asc" ? "오래된순" : "최신순"}`,
      `표시 언어: ${languageLabel}`,
      `표시 건수: ${entries.length}건`,
      ""
    );
    entries.forEach((entry, index) => {
      const meta = [entry.time, entry.type, entry.author].filter(Boolean).join(" | ");
      const translated = this.state.language === "original"
        ? ""
        : entry.translations?.[this.state.language] || "";
      const content = entry.url
        ? `${entry.content || "첨부파일"}\n${entry.url}`
        : translated || entry.content || "";
      lines.push(`${index + 1}. ${meta}`, content, "");
    });
    try {
      await navigator.clipboard.writeText(lines.join("\n").trim());
      new Notice(`현재 화면 순서대로 워킹노트 ${entries.length}건을 복사했습니다.`, 5000);
    } catch (error) {
      new Notice(`클립보드 복사 실패: ${error.message || error}`, 7000);
    }
  }

  renderEntries(container, allEntries) {
    container.querySelector(".clt-sn-results")?.remove();
    const results = container.createDiv({ cls: "clt-sn-results" });
    const entries = this.filteredEntries(allEntries);
    results.createDiv({ cls: "clt-sn-count", text: `${entries.length} / ${allEntries.length}건` });
    if (!entries.length) {
      results.createDiv({ cls: "clt-sn-empty", text: "조건에 맞는 워킹노트가 없습니다." });
      return;
    }
    entries.forEach((entry) => {
      const card = results.createDiv({ cls: `clt-sn-card clt-sn-${String(entry.type).toLowerCase().replace(/\s+/g, "-")}` });
      const meta = card.createDiv({ cls: "clt-sn-card-meta" });
      meta.createSpan({ cls: "clt-sn-time", text: entry.time });
      meta.createSpan({ cls: "clt-sn-badge", text: entry.type });
      if (entry.author) meta.createSpan({ cls: "clt-sn-author", text: entry.author });
      if (entry.url) {
        this.renderAttachment(card, entry);
      } else {
        const translated = this.state.language === "original" ? "" : entry.translations?.[this.state.language] || "";
        if (translated) {
          card.createEl("pre", { cls: "clt-sn-content clt-sn-translation", text: translated });
          const original = card.createEl("details", { cls: "clt-sn-original" });
          original.createEl("summary", { text: "원문 보기" });
          original.createEl("pre", { cls: "clt-sn-content", text: entry.content || "" });
        } else {
          card.createEl("pre", { cls: "clt-sn-content", text: entry.content || "" });
          if (this.state.language !== "original") {
            card.createDiv({ cls: "clt-sn-translation-missing", text: "아직 번역되지 않은 항목입니다." });
          }
        }
      }
    });
  }

  renderAttachment(card, entry) {
    const image = isImageAttachment(entry.content, entry.contentType);
    const video = isVideoAttachment(entry.content, entry.contentType);
    const attachmentId = serviceNowAttachmentId(entry);
    if (image && attachmentId) {
      const preview = card.createDiv({ cls: "clt-sn-attachment-preview" });
      const loading = preview.createDiv({ cls: "clt-sn-attachment-loading", text: "이미지 불러오는 중…" });
      this.plugin.attachmentImageDataUrl({ ...entry, attachmentId }).then((dataUrl) => {
        if (!preview.isConnected) return;
        loading.remove();
        preview.createEl("img", {
          attr: { src: dataUrl, alt: entry.content || "ServiceNow 첨부 이미지" }
        });
      }).catch((error) => {
        if (!preview.isConnected) return;
        loading.setText(`이미지 미리보기 실패: ${error.message || error}`);
      });
    }
    if (video && attachmentId) {
      const preview = card.createDiv({ cls: "clt-sn-attachment-preview clt-sn-video-preview" });
      const loading = preview.createDiv({ cls: "clt-sn-attachment-loading", text: "영상 준비 중…" });
      this.plugin.ensureAttachmentVideoFile(this.ticketId, { ...entry, attachmentId }).then((path) => {
        if (!preview.isConnected) return;
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error("저장된 영상 파일을 찾을 수 없습니다.");
        loading.remove();
        preview.createEl("video", {
          attr: {
            src: this.plugin.app.vault.getResourcePath(file),
            controls: "",
            preload: "metadata",
            playsinline: "",
            title: entry.content || "ServiceNow 첨부 영상"
          }
        });
      }).catch((error) => {
        if (!preview.isConnected) return;
        loading.setText(`영상 미리보기 실패: ${error.message || error}`);
      });
    }
    const link = card.createEl("a", {
      text: image || video ? `${entry.content || "첨부파일"} · ServiceNow에서 열기` : entry.content || "첨부파일 열기",
      href: entry.url,
      cls: "clt-sn-attachment-link"
    });
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noopener");
  }
}

class TicketStatusRenderChild extends MarkdownRenderChild {
  constructor(containerEl, plugin, ticketId) {
    super(containerEl);
    this.plugin = plugin;
    this.ticketId = ticketId;
  }
  onload() {
    this.plugin.registerView(this.ticketId, this);
    this.render();
    this.plugin.scheduleViewRefresh(this.ticketId, "root");
  }
  onunload() {
    this.plugin.unregisterView(this.ticketId, this);
  }
  render() {
    this.containerEl.empty();
    this.plugin.renderTicketStatusControl(this.containerEl, this.ticketId);
  }
}

class MeetingSectionRenderChild extends MarkdownRenderChild {
  constructor(containerEl, plugin, ticketId) {
    super(containerEl);
    this.plugin = plugin;
    this.ticketId = ticketId;
    this.refreshTimer = null;
  }
  onload() {
    this.plugin.registerView(this.ticketId, this);
    const refreshIfRelevant = (file, oldPath = "") => {
      if (!this.plugin.isMeetingFileRelevantToTicket(file, this.ticketId, oldPath)) return;
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = window.setTimeout(() => this.render(), 120);
    };
    this.registerEvent(this.plugin.app.vault.on("create", refreshIfRelevant));
    this.registerEvent(this.plugin.app.vault.on("delete", refreshIfRelevant));
    this.registerEvent(this.plugin.app.vault.on("rename", refreshIfRelevant));
    this.registerEvent(this.plugin.app.vault.on("modify", refreshIfRelevant));
    this.registerEvent(this.plugin.app.metadataCache.on("changed", refreshIfRelevant));
    this.render();
  }
  onunload() {
    window.clearTimeout(this.refreshTimer);
    this.plugin.unregisterView(this.ticketId, this);
  }
  render() {
    this.containerEl.empty();
    this.plugin.renderTicketMeetingSection(this.containerEl, this.ticketId);
  }
}

class DocumentCandidateModal extends Modal {
  constructor(app, ticketId, candidateGroups, currentValues, onSubmit) {
    super(app);
    this.ticketId = ticketId;
    this.candidateGroups = candidateGroups;
    this.currentValues = currentValues;
    this.onSubmit = onSubmit;
    this.selected = {};
    this.finished = false;
  }

  onOpen() {
    this.contentEl.empty();
    this.titleEl.setText(`${this.ticketId} 문서 링크 선택`);
    this.contentEl.createEl("p", {
      text: "후보가 여러 개인 문서만 표시됩니다. 반영할 링크를 고르고 확인을 누르세요. 선택하지 않은 필드는 기존 값을 유지합니다."
    });
    Object.entries(this.candidateGroups).forEach(([type, candidates]) => {
      const section = this.contentEl.createDiv({ cls: "clt-sn-document-section" });
      section.createEl("h4", { text: `${type} 후보 ${candidates.length}개` });
      const groupName = `clt-doc-${this.ticketId}-${type}-${Date.now()}`;
      const keep = section.createEl("label", { cls: "clt-sn-document-candidate" });
      const keepRadio = keep.createEl("input", { type: "radio" });
      keepRadio.name = groupName;
      keepRadio.checked = true;
      keepRadio.addEventListener("change", () => { if (keepRadio.checked) delete this.selected[type]; });
      keep.createSpan({ text: this.currentValues[type] ? "기존 링크 유지" : "선택하지 않음" });
      candidates.forEach((candidate) => {
        const row = section.createEl("label", { cls: "clt-sn-document-candidate" });
        const radio = row.createEl("input", { type: "radio" });
        radio.name = groupName;
        radio.addEventListener("change", () => { if (radio.checked) this.selected[type] = candidate.url; });
        const body = row.createDiv({ cls: "clt-sn-document-candidate-body" });
        const link = body.createEl("a", { text: candidate.name, href: candidate.url });
        link.setAttr("target", "_blank");
        link.addEventListener("click", (event) => event.stopPropagation());
        body.createDiv({ cls: "clt-sn-document-candidate-url", text: candidate.url });
        const detail = [candidate.modifiedTime, candidate.source].filter(Boolean).join(" · ");
        if (detail) body.createDiv({ cls: "clt-sn-document-candidate-meta", text: detail });
      });
    });
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    const cancel = actions.createEl("button", { text: "취소" });
    cancel.addEventListener("click", () => { this.finish({}); this.close(); });
    const confirm = actions.createEl("button", { text: "선택 반영", cls: "mod-cta" });
    confirm.addEventListener("click", () => {
      this.finish(this.selected);
      this.close();
    });
  }

  finish(value) {
    if (this.finished) return;
    this.finished = true;
    this.onSubmit(value);
  }

  onClose() {
    this.finish({});
    this.contentEl.empty();
  }
}

class TodoWorkflowSettingsModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.draft = plugin.getTodoWorkflow();
  }
  onOpen() {
    this.modalEl.addClass("snm-todo-workflow-modal");
    this.titleEl.setText("To-Do 상태 설정");
    this.render();
  }
  render() {
    const content = this.contentEl;
    content.empty();
    content.createEl("p", { text: "이름·사용 여부·순서를 설정합니다. 업무현황과 모든 원본 티켓 노트에 함께 적용됩니다. 이름을 바꿔도 상태의 내부 역할은 유지됩니다." });
    content.createEl("p", { cls: "snm-pack-import-help", text: "사용하지 않는 상태는 새 To-Do에서 선택할 수 없습니다. 기존 항목은 보존되며 ‘비활성화 상태 보기’에서 확인·수정할 수 있습니다. 최소 한 상태는 사용해야 합니다." });
    this.draft.forEach((state, index) => {
      const row = content.createDiv({ cls: "snm-todo-workflow-row" });
      row.dataset.statusKey = state.key;
      const label = row.createEl("label");
      const enabled = label.createEl("input", { type: "checkbox" });
      enabled.checked = state.enabled;
      enabled.setAttr("aria-label", `${state.label} 사용`);
      enabled.addEventListener("change", () => { state.enabled = enabled.checked; });
      label.createSpan({ text: state.icon });
      const name = row.createEl("input", { type: "text" });
      name.value = state.label;
      name.maxLength = 60;
      name.setAttr("aria-label", `${state.key} 상태 이름`);
      name.addEventListener("input", () => { state.label = name.value; });
      const role = row.createEl("small", { text: DEFAULT_TODO_WORKFLOW.find(item => item.key === state.key).label });
      role.title = "변경되지 않는 기본 역할";
      for (const [offset, text] of [[-1, "↑"], [1, "↓"]]) {
        const button = row.createEl("button", { text });
        button.setAttr("aria-label", `${state.label} ${offset < 0 ? "위로" : "아래로"}`);
        button.disabled = index + offset < 0 || index + offset >= this.draft.length;
        button.addEventListener("click", () => {
          [this.draft[index], this.draft[index + offset]] = [this.draft[index + offset], this.draft[index]];
          this.render();
        });
      }
    });
    const status = content.createDiv({ cls: "snm-pack-import-status" });
    status.setAttr("role", "status");
    const actions = content.createDiv({ cls: "clt-sn-document-actions" });
    actions.createEl("button", { text: "기본값" }).addEventListener("click", () => { this.draft = normalizeTodoWorkflow([]); this.render(); });
    actions.createEl("button", { text: "취소" }).addEventListener("click", () => this.close());
    const save = actions.createEl("button", { text: "저장", cls: "mod-cta" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try { await this.plugin.saveTodoWorkflow(this.draft); this.close(); new Notice("To-Do 상태 설정을 모든 화면에 적용했습니다."); }
      catch (error) { status.setText(error.message || String(error)); save.disabled = false; }
    });
  }
  onClose() { this.contentEl.empty(); }
}

class InactiveTodoModal extends Modal {
  constructor(app, plugin, tasks) { super(app); this.plugin = plugin; this.tasks = tasks; }
  onOpen() {
    this.titleEl.setText("비활성화 상태의 기존 To-Do");
    this.contentEl.createEl("p", { text: "기존 데이터는 그대로 보존됩니다. 항목을 눌러 활성 상태로 옮기거나 상태 설정에서 다시 사용하도록 변경하세요." });
    for (const task of this.tasks) {
      const label = this.plugin.getTodoWorkflow().find(state => state.key === task.status)?.label || task.status;
      const button = this.contentEl.createEl("button", { cls: "snm-inactive-todo-item", text: `${task.ticketId || "일반"} · ${label} · ${task.text}` });
      button.addEventListener("click", () => this.plugin.openTodoDetailEntryModal(task, async () => {
        for (const [list, value] of this.plugin.todoBoardViews || []) {
          if (list.isConnected && value.ticketId === task.ticketId) {
            const tasks = await this.plugin.readTodoTasks(task.ticketId);
            this.plugin.renderTicketTodoBoard(list, value.ticketId, tasks);
          }
        }
        this.plugin.app.workspace.trigger("servicenow-manage:todo-workflow-changed");
        this.close();
      }));
    }
  }
  onClose() { this.contentEl.empty(); }
}

class SettingsJsonImportModal extends Modal {
  constructor(app, plugin, onDone, kind = "organization-pack") {
    super(app);
    this.plugin = plugin;
    this.onDone = onDone;
    this.kind = kind;
    this.busy = false;
  }

  onOpen() {
    this.modalEl.addClass("snm-pack-import-modal");
    const google = this.kind === "google-oauth";
    this.titleEl.setText(google ? "Google OAuth JSON 가져오기 / 교체" : this.plugin.hasOrganizationPack() ? "업무가이드팩 교체" : "업무가이드팩 JSON 가져오기");
    const content = this.contentEl;
    content.createEl("p", { text: "JSON 파일을 선택하거나 JSON 내용 전체를 아래에 붙여넣은 뒤 ‘등록’을 누르세요. 초기 설정 이후에도 사용할 수 있습니다." });
    if (google) {
      content.createEl("p", { cls: "snm-pack-import-help", text: "Google Cloud Console에서 받은 Desktop OAuth JSON을 사용하세요. 인증 정보는 기존 SecretStorage 저장 방식을 사용하며 로그에 출력하지 않습니다." });
    } else if (this.plugin.hasOrganizationPack()) {
      content.createEl("p", { cls: "snm-pack-import-help", text: "등록하면 현재 팩을 교체합니다. 기존 티켓과 사용자가 수정한 분석 템플릿은 보존합니다." });
    }
    const fileLabel = content.createEl("label", { cls: "snm-pack-import-field" });
    fileLabel.createSpan({ text: "JSON 파일 선택" });
    // Keep the native file control visible and connected to the active modal.
    // A detached input.click() can silently fail in an embedded desktop window.
    const fileInput = fileLabel.createEl("input", { type: "file" });
    fileInput.accept = ".json,application/json";
    this.fileInput = fileInput;
    const jsonLabel = content.createEl("label", { cls: "snm-pack-import-field" });
    jsonLabel.createSpan({ text: "또는 JSON 내용 붙여넣기" });
    const jsonInput = jsonLabel.createEl("textarea", { cls: "snm-pack-import-json" });
    jsonInput.placeholder = '{ "schemaVersion": 1, "packId": "...", "name": "...", ... }';
    jsonInput.spellcheck = false;
    this.jsonInput = jsonInput;
    const status = content.createDiv({ cls: "snm-pack-import-status" });
    status.setAttr("role", "status");
    status.setAttr("aria-live", "polite");
    const actions = content.createDiv({ cls: "clt-sn-document-actions" });
    const cancel = actions.createEl("button", { text: "취소" });
    const submit = actions.createEl("button", { text: "등록", cls: "mod-cta" });
    const setBusy = (busy) => {
      this.busy = busy;
      fileInput.disabled = jsonInput.disabled = submit.disabled = cancel.disabled = busy;
      submit.setText(busy ? "등록 중…" : "등록");
    };
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file || this.busy) return;
      setBusy(true);
      try {
        jsonInput.value = await file.text();
        status.setText(`${file.name}을 읽었습니다. 내용을 확인하고 ‘등록’을 누르세요.`);
      } catch (error) {
        status.setText(`파일 읽기 실패: ${error.message || error}. JSON 내용을 직접 붙여넣을 수도 있습니다.`);
      } finally {
        fileInput.value = "";
        setBusy(false);
      }
    });
    cancel.addEventListener("click", () => { if (!this.busy) this.close(); });
    submit.addEventListener("click", async () => {
      if (this.busy) return;
      if (!jsonInput.value.trim()) {
        status.setText("JSON 파일을 선택하거나 JSON 내용을 붙여넣어 주세요.");
        jsonInput.focus();
        return;
      }
      setBusy(true);
      try {
        const value = JSON.parse(jsonInput.value.replace(/^\uFEFF/, ""));
        if (google) {
          await this.plugin.applyGoogleOAuthJson(value);
          new Notice("Google OAuth JSON을 등록했습니다. Google 계정을 연결하거나 다시 연결해 주세요.", 8000);
        } else {
          const pack = await this.plugin.applyOrganizationPack(value);
          const result = this.plugin.lastOrganizationPackApplyResult || {};
          new Notice(`업무가이드팩을 등록했습니다: ${pack.name}${result.updated ? ` · 기본 템플릿 갱신 ${result.updated}개` : ""}${result.preserved ? ` · 사용자 수정 템플릿 보존 ${result.preserved}개` : ""}`, 8000);
        }
      } catch (error) {
        // Do not echo parser excerpts: OAuth JSON may contain client secrets.
        const message = error instanceof SyntaxError ? "JSON 문법이 올바르지 않습니다. 내용 전체를 복사했는지 확인해 주세요." : String(error.message || error);
        status.setText(`${google ? "Google OAuth JSON" : "업무가이드팩"} 등록 실패: ${message}`);
        setBusy(false);
        return;
      }
      this.close();
      this.onDone?.();
    });
  }

  onClose() {
    if (this.jsonInput) this.jsonInput.value = "";
    if (this.fileInput) this.fileInput.value = "";
    this.contentEl.empty();
  }
}

class BearerTokenModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText("ServiceNow Bearer Token 연결");
    contentEl.createEl("p", {
      text: "본인에게 정식으로 발급된 Bearer Token만 붙여넣으세요. 브라우저 세션 쿠키나 다른 사람의 토큰은 사용하지 마세요."
    });
    const input = contentEl.createEl("input", { type: "password" });
    input.addClass("clt-sn-token-input");
    input.setAttr("placeholder", "Bearer 접두어 없이 토큰만 붙여넣기");
    input.setAttr("autocomplete", "off");
    const status = contentEl.createDiv({ cls: "clt-sn-token-status" });

    const actions = new Setting(contentEl);
    actions.addButton((button) => button
      .setButtonText("취소")
      .onClick(() => this.close()));
    actions.addButton((button) => button
      .setButtonText("저장하고 연결 확인")
      .setCta()
      .onClick(async () => {
        const token = cleanBearerToken(input.value);
        if (token.length < 20) {
          status.setText("올바른 Bearer Token을 입력하세요.");
          return;
        }
        button.setDisabled(true);
        button.setButtonText("확인 중…");
        status.setText("토큰을 SecretStorage에 저장하고 CR/SR 조회 권한을 확인합니다.");
        try {
          await this.plugin.saveManualBearerToken(token);
          await this.plugin.testConnection();
          this.close();
        } catch (error) {
          status.setText(`연결 실패: ${error.message}`);
          button.setDisabled(false);
          button.setButtonText("저장하고 연결 확인");
        }
      }));
    window.setTimeout(() => input.focus(), 50);
  }

  onClose() {
    this.tokenValue = "";
    this.googleJsonValue = "";
    this.organizationPackValue = "";
    this.contentEl.empty();
  }
}

class FirstRunSetupModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.step = 0;
    this.finished = false;
    this.rootFolderValue = plugin.settings.rootFolder || "ServiceNow";
    this.instanceUrlValue = plugin.settings.instanceUrl || "";
    this.authModeValue = plugin.settings.authMode || "bearer";
    this.clientIdValue = plugin.settings.clientId || "";
    this.oauthScopeValue = plugin.settings.oauthScope || "";
    this.tokenValue = "";
    this.googleJsonValue = "";
    this.organizationPackValue = "";
    this.readingViewDefaultValue = plugin.isReadingViewDefault();
    this.statusMessage = "";
  }

  onOpen() {
    this.modalEl.addClass("snm-setup-modal");
    this.render();
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    const steps = ["시작", "화면 설정", "필수 플러그인", "ServiceNow", "Google Drive", "업무가이드팩", "완료"];
    this.titleEl.setText(`ServiceNow Manage 초기 설정 · ${steps[this.step]}`);
    contentEl.createDiv({ cls: "snm-setup-progress", text: `${this.step + 1} / ${steps.length}` });

    if (this.step === 0) this.renderWelcome(contentEl);
    if (this.step === 1) this.renderDisplaySettings(contentEl);
    if (this.step === 2) this.renderDependencies(contentEl);
    if (this.step === 3) this.renderServiceNow(contentEl);
    if (this.step === 4) this.renderGoogle(contentEl);
    if (this.step === 5) this.renderOrganizationPack(contentEl);
    if (this.step === 6) this.renderSummary(contentEl);

    if (this.statusMessage) contentEl.createDiv({ cls: "snm-setup-status", text: this.statusMessage });
    const footer = contentEl.createDiv({ cls: "snm-setup-footer" });
    const later = footer.createEl("button", { text: "나중에 설정" });
    later.addEventListener("click", () => this.complete(false));
    const navigation = footer.createDiv({ cls: "snm-setup-navigation" });
    if (this.step > 0) {
      const back = navigation.createEl("button", { text: "이전" });
      back.addEventListener("click", () => {
        this.statusMessage = "";
        this.step -= 1;
        this.render();
      });
    }
    const next = navigation.createEl("button", {
      cls: "mod-cta",
      text: this.step === steps.length - 1 ? "설정 완료" : "다음"
    });
    next.addEventListener("click", async () => {
      next.disabled = true;
      try {
        await this.saveCurrentStep();
        if (this.step === steps.length - 1) return await this.complete(true);
        this.statusMessage = "";
        this.step += 1;
        this.render();
      } catch (error) {
        this.statusMessage = error.message || String(error);
        next.disabled = false;
        this.render();
      }
    });
  }

  renderWelcome(contentEl) {
    contentEl.createEl("p", {
      text: "처음 사용하는 데 필요한 항목을 순서대로 확인합니다. 모든 항목은 나중에 설정 → ServiceNow Manage에서 다시 변경할 수 있습니다."
    });
    new Setting(contentEl)
      .setName("루트 폴더")
      .setDesc("티켓, 업무현황, 템플릿을 저장할 Vault 폴더입니다. 기존 사용자는 현재 값이 그대로 표시됩니다.")
      .addText((text) => text
        .setPlaceholder("ServiceNow")
        .setValue(this.rootFolderValue)
        .onChange((value) => { this.rootFolderValue = value; }));
    contentEl.createDiv({
      cls: "snm-setup-note",
      text: "기존 Vault에서 루트 폴더를 실제로 옮길 때는 초기 설정 후 일반 설정의 ‘적용’ 버튼을 사용하세요."
    });
  }

  renderDependencies(contentEl) {
    contentEl.createEl("p", { text: "업무현황에는 Dataview의 JavaScript Query 기능이 필요합니다. Translate는 워킹노트 번역을 사용할 때만 필요합니다." });
    const dataview = this.plugin.app.plugins?.plugins?.dataview;
    const dataviewJsEnabled = dataview ? dataview.settings?.enableDataviewJs === true : false;
    const dataviewCard = contentEl.createDiv({ cls: "snm-setup-dependency-card" });
    dataviewCard.createEl("strong", {
      text: `Dataview · ${!dataview ? "설치 필요" : (dataviewJsEnabled ? "🟢 JavaScript Queries 켜짐" : "🔴 JavaScript Queries 꺼짐 (활성화 필요)")}`
    });
    dataviewCard.createEl("p", {
      text: !dataview
        ? "Dataview가 설치되지 않았습니다. 업무 목록과 To-Do 보드를 표시하려면 먼저 설치해 주세요."
        : (dataviewJsEnabled
          ? "Dataview와 JavaScript Queries가 정상 작동 중입니다. 업무현황 대시보드를 사용할 수 있습니다."
          : "Dataview가 설치되어 있지만 ‘Enable JavaScript Queries’가 꺼져 있습니다. 아래 버튼으로 켤 수 있습니다.")
    });
    const dataviewActions = dataviewCard.createDiv({ cls: "snm-setup-inline-actions" });
    if (dataview && !dataviewJsEnabled) {
      const enableJsButton = dataviewActions.createEl("button", { cls: "mod-cta", text: "JavaScript Queries 즉시 켜기" });
      enableJsButton.addEventListener("click", async () => {
        try {
          dataview.settings.enableDataviewJs = true;
          if (typeof dataview.saveSettings === "function") await dataview.saveSettings();
          this.statusMessage = "Dataview JavaScript Queries를 활성화했습니다.";
        } catch (error) {
          this.statusMessage = `Dataview 설정 갱신 실패: ${error.message || error}`;
        }
        this.render();
      });
    }
    const dataviewButton = dataviewActions.createEl("button", { text: dataview ? "Dataview 설정 열기" : "Dataview 설치 화면 열기" });
    dataviewButton.addEventListener("click", () => this.plugin.openDataviewSetup());

    const translate = this.plugin.app.plugins?.plugins?.translate;
    const translateCard = contentEl.createDiv({ cls: "snm-setup-dependency-card" });
    translateCard.createEl("strong", { text: `Translate · ${translate ? "설치됨" : "선택 설치"}` });
    translateCard.createEl("p", { text: "Short Description, Description, 워킹노트를 번역합니다. DeepL API Free 계정의 인증 키 등을 Translate 플러그인 설정에 등록해야 합니다." });
    const translateButton = translateCard.createEl("button", { text: translate ? "Translate 설정 열기" : "Translate 설치 화면 열기" });
    translateButton.addEventListener("click", () => this.plugin.openTranslateSetup());
    contentEl.createDiv({ cls: "snm-setup-note", text: "Obsidian의 제한 모드가 켜져 있으면 먼저 설정 → 커뮤니티 플러그인에서 제한 모드를 해제해 주세요. 보안상 플러그인이 이 설정을 임의로 변경하지는 않습니다." });
  }

  renderDisplaySettings(contentEl) {
    contentEl.createEl("p", {
      text: "티켓 노트의 To-Do 보드와 작업 버튼은 읽기 화면에서 표시됩니다. 새 탭에서 노트를 열 때 읽기 화면을 기본값으로 사용하도록 설정할 수 있습니다."
    });
    new Setting(contentEl)
      .setName("새 탭을 읽기 화면으로 열기")
      .setDesc("Obsidian 전체의 새 Markdown 탭에 적용됩니다. 노트를 편집해야 할 때는 해당 탭에서 언제든 편집 화면으로 전환할 수 있습니다.")
      .addToggle((toggle) => toggle
        .setValue(this.readingViewDefaultValue)
        .onChange((value) => { this.readingViewDefaultValue = value; }));
    new Setting(contentEl)
      .setName("모든 파일 형식 표시")
      .setDesc("assets 폴더의 Excel·Word·PowerPoint 파일을 파일 탐색기와 플러그인 문서 검색에서 찾을 수 있도록 활성화합니다.")
      .addToggle((toggle) => toggle
        .setValue(true)
        .setDisabled(true));
    const quickApply = contentEl.createEl("button", {
      cls: this.plugin.isReadingViewDefault() ? "" : "mod-cta",
      text: this.plugin.isReadingViewDefault() ? "현재 읽기 화면으로 설정됨" : "지금 읽기 화면을 기본값으로 적용"
    });
    quickApply.addEventListener("click", async () => {
      try {
        await this.plugin.setReadingViewDefault(true, { notify: false });
        await this.plugin.setShowAllFileTypes(true, { notify: false });
        this.readingViewDefaultValue = true;
        this.statusMessage = "읽기 화면과 모든 파일 형식 표시를 적용했습니다.";
      } catch (error) {
        this.statusMessage = `화면 설정 실패: ${error.message || error}`;
      }
      this.render();
    });
    contentEl.createDiv({
      cls: "snm-setup-note",
      text: "Excel 파일은 Obsidian 파일 탐색기에 표시되며 클릭하면 시스템 기본 앱에서 열립니다. 이미 열려 있는 탭의 화면은 바뀌지 않습니다. 설정 후 새 탭을 열거나 기존 탭을 다시 열어 확인해 주세요."
    });
  }

  renderServiceNow(contentEl) {
    contentEl.createEl("p", {
      text: "주소는 https://회사인스턴스.service-now.com 형식으로 입력하세요. 뒤의 /now, /nav_to.do 등 화면 경로는 입력하지 않습니다. 조직에서 허용한 인증 방식만 사용하세요."
    });
    new Setting(contentEl)
      .setName("ServiceNow 주소")
      .addText((text) => text
        .setPlaceholder("https://your-instance.service-now.com")
        .setValue(this.instanceUrlValue)
        .onChange((value) => { this.instanceUrlValue = value; }));
    new Setting(contentEl)
      .setName("인증 방식")
      .setDesc("OAuth는 ServiceNow 관리자가 미리 등록한 Public Client ID가 있을 때 사용할 수 있습니다.")
      .addDropdown((dropdown) => dropdown
        .addOption("bearer", "조직에서 제공한 Bearer Token")
        .addOption("oauth", "브라우저 OAuth PKCE 로그인")
        .setValue(this.authModeValue)
        .onChange((value) => { this.authModeValue = value; this.render(); }));
    if (this.authModeValue === "bearer") {
      new Setting(contentEl)
        .setName("Bearer Token")
        .setDesc(this.plugin.getSecret(ACCESS_TOKEN_KEY) ? "이미 저장된 Token이 있습니다. 비워 두면 기존 Token을 유지합니다." : "Token은 Obsidian SecretStorage에 저장됩니다.")
        .addText((text) => {
          text.inputEl.type = "password";
          text.inputEl.autocomplete = "off";
          text.setPlaceholder("Bearer 접두어 없이 입력")
            .setValue(this.tokenValue)
            .onChange((value) => { this.tokenValue = value; });
        });
    } else {
      new Setting(contentEl)
        .setName("OAuth Public Client ID")
        .setDesc("ServiceNow 관리자가 OAuth Application Registry에서 발급한 값입니다. Client Secret은 필요하지 않습니다.")
        .addText((text) => text.setPlaceholder("관리자 발급 Client ID").setValue(this.clientIdValue).onChange((value) => { this.clientIdValue = value.trim(); }));
      new Setting(contentEl)
        .setName("OAuth scope · 선택")
        .addText((text) => text.setPlaceholder("관리자가 지정한 경우만 입력").setValue(this.oauthScopeValue).onChange((value) => { this.oauthScopeValue = value.trim(); }));
    }
    const test = contentEl.createEl("button", { text: "저장 후 연결 확인" });
    test.addEventListener("click", async () => {
      test.disabled = true;
      try {
        await this.saveServiceNow();
        if (this.authModeValue === "oauth") {
          await this.plugin.connectServiceNow();
          this.statusMessage = "브라우저에서 ServiceNow 로그인을 완료해 주세요. 로그인 완료 후 설정의 연결 확인을 사용할 수 있습니다.";
        } else {
          await this.plugin.testConnection();
          this.statusMessage = "ServiceNow 연결을 확인했습니다.";
        }
      } catch (error) {
        this.statusMessage = `연결 확인 실패: ${error.message || error}`;
      }
      this.render();
    });
  }

  renderGoogle(contentEl) {
    const ready = Boolean(this.plugin.settings.googleClientId && this.plugin.getSecret(GOOGLE_CLIENT_SECRET_KEY));
    const googleConnected = Boolean(this.plugin.getSecret(GOOGLE_REFRESH_TOKEN_KEY) || this.plugin.getSecret(GOOGLE_ACCESS_TOKEN_KEY));
    const permissionInfo = this.plugin.getGooglePermissionInfo();

    contentEl.createEl("p", {
      text: "Google Drive 문서 검색을 사용할 때만 등록하세요. Desktop OAuth JSON 파일을 선택하거나 JSON 원문을 붙여넣을 수 있습니다."
    });
    if (ready) {
      const card = contentEl.createDiv({ cls: "snm-setup-dependency-card" });
      const heading = card.createEl("strong", { text: `Google OAuth JSON 등록됨 · ${this.plugin.settings.googleClientId}` });
      if (googleConnected && permissionInfo.badge) {
        heading.createSpan({
          cls: permissionInfo.hasDownloadPermission ? "snm-scope-badge is-valid" : "snm-scope-badge is-warning",
          text: permissionInfo.badge
        });
      }
      const desc = googleConnected
        ? `계정: ${this.plugin.settings.googleAccountEmail || "연결됨"}${permissionInfo.permissionLabel ? ` · ${permissionInfo.permissionLabel}` : ""}`
        : "OAuth JSON이 성공적으로 등록되었습니다. 티켓 생성 시 Google Drive 문서 자동 검색을 사용할 수 있습니다.";
      card.createEl("p", { text: desc });
      const actions = card.createDiv({ cls: "snm-setup-inline-actions" });
      if (googleConnected && permissionInfo.needsReauth) {
        const reauthButton = actions.createEl("button", {
          cls: "mod-cta mod-warning",
          text: "재인증 필요 (다운로드 권한 추가)"
        });
        reauthButton.addEventListener("click", () => this.plugin.connectGoogleDrive());
      }
      const fileButton = actions.createEl("button", { text: "OAuth JSON 교체" });
      fileButton.addEventListener("click", () => this.plugin.importGoogleOAuthJson(() => {
        this.statusMessage = "Google OAuth JSON을 등록했습니다.";
        this.render();
      }));
      const removeButton = actions.createEl("button", { text: "JSON 제거" });
      removeButton.addEventListener("click", async () => {
        this.plugin.settings.googleClientId = "";
        this.plugin.setSecret(GOOGLE_CLIENT_SECRET_KEY, "");
        await this.plugin.savePluginData();
        this.statusMessage = "Google OAuth JSON을 제거했습니다.";
        this.render();
      });
      contentEl.createDiv({ cls: "snm-setup-note", text: "Google 계정 연결은 초기 설정 완료 후 일반 설정에서도 언제든 진행할 수 있습니다." });
      return;
    }

    const actions = contentEl.createDiv({ cls: "snm-setup-inline-actions" });
    const fileButton = actions.createEl("button", { text: "OAuth JSON 파일 선택" });
    fileButton.addEventListener("click", () => this.plugin.importGoogleOAuthJson(() => {
      this.statusMessage = "Google OAuth JSON을 등록했습니다.";
      this.render();
    }));
    const textarea = contentEl.createEl("textarea", { cls: "snm-setup-json-input" });
    textarea.setAttr("placeholder", "또는 Google Desktop OAuth JSON 원문 붙여넣기");
    textarea.value = this.googleJsonValue;
    textarea.addEventListener("input", () => { this.googleJsonValue = textarea.value; });
    contentEl.createDiv({ cls: "snm-setup-note", text: "JSON을 붙여넣은 경우 ‘다음’을 누를 때 자동으로 검증하고 저장합니다. 비워 두면 이 단계를 건너뜁니다." });
    const pasteButton = contentEl.createEl("button", { text: "붙여넣은 JSON 등록" });
    pasteButton.addEventListener("click", async () => {
      pasteButton.disabled = true;
      try {
        await this.plugin.applyGoogleOAuthJson(JSON.parse(this.googleJsonValue));
        this.googleJsonValue = "";
        this.statusMessage = "Google OAuth JSON을 등록했습니다. 설정에서 Google 계정 연결을 계속할 수 있습니다.";
      } catch (error) {
        this.statusMessage = `Google OAuth JSON 등록 실패: ${error.message || error}`;
      }
      this.render();
    });
    contentEl.createDiv({ cls: "snm-setup-note", text: "Google 계정을 연결하지 않아도 ServiceNow, 로컬 노트, 업무현황과 To-Do 기능은 사용할 수 있습니다." });
  }

  renderOrganizationPack(contentEl) {
    const ready = this.plugin.hasOrganizationPack();
    contentEl.createEl("p", {
      text: "업무가이드팩이 있나요? 조직에서 별도로 제공한 업무가이드팩이 있으면 등록하세요. 상태별 업무 가이드와 조직 AI 템플릿은 팩이 있을 때만 표시됩니다."
    });
    if (ready) {
      const card = contentEl.createDiv({ cls: "snm-setup-dependency-card" });
      const version = this.plugin.organizationPack.version ? ` · v${this.plugin.organizationPack.version}` : "";
      card.createEl("strong", { text: `업무가이드팩 등록됨 · ${this.plugin.organizationPack.name}${version}` });
      card.createEl("p", { text: `팩 ID: ${this.plugin.organizationPack.packId || "custom"} · 상태별 가이드 및 AI 프롬프트가 활성화됩니다.` });
      const actions = card.createDiv({ cls: "snm-setup-inline-actions" });
      const fileButton = actions.createEl("button", { text: "업무가이드팩 교체" });
      fileButton.addEventListener("click", () => this.plugin.importOrganizationPack(() => {
        this.statusMessage = "업무가이드팩을 등록했습니다.";
        this.render();
      }));
      const removeButton = actions.createEl("button", { text: "팩 제거" });
      removeButton.addEventListener("click", async () => {
        await this.plugin.removeOrganizationPack(() => {
          this.statusMessage = "업무가이드팩을 제거했습니다.";
          this.render();
        });
      });
      contentEl.createDiv({ cls: "snm-setup-note", text: "업무가이드팩이 없어도 ServiceNow 조회, 워킹노트, 업무현황과 To-Do는 정상적으로 사용할 수 있습니다." });
      return;
    }

    const actions = contentEl.createDiv({ cls: "snm-setup-inline-actions" });
    const fileButton = actions.createEl("button", { text: "업무가이드팩 파일 선택" });
    fileButton.addEventListener("click", () => this.plugin.importOrganizationPack(() => {
      this.statusMessage = "업무가이드팩을 등록했습니다.";
      this.render();
    }));
    const textarea = contentEl.createEl("textarea", { cls: "snm-setup-json-input" });
    textarea.setAttr("placeholder", "또는 업무가이드팩 JSON 원문 붙여넣기");
    textarea.value = this.organizationPackValue;
    textarea.addEventListener("input", () => { this.organizationPackValue = textarea.value; });
    contentEl.createDiv({ cls: "snm-setup-note", text: "업무가이드팩을 붙여넣은 경우 ‘다음’을 누를 때 자동으로 검증하고 저장합니다. 비워 두면 건너뜁니다." });
    const pasteButton = contentEl.createEl("button", { text: "붙여넣은 업무가이드팩 등록" });
    pasteButton.addEventListener("click", async () => {
      pasteButton.disabled = true;
      try {
        const pack = await this.plugin.applyOrganizationPack(JSON.parse(this.organizationPackValue));
        const templateResult = this.plugin.lastOrganizationPackApplyResult || {};
        this.organizationPackValue = "";
        this.statusMessage = `업무가이드팩을 등록했습니다: ${pack.name}${templateResult.updated ? ` · 기본 템플릿 갱신 ${templateResult.updated}개` : ""}${templateResult.preserved ? ` · 사용자 수정 템플릿 보존 ${templateResult.preserved}개` : ""}`;
      } catch (error) {
        this.statusMessage = `업무가이드팩 등록 실패: ${error.message || error}`;
      }
      this.render();
    });
    contentEl.createDiv({ cls: "snm-setup-note", text: "업무가이드팩이 없어도 ServiceNow 조회, 워킹노트, 업무현황과 To-Do는 정상적으로 사용할 수 있습니다." });
  }

  renderSummary(contentEl) {
    const rows = [
      ["루트 폴더", this.plugin.rootFolder()],
      ["새 탭 기본 화면", this.plugin.isReadingViewDefault() ? "읽기 화면" : "편집 화면"],
      ["ServiceNow 주소", this.plugin.settings.instanceUrl || "나중에 설정"],
      ["ServiceNow 인증", this.plugin.settings.authMode === "oauth" ? "OAuth PKCE" : "Bearer Token"],
      ["ServiceNow Token", this.plugin.getSecret(ACCESS_TOKEN_KEY) ? "등록됨" : "나중에 설정"],
      ["Google OAuth JSON", this.plugin.settings.googleClientId && this.plugin.getSecret(GOOGLE_CLIENT_SECRET_KEY) ? "등록됨" : "사용 안 함 / 나중에 설정"],
      ["업무가이드팩", this.plugin.hasOrganizationPack() ? `${this.plugin.organizationPack.name}${this.plugin.organizationPack.version ? ` v${this.plugin.organizationPack.version}` : ""}` : "사용 안 함 / 나중에 설정"]
    ];
    const summary = contentEl.createDiv({ cls: "snm-setup-summary" });
    for (const [label, value] of rows) {
      const row = summary.createDiv({ cls: "snm-setup-summary-row" });
      row.createEl("strong", { text: label });
      row.createEl("span", { text: value });
    }
    contentEl.createEl("p", { text: "설정 완료 후에도 설정 → ServiceNow Manage → 초기 설정 도우미에서 다시 실행할 수 있습니다." });
  }

  async saveRootFolder() {
    const next = normalizePath(String(this.rootFolderValue || "").trim()).replace(/^\/+|\/+$/g, "") || "ServiceNow";
    this.plugin.settings.rootFolder = next;
    await this.plugin.savePluginData();
  }

  async saveCurrentStep() {
    if (this.step === 0) return this.saveRootFolder();
    if (this.step === 1) {
      await this.plugin.setReadingViewDefault(this.readingViewDefaultValue, { notify: false });
      return this.plugin.setShowAllFileTypes(true, { notify: false });
    }
    if (this.step === 3) return this.saveServiceNow();
    if (this.step === 4 && this.googleJsonValue.trim()) {
      await this.plugin.applyGoogleOAuthJson(JSON.parse(this.googleJsonValue));
      this.googleJsonValue = "";
      return;
    }
    if (this.step === 5 && this.organizationPackValue.trim()) {
      await this.plugin.applyOrganizationPack(JSON.parse(this.organizationPackValue));
      this.organizationPackValue = "";
    }
  }

  async saveServiceNow() {
    this.plugin.settings.instanceUrl = cleanInstanceUrl(this.instanceUrlValue);
    this.plugin.settings.authMode = this.authModeValue;
    this.plugin.settings.clientId = this.clientIdValue;
    this.plugin.settings.oauthScope = this.oauthScopeValue;
    const token = cleanBearerToken(this.tokenValue);
    if (this.authModeValue === "bearer" && this.tokenValue && token.length < 20) throw new Error("올바른 Bearer Token을 입력하세요.");
    if (token) {
      await this.plugin.saveManualBearerToken(token);
      this.tokenValue = "";
    } else {
      await this.plugin.savePluginData();
    }
  }

  async complete(finished) {
    this.finished = true;
    this.plugin.settings.setupWizardVersion = FIRST_RUN_SETUP_VERSION;
    await this.plugin.savePluginData();
    if (finished) {
      await this.plugin.ensureWorkspaceScaffold();
      new Notice("ServiceNow Manage 초기 설정을 완료했습니다.", 6000);
    } else {
      new Notice("초기 설정을 닫았습니다. 설정에서 언제든 다시 열 수 있습니다.", 6000);
    }
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

class WorkNotesSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.plugin.workNotesSettingTab = this;
  }

  display() {
    const { containerEl } = this;
    const scrollContainer = containerEl.closest(".vertical-tab-content") || containerEl.parentElement || containerEl;
    const savedScrollTop = scrollContainer?.scrollTop || containerEl.scrollTop || 0;
    containerEl.empty();

    new Setting(containerEl)
      .setName("초기 설정 도우미")
      .setDesc("ServiceNow 주소·Token, 선택 Google OAuth JSON과 업무가이드팩을 단계별로 다시 확인합니다.")
      .addButton((button) => button
        .setButtonText("다시 열기")
        .setCta()
        .onClick(() => this.plugin.openSetupWizard()));

    new Setting(containerEl)
      .setName("새 탭 기본 화면")
      .setDesc("읽기 화면을 선택하면 티켓 노트의 To-Do 보드와 작업 버튼이 새 탭에서 바로 표시됩니다. 기존에 열린 탭에는 영향을 주지 않습니다.")
      .addDropdown((dropdown) => dropdown
        .addOption("preview", "읽기 화면")
        .addOption("source", "편집 화면")
        .setValue(this.plugin.isReadingViewDefault() ? "preview" : "source")
        .onChange(async (value) => {
          await this.plugin.setReadingViewDefault(value === "preview");
        }));

    let pendingRootFolder = this.plugin.settings.rootFolder;
    new Setting(containerEl)
      .setName("루트 폴더")
      .setDesc("티켓·업무현황·업무가이드 템플릿이 위치할 기준 폴더입니다. 대상 폴더가 이미 있으면 기존 내용을 유지한 채 해당 폴더를 사용합니다.")
      .addText((text) => text
        .setPlaceholder("ServiceNow")
        .setValue(this.plugin.settings.rootFolder)
        .onChange((value) => { pendingRootFolder = value; }))
      .addButton((button) => button
        .setButtonText("적용")
        .setCta()
        .onClick(() => this.plugin.requestRootFolderChange(pendingRootFolder, () => this.display())));

    containerEl.createEl("h3", { text: "To-Do" });
    new Setting(containerEl)
      .setName("To-Do 상태 설정")
      .setDesc("상태 이름·사용 여부·순서를 업무현황과 원본 노트에 공통 적용합니다.")
      .addButton(button => button.setButtonText("상태 설정").onClick(() => this.plugin.openTodoWorkflowSettings()));
    containerEl.createEl("h3", { text: "업무가이드팩" });
    containerEl.createEl("p", {
      text: "상태별 업무 가이드, 조직 전용 SLA와 AI 분석 템플릿은 공개 플러그인에 포함되지 않습니다. 조직에서 제공한 ServiceNow Manage 업무가이드팩(JSON)을 별도로 가져오세요."
    });
    const organizationPackReady = this.plugin.hasOrganizationPack();
    const organizationPackSetting = new Setting(containerEl)
      .setName("업무가이드팩")
      .setDesc(organizationPackReady
        ? `등록됨 · ${this.plugin.organizationPack.name} (${this.plugin.organizationPack.packId})${this.plugin.organizationPack.version ? ` · v${this.plugin.organizationPack.version}` : ""}`
        : "등록되지 않음 · 기본 ServiceNow 및 To-Do 기능은 계속 사용할 수 있습니다.");
    organizationPackSetting.addButton((button) => button
      .setButtonText(organizationPackReady ? "팩 교체" : "JSON 가져오기")
      .setCta()
      .onClick(() => this.plugin.importOrganizationPack(() => this.display())));
    organizationPackSetting.addButton((button) => button
      .setButtonText("팩 제거")
      .setDisabled(!organizationPackReady)
      .onClick(() => this.plugin.removeOrganizationPack(() => this.display())));

    new Setting(containerEl)
      .setName("업무가이드 기능 표시")
      .setDesc("등록된 팩의 상태 가이드, SLA 규칙과 AI 프롬프트 기능을 표시합니다. 팩이 없으면 활성화할 수 없습니다.")
      .addToggle((toggle) => toggle
        .setDisabled(!organizationPackReady)
        .setValue(organizationPackReady && this.plugin.settings.organizationFeaturesEnabled)
        .onChange(async (value) => {
          this.plugin.settings.organizationFeaturesEnabled = organizationPackReady && value;
          if (this.plugin.settings.organizationFeaturesEnabled) await this.plugin.ensureOrganizationTemplates();
          await this.plugin.savePluginData();
          this.display();
        }));

    new Setting(containerEl)
      .setName("ServiceNow 주소")
      .setDesc("https://회사인스턴스.service-now.com 형식만 입력합니다. /now 또는 화면 경로는 제외합니다.")
      .addText((text) => text
        .setPlaceholder("https://your-instance.service-now.com")
        .setValue(this.plugin.settings.instanceUrl)
        .onChange(async (value) => {
          this.plugin.settings.instanceUrl = cleanInstanceUrl(value);
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("인증 방식")
      .setDesc("관리자 등록이 없으면 기존 Bearer Token 직접 입력을 사용하세요.")
      .addDropdown((dropdown) => dropdown
        .addOption("bearer", "기존 Bearer Token 직접 입력")
        .addOption("oauth", "OAuth PKCE 로그인")
        .setValue(this.plugin.settings.authMode)
        .onChange(async (value) => {
          this.plugin.settings.authMode = value;
          await this.plugin.savePluginData();
          this.display();
        }));

    if (this.plugin.settings.authMode === "oauth") {
      new Setting(containerEl)
        .setName("OAuth client ID")
        .setDesc("ServiceNow 관리자가 발급한 Public Client ID. Client Secret은 입력하지 않습니다.")
        .addText((text) => text
          .setPlaceholder("관리자 발급 후 입력")
          .setValue(this.plugin.settings.clientId)
          .onChange(async (value) => {
            this.plugin.settings.clientId = value.trim();
            await this.plugin.savePluginData();
          }));

      new Setting(containerEl)
        .setName("OAuth scope")
        .setDesc("관리자가 지정한 읽기 전용 scope. 지정받지 않았다면 비워둘 수 있습니다.")
        .addText((text) => text
          .setPlaceholder("예: clt_worknotes_read")
          .setValue(this.plugin.settings.oauthScope)
          .onChange(async (value) => {
            this.plugin.settings.oauthScope = value.trim();
            await this.plugin.savePluginData();
          }));

      new Setting(containerEl)
        .setName("OAuth callback URL")
        .setDesc("ServiceNow Application Registry에 동일하게 등록해야 합니다. 기본값은 이 PC의 로컬 주소입니다.")
        .addText((text) => text
          .setPlaceholder("http://127.0.0.1:42813/oauth/callback")
          .setValue(this.plugin.settings.redirectUri)
          .onChange(async (value) => {
            this.plugin.settings.redirectUri = value.trim();
            await this.plugin.savePluginData();
          }));
    }



    containerEl.createEl("h3", { text: "고급 ServiceNow API 설정" });
    containerEl.createEl("p", { text: "회사별 ServiceNow 테이블 이름이 다를 때만 변경하세요." });
    for (const [key, label, placeholder] of [
      ["changeRequestTable", "CR 테이블", "change_request"],
      ["serviceRequestTable", "SR 테이블", "u_service_call"],
      ["incidentTable", "Incident 테이블", "incident"]
    ]) {
      new Setting(containerEl)
        .setName(label)
        .addText((input) => input
          .setPlaceholder(placeholder)
          .setValue(this.plugin.settings[key] || placeholder)
          .onChange(async (value) => {
            this.plugin.settings[key] = String(value || "").trim() || placeholder;
            await this.plugin.savePluginData();
          }));
    }

    new Setting(containerEl)
      .setName("새 티켓 워킹노트 자동 생성")
      .setDesc(`${this.plugin.settings.rootFolder}/티켓/<Ticket ID>/<Ticket ID>.md 형식의 새 CR/SR 원본 노트에 워킹노트를 만들고 링크 속성을 자동 추가합니다.`)
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoCreateWorkNotes)
        .onChange(async (value) => {
          this.plugin.settings.autoCreateWorkNotes = value;
          await this.plugin.savePluginData();
        }));

    let pendingWorkNotesFolder = this.plugin.settings.workNotesFolder;
    new Setting(containerEl)
      .setName("워킹노트 생성 폴더")
      .setDesc("적용을 누르면 기존 워킹노트도 새 폴더로 이동합니다. 비우고 적용하면 각 티켓 노트 폴더로 되돌립니다.")
      .addText((text) => text
        .setPlaceholder("예: ServiceNow/워킹노트")
        .setValue(this.plugin.settings.workNotesFolder)
        .onChange((value) => { pendingWorkNotesFolder = value; }))
      .addButton((button) => button
        .setButtonText("적용")
        .setCta()
        .onClick(() => this.plugin.requestWorkNotesFolderChange(pendingWorkNotesFolder, () => this.display())));

    new Setting(containerEl)
      .setName("문서 자동화 사용")
      .setDesc("Description의 BS 링크와 Google Drive의 FS·DS·UT 문서 검색 기능을 표시합니다. 회사별 문서 규칙이 다르면 끌 수 있습니다.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.enableDocumentAutomation)
        .onChange(async (value) => {
          this.plugin.settings.enableDocumentAutomation = value;
          await this.plugin.savePluginData();
          this.display();
        }));

    new Setting(containerEl)
      .setName("새 티켓 문서 링크 자동 검색")
      .setDesc("새 CR/SR 티켓을 처음 만들 때만 BS·FS·DS·UT를 검색합니다. 끄더라도 티켓 노트의 문서 갱신 버튼으로 직접 검색할 수 있습니다.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoDocumentSearchOnNewTicket)
        .onChange(async (value) => {
          this.plugin.settings.autoDocumentSearchOnNewTicket = value;
          await this.plugin.savePluginData();
        }));

    containerEl.createEl("h3", { text: "Google Drive 문서 연결" });
    containerEl.createEl("p", {
      text: "선택 기능입니다. 파일명 규칙에 맞는 FS·DS·UT 검색과 AI 분석용 원본 다운로드에 사용합니다. BS처럼 별도 권한이 필요한 문서는 사용자가 직접 내려받을 수 있습니다."
    });
    const googleCredentialsReady = Boolean(
      this.plugin.settings.googleClientId && this.plugin.getSecret(GOOGLE_CLIENT_SECRET_KEY)
    );
    new Setting(containerEl)
      .setName("Google OAuth 설정")
      .setDesc(googleCredentialsReady
        ? `OAuth JSON 등록됨 · ${this.plugin.settings.googleClientId}`
        : "Google Cloud Console에서 받은 Desktop OAuth JSON 파일을 먼저 선택하세요.")
      .addButton((button) => button
        .setButtonText("OAuth JSON 선택")
        .onClick(() => this.plugin.importGoogleOAuthJson(() => this.display())));
    const googleConnected = Boolean(this.plugin.getSecret(GOOGLE_REFRESH_TOKEN_KEY) || this.plugin.getSecret(GOOGLE_ACCESS_TOKEN_KEY));
    const permissionInfo = this.plugin.getGooglePermissionInfo();

    if (googleConnected && !this.plugin.settings.googleGrantedScopes) {
      void this.plugin.inspectGoogleTokenScopes().then((result) => {
        if (result.success && this.containerEl.isShown()) {
          this.display();
        }
      });
    }

    const descLines = [];
    if (googleConnected) {
      descLines.push(`${this.plugin.settings.googleAccountEmail || "연결됨"}${this.plugin.settings.googleConnectedAt ? ` · ${this.plugin.settings.googleConnectedAt}` : ""}`);
      if (permissionInfo.permissionLabel) {
        descLines.push(`보유 권한: ${permissionInfo.permissionLabel}`);
      }
    } else {
      descLines.push("연결되지 않음");
    }

    const googleConnection = new Setting(containerEl)
      .setName("Google 계정")
      .setDesc(descLines.join(" · "));

    if (googleConnected && permissionInfo.badge) {
      googleConnection.nameEl.createSpan({
        cls: permissionInfo.hasDownloadPermission ? "snm-scope-badge is-valid" : "snm-scope-badge is-warning",
        text: permissionInfo.badge
      });
    }

    const connectButtonText = !googleConnected
      ? "Google 계정 연결"
      : permissionInfo.needsReauth
        ? "재인증 필요 (권한 추가)"
        : "다시 연결";

    googleConnection.addButton((button) => {
      button
        .setButtonText(connectButtonText)
        .setCta()
        .setDisabled(!googleCredentialsReady)
        .onClick(() => this.plugin.connectGoogleDrive());
      if (googleConnected && permissionInfo.needsReauth) {
        button.buttonEl.addClass("mod-warning");
      }
    });
    googleConnection.addButton((button) => button
      .setButtonText("연결 해제")
      .setDisabled(!googleConnected)
      .onClick(async () => {
        await this.plugin.disconnectGoogleDrive();
        this.display();
      }));

    const statusSyncSetting = new Setting(containerEl)
      .setName("티켓 상태 하루 1회 자동 갱신")
      .setDesc(`Obsidian이 열려 있을 때 ${this.plugin.settings.rootFolder}/티켓의 상태·기본정보·워킹노트를 지정 시간 이후 하루 한 번 갱신합니다.`)
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoStatusSync)
        .onChange(async (value) => {
          this.plugin.settings.autoStatusSync = value;
          await this.plugin.savePluginData();
          if (value) this.plugin.runDailyStatusSyncIfDue();
          this.display();
        }));
    if (this.plugin.settings.autoStatusSync) {
      statusSyncSetting.addText((text) => {
        text.inputEl.type = "time";
        text.setValue(this.plugin.settings.statusSyncTime || "09:00");
        text.onChange(async (value) => {
          if (!/^\d{2}:\d{2}$/.test(value)) return;
          this.plugin.settings.statusSyncTime = value;
          await this.plugin.savePluginData();
        });
      });
    }

    new Setting(containerEl)
      .setName("워킹노트 자동 갱신")
      .setDesc("Obsidian이 열려 있을 때 등록된 티켓의 상태·기본정보와 워킹노트를 자동 갱신합니다.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoSync)
        .onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("워킹노트 매 정각 갱신")
      .setDesc("워킹노트 자동 갱신이 켜진 경우 상태·기본정보·워킹노트를 매 정각에 순차적으로 갱신합니다.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.syncAtTopOfHour)
        .onChange(async (value) => {
          this.plugin.settings.syncAtTopOfHour = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("실행 시 누락분 갱신")
      .setDesc("마지막 성공 이후 날짜가 바뀌었으면 Obsidian 실행 후 상태·기본정보·워킹노트를 한 번 갱신합니다.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.catchUpOnOpen)
        .onChange(async (value) => {
          this.plugin.settings.catchUpOnOpen = value;
          await this.plugin.savePluginData();
        }));

    const translateApi = this.plugin.getTranslateApi();
    const translationSetting = new Setting(containerEl)
      .setName("번역 연동")
      .setDesc(translateApi?.canTranslate
        ? "Translate 플러그인이 연결되어 있습니다. 워킹노트 화면에서 한국어/베트남어 번역을 실행할 수 있습니다."
        : "Community Plugins에서 Translate를 설치·설정하면 워킹노트 번역을 사용할 수 있습니다.");
    translationSetting.addButton((button) => button
      .setButtonText(translateApi ? "Translate 설정 열기" : "Translate 설치하기")
      .onClick(() => this.plugin.openTranslateSetup()));

    const dataview = this.plugin.app.plugins?.plugins?.dataview;
    const dataviewJsEnabled = dataview ? dataview.settings?.enableDataviewJs === true : false;
    const dataviewSetting = new Setting(containerEl)
      .setName("업무현황 필수 플러그인 · Dataview")
      .setDesc(dataview
        ? (dataviewJsEnabled
          ? "🟢 Dataview와 JavaScript Queries가 정상 활성화되어 있습니다."
          : "🔴 Dataview가 설치되어 있으나 ‘Enable JavaScript Queries’가 꺼져 있어 업무현황이 표시되지 않습니다.")
        : "Dataview가 설치되지 않았습니다. 업무 목록과 To-Do 보드를 표시하려면 설치가 필요합니다.");
    if (dataview && !dataviewJsEnabled) {
      dataviewSetting.addButton((button) => button
        .setButtonText("JavaScript Queries 즉시 켜기")
        .setCta()
        .onClick(async () => {
          try {
            dataview.settings.enableDataviewJs = true;
            if (typeof dataview.saveSettings === "function") await dataview.saveSettings();
            new Notice("Dataview JavaScript Queries를 활성화했습니다.", 5000);
          } catch (error) {
            new Notice(`Dataview 설정 실패: ${error.message || error}`, 7000);
          }
          this.display();
        }));
    }
    dataviewSetting.addButton((button) => button
      .setButtonText(dataview ? "Dataview 설정 열기" : "Dataview 설치하기")
      .onClick(() => this.plugin.openDataviewSetup()));

    new Setting(containerEl)
      .setName("업무현황 대시보드 템플릿")
      .setDesc("업무현황.md의 코드를 플러그인 최신 런타임(v2.6.8: 순서 변경 모드 및 노스크롤 팝업 지원)으로 갱신합니다.")
      .addButton((button) => button
        .setButtonText("대시보드 템플릿 갱신")
        .onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("갱신 중…");
          try {
            const updated = await this.plugin.forceUpgradeDashboard();
            if (updated) {
              new Notice("업무현황 대시보드를 최신 버전(v2.6.8)으로 갱신했습니다.", 6000);
            } else {
              new Notice("업무현황 대시보드가 이미 최신 버전(v2.6.8)입니다.", 5000);
            }
          } catch (error) {
            new Notice(`업무현황 갱신 실패: ${error.message || error}`, 8000);
          } finally {
            button.setDisabled(false);
            button.setButtonText("대시보드 템플릿 갱신");
          }
        }));

    const cachedYears = Object.keys(this.plugin.settings.holidayCache || {}).sort();
    const cachedCount = cachedYears.reduce(
      (count, year) => count + (this.plugin.settings.holidayCache?.[year]?.length || 0),
      0
    );
    const holidaySetting = new Setting(containerEl)
      .setName("공휴일")
      .setDesc(`Nager.Date 공개 자료로 대한민국 공휴일을 현재 연도와 다음 연도 기준으로 자동 관리합니다.${cachedYears.length ? ` 저장: ${cachedYears.join("·")}년 ${cachedCount}일` : " 아직 저장된 공휴일이 없습니다."}`)
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoHolidaySync)
        .onChange(async (value) => {
          this.plugin.settings.autoHolidaySync = value;
          await this.plugin.savePluginData();
          if (value) await this.plugin.syncHolidayCalendar({ notify: true, force: true });
          this.display();
        }));
    holidaySetting.addButton((button) => button
      .setButtonText("지금 갱신")
      .setDisabled(!this.plugin.settings.autoHolidaySync)
      .onClick(async () => {
        button.setDisabled(true);
        button.setButtonText("갱신 중…");
        await this.plugin.syncHolidayCalendar({ notify: true, force: true });
        this.display();
      }));

    new Setting(containerEl)
      .setName("추가 공휴일")
      .setDesc("회사 휴무일 또는 자동 목록의 누락분을 YYYY-MM-DD 형식으로 추가합니다.")
      .addTextArea((text) => text
        .setPlaceholder("2026-08-17, 2026-09-24")
        .setValue(this.plugin.settings.koreanHolidays)
        .onChange(async (value) => {
          this.plugin.settings.koreanHolidays = value;
          await this.plugin.savePluginData();
        }));

    const connected = Boolean(this.plugin.getSecret(ACCESS_TOKEN_KEY));
    const connection = new Setting(containerEl)
      .setName("ServiceNow 연결")
      .setDesc(connected
        ? `토큰 저장됨${this.plugin.settings.connectedAt ? ` · 마지막 확인 ${this.plugin.settings.connectedAt}` : ""}`
        : "연결되지 않음");
    connection.addButton((button) => button
      .setButtonText(this.plugin.settings.authMode === "bearer" ? (connected ? "토큰 교체" : "토큰 입력") : (connected ? "다시 연결" : "연결"))
      .setCta()
      .onClick(() => this.plugin.connectServiceNow()));
    connection.addButton((button) => button
      .setButtonText("ServiceNow 열기")
      .setDisabled(!this.plugin.settings.instanceUrl)
      .onClick(() => shell.openExternal(cleanInstanceUrl(this.plugin.settings.instanceUrl))));
    connection.addButton((button) => button
      .setButtonText("연결 확인")
      .setDisabled(!connected)
      .onClick(() => this.plugin.testConnection().catch((error) => new Notice(`연결 실패: ${error.message}`, 9000))));
    connection.addButton((button) => button
      .setButtonText("연결 해제")
      .setDisabled(!connected)
      .onClick(async () => {
        await this.plugin.disconnectServiceNow();
        this.display();
      }));

    if (savedScrollTop > 0) {
      window.requestAnimationFrame(() => {
        if (scrollContainer) scrollContainer.scrollTop = savedScrollTop;
        if (containerEl) containerEl.scrollTop = savedScrollTop;
      });
    }
  }
}

class CltServiceNowWorkNotes extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    const savedSettings = saved.settings || {};
    const detectedRoot = Object.prototype.hasOwnProperty.call(savedSettings, "rootFolder")
      ? savedSettings.rootFolder
      : "ServiceNow";
    this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings, { rootFolder: detectedRoot || "ServiceNow" });
    this.data = {
      tickets: saved.tickets || {},
      todoMetadataVersion: Number(saved.todoMetadataVersion || 0)
    };
    this.organizationPack = await this.loadOrganizationPack();
    if (!this.organizationPack) this.settings.organizationFeaturesEnabled = false;
    else if (!Object.prototype.hasOwnProperty.call(savedSettings, "organizationFeaturesEnabled")) {
      this.settings.organizationFeaturesEnabled = true;
    }
    this.migrateLegacySecrets();
    this.views = new Map();
    this.syncing = new Set();
    this.statusSyncing = new Set();
    this.dailyStatusSyncing = false;
    this.translating = new Set();
    this.lastAutomationHour = "";
    this.pendingOAuth = null;
    this.oauthServer = null;
    this.pendingGoogleOAuth = null;
    this.googleOAuthServer = null;
    this.pendingNewTicketFiles = new Set();
    this.autoLinking = new Set();
    this.knownStatus = new Map();
    this.updatingStatus = new Set();
    this.attachmentImageCache = new Map();
    this.linkingLocalBs = new Set();
    this.ticketNoticeQueue = [];
    this.ticketNoticeTimer = null;
    this.viewRefreshTimers = new Map();
    this.lastViewRefreshAt = new Map();
    this.workNotesSettingTab = null;

    this.addSettingTab(new WorkNotesSettingTab(this.app, this));
    this.addCommand({
      id: "open-setup-wizard",
      name: "초기 설정 도우미 열기",
      callback: () => this.openSetupWizard()
    });
    this.addCommand({
      id: "create-ticket-note",
      name: "새 CR/SR 티켓 노트 만들기",
      callback: () => new NewTicketModal(this.app, (ticketId) => this.createTicketNote(ticketId)).open()
    });
    this.addCommand({
      id: "set-ticket-status",
      name: "티켓 상태 변경 (SR/CR 자동 분류)",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) this.openStatePicker(file);
        return true;
      }
    });
    this.addCommand({
      id: "open-or-create-work-notes",
      name: "현재 티켓의 ServiceNow 워킹노트 열기/생성",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const ticketId = this.ticketIdFromFile(file);
        if (!file || !ticketId) return false;
        if (!checking) this.openOrCreateWorkNotes(file);
        return true;
      }
    });
    this.addCommand({
      id: "refresh-current-work-notes",
      name: "현재 워킹노트 ServiceNow에서 갱신",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const ticketId = this.ticketIdFromFile(file, true);
        if (!file || !ticketId) return false;
        if (!checking) this.syncTicket(ticketId, { notify: true });
        return true;
      }
    });
    this.addRibbonIcon("messages-square", "ServiceNow 워킹노트 열기/생성", () => {
      const file = this.app.workspace.getActiveFile();
      if (!file) return new Notice("티켓 노트를 먼저 여세요.");
      this.openOrCreateWorkNotes(file);
    });
    this.addRibbonIcon("file-plus-2", "새 CR/SR 티켓 노트 만들기", () => {
      new NewTicketModal(this.app, (ticketId) => this.createTicketNote(ticketId)).open();
    });
    this.addRibbonIcon("list-checks", "티켓 상태 변경", () => {
      const file = this.app.workspace.getActiveFile();
      if (file) this.openStatePicker(file);
    });
    for (const language of [PLUGIN_ID, LEGACY_PLUGIN_ID]) {
      this.registerMarkdownCodeBlockProcessor(language, (source, el, ctx) => {
        const configured = source.match(/^ticket:\s*(\S+)\s*$/m)?.[1];
        const ticketId = normalizeTicketId(configured || this.ticketIdFromPath(ctx.sourcePath));
        if (!ticketId) {
          el.createDiv({ cls: "clt-sn-empty", text: "유효한 ticket 번호가 없습니다." });
          return;
        }
        ctx.addChild(new WorkNotesRenderChild(el, this, ticketId));
      });
    }
    this.registerMarkdownCodeBlockProcessor("clt-ticket-status", (source, el, ctx) => {
      const configured = source.match(/^ticket:\s*(\S+)\s*$/m)?.[1];
      const ticketId = normalizeTicketId(configured || this.ticketIdFromPath(ctx.sourcePath));
      if (!ticketId) {
        el.createDiv({ cls: "clt-sn-empty", text: "유효한 ticket 번호가 없습니다." });
        return;
      }
      ctx.addChild(new TicketStatusRenderChild(el, this, ticketId));
    });
    this.registerMarkdownCodeBlockProcessor("clt-ticket-worklog-actions", (source, el, ctx) => {
      const configured = source.match(/^ticket:\s*(\S+)\s*$/m)?.[1];
      const ticketId = normalizeTicketId(configured || this.ticketIdFromPath(ctx.sourcePath));
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!ticketId || !(file instanceof TFile)) return;
      this.renderTicketSectionAction(el, file, ticketId, "worklog");
    });
    this.registerMarkdownCodeBlockProcessor("clt-ticket-meeting-actions", (source, el, ctx) => {
      const configured = source.match(/^ticket:\s*(\S+)\s*$/m)?.[1];
      const ticketId = normalizeTicketId(configured || this.ticketIdFromPath(ctx.sourcePath));
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!ticketId || !(file instanceof TFile)) return;
      ctx.addChild(new MeetingSectionRenderChild(el, this, ticketId));
    });
    this.registerMarkdownCodeBlockProcessor("clt-ticket-todo-actions", (source, el, ctx) => {
      const configured = source.match(/^ticket:\s*(\S+)\s*$/m)?.[1];
      const ticketId = normalizeTicketId(configured || this.ticketIdFromPath(ctx.sourcePath));
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!ticketId || !(file instanceof TFile)) return;
      this.renderTicketSectionAction(el, file, ticketId, "todo");
    });
    this.registerMarkdownPostProcessor(async (el, ctx) => {
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      const frontmatter = file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter || {} : {};
      if (String(frontmatter.meeting_kind || "").toLowerCase() === "analysis") {
        const headings = [
          ...(el.matches?.("h1, h2, h3, h4, h5, h6") ? [el] : []),
          ...el.querySelectorAll("h1, h2, h3, h4, h5, h6")
        ];
        const actionHeading = headings.find((heading) => /(?:action items|할\s*일|액션\s*아이템)/i.test(String(heading.textContent || "")));
        if (actionHeading && !actionHeading.querySelector(".clt-meeting-action-create")) {
          const button = actionHeading.createEl("button", { cls: "clt-meeting-action-create", text: "＋ To-Do로 만들기", attr: { type: "button" } });
          button.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const markdown = await this.app.vault.cachedRead(file);
            const items = extractMeetingActionItems(markdown);
            if (!items.length) return new Notice("Action Items에서 생성할 할 일을 찾지 못했습니다.");
            new MeetingActionItemsModal(this.app, this, normalizeTicketId(frontmatter.ticket || this.ticketIdFromPath(ctx.sourcePath)), items).open();
          });
        }
      }
      const ticketId = this.rootTicketIdFromFile(file) || this.rootTicketIdFromPathStructure(file);
      if (!ticketId) return;
      const mountTodoBoards = async () => {
        const taskItems = [
          ...(el.matches?.("li.task-list-item") ? [el] : []),
          ...el.querySelectorAll("li.task-list-item")
        ];
        if (!taskItems.length) return;
        const tasks = await this.readTodoTasks(ticketId);
        const matchedItems = taskItems.filter((item) => {
          const rendered = String(item.textContent || "").replace(/\s+/g, " ").trim();
          const dateTime = rendered.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/)?.[0] || "";
          return tasks.some((task) => task.dateTime === dateTime);
        });
        const lists = [...new Set(matchedItems
          .map((item) => item.closest("ul.contains-task-list, ul.task-list"))
          .filter(Boolean))];
        for (const list of lists) this.renderTicketTodoBoard(list, ticketId, tasks);
      };
      const mountWorkLogCards = async () => {
        const markdown = await this.app.vault.cachedRead(file);
        const workLogs = extractTicketWorkLogs(markdown);
        if (!workLogs.length) return;
        const logTimes = new Set(workLogs.map((entry) => entry.dateTime).filter(Boolean));
        const listItems = [
          ...(el.matches?.("li:not(.task-list-item)") ? [el] : []),
          ...el.querySelectorAll("li:not(.task-list-item)")
        ];
        const lists = [...new Set(listItems
          .filter((item) => {
            const dateTime = String(item.textContent || "").match(/\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?/)?.[0] || "";
            return logTimes.has(dateTime);
          })
          .map((item) => item.closest("ul"))
          .filter((list) => list && !list.matches("ul.contains-task-list, ul.task-list")))];
        for (const list of lists) this.renderTicketWorkLogCards(list, ticketId, workLogs, file.path);
      };
      await mountTodoBoards();
      await mountWorkLogCards();
      window.setTimeout(() => mountTodoBoards(), 120);
      window.setTimeout(() => mountWorkLogCards(), 120);
    });
    this.registerDomEvent(document, "click", (event) => {
      this.handleLivePreviewTodoClick(event);
    });

    this.registerEvent(this.app.vault.on("create", (file) => {
      if (!(file instanceof TFile)) return;
      if (file.extension !== "md") {
        window.setTimeout(() => this.onTicketAssetChanged(file), 700);
        return;
      }
      this.pendingNewTicketFiles.add(file.path);
      window.setTimeout(() => this.autoCreateWorkNotesForFile(file), 500);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.pendingNewTicketFiles.delete(oldPath);
      if (!(file instanceof TFile)) return;
      if (file.extension !== "md") {
        window.setTimeout(() => this.onTicketAssetChanged(file), 500);
        return;
      }
      this.pendingNewTicketFiles.add(file.path);
      window.setTimeout(() => this.autoCreateWorkNotesForFile(file), 300);
    }));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      if (this.pendingNewTicketFiles.has(file.path)) this.autoCreateWorkNotesForFile(file);
      this.onTicketMetadataChanged(file);
    }));

    this.app.vault.getMarkdownFiles().forEach((file) => {
      const status = this.app.metadataCache.getFileCache(file)?.frontmatter?.status;
      if (status) this.knownStatus.set(file.path, String(status));
    });

    this.addCommand({
      id: "force-refresh-dashboard",
      name: "업무현황 대시보드를 최신 버전(v2.6.8)으로 갱신",
      callback: async () => {
        try {
          const updated = await this.forceUpgradeDashboard();
          if (updated) {
            new Notice("업무현황 대시보드를 최신 버전(v2.6.8)으로 갱신했습니다.", 6000);
          } else {
            new Notice("업무현황 대시보드가 이미 최신 버전(v2.6.8)입니다.", 5000);
          }
        } catch (error) {
          new Notice(`업무현황 갱신 실패: ${error.message || error}`, 8000);
        }
      }
    });

    const initLayout = async () => {
      await this.ensureWorkspaceScaffold();
      await this.migrateDeploymentFinishFields();
      await this.migrateMeetingParentLinks();
      await this.normalizeTodoMetadataOnce();
      await this.linkExistingLocalBsDocuments();
      await this.repairMalformedRootTickets();
      if (this.settings.autoHolidaySync) {
        window.setTimeout(() => this.syncHolidayCalendar(), 1000);
      }
      window.setTimeout(() => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) this.autoCreateWorkNotesForFile(activeFile, true);
      }, 800);
      window.setTimeout(() => this.ensureStatusBlocksForAllRootTickets(), 1200);
      if (this.settings.autoSync && this.settings.catchUpOnOpen) {
        window.setTimeout(() => this.runCatchUpSync(), 1500);
      }
      if (this.settings.autoStatusSync) {
        window.setTimeout(() => this.runDailyStatusSyncIfDue(), 2200);
      }
      window.setTimeout(() => this.syncUninitializedTickets(), 2800);
      if (Number(this.settings.setupWizardVersion || 0) < FIRST_RUN_SETUP_VERSION) {
        window.setTimeout(() => this.openSetupWizard(), 600);
      }
    };

    if (this.app.workspace.layoutReady) {
      void initLayout();
    } else {
      this.app.workspace.onLayoutReady(initLayout);
    }
    this.registerInterval(window.setInterval(() => this.automationTick(), 60 * 1000));
  }

  onunload() {
    if (this.ticketNoticeTimer) window.clearTimeout(this.ticketNoticeTimer);
    this.todoBoardViews?.clear();
    this.viewRefreshTimers?.forEach((timer) => window.clearTimeout(timer));
    this.viewRefreshTimers?.clear();
    if (this.oauthServer) {
      try { this.oauthServer.close(); } catch (_) { /* no-op */ }
    }
    if (this.googleOAuthServer) {
      try { this.googleOAuthServer.close(); } catch (_) { /* no-op */ }
    }
  }

  async savePluginData() {
    await this.saveData({
      settings: this.settings,
      tickets: this.data.tickets,
      todoMetadataVersion: this.data.todoMetadataVersion || 0
    });
  }

  openSetupWizard() {
    new FirstRunSetupModal(this.app, this).open();
  }

  getTodoWorkflow() {
    const workflow = normalizeTodoWorkflow(this.settings.todoWorkflow);
    return workflow.some(state => state.enabled) ? workflow : normalizeTodoWorkflow([]);
  }

  assertTodoStatusEnabled(status) {
    if (!this.getTodoWorkflow().some(state => state.key === status && state.enabled)) {
      throw new Error("사용하지 않는 To-Do 상태입니다. 활성 상태를 선택하거나 상태 설정을 변경해 주세요.");
    }
  }

  async saveTodoWorkflow(value) {
    const workflow = normalizeTodoWorkflow(value);
    if (!workflow.some(state => state.enabled)) throw new Error("최소 한 개의 상태는 사용해야 합니다.");
    const previous = this.settings.todoWorkflow;
    this.settings.todoWorkflow = workflow;
    try { await this.savePluginData(); }
    catch (error) { this.settings.todoWorkflow = previous; throw error; }
    this.refreshTodoWorkflowViews();
    this.app.workspace.trigger("servicenow-manage:todo-workflow-changed");
    return workflow;
  }

  refreshTodoWorkflowViews() {
    for (const [list, value] of [...(this.todoBoardViews || [])]) {
      if (!list.isConnected) { this.todoBoardViews.delete(list); continue; }
      this.renderTicketTodoBoard(list, value.ticketId, value.tasks);
    }
  }

  openTodoWorkflowSettings() { new TodoWorkflowSettingsModal(this.app, this).open(); }
  openInactiveTodoModal(tasks) { new InactiveTodoModal(this.app, this, tasks).open(); }

  isReadingViewDefault() {
    return this.app.vault.getConfig?.("defaultViewMode") === "preview";
  }

  async setReadingViewDefault(enabled, options = {}) {
    if (typeof this.app.vault.setConfig !== "function") {
      throw new Error("현재 Obsidian 버전에서는 새 탭 기본 화면을 자동으로 변경할 수 없습니다. 설정 → 편집기 → 새 탭 기본 화면에서 직접 변경해 주세요.");
    }
    await Promise.resolve(this.app.vault.setConfig("defaultViewMode", enabled ? "preview" : "source"));
    if (options.notify !== false) {
      new Notice(`새 탭 기본 화면을 ${enabled ? "읽기 화면" : "편집 화면"}으로 변경했습니다. 이미 열린 탭에는 적용되지 않습니다.`, 6000);
    }
  }

  isShowingAllFileTypes() {
    return this.app.vault.getConfig?.("showUnsupportedFiles") === true;
  }

  async setShowAllFileTypes(enabled, options = {}) {
    if (typeof this.app.vault.setConfig !== "function") {
      throw new Error("현재 Obsidian 버전에서는 모든 파일 형식 표시를 자동으로 변경할 수 없습니다. 설정 → 파일 및 링크 → 모든 파일 형식 표시를 직접 켜 주세요.");
    }
    await Promise.resolve(this.app.vault.setConfig("showUnsupportedFiles", Boolean(enabled)));
    if (options.notify !== false) {
      new Notice(`모든 파일 형식 표시를 ${enabled ? "활성화" : "비활성화"}했습니다.`, 5000);
    }
  }

  queueTicketChangeNotice({ kind = "other", ticketId = "", message = "", failed = false, duration = 7000 }) {
    this.ticketNoticeQueue.push({ kind, ticketId, message, failed, duration });
    if (this.ticketNoticeTimer) window.clearTimeout(this.ticketNoticeTimer);
    this.ticketNoticeTimer = window.setTimeout(() => this.flushTicketChangeNotices(), 7000);
  }

  flushTicketChangeNotices() {
    const entries = this.ticketNoticeQueue.splice(0);
    this.ticketNoticeTimer = null;
    if (!entries.length) return;
    if (entries.length < 3) {
      for (const entry of entries) new Notice(entry.message, entry.duration);
      return;
    }
    new Notice(summarizeTicketNotices(entries), 9000);
  }

  getSecret(key) {
    return this.app.secretStorage?.getSecret?.(key) || "";
  }

  setSecret(key, value) {
    if (!this.app.secretStorage?.setSecret) {
      throw new Error("현재 Obsidian 버전에서 SecretStorage를 사용할 수 없습니다. Obsidian을 업데이트하세요.");
    }
    this.app.secretStorage.setSecret(key, value || "");
  }

  deleteSecret(key) {
    if (this.app.secretStorage?.deleteSecret) this.app.secretStorage.deleteSecret(key);
    else if (this.app.secretStorage?.setSecret) this.app.secretStorage.setSecret(key, "");
  }

  migrateLegacySecrets() {
    const pairs = [
      [`${LEGACY_PLUGIN_ID}-access-token`, ACCESS_TOKEN_KEY],
      [`${LEGACY_PLUGIN_ID}-refresh-token`, REFRESH_TOKEN_KEY],
      [`${LEGACY_PLUGIN_ID}-google-access-token`, GOOGLE_ACCESS_TOKEN_KEY],
      [`${LEGACY_PLUGIN_ID}-google-refresh-token`, GOOGLE_REFRESH_TOKEN_KEY],
      [`${LEGACY_PLUGIN_ID}-google-client-secret`, GOOGLE_CLIENT_SECRET_KEY]
    ];
    for (const [legacyKey, currentKey] of pairs) {
      const legacyValue = this.getSecret(legacyKey);
      if (legacyValue && !this.getSecret(currentKey)) this.setSecret(currentKey, legacyValue);
    }
  }

  registerView(ticketId, view) {
    if (!this.views.has(ticketId)) this.views.set(ticketId, new Set());
    this.views.get(ticketId).add(view);
  }

  unregisterView(ticketId, view) {
    this.views.get(ticketId)?.delete(view);
  }

  refreshViews(ticketId) {
    this.views.get(ticketId)?.forEach((view) => view.render());
  }

  scheduleViewRefresh(ticketId, kind) {
    const normalized = normalizeTicketId(ticketId);
    if (!normalized) return;
    const key = `${kind}:${normalized}`;
    const previousTimer = this.viewRefreshTimers.get(key);
    if (previousTimer) window.clearTimeout(previousTimer);
    const timer = window.setTimeout(() => {
      this.viewRefreshTimers.delete(key);
      const now = Date.now();
      const lastRefresh = Number(this.lastViewRefreshAt.get(key) || 0);
      if (now - lastRefresh < 60 * 1000) return;
      this.lastViewRefreshAt.set(key, now);
      if (kind === "work-notes") void this.syncTicket(normalized);
      else void this.syncTicketStatus(normalized);
    }, 300);
    this.viewRefreshTimers.set(key, timer);
  }

  ticketIdFromPath(path) {
    const match = String(path || "").toUpperCase().match(/(?:^|\/)((?:CR|SR|INC)\d+)(?:\s+워킹노트)?\.MD$/);
    return match ? match[1] : "";
  }

  ticketIdFromFile(file, allowWorkNotes = false) {
    if (!(file instanceof TFile) || file.extension !== "md") return "";
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const fromTicket = normalizeTicketId(fm.ticket);
    if (allowWorkNotes && fromTicket) return fromTicket;
    const fromId = normalizeTicketId(fm.id);
    if (fromId) return fromId;
    return normalizeTicketId(file.basename.replace(/\s+워킹노트$/, ""));
  }

  async ensureFolder(path) {
    const normalized = normalizePath(path || "");
    if (!normalized || this.app.vault.getAbstractFileByPath(normalized)) return;
    const parts = normalized.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }

  rootFolder() {
    return normalizePath(String(this.settings.rootFolder || "ServiceNow").trim() || "ServiceNow");
  }

  ticketsFolder() {
    return normalizePath(`${this.rootFolder()}/티켓`);
  }

  ticketFolder(ticketId) {
    return normalizePath(`${this.ticketsFolder()}/${normalizeTicketId(ticketId)}`);
  }

  templateFolder() {
    return normalizePath(`${this.rootFolder()}/Templates`);
  }

  ticketTemplatePath() {
    return normalizePath(`${this.templateFolder()}/티켓 템플릿.md`);
  }

  workNotesTemplatePath() {
    return normalizePath(`${this.templateFolder()}/워킹노트 템플릿.md`);
  }

  aiPromptTemplatePath() {
    return normalizePath(`${this.rootFolder()}/지침/AI 내용.md`);
  }

  analysisTemplatePath(category) {
    const type = String(category || "").toUpperCase() === "SR" ? "SR" : "CR";
    return normalizePath(`${this.rootFolder()}/지침/${type}_TEMPLATE.md`);
  }

  absoluteVaultPath(vaultPath) {
    const relative = String(vaultPath || "");
    const base = typeof this.app.vault.adapter.getBasePath === "function"
      ? String(this.app.vault.adapter.getBasePath() || "")
      : "";
    if (!base) return relative;
    const separator = base.includes("\\") ? "\\" : "/";
    return `${base.replace(/[\\/]+$/, "")}${separator}${relative.replace(/[\\/]+/g, separator)}`;
  }

  documentsFolder() {
    return normalizePath(`${this.rootFolder()}/문서`);
  }

  ticketDocumentsFolder(ticketId) {
    return normalizePath(`${this.documentsFolder()}/${normalizeTicketId(ticketId)}`);
  }

  ticketAssetsFolder(ticketId) {
    return normalizePath(`${this.ticketFolder(ticketId)}/assets`);
  }

  ticketMeetingsFolder(ticketId) {
    return normalizePath(`${this.ticketFolder(ticketId)}/회의록`);
  }

  generalMeetingsFolder() {
    return normalizePath(`${this.rootFolder()}/회의록`);
  }

  dashboardPath() {
    return normalizePath(`${this.rootFolder()}/업무현황.md`);
  }

  async readBundledDashboard() {
    if (EMBEDDED_DASHBOARD_GZIP_BASE64) {
      try {
        return zlib.gunzipSync(Buffer.from(EMBEDDED_DASHBOARD_GZIP_BASE64, "base64")).toString("utf8");
      } catch (error) {
        console.error("[ServiceNow Manage] 내장 업무현황 데이터 해제 실패", error);
      }
    }
    const configDir = this.app.vault.configDir || ".obsidian";
    const path = normalizePath(`${configDir}/plugins/${PLUGIN_ID}/업무현황.md`);
    try {
      return await this.app.vault.adapter.read(path);
    } catch (error) {
      console.error("[ServiceNow Manage] 내장 업무현황 템플릿 읽기 실패", error);
      return "";
    }
  }

  async ensureWorkspaceScaffold() {
    await this.ensureFolder(this.ticketsFolder());
    await this.ensureTicketAssetFolders();
    await this.ensureFolder(this.templateFolder());
    await this.ensureFolder(normalizePath(`${this.rootFolder()}/지침`));
    if (!this.app.vault.getAbstractFileByPath(this.ticketTemplatePath())) {
      await this.app.vault.create(this.ticketTemplatePath(), defaultTicketTemplate());
    }
    await this.ensureTicketTemplateFields();
    if (!this.app.vault.getAbstractFileByPath(this.workNotesTemplatePath())) {
      await this.app.vault.create(this.workNotesTemplatePath(), defaultWorkNotesTemplate());
    }
    if (this.settings.organizationFeaturesEnabled && this.hasOrganizationPack()) {
      await this.ensureOrganizationTemplates();
    }
    if (!this.app.vault.getAbstractFileByPath(this.dashboardPath())) {
      const bundled = await this.readBundledDashboard();
      if (bundled) {
        const dashboard = bundled.replaceAll("__SERVICENOW_ROOT_FOLDER__", this.rootFolder());
        await this.app.vault.create(this.dashboardPath(), dashboard);
      } else {
        new Notice("업무현황 내장 템플릿을 읽지 못했습니다. 플러그인을 다시 설치해 주세요.", 9000);
      }
    }
    await this.ensureDashboardRuntime();
    await this.ensureDashboardPopupFieldGrid();
    await this.ensureDashboardTodoCreation();
    await this.ensureDashboardControlVisibility();
    await this.ensureDashboardTodoDetails();
    await this.ensureDashboardTodoSummaryColumn();
    await this.ensureDashboardSharedTodoModal();
    await this.ensureDashboardFieldOrdering();
    await this.ensureDashboardTodoPagination();
    await this.savePluginData();
  }

  async ensureDashboardRuntime() {
    const dashboard = this.app.vault.getAbstractFileByPath(this.dashboardPath());
    if (!(dashboard instanceof TFile)) return;
    const bundled = await this.readBundledDashboard();
    if (!bundled) return;
    const configured = bundled.replaceAll("__SERVICENOW_ROOT_FOLDER__", this.rootFolder());
    await this.app.vault.process(
      dashboard,
      (markdown) => upgradeDashboardRuntime(markdown, configured)
    );
  }

  async forceUpgradeDashboard() {
    const dashboard = this.app.vault.getAbstractFileByPath(this.dashboardPath());
    if (!(dashboard instanceof TFile)) throw new Error(`${this.dashboardPath()} 파일을 찾을 수 없습니다.`);
    const bundled = await this.readBundledDashboard();
    if (!bundled) throw new Error("내장 업무현황 템플릿을 읽을 수 없습니다.");
    const configured = bundled.replaceAll("__SERVICENOW_ROOT_FOLDER__", this.rootFolder());
    let updated = false;
    await this.app.vault.process(dashboard, (markdown) => {
      const next = upgradeDashboardRuntime(markdown, configured);
      if (next !== markdown) updated = true;
      return next;
    });
    return updated;
  }

  async ensureDashboardPopupFieldGrid() {
    const dashboard = this.app.vault.getAbstractFileByPath(this.dashboardPath());
    if (!(dashboard instanceof TFile)) return;
    await this.app.vault.process(dashboard, upgradeDashboardPopupFieldGrid);
  }

  async ensureDashboardTodoCreation() {
    const dashboard = this.app.vault.getAbstractFileByPath(this.dashboardPath());
    if (!(dashboard instanceof TFile)) return;
    const bundled = await this.readBundledDashboard();
    if (!bundled) return;
    await this.app.vault.process(
      dashboard,
      (markdown) => upgradeDashboardTodoCreation(markdown, bundled)
    );
  }

  async ensureDashboardControlVisibility() {
    const dashboard = this.app.vault.getAbstractFileByPath(this.dashboardPath());
    if (!(dashboard instanceof TFile)) return;
    const bundled = await this.readBundledDashboard();
    if (!bundled) return;
    await this.app.vault.process(
      dashboard,
      (markdown) => upgradeDashboardControlVisibility(markdown, bundled)
    );
  }

  async ensureDashboardTodoDetails() {
    const dashboard = this.app.vault.getAbstractFileByPath(this.dashboardPath());
    if (!(dashboard instanceof TFile)) return;
    const bundled = await this.readBundledDashboard();
    if (!bundled) return;
    await this.app.vault.process(
      dashboard,
      (markdown) => upgradeDashboardTodoDetails(markdown, bundled)
    );
  }

  async ensureDashboardTodoSummaryColumn() {
    const dashboard = this.app.vault.getAbstractFileByPath(this.dashboardPath());
    if (!(dashboard instanceof TFile)) return;
    const bundled = await this.readBundledDashboard();
    if (!bundled) return;
    await this.app.vault.process(
      dashboard,
      (markdown) => upgradeDashboardTodoSummaryColumn(markdown, bundled)
    );
  }

  async ensureDashboardSharedTodoModal() {
    const dashboard = this.app.vault.getAbstractFileByPath(this.dashboardPath());
    if (!(dashboard instanceof TFile)) return;
    const bundled = await this.readBundledDashboard();
    if (!bundled) return;
    await this.app.vault.process(
      dashboard,
      (markdown) => upgradeDashboardSharedTodoModal(markdown, bundled)
    );
  }

  async ensureDashboardFieldOrdering() {
    const dashboard = this.app.vault.getAbstractFileByPath(this.dashboardPath());
    if (!(dashboard instanceof TFile)) return;
    const bundled = await this.readBundledDashboard();
    if (!bundled) return;
    await this.app.vault.process(
      dashboard,
      (markdown) => upgradeDashboardFieldOrdering(markdown, bundled)
    );
  }

  async ensureDashboardTodoPagination() {
    const dashboard = this.app.vault.getAbstractFileByPath(this.dashboardPath());
    if (!(dashboard instanceof TFile)) return;
    const bundled = await this.readBundledDashboard();
    if (!bundled) return;
    await this.app.vault.process(
      dashboard,
      (markdown) => upgradeDashboardTodoPagination(markdown, bundled)
    );
  }

  async ensureTicketAssetFolders() {
    const tickets = this.app.vault.getAbstractFileByPath(this.ticketsFolder());
    const folders = Array.isArray(tickets?.children)
      ? tickets.children.filter((entry) => /^(?:CR|SR)\d+$/i.test(entry.name || ""))
      : [];
    for (const folder of folders) {
      await this.ensureFolder(normalizePath(`${folder.path}/assets`));
      await this.ensureFolder(normalizePath(`${folder.path}/회의록`));
    }
  }

  async readTemplate(path, fallback) {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? this.app.vault.read(file) : fallback;
  }

  async ensureTicketTemplateFields() {
    const file = this.app.vault.getAbstractFileByPath(this.ticketTemplatePath());
    if (!(file instanceof TFile)) return;
    const required = [
      "short_description", "service_now_priority", "ticket_creator", "ticket_requester", "service_now_created",
      "assignment_group", "assigned_person", "service_now_category", "service_now_updated",
      "estimated_qa_completion_date", "target_qa_completion_date", "actual_release_date",
      "배포일", "ui_interface_id", "BS-한글"
    ];
    await this.app.vault.process(file, (markdown) => {
      let next = repairTemplatePlaceholders(markdown);
      const match = next.match(/^---(\r?\n)([\s\S]*?)(\r?\n)---/);
      if (!match) return next;
      const existing = new Set([...match[2].matchAll(/^([^\s:#][^:]*):/gm)].map((item) => item[1].trim()));
      const missing = required.filter((key) => !existing.has(key));
      if (missing.length) {
        const additions = missing.map((key) => `${key}:`).join(match[1]);
        next = next.replace(match[0], `${match[0].slice(0, -3)}${match[1]}${additions}${match[1]}---`);
      }
      next = next.replace(/^deployment_finish:[^\r\n]*(?:\r?\n|$)/m, "");
      next = next.replace(/(^##[^\r\n]*To-Do[^\r\n]*\r?\n(?:\r?\n)*)(?:- \[ \][ \t]*(?:\r?\n|$))/mi, "$1");
      next = ensureSectionActionBlock(next, "{{ticketId}}", "📝 작업 일지", "clt-ticket-worklog-actions");
      next = ensureSectionActionBlock(next, "{{ticketId}}", "🗓️ 회의록", "clt-ticket-meeting-actions");
      return ensureSectionActionBlock(next, "{{ticketId}}", "✅ To-Do", "clt-ticket-todo-actions");
    });
  }

  async createTicketNote(ticketId) {
    const normalized = normalizeTicketId(ticketId);
    if (!normalized || !/^(CR|SR)/.test(normalized)) return new Notice("올바른 CR/SR 티켓 번호가 아닙니다.");
    await this.ensureWorkspaceScaffold();
    const category = normalized.slice(0, 2);
    const folder = normalizePath(`${this.ticketsFolder()}/${normalized}`);
    const path = normalizePath(`${folder}/${normalized}.md`);
    await this.ensureFolder(folder);
    await this.ensureFolder(this.ticketAssetsFolder(normalized));
    await this.ensureFolder(this.ticketMeetingsFolder(normalized));
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(existing);
      return new Notice(`${normalized} 티켓 노트가 이미 있어 기존 노트를 열었습니다.`);
    }
    const template = repairTemplatePlaceholders(
      await this.readTemplate(this.ticketTemplatePath(), defaultTicketTemplate())
    );
    const now = localIsoDateTime().replace(" ", "T").slice(0, 16);
    const file = await this.app.vault.create(path, fillTemplate(template, {
      ticketId: normalized,
      category,
      now
    }));
    this.autoLinking.add(file.path);
    try {
      await this.ensureRootTicketIdentity(file, normalized, category, now);
      await this.app.workspace.getLeaf(false).openFile(file);
      const synced = await this.initializeNewTicket(file, normalized);
      new Notice(synced
        ? `${normalized} 티켓 생성과 ServiceNow 최초 동기화를 완료했습니다.`
        : `${normalized} 티켓은 만들었지만 ServiceNow 최초 동기화에 실패했습니다. 티켓의 갱신 버튼으로 다시 시도해 주세요.`,
      8000);
    } finally {
      this.pendingNewTicketFiles.delete(file.path);
      this.autoLinking.delete(file.path);
    }
  }

  requestRootFolderChange(value, onDone) {
    const next = normalizePath(String(value || "").trim() || "ServiceNow");
    const current = this.rootFolder();
    if (next === current) return new Notice("현재 루트 폴더와 같습니다.");
    const targetExists = Boolean(this.app.vault.getAbstractFileByPath(next));
    const message = targetExists
      ? `${current}/티켓과 ${next}/티켓을 비교해 ${next}에 없는 티켓 폴더만 이동합니다. 같은 티켓은 양쪽 모두 그대로 유지합니다. 계속할까요?`
      : `${current} 폴더 전체를 ${next}(으)로 이동합니다. Obsidian이 내부 링크도 함께 갱신합니다. 계속할까요?`;
    new ConfirmActionModal(
      this.app,
      "루트 폴더 변경",
      message,
      async () => {
        await this.changeRootFolder(next);
        onDone?.();
      }
    ).open();
  }

  async changeRootFolder(nextRoot) {
    const current = this.rootFolder();
    const next = normalizePath(String(nextRoot || "").trim() || "ServiceNow");
    const currentFolder = this.app.vault.getAbstractFileByPath(current);
    const target = this.app.vault.getAbstractFileByPath(next);
    const parent = next.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureFolder(parent);
    let movedTickets = 0;
    let skippedTickets = 0;
    if (target && target !== currentFolder) {
      const currentTicketsPath = normalizePath(`${current}/티켓`);
      const nextTicketsPath = normalizePath(`${next}/티켓`);
      await this.ensureFolder(nextTicketsPath);
      const currentTickets = this.app.vault.getAbstractFileByPath(currentTicketsPath);
      const ticketFolders = Array.isArray(currentTickets?.children)
        ? [...currentTickets.children].filter((child) => /^(CR|SR)\d+$/i.test(child.name || ""))
        : [];
      for (const ticketFolder of ticketFolders) {
        const destination = normalizePath(`${nextTicketsPath}/${ticketFolder.name}`);
        if (this.app.vault.getAbstractFileByPath(destination)) {
          skippedTickets++;
          continue;
        }
        await this.app.fileManager.renameFile(ticketFolder, destination);
        movedTickets++;
      }
    } else if (currentFolder) {
      await this.app.fileManager.renameFile(currentFolder, next);
    }
    if (this.settings.workNotesFolder === current || this.settings.workNotesFolder?.startsWith(`${current}/`)) {
      this.settings.workNotesFolder = `${next}${this.settings.workNotesFolder.slice(current.length)}`;
    }
    this.settings.rootFolder = next;
    const dashboard = this.app.vault.getAbstractFileByPath(normalizePath(`${next}/업무현황.md`));
    if (dashboard instanceof TFile) {
      await this.app.vault.process(dashboard, (markdown) => markdown.replace(
        /const ROOT_FOLDER = "[^"]*";/,
        `const ROOT_FOLDER = "${next.replaceAll('"', '\\"')}";`
      ));
    }
    await this.ensureWorkspaceScaffold();
    const result = target && target !== currentFolder
      ? `루트 폴더를 ${next}(으)로 변경했습니다. · 티켓 이동 ${movedTickets}개 · 중복 유지 ${skippedTickets}개`
      : `루트 폴더를 ${next}(으)로 이동했습니다.`;
    new Notice(result, 9000);
  }

  requestWorkNotesFolderChange(value, onDone) {
    const next = normalizePath(String(value || "").trim());
    const current = normalizePath(this.settings.workNotesFolder || "");
    if (next === current) return new Notice("현재 워킹노트 폴더 설정과 같습니다.");
    const count = this.workNotesFiles().length;
    const destination = next || "각 티켓 노트 폴더";
    new ConfirmActionModal(
      this.app,
      "워킹노트 폴더 이동",
      `워킹노트 ${count}개를 ${destination}(으)로 이동하고 설정을 변경합니다. 계속할까요?`,
      async () => {
        await this.changeWorkNotesFolder(next);
        onDone?.();
      }
    ).open();
  }

  workNotesFiles() {
    return this.app.vault.getMarkdownFiles().filter((file) => {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      return String(fm.category || "").toLowerCase() === "work notes" && normalizeTicketId(fm.ticket);
    });
  }

  async changeWorkNotesFolder(nextFolder) {
    const next = normalizePath(String(nextFolder || "").trim());
    if (next) await this.ensureFolder(next);
    const moves = [];
    for (const file of this.workNotesFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      const ticketId = normalizeTicketId(fm.ticket);
      const rootFile = this.rootTicketFile(ticketId);
      if (!rootFile) continue;
      const destinationFolder = next || rootFile.parent?.path || "";
      const destination = normalizePath(`${destinationFolder ? `${destinationFolder}/` : ""}${file.name}`);
      if (destination === file.path) continue;
      const conflict = this.app.vault.getAbstractFileByPath(destination);
      if (conflict && conflict !== file) throw new Error(`${destination} 파일이 이미 있습니다.`);
      moves.push([file, destination]);
    }
    for (const [file, destination] of moves) await this.app.fileManager.renameFile(file, destination);
    this.settings.workNotesFolder = next;
    await this.savePluginData();
    new Notice(`워킹노트 ${moves.length}개를 이동했습니다.`, 7000);
  }

  openTranslateSetup() {
    const installed = this.app.plugins?.plugins?.translate;
    if (installed) {
      this.app.setting?.open?.();
      this.app.setting?.openTabById?.("translate");
      return;
    }
    shell.openExternal("obsidian://show-plugin?id=translate");
  }

  openDataviewSetup() {
    const installed = this.app.plugins?.plugins?.dataview;
    if (installed) {
      this.app.setting?.open?.();
      this.app.setting?.openTabById?.("dataview");
      return;
    }
    shell.openExternal("obsidian://show-plugin?id=dataview");
  }

  holidaySet() {
    const manual = String(this.settings.koreanHolidays || "")
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
    const automatic = Object.values(this.settings.holidayCache || {})
      .flat()
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
    return new Set([...automatic, ...manual]);
  }

  async fetchPublicHolidays(year) {
    const response = await requestUrl({
      url: `https://date.nager.at/api/v4/Holidays/KR/${year}`,
      method: "GET",
      headers: { Accept: "application/json" },
      throw: false
    });
    if (response.status < 200 || response.status >= 300 || !Array.isArray(response.json)) {
      throw new Error(`공휴일 API HTTP ${response.status}`);
    }
    return [...new Set(response.json
      .filter((holiday) => holiday?.nationalHoliday !== false)
      .filter((holiday) => !Array.isArray(holiday?.holidayTypes) || holiday.holidayTypes.includes("Public"))
      .map((holiday) => String(holiday?.date || "").slice(0, 10))
      .filter((date) => date.startsWith(`${year}-`) && /^\d{4}-\d{2}-\d{2}$/.test(date)))]
      .sort();
  }

  async syncHolidayCalendar(options = {}) {
    if (!this.settings.autoHolidaySync && !options.force) return;
    const today = localIsoDate();
    if (!options.force && this.settings.lastHolidaySyncDate === today) return;
    const currentYear = new Date().getFullYear();
    const years = [currentYear, currentYear + 1];
    const previous = this.settings.holidayCache || {};
    const nextCache = {};
    const failures = [];
    for (const year of years) {
      try {
        nextCache[year] = await this.fetchPublicHolidays(year);
      } catch (error) {
        failures.push(`${year}: ${error.message || error}`);
        if (Array.isArray(previous[year])) nextCache[year] = previous[year];
      }
    }
    this.settings.holidayCache = nextCache;
    if (!failures.length) this.settings.lastHolidaySyncDate = today;
    await this.savePluginData();
    if (options.notify) {
      const count = Object.values(nextCache).reduce((sum, dates) => sum + dates.length, 0);
      new Notice(failures.length
        ? `공휴일 갱신 일부 실패 · 기존 자료 유지\n${failures.join("\n")}`
        : `공휴일 갱신 완료 · ${years.join("·")}년 ${count}일`, 9000);
    }
  }

  serviceNowTableForTicket(ticketId) {
    return tableForTicket(ticketId, {
      CR: this.settings.changeRequestTable || "change_request",
      SR: this.settings.serviceRequestTable || "u_service_call",
      IN: this.settings.incidentTable || "incident"
    });
  }

  stateOptions(category) {
    const configured = this.settings.organizationFeaturesEnabled
      ? this.organizationPack?.states?.[category]
      : null;
    if (Array.isArray(configured) && configured.length) return configured.map(String);
    return category === "CR" ? CR_STATES : category === "SR" ? SR_STATES : [];
  }

  canonicalStatus(category, status) {
    const allowed = this.stateOptions(category);
    const value = String(status || "").trim();
    return allowed.find((item) => item.toLowerCase() === value.toLowerCase()) || value;
  }

  async openStatePicker(file) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const category = String(fm.category || "").toUpperCase();
    if (!["CR", "SR"].includes(category)) return new Notice("먼저 category를 CR 또는 SR로 설정하세요.");
    new StateModal(this.app, this.stateOptions(category),
      (state) => this.applyStatus(file, category, state)).open();
  }

  async onTicketMetadataChanged(file) {
    if (!(file instanceof TFile) || this.updatingStatus.has(file.path)) return;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    if (!fm.status || !this.rootTicketIdFromFile(file)) return;
    const status = String(fm.status);
    const previous = this.knownStatus.get(file.path);
    this.knownStatus.set(file.path, status);
    if (previous !== undefined && previous !== status) {
      await this.applyStatus(file, String(fm.category || "").toUpperCase(), status, {
        noticeMode: "batch"
      });
    }
  }

  resolveSla(category, status, fm) {
    if (!this.organizationFeatureEnabled("slaRules")) return null;
    const configured = this.organizationPack?.slaRules?.[category]?.[status];
    if (!configured) return CR_SLA[status] || null;
    if (Array.isArray(configured)) return configured;
    if (configured.rule && configured.frontmatter) {
      const current = String(fm[configured.frontmatter] || "").toLowerCase();
      return current === String(configured.equals || "").toLowerCase() ? configured.rule : null;
    }
    const priority = String(fm.service_now_priority || fm.priority || "").toLowerCase();
    const purpose = String(fm.purpose || "").toUpperCase().match(/^[A-Z]+/)?.[0] || "";
    return configured.priority?.[priority] || configured.purpose?.[purpose] || null;
  }

  async applyStatus(file, category, status, options = {}) {
    const allowed = this.stateOptions(category);
    const normalizedStatus = this.canonicalStatus(category, status);
    if (!options.allowUnknown && !allowed.includes(normalizedStatus)) {
      return new Notice(`${category || "미분류"}에서 사용할 수 없는 상태입니다.`);
    }
    this.updatingStatus.add(file.path);
    try {
      let dueMessage = "고정 SLA가 없어 작업예정일은 유지했습니다.";
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        fm.status = normalizedStatus;
        fm.status_changed = localIsoDate();
        const sla = this.resolveSla(category, normalizedStatus, fm);
        if (!sla) return;
        const [kind, count, basis] = sla;
        const due = kind === "working"
          ? addWorkingDays(new Date(), count, this.holidaySet())
          : addCalendarDays(new Date(), count);
        fm["작업예정일"] = localIsoDate(due);
        fm.sla_basis = basis;
        dueMessage = `작업예정일: ${fm["작업예정일"]} (${basis})`;
      });
      this.knownStatus.set(file.path, normalizedStatus);
      if (options.notify !== false) {
        const message = `${normalizedStatus}\n${dueMessage}`;
        if (options.noticeMode === "batch") {
          this.queueTicketChangeNotice({
            kind: "status",
            ticketId: this.rootTicketIdFromFile(file),
            message,
            duration: 6000
          });
        } else {
          new Notice(message, 6000);
        }
      }
    } finally {
      window.setTimeout(() => this.updatingStatus.delete(file.path), 300);
    }
  }

  async applyExternalStatus(file, status) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const category = String(fm.category || "").toUpperCase();
    return this.applyStatus(file, category, this.canonicalStatus(category, status), {
      allowUnknown: true,
      notify: false
    });
  }

  async resolveExistingWorkNotes(parentFile, frontmatter) {
    const linkPath = parseWikiLink(frontmatter?.["워킹노트"]);
    if (!linkPath) return null;
    const resolved = this.app.metadataCache.getFirstLinkpathDest(linkPath, parentFile.path);
    return resolved instanceof TFile ? resolved : null;
  }

  rootTicketIdFromFile(file) {
    if (!(file instanceof TFile) || file.extension !== "md") return "";
    const path = normalizePath(file.path);
    const prefix = `${this.ticketsFolder()}/`;
    if (!path.toLowerCase().startsWith(prefix.toLowerCase())) return "";
    const match = path.slice(prefix.length).match(/^((?:CR|SR)\d+)\/\1\.md$/i);
    if (!match) return "";
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const ticketId = normalizeTicketId(fm.id);
    const category = String(fm.category || "").toUpperCase();
    return ticketId === match[1].toUpperCase() && ticketId.startsWith(category) ? ticketId : "";
  }

  rootTicketIdFromPathStructure(file) {
    if (!(file instanceof TFile) || file.extension !== "md") return "";
    const path = normalizePath(file.path);
    const prefix = `${this.ticketsFolder()}/`;
    if (!path.toLowerCase().startsWith(prefix.toLowerCase())) return "";
    const match = path.slice(prefix.length).match(/^((?:CR|SR)\d+)\/\1\.md$/i);
    return match ? match[1].toUpperCase() : "";
  }

  async ensureRootTicketIdentity(file, ticketId, category = ticketId.slice(0, 2), now = "") {
    let changed = false;
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      if (normalizeTicketId(frontmatter.id) !== ticketId) {
        frontmatter.id = ticketId;
        changed = true;
      }
      if (String(frontmatter.category || "").toUpperCase() !== category) {
        frontmatter.category = category;
        changed = true;
      }
      if (!Object.prototype.hasOwnProperty.call(frontmatter, "BS-한글")) {
        frontmatter["BS-한글"] = "";
        changed = true;
      }
      for (const field of ["created", "updated"]) {
        const value = frontmatter[field];
        const malformed = value && typeof value === "object";
        if ((value === undefined || value === null || value === "" || malformed) && now) {
          frontmatter[field] = now;
          changed = true;
        }
      }
    });
    return changed;
  }

  async migrateDeploymentFinishFields() {
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.rootTicketIdFromPathStructure(file)) continue;
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        mergeDeploymentFinishField(frontmatter);
      });
    }
  }

  async migrateMeetingParentLinks() {
    const files = this.app.vault.getMarkdownFiles().filter((file) => file.path.includes("/회의록/"));
    for (const file of files) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      if (String(frontmatter.type || "") !== "meeting-minutes" || frontmatter.Parent) continue;
      const ticketId = normalizeTicketId(frontmatter.ticket || this.ticketIdFromPath(file.path));
      if (!ticketId) continue;
      await this.app.fileManager.processFrontMatter(file, (current) => {
        if (!current.Parent) current.Parent = `[[${ticketId}]]`;
      });
    }
  }

  async repairMalformedRootTickets() {
    const candidates = this.app.vault.getMarkdownFiles()
      .map((file) => ({ file, ticketId: this.rootTicketIdFromPathStructure(file) }))
      .filter((item) => item.ticketId);
    for (const { file, ticketId } of candidates) {
      await this.ensureRootTicketIdentity(
        file,
        ticketId,
        ticketId.slice(0, 2),
        localIsoDateTime().replace(" ", "T").slice(0, 16)
      );
      if (!this.data.tickets[ticketId]?.lastSyncedAt) {
        await this.initializeNewTicket(file, ticketId);
      }
    }
  }

  rootTicketFiles() {
    return this.app.vault.getMarkdownFiles().filter((file) => this.rootTicketIdFromFile(file));
  }

  rootTicketFile(ticketId) {
    const normalized = normalizeTicketId(ticketId);
    return this.rootTicketFiles().find((file) => this.rootTicketIdFromFile(file) === normalized) || null;
  }

  meetingTicketIdsForFile(file) {
    const pending = this.pendingMeetingTicketLinks?.get(file?.path) || [];
    const frontmatter = file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter || {} : {};
    return normalizeMeetingTicketIds([pending, frontmatter.tickets || frontmatter.ticket]);
  }

  isMeetingFileRelevantToTicket(file, ticketId, oldPath = "") {
    const normalized = normalizeTicketId(ticketId);
    const directFolder = `${this.ticketMeetingsFolder(normalized)}/`;
    const paths = [String(file?.path || ""), String(oldPath || "")];
    if (paths.some((path) => path.startsWith(directFolder))) return true;
    if (!paths.some((path) => path.startsWith(`${this.generalMeetingsFolder()}/`))) return false;
    return this.meetingTicketIdsForFile(file).includes(normalized);
  }

  listTicketMeetings(ticketId, sortDirection = "desc") {
    const normalizedTicketId = normalizeTicketId(ticketId);
    const folder = `${this.ticketMeetingsFolder(normalizedTicketId)}/`;
    const generalFolder = `${this.generalMeetingsFolder()}/`;
    const meetings = this.app.vault.getMarkdownFiles()
      .filter((file) => {
        if (file.path.startsWith(folder)) return true;
        if (!file.path.startsWith(generalFolder)) return false;
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
        return this.meetingTicketIdsForFile(file).includes(normalizedTicketId);
      })
      .map((file) => {
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
        const meetingDate = String(frontmatter.meeting_date || "");
        const ticketIds = normalizeMeetingTicketIds(frontmatter.tickets || frontmatter.ticket || normalizedTicketId);
        return {
          ticketId: normalizedTicketId,
          ticketIds,
          shared: ticketIds.length > 1 || file.path.startsWith(generalFolder),
          file,
          title: file.basename.replace(/^\d{4}-\d{2}-\d{2}[ T_-]*\d{0,2}[-:]?\d{0,2}\s*-?\s*/, "") || file.basename,
          meetingDate,
          meetingStart: String(frontmatter.meeting_start || ""),
          meetingEnd: String(frontmatter.meeting_end || ""),
          sourceName: String(frontmatter.source_name || ""),
          sourceDriveId: String(frontmatter.source_drive_id || ""),
          sourcePdf: parseWikiLink(frontmatter.source_pdf || ""),
          kind: String(frontmatter.meeting_kind || "gemini").toLowerCase()
        };
      });
    meetings.sort((left, right) => {
      const compared = String(left.meetingDate || left.file.stat.ctime).localeCompare(String(right.meetingDate || right.file.stat.ctime));
      return sortDirection === "asc" ? compared : -compared;
    });
    return meetings;
  }

  latestMeetingAnalysis(ticketId) {
    return this.listTicketMeetings(ticketId, "desc")
      .filter((meeting) => meeting.kind === "analysis")
      .sort((left, right) => {
        const leftEnd = String(left.meetingEnd || left.meetingDate || "");
        const rightEnd = String(right.meetingEnd || right.meetingDate || "");
        return rightEnd.localeCompare(leftEnd) || right.file.stat.mtime - left.file.stat.mtime;
      })[0] || null;
  }

  meetingCoveredByAnalysis(meeting, analysis) {
    const meetingDate = String(meeting?.meetingDate || "");
    const analysisEnd = String(analysis?.meetingEnd || analysis?.meetingDate || "");
    return Boolean(meetingDate && analysisEnd && meetingDate.slice(0, 10) <= analysisEnd.slice(0, 10));
  }

  renderMeetingCards(container, meetings, { emptyText = "등록된 회의록이 없습니다." } = {}) {
    container.empty?.();
    if (!meetings.length) {
      container.createDiv({ cls: "clt-meeting-empty", text: emptyText });
      return;
    }
    for (const meeting of meetings) {
      const card = container.createDiv({ cls: `clt-meeting-card${meeting.kind === "analysis" ? " is-analysis" : ""}` });
      const open = card.createEl("button", { cls: "clt-meeting-card-open", attr: { type: "button", title: `${meeting.title} 열기` } });
      const date = String(meeting.meetingDate || "").replace("T", " ") || "일시 미지정";
      const heading = open.createDiv({ cls: "clt-meeting-card-heading" });
      heading.createDiv({ cls: "clt-meeting-card-date", text: date });
      heading.createSpan({
        cls: `clt-meeting-type-badge ${meeting.kind === "analysis" ? "is-analysis" : "is-gemini"}`,
        text: meeting.kind === "analysis" ? "AI 회의록 분석" : "Gemini 회의록"
      });
      open.createDiv({ cls: "clt-meeting-card-title", text: meeting.title });
      const meta = open.createDiv({ cls: "clt-meeting-card-meta" });
      meta.createSpan({ text: meeting.sourceName || (meeting.kind === "analysis" ? "AI 분석" : "회의록") });
      open.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await this.app.workspace.getLeaf(false).openFile(meeting.file);
      });
      const remove = card.createEl("button", {
        cls: "clt-meeting-card-delete",
        text: "×",
        attr: { type: "button", title: "회의록 삭제", "aria-label": `${meeting.title} 삭제` }
      });
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        new ConfirmActionModal(
          this.app,
          "회의록 삭제",
          `'${meeting.title}'을 Obsidian에서 삭제하시겠습니까? Google Drive 원본은 삭제되지 않습니다.`,
          async () => {
            await this.deleteTicketMeeting(meeting);
            container.dispatchEvent(new CustomEvent("clt-meeting-deleted", { bubbles: true }));
          },
          "삭제",
          "회의록 삭제"
        ).open();
      });
    }
  }

  renderTicketMeetingSection(el, ticketId) {
    el.addClass("clt-ticket-meeting-action");
    el.closest(".markdown-preview-view, .markdown-rendered")?.classList.add("clt-ticket-note-render");
    const toolbar = el.createDiv({ cls: "clt-meeting-inline-toolbar" });
    const count = toolbar.createSpan({ cls: "clt-meeting-list-count" });
    const actions = toolbar.createDiv({ cls: "clt-meeting-list-actions" });
    const sort = actions.createEl("button", { text: "최신순 ↓", attr: { type: "button" } });
    const filter = actions.createEl("details", { cls: "clt-meeting-label-filter" });
    filter.createEl("summary", { text: "라벨 필터" });
    const filterMenu = filter.createDiv({ cls: "clt-meeting-label-filter-menu" });
    const selectedKinds = new Set(["gemini", "analysis"]);
    const labels = new Map([["gemini", "Gemini 회의록"], ["analysis", "AI 회의록 분석"]]);
    for (const [kind, label] of labels) {
      const option = filterMenu.createEl("label");
      const checkbox = option.createEl("input", { type: "checkbox" });
      checkbox.checked = true;
      option.createSpan({ text: label });
      checkbox.addEventListener("change", () => {
        checkbox.checked ? selectedKinds.add(kind) : selectedKinds.delete(kind);
        refresh();
      });
    }
    const drive = actions.createEl("button", { text: "Drive에서 가져오기", attr: { type: "button" } });
    const reload = actions.createEl("button", { text: "새로고침", attr: { type: "button", title: "회의록 목록 새로고침" } });
    const add = actions.createEl("button", { text: "＋ 파일로 추가", cls: "mod-cta", attr: { type: "button" } });
    const list = el.createDiv({ cls: "clt-meeting-list" });
    let direction = "desc";
    const refresh = () => {
      const allMeetings = this.listTicketMeetings(ticketId, direction);
      const meetings = allMeetings.filter((meeting) => selectedKinds.has(meeting.kind));
      count.setText(`${meetings.length}개의 회의 기록${meetings.length !== allMeetings.length ? ` · 전체 ${allMeetings.length}개` : ""}`);
      sort.setText(direction === "desc" ? "최신순 ↓" : "오래된순 ↑");
      list.dataset.sortDirection = direction;
      this.renderMeetingCards(list, meetings);
    };
    sort.addEventListener("click", () => {
      direction = direction === "desc" ? "asc" : "desc";
      refresh();
    });
    add.addEventListener("click", () => new MeetingImportModal(this.app, this, ticketId, refresh).open());
    drive.addEventListener("click", () => new DriveMeetingCandidateModal(this.app, this, ticketId, refresh).open());
    reload.addEventListener("click", refresh);
    list.addEventListener("clt-meeting-deleted", refresh);
    refresh();
  }

  openMeetingImportModal(ticketId, onImported = null) {
    new MeetingImportModal(this.app, this, ticketId, onImported).open();
  }

  openGlobalMeetingImportModal(onImported = null) {
    new MeetingImportModal(this.app, this, "", onImported, true).open();
  }

  openGlobalDriveMeetingModal(onImported = null) {
    new GlobalDriveMeetingTicketModal(this.app, this, onImported).open();
  }

  openMeetingListModal(ticketId) {
    new MeetingListModal(this.app, this, ticketId).open();
  }

  openDriveMeetingCandidateModal(ticketId, onImported = null) {
    new DriveMeetingCandidateModal(this.app, this, ticketId, onImported).open();
  }

  openMeetingAnalysisPromptModal(ticketId) {
    new MeetingAnalysisPromptModal(this.app, this, ticketId).open();
  }

  async generateMeetingAnalysisPrompt(ticketId, meetings, { useBaseline = false } = {}) {
    const normalized = normalizeTicketId(ticketId);
    const rootFile = this.rootTicketFile(normalized);
    const baseline = useBaseline ? this.latestMeetingAnalysis(normalized) : null;
    const inputMeetings = baseline
      ? meetings.filter((meeting) => !this.meetingCoveredByAnalysis(meeting, baseline))
      : meetings;
    if (baseline && !inputMeetings.length) {
      throw new Error("기존 분석 이후 새로 추가된 회의록이 없습니다. 전체 재분석이 필요하면 기존 분석 자료 활용 옵션을 해제해 주세요.");
    }
    const withContent = await Promise.all(inputMeetings.map(async (meeting) => {
      const rawContent = meeting.file instanceof TFile ? await this.app.vault.cachedRead(meeting.file) : "";
      const ticketIds = normalizeMeetingTicketIds(meeting.ticketIds || meeting.ticketId);
      return {
        ...meeting,
        ticketIds,
        content: ticketIds.length > 1 ? extractTicketFocusedMeetingContent(rawContent, normalized) : rawContent
      };
    }));
    const baselineWithContent = baseline ? {
      ...baseline,
      content: baseline.file instanceof TFile ? await this.app.vault.cachedRead(baseline.file) : ""
    } : null;
    return buildMeetingAnalysisPrompt({
      ticketId: normalized,
      meetings: withContent,
      ticketPath: rootFile?.path || "",
      outputFolder: this.ticketMeetingsFolder(normalized),
      baseline: baselineWithContent
    });
  }

  async deleteTicketMeeting(meeting) {
    if (!(meeting?.file instanceof TFile)) throw new Error("삭제할 회의록 노트를 찾을 수 없습니다.");
    const allowedFolders = [
      `${this.generalMeetingsFolder()}/`,
      ...normalizeMeetingTicketIds(meeting.ticketIds || meeting.ticketId).map((id) => `${this.ticketMeetingsFolder(id)}/`)
    ];
    const folder = allowedFolders.find((candidate) => meeting.file.path.startsWith(candidate));
    if (!folder) throw new Error("티켓 회의록 폴더 밖의 파일은 삭제할 수 없습니다.");
    if (meeting.sourcePdf) {
      const pdf = this.app.vault.getAbstractFileByPath(normalizePath(meeting.sourcePdf));
      if (pdf instanceof TFile && pdf.path.startsWith(folder)) await this.app.vault.trash(pdf, true);
    }
    await this.app.vault.trash(meeting.file, true);
    new Notice("회의록을 휴지통으로 이동했습니다.");
  }

  confirmDeleteMeetingPath(path, onDeleted = null) {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) return new Notice("삭제할 회의록을 찾을 수 없습니다.");
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const meeting = {
      file,
      ticketId: normalizeTicketId(frontmatter.ticket || ""),
      ticketIds: normalizeMeetingTicketIds(frontmatter.tickets || frontmatter.ticket),
      title: file.basename,
      sourcePdf: parseWikiLink(frontmatter.source_pdf || "")
    };
    new ConfirmActionModal(
      this.app,
      "회의록 삭제",
      `'${meeting.title}'을 Obsidian에서 삭제하시겠습니까?${meeting.ticketIds.length > 1 ? `\n연결된 ${meeting.ticketIds.length}개 티켓의 목록에서도 함께 사라집니다.` : ""}`,
      async () => {
        await this.deleteTicketMeeting(meeting);
        if (typeof onDeleted === "function") await onDeleted();
      },
      "삭제",
      "회의록 삭제"
    ).open();
  }

  async importMeetingFiles(ticketId, files, options = {}) {
    const ticketIds = normalizeMeetingTicketIds(ticketId);
    const normalized = ticketIds[0] || "";
    const rootFiles = ticketIds.map((id) => ({ id, file: this.rootTicketFile(id) }));
    const missing = rootFiles.filter(({ file }) => !(file instanceof TFile)).map(({ id }) => id);
    if (missing.length) throw new Error(`${missing.join(", ")} 원본 티켓 노트를 찾을 수 없습니다.`);
    const selected = [...(files || [])];
    const textFiles = selected.filter((file) => /\.(?:md|txt)$/i.test(file.name));
    const pdfFiles = selected.filter((file) => /\.pdf$/i.test(file.name));
    if (textFiles.length !== 1) throw new Error("Markdown(.md) 또는 텍스트(.txt) 파일을 정확히 1개 선택해 주세요.");
    if (pdfFiles.length > 1) throw new Error("PDF 원본은 1개만 함께 선택할 수 있습니다.");
    const source = textFiles[0];
    const sourceText = await source.text();
    if (!sourceText.trim()) throw new Error("선택한 회의록 파일이 비어 있습니다.");
    const folder = ticketIds.length === 1 ? this.ticketMeetingsFolder(normalized) : this.generalMeetingsFolder();
    await this.ensureFolder(folder);
    const meetingDate = options.meetingDate || parseMeetingDate(`${source.name}\n${sourceText}`);
    const titleFromBody = sourceText.match(/^##\s+(?:\*\*)?(.+?)(?:\*\*)?\s*$/m)?.[1] || source.name;
    const title = cleanMeetingTitle(options.title || titleFromBody, normalized);
    const fileStem = `${meetingDate.slice(0, 10)} ${meetingDate.slice(11, 16).replace(":", "-")} - ${safeFileName(title).slice(0, 90)}`;
    let pdfPath = "";
    if (pdfFiles[0]) {
      pdfPath = await this.uniqueVaultPath(`${folder}/${fileStem} - 원본.pdf`);
      await this.app.vault.createBinary(pdfPath, await pdfFiles[0].arrayBuffer());
    }
    const notePath = await this.uniqueVaultPath(`${folder}/${fileStem}.md`);
    const markdown = buildMeetingNoteMarkdown({
      ticketId: normalized,
      ticketIds,
      sourceName: source.name,
      sourceText,
      meetingDate,
      title,
      pdfPath
    });
    const note = await this.app.vault.create(notePath, markdown);
    this.pendingMeetingTicketLinks ||= new Map();
    this.pendingMeetingTicketLinks.set(note.path, ticketIds);
    for (const { id, file } of rootFiles) await this.ensureMeetingSection(file, id);
    ticketIds.forEach((id) => this.refreshViews(id));
    return note;
  }

  async uniqueVaultPath(path) {
    const normalized = normalizePath(path);
    if (!this.app.vault.getAbstractFileByPath(normalized)) return normalized;
    const extension = normalized.match(/(\.[^./]+)$/)?.[1] || "";
    const base = extension ? normalized.slice(0, -extension.length) : normalized;
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(`${base} (${suffix})${extension}`)) suffix += 1;
    return normalizePath(`${base} (${suffix})${extension}`);
  }

  async ensureMeetingSection(file, ticketId) {
    await this.app.vault.process(file, (markdown) =>
      ensureSectionActionBlock(markdown, ticketId, "🗓️ 회의록", "clt-ticket-meeting-actions")
    );
  }

  renderTicketSectionAction(el, file, ticketId, type) {
    el.addClass("clt-ticket-heading-action");
    el.addClass(type === "worklog" ? "clt-ticket-worklog-action" : "clt-ticket-todo-action");
    el.closest(".markdown-preview-view, .markdown-rendered")?.classList.add("clt-ticket-note-render");
    const button = el.createEl("button", {
      cls: "clt-ticket-section-add",
      text: type === "worklog" ? "＋ 새 작업 추가" : "＋ 할 일 추가"
    });
    const configure = type === "todo" ? el.createEl("button", { cls: "snm-todo-workflow-heading-action", text: "상태 설정", attr: { type: "button" } }) : null;
    configure?.addEventListener("click", () => this.openTodoWorkflowSettings());
    button.addEventListener("click", () => {
      if (type === "worklog") this.openTicketWorkLogEntry(file, ticketId);
      else this.openTicketTodoEntry(file, ticketId);
    });
    const moveButtonBesideHeading = () => {
      let cursor = el;
      let heading = null;
      while (cursor && !heading) {
        let sibling = cursor.previousElementSibling;
        while (sibling && !heading) {
          if (sibling.matches?.("h2")) heading = sibling;
          else heading = sibling.querySelector?.("h2:last-of-type") || null;
          sibling = sibling.previousElementSibling;
        }
        if (heading || cursor.matches?.(".markdown-preview-section, .markdown-rendered")) break;
        cursor = cursor.parentElement;
      }
      if (!heading) return;
      heading.addClass("clt-ticket-section-heading");
      heading.appendChild(button);
      if (configure) heading.appendChild(configure);
      el.addClass("clt-ticket-heading-action-mounted");
    };
    moveButtonBesideHeading();
    window.requestAnimationFrame(moveButtonBesideHeading);
  }

  decorateTicketNote(el, ctx) {
    const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    const ticketId = this.rootTicketIdFromFile(file);
    if (!ticketId) return;
    el.addClass("clt-ticket-note-render");
    for (const heading of el.querySelectorAll("h2")) {
      const normalized = normalizedHeadingText(heading.textContent);
      const isWorkLog = normalized.includes("작업일지");
      const isTodo = normalized.includes("todo");
      if (!isWorkLog && !isTodo) continue;
      heading.addClass("clt-ticket-section-heading");
      if (!heading.querySelector(".clt-ticket-section-add")) {
        const button = heading.createEl("button", {
          cls: "clt-ticket-section-add",
          text: isWorkLog ? "＋ 새 작업 추가" : "＋ 할 일 추가"
        });
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (isWorkLog) this.openTicketWorkLogEntry(file, ticketId);
          else this.openTicketTodoEntry(file, ticketId);
        });
      }
      if (isTodo) {
        if (!heading.querySelector(".snm-todo-workflow-heading-action")) {
          heading.createEl("button", { cls: "snm-todo-workflow-heading-action", text: "상태 설정" })
            .addEventListener("click", event => {
              event.preventDefault();
              event.stopPropagation();
              this.openTodoWorkflowSettings();
            });
        }
        let sibling = heading.nextElementSibling;
        while (sibling && !/^H[1-2]$/.test(sibling.tagName)) {
          if (sibling.matches("ul.contains-task-list, ul.task-list")) sibling.addClass("clt-ticket-todo-list");
          sibling = sibling.nextElementSibling;
        }
      }
    }
  }

  renderTicketTodoBoard(sourceList, ticketId, tasks) {
    if (!(sourceList instanceof HTMLElement)) return;
    this.todoBoardViews ||= new Map();
    this.todoBoardViews.set(sourceList, { ticketId, tasks });
    const existing = sourceList.previousElementSibling;
    if (existing?.matches?.(".clt-ticket-mini-todo-board")) existing.remove();
    sourceList.addClass("clt-ticket-todo-source-hidden");

    const board = document.createElement("div");
    board.className = "clt-ticket-mini-todo-board";
    const workflow = this.getTodoWorkflow();
    const definitions = workflow.filter(state => state.enabled).map(state => [state.key, state.label, state.icon]);
    board.style.setProperty("--snm-todo-column-count", String(definitions.length));
    const toolbar = board.createDiv({ cls: "snm-todo-board-toolbar" });
    toolbar.createEl("button", { text: "상태 설정", attr: { type: "button" } }).addEventListener("click", () => this.openTodoWorkflowSettings());
    const inactiveTasks = tasks.filter(task => !workflow.some(state => state.key === task.status && state.enabled));
    if (inactiveTasks.length) toolbar.createEl("button", { text: `비활성화 상태 보기 · ${inactiveTasks.length}개`, attr: { type: "button" } })
      .addEventListener("click", () => this.openInactiveTodoModal(inactiveTasks));
    for (const [status, label, icon] of definitions) {
      const column = board.createDiv({ cls: `clt-ticket-mini-column is-${status}` });
      const heading = column.createDiv({ cls: "clt-ticket-mini-column-heading" });
      heading.createSpan({ cls: "clt-ticket-mini-status-icon", text: icon });
      heading.createSpan({ text: label });
      const columnTasks = tasks.filter((task) => task.status === status);
      heading.createSpan({ cls: "clt-ticket-mini-count", text: String(columnTasks.length) });
      const body = column.createDiv({ cls: "clt-ticket-mini-column-body" });
      column.addEventListener("dragover", (event) => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        column.addClass("drag-over");
      });
      column.addEventListener("dragleave", (event) => {
        if (!column.contains(event.relatedTarget)) column.removeClass("drag-over");
      });
      column.addEventListener("drop", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        column.removeClass("drag-over");
        const taskId = event.dataTransfer?.getData("text/plain") || "";
        const task = tasks.find((item) => item.id === taskId);
        if (!task || task.status === status) return;
        column.addClass("is-updating");
        try {
          await this.updateTodoTaskDetails(task, { status });
          const refreshed = await this.readTodoTasks(ticketId);
          this.renderTicketTodoBoard(sourceList, ticketId, refreshed);
          new Notice(`${ticketId} To-Do를 '${label}' 상태로 변경했습니다.`);
        } catch (error) {
          column.removeClass("is-updating");
          new Notice(`To-Do 상태 변경 실패: ${error.message || error}`, 9000);
        }
      });
      if (!columnTasks.length) {
        body.createDiv({ cls: "clt-ticket-mini-empty", text: "할 일 없음" });
      } else for (const task of columnTasks) {
        const card = body.createEl("button", {
          cls: "clt-ticket-mini-card",
          attr: { type: "button", title: "클릭하여 수정하거나 다른 상태로 드래그", draggable: "true" }
        });
        const visualTone = todoVisualTone(task);
        if (visualTone) card.addClass(visualTone);
        card.dataset.todoId = task.id;
        card.createDiv({ cls: "clt-ticket-mini-card-text", text: task.text || "(내용 없음)" });
        if (task.details) {
          const detail = card.createDiv({ cls: "clt-ticket-mini-card-detail markdown-rendered" });
          void this.renderMarkdownInto(detail, task.details, task.filePath || "");
        }
        if (task.result) {
          const result = card.createDiv({ cls: "clt-ticket-mini-card-detail clt-ticket-mini-card-result markdown-rendered" });
          result.createEl("strong", { text: "처리 내용" });
          const resultBody = result.createDiv();
          void this.renderMarkdownInto(resultBody, task.result, task.filePath || "");
        }
        renderTodoWaitingInfo(card, task);
        const meta = card.createDiv({ cls: "clt-ticket-mini-card-meta" });
        meta.createSpan({ cls: "clt-ticket-mini-card-due", text: task.dueDate ? `완료 예정 ${task.dueDate}` : "완료 예정일 없음" });
        meta.createSpan({ cls: "clt-ticket-mini-card-action", text: "열기 ›" });
        card.addEventListener("dragstart", (event) => {
          card.dataset.dragged = "true";
          card.addClass("dragging");
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", task.id);
          }
        });
        card.addEventListener("dragend", () => {
          card.removeClass("dragging");
          window.setTimeout(() => { delete card.dataset.dragged; }, 0);
        });
        card.addEventListener("click", (event) => {
          if (card.dataset.dragged === "true") return;
          event.preventDefault();
          event.stopPropagation();
          this.openTodoDetailEntryModal(task, async () => {
            const refreshed = await this.readTodoTasks(ticketId);
            this.renderTicketTodoBoard(sourceList, ticketId, refreshed);
          });
        });
      }
      const quickAdd = column.createEl("button", {
        cls: "clt-ticket-mini-add",
        text: "＋ To-Do 추가",
        attr: { type: "button", title: `${label} 상태로 새 To-Do 추가` }
      });
      quickAdd.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openTodoEntryModal(ticketId, async () => {
          const refreshed = await this.readTodoTasks(ticketId);
          this.renderTicketTodoBoard(sourceList, ticketId, refreshed);
        }, status);
      });
    }
    sourceList.parentElement?.insertBefore(board, sourceList);
  }

  renderTicketWorkLogCards(sourceList, ticketId, workLogs, sourcePath = "") {
    if (!(sourceList instanceof HTMLElement)) return;
    const existing = sourceList.previousElementSibling;
    if (existing?.matches?.(".clt-ticket-worklog-cards")) existing.remove();
    sourceList.addClass("clt-ticket-worklog-source-hidden");
    const viewMode = sourceList.dataset.cltWorklogView || "latest";
    const sortDirection = sourceList.dataset.cltWorklogSort || "desc";
    const sortedLogs = [...workLogs].sort((left, right) => {
      const compared = String(left.dateTime).localeCompare(String(right.dateTime));
      return sortDirection === "asc" ? compared : -compared;
    });
    const visibleLogs = viewMode === "latest" ? sortedLogs.slice(0, 1) : sortedLogs;
    const container = document.createElement("div");
    container.className = "clt-ticket-worklog-cards";
    const toolbar = document.createElement("div");
    toolbar.className = "clt-ticket-worklog-toolbar";
    const viewButtons = document.createElement("div");
    viewButtons.className = "clt-ticket-worklog-view-buttons";
    const latestButton = document.createElement("button");
    latestButton.type = "button";
    latestButton.className = `clt-ticket-worklog-button${viewMode === "latest" ? " is-active" : ""}`;
    latestButton.textContent = "최근 작업";
    const allButton = document.createElement("button");
    allButton.type = "button";
    allButton.className = `clt-ticket-worklog-button${viewMode === "all" ? " is-active" : ""}`;
    allButton.textContent = "전체 작업";
    const sortButton = document.createElement("button");
    sortButton.type = "button";
    sortButton.className = `clt-ticket-worklog-button clt-ticket-worklog-sort${viewMode === "all" ? "" : " is-hidden"}`;
    sortButton.textContent = sortDirection === "desc" ? "최신순" : "오래된순";
    sortButton.title = "전체 작업 정렬 순서 변경";
    latestButton.addEventListener("click", () => {
      sourceList.dataset.cltWorklogView = "latest";
      this.renderTicketWorkLogCards(sourceList, ticketId, workLogs, sourcePath);
    });
    allButton.addEventListener("click", () => {
      sourceList.dataset.cltWorklogView = "all";
      this.renderTicketWorkLogCards(sourceList, ticketId, workLogs, sourcePath);
    });
    sortButton.addEventListener("click", () => {
      sourceList.dataset.cltWorklogSort = sortDirection === "desc" ? "asc" : "desc";
      this.renderTicketWorkLogCards(sourceList, ticketId, workLogs, sourcePath);
    });
    viewButtons.append(latestButton, allButton);
    toolbar.append(viewButtons, sortButton);
    container.appendChild(toolbar);
    for (const entry of visibleLogs) {
      const card = container.createDiv({ cls: "clt-ticket-worklog-card" });
      const heading = card.createDiv({ cls: "clt-ticket-worklog-heading" });
      heading.createDiv({ cls: "clt-ticket-worklog-time", text: entry.dateTime || "날짜 없음" });
      const remove = heading.createEl("button", {
        cls: "clt-ticket-worklog-delete",
        text: "×",
        attr: { type: "button", title: "작업 일지 삭제", "aria-label": "작업 일지 삭제" }
      });
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        new ConfirmActionModal(
          this.app,
          "작업 일지 삭제",
          `${entry.dateTime || "선택한"} 작업 일지를 삭제하시겠습니까?`,
          async () => {
            await this.deleteTicketWorkLog(sourcePath, entry);
            const file = this.app.vault.getAbstractFileByPath(sourcePath);
            const refreshed = file instanceof TFile ? extractTicketWorkLogs(await this.app.vault.cachedRead(file)) : [];
            this.renderTicketWorkLogCards(sourceList, ticketId, refreshed, sourcePath);
          },
          "삭제"
        ).open();
      });
      const body = card.createDiv({ cls: "clt-ticket-worklog-body markdown-rendered" });
      if (entry.contentMarkdown) void this.renderMarkdownInto(body, entry.contentMarkdown, sourcePath);
      else body.createSpan({ cls: "clt-ticket-worklog-empty", text: "내용 없음" });
    }
    sourceList.parentElement?.insertBefore(container, sourceList);
  }

  async deleteTicketWorkLog(sourcePath, entry) {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(String(sourcePath || "")));
    if (!(file instanceof TFile)) throw new Error("원본 티켓 노트를 찾을 수 없습니다.");
    let deleted = false;
    await this.app.vault.process(file, (markdown) => {
      const logs = extractTicketWorkLogs(markdown);
      const target = logs.find((item) =>
        item.dateTime === entry?.dateTime
        && item.contentMarkdown === entry?.contentMarkdown
      );
      if (!target || !Number.isInteger(target.startLine)) return markdown;
      const lines = markdown.split(/\r?\n/);
      lines.splice(target.startLine, Math.max(1, target.endLine - target.startLine));
      deleted = true;
      return lines.join(markdown.includes("\r\n") ? "\r\n" : "\n");
    });
    if (!deleted) throw new Error("삭제할 작업 일지를 찾을 수 없습니다.");
    new Notice("작업 일지를 삭제했습니다.");
    return true;
  }

  openTicketWorkLogEntry(file, ticketId) {
    new TimedEntryModal(this.app, {
      title: `${ticketId} 새 작업 일지`,
      placeholder: "새 작업 내용을 입력하세요.",
      emptyMessage: "작업 내용을 입력해 주세요.",
      sourcePath: file.path,
      onSubmit: async (content) => {
        const time = localIsoDateTime().slice(0, 16);
        await this.app.vault.process(file, (markdown) => appendEntryToMarkdownSection(
          markdown,
          "📝 작업 일지",
          formatMarkdownListEntry(`- ${time} : `, content)
        ));
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
          frontmatter["마지막확인"] = time.slice(0, 10);
        });
        new Notice("작업 일지가 추가되었습니다.");
      }
    }).open();
  }

  openTicketTodoEntry(file, ticketId) {
    this.openTodoEntryModal(ticketId);
  }

  createRichMarkdownInput(parent, initialValue = "", sourcePath = "", placeholder = "") {
    return createRichMarkdownEditor(this.app, this, parent, initialValue, sourcePath, placeholder);
  }

  async renderMarkdownInto(container, markdown, sourcePath = "") {
    if (typeof container.empty === "function") container.empty();
    else container.innerHTML = "";
    await MarkdownRenderer.render(this.app, String(markdown || ""), container, sourcePath, this);
  }

  openTodoEntryModal(preselectedTicketId = "", onSaved = null, preselectedStatus = "pending") {
    new TodoEntryModal(this.app, this, preselectedTicketId, onSaved, preselectedStatus).open();
  }

  openTodoDetailEntryModal(task, onSaved = null) {
    new TodoDetailEntryModal(this.app, this, task, onSaved).open();
  }

  async handleLivePreviewTodoClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    const taskLine = target?.closest?.(".markdown-source-view.mod-cm6 .HyperMD-task-line");
    if (!taskLine || target.closest("input[type='checkbox'], a, button")) return;
    const selection = window.getSelection();
    if (selection?.toString() && taskLine.contains(selection.anchorNode)) return;

    const leaf = this.app.workspace.getLeavesOfType("markdown")
      .find((item) => item.containerEl?.contains(taskLine));
    const file = leaf?.view?.file;
    const ticketId = this.rootTicketIdFromFile(file);
    if (!ticketId) return;

    const tasks = await this.readTodoTasks(ticketId);
    if (!tasks.length) return;
    const mousePosition = leaf?.view?.editor?.posAtMouse?.(event);
    let task = mousePosition
      ? tasks.find((item) => item.lineIndex === mousePosition.line)
      : null;
    if (!task) {
      const rendered = String(taskLine.textContent || "").replace(/\s+/g, " ").trim();
      const dateTime = rendered.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/)?.[0] || "";
      const candidates = tasks.filter((item) => item.dateTime === dateTime);
      task = candidates.find((item) => rendered.includes(item.text)) || candidates[0];
    }
    if (!task) return;

    event.preventDefault();
    event.stopPropagation();
    this.openTodoDetailEntryModal(task);
  }

  async readTodoTasks(ticketId) {
    const normalized = normalizeTicketId(ticketId);
    const file = this.rootTicketFile(normalized);
    if (!(file instanceof TFile)) return [];
    const markdown = await this.app.vault.read(file);
    const lines = markdown.split(/\r?\n/);
    let sectionStart = -1;
    let headingLevel = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const heading = matchTodoHeading(lines[index]);
      if (!heading) continue;
      sectionStart = index + 1;
      headingLevel = heading[1].length;
      break;
    }
    if (sectionStart < 0) return [];

    const tasks = [];
    let taskIndex = 0;
    for (let lineIndex = sectionStart; lineIndex < lines.length; lineIndex += 1) {
      const heading = lines[lineIndex].match(/^(#{1,6})\s+/);
      if (heading && heading[1].length <= headingLevel) break;
      const checkbox = lines[lineIndex].match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
      if (!checkbox) continue;
      const rawContent = checkbox[2];
      const dateTime = rawContent.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s*:\s*/)?.[1] || "";
      const dueDate = rawContent.match(/<!--\s*clt-todo-due:(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?)\s*-->/i)?.[1] || "";
      const completedAt = rawContent.match(/<!--\s*clt-todo-completed:([^>]+?)\s*-->/i)?.[1]?.trim() || "";
      const details = decodeTodoDetail(rawContent.match(/<!--\s*clt-todo-detail:([^>]*)\s*-->/i)?.[1]?.trim() || "");
      const result = decodeTodoDetail(rawContent.match(/<!--\s*clt-todo-result:([^>]*)\s*-->/i)?.[1]?.trim() || "");
      const inProgress = /<!--\s*clt-todo:in-progress\s*-->/i.test(rawContent);
      const waiting = /<!--\s*clt-todo:waiting\s*-->/i.test(rawContent);
      const text = stripCltTodoMetadata(rawContent)
        .replace(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s*:\s*/, "")
        .trim();
      const done = checkbox[1].toLowerCase() === "x";
      tasks.push({
        id: `${file.path}::${taskIndex}`,
        filePath: file.path,
        ticketId: normalized,
        taskIndex,
        lineIndex,
        dateTime,
        dueDate,
        completedAt,
        details,
        result,
        text,
        rawContent,
        ...readTodoWaiting(rawContent),
        status: done ? "done" : waiting ? "waiting" : inProgress ? "in-progress" : "pending"
      });
      taskIndex += 1;
    }
    return tasks;
  }

  generalTodoFile() {
    const root = this.rootFolder();
    return this.app.vault.getAbstractFileByPath(`${root}/To-Do.md`)
      || this.app.vault.getAbstractFileByPath(`${root}/일반 To-Do.md`)
      || null;
  }

  async ensureGeneralTodoFile() {
    const existing = this.generalTodoFile();
    if (existing instanceof TFile) return existing;
    const root = this.rootFolder();
    await this.ensureFolder(root);
    const path = `${root}/To-Do.md`;
    const initialContent = `# 📋 일반 To-Do\n\n## ✅ To-Do\n\n`;
    return await this.app.vault.create(path, initialContent);
  }

  async updateTodoTaskDetails(task, changes = {}) {
    const normalized = normalizeTicketId(task?.ticketId);
    const file = task?.filePath
      ? this.app.vault.getAbstractFileByPath(task.filePath)
      : (normalized ? this.rootTicketFile(normalized) : this.generalTodoFile());
    if (!(file instanceof TFile)) throw new Error(normalized ? `${normalized} 티켓 노트를 찾을 수 없습니다.` : "To-Do 노트를 찾을 수 없습니다.");
    const cleanText = stripCltTodoMetadata(
      String(changes.text ?? task.text ?? "").replace(/\r?\n+/g, " ")
    );
    if (!cleanText) throw new Error("할 일을 입력해 주세요.");
    const status = ["pending", "in-progress", "waiting", "done"].includes(changes.status)
      ? changes.status
      : task.status;
    if (status !== task.status) this.assertTodoStatusEnabled?.(status);
    const dueDate = String(changes.dueDate ?? task.dueDate ?? "").trim();
    const details = String(changes.details ?? task.details ?? "").trim();
    const result = String(changes.result ?? task.result ?? "").trim();
    const waiting = todoWaitingChanges(task, changes, status, localIsoDateTime().slice(0, 16));
    const completedAt = status === "done"
      ? (task.completedAt || localIsoDateTime().slice(0, 16))
      : "";
    const dateTime = task.dateTime || localIsoDateTime().slice(0, 16);
    const checkbox = status === "done" ? "x" : " ";
    const statusMarker = ["in-progress", "waiting"].includes(status) ? ` <!-- clt-todo:${status} -->` : "";
    const dueMarker = dueDate ? ` <!-- clt-todo-due:${dueDate} -->` : "";
    const completedMarker = completedAt ? ` <!-- clt-todo-completed:${completedAt} -->` : "";
    const detailMarker = details ? ` <!-- clt-todo-detail:${encodeTodoDetail(details)} -->` : "";
    const resultMarker = result ? ` <!-- clt-todo-result:${encodeTodoDetail(result)} -->` : "";
    const replacement = `- [${checkbox}] ${dateTime} : ${cleanText}${statusMarker}${dueMarker}${completedMarker}${detailMarker}${resultMarker}${todoWaitingMarker(waiting)}`;
    let replaced = false;
    await this.app.vault.process(file, (markdown) => {
      const lines = markdown.split(/\r?\n/);
      let sectionStart = -1;
      let headingLevel = 0;
      let currentTaskIndex = 0;
      for (let index = 0; index < lines.length; index += 1) {
        const heading = matchTodoHeading(lines[index]);
        if (!heading) continue;
        sectionStart = index + 1;
        headingLevel = heading[1].length;
        break;
      }
      if (sectionStart < 0) throw new Error("To-Do 섹션을 찾을 수 없습니다.");
      for (let index = sectionStart; index < lines.length; index += 1) {
        const heading = lines[index].match(/^(#{1,6})\s+/);
        if (heading && heading[1].length <= headingLevel) break;
        if (!/^\s*-\s*\[[ xX]\]\s*/.test(lines[index])) continue;
        if (currentTaskIndex === Number(task.taskIndex)) {
          lines[index] = replacement;
          replaced = true;
          break;
        }
        currentTaskIndex += 1;
      }
      if (!replaced) throw new Error("수정할 To-Do 항목을 찾을 수 없습니다.");
      return lines.join(markdown.includes("\r\n") ? "\r\n" : "\n");
    });
    await this.touchTodoLastChecked(file);
    return {
      ...task,
      ticketId: normalized,
      filePath: file.path,
      text: cleanText,
      status,
      dueDate,
      details,
      result,
      completedAt,
      dateTime,
      ...waiting,
      rawContent: replacement.replace(/^\s*-\s*\[[ xX]\]\s*/, "")
    };
  }

  async deleteTodoTask(task) {
    const normalized = normalizeTicketId(task?.ticketId);
    const file = task?.filePath
      ? this.app.vault.getAbstractFileByPath(task.filePath)
      : (normalized ? this.rootTicketFile(normalized) : this.generalTodoFile());
    if (!(file instanceof TFile)) throw new Error(normalized ? `${normalized} 티켓 노트를 찾을 수 없습니다.` : "To-Do 노트를 찾을 수 없습니다.");
    let deleted = false;
    await this.app.vault.process(file, (markdown) => {
      const lines = markdown.split(/\r?\n/);
      let sectionStart = -1;
      let headingLevel = 0;
      let currentTaskIndex = 0;
      for (let index = 0; index < lines.length; index += 1) {
        const heading = matchTodoHeading(lines[index]);
        if (!heading) continue;
        sectionStart = index + 1;
        headingLevel = heading[1].length;
        break;
      }
      if (sectionStart < 0) throw new Error("To-Do 섹션을 찾을 수 없습니다.");
      for (let index = sectionStart; index < lines.length; index += 1) {
        const heading = lines[index].match(/^(#{1,6})\s+/);
        if (heading && heading[1].length <= headingLevel) break;
        if (!/^\s*-\s*\[[ xX]\]\s*/.test(lines[index])) continue;
        if (currentTaskIndex === Number(task.taskIndex)) {
          lines.splice(index, 1);
          deleted = true;
          break;
        }
        currentTaskIndex += 1;
      }
      if (!deleted) throw new Error("삭제할 To-Do 항목을 찾을 수 없습니다. 화면을 새로고침한 후 다시 시도해 주세요.");
      return lines.join(markdown.includes("\r\n") ? "\r\n" : "\n");
    });
    await this.touchTodoLastChecked(file);
  }

  async touchTodoLastChecked(file) {
    if (!(file instanceof TFile)) return "";
    const today = localIsoDateTime().slice(0, 10);
    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        frontmatter["마지막확인"] = today;
      });
    } catch (_) {}
    return today;
  }

  async addTodoToGeneral(content, dueDate = "", status = "", details = "", result = "", waitingDetails = {}) {
    const cleanContent = stripCltTodoMetadata(String(content || "").replace(/\r?\n+/g, " "));
    if (!cleanContent) throw new Error("할 일을 입력해 주세요.");
    const safeStatus = status || this.getTodoWorkflow().find(state => state.enabled).key;
    this.assertTodoStatusEnabled(safeStatus);
    const file = await this.ensureGeneralTodoFile();
    const time = localIsoDateTime().slice(0, 16);
    const checkbox = safeStatus === "done" ? "x" : " ";
    const statusMarker = ["in-progress", "waiting"].includes(safeStatus) ? ` <!-- clt-todo:${safeStatus} -->` : "";
    const dueMarker = dueDate ? ` <!-- clt-todo-due:${dueDate} -->` : "";
    const completedMarker = safeStatus === "done" ? ` <!-- clt-todo-completed:${time} -->` : "";
    const detailMarker = String(details || "").trim() ? ` <!-- clt-todo-detail:${encodeTodoDetail(details)} -->` : "";
    const resultMarker = String(result || "").trim() ? ` <!-- clt-todo-result:${encodeTodoDetail(result)} -->` : "";
    await this.app.vault.process(file, (markdown) => appendEntryToMarkdownSection(
      markdown,
      "✅ To-Do",
      `- [${checkbox}] ${time} : ${cleanContent}${statusMarker}${dueMarker}${completedMarker}${detailMarker}${resultMarker}${todoWaitingMarker(todoWaitingChanges({}, waitingDetails, safeStatus, time))}`
    ));
    return { ticketId: "", time, path: file.path };
  }

  async addTodoToTicket(ticketId, content, dueDate = "", status = "", details = "", result = "", waitingDetails = {}) {
    const normalized = normalizeTicketId(ticketId);
    if (!normalized) return this.addTodoToGeneral(content, dueDate, status, details, result, waitingDetails);
    const file = this.rootTicketFile(normalized);
    if (!(file instanceof TFile)) throw new Error(`${normalized} 티켓 노트를 찾을 수 없습니다.`);
    const cleanContent = stripCltTodoMetadata(String(content || "").replace(/\r?\n+/g, " "));
    if (!cleanContent) throw new Error("할 일을 입력해 주세요.");
    const safeStatus = status || this.getTodoWorkflow().find(state => state.enabled).key;
    this.assertTodoStatusEnabled(safeStatus);
    const time = localIsoDateTime().slice(0, 16);
    const checkbox = safeStatus === "done" ? "x" : " ";
    const statusMarker = ["in-progress", "waiting"].includes(safeStatus) ? ` <!-- clt-todo:${safeStatus} -->` : "";
    const dueMarker = dueDate ? ` <!-- clt-todo-due:${dueDate} -->` : "";
    const completedMarker = safeStatus === "done" ? ` <!-- clt-todo-completed:${time} -->` : "";
    const detailMarker = String(details || "").trim() ? ` <!-- clt-todo-detail:${encodeTodoDetail(details)} -->` : "";
    const resultMarker = String(result || "").trim() ? ` <!-- clt-todo-result:${encodeTodoDetail(result)} -->` : "";
    await this.app.vault.process(file, (markdown) => appendEntryToMarkdownSection(
      markdown,
      "✅ To-Do",
      `- [${checkbox}] ${time} : ${cleanContent}${statusMarker}${dueMarker}${completedMarker}${detailMarker}${resultMarker}${todoWaitingMarker(todoWaitingChanges({}, waitingDetails, safeStatus, time))}`
    ));
    await this.touchTodoLastChecked(file);
    return { ticketId: normalized, time, path: file.path };
  }

  async normalizeTodoMetadataOnce() {
    if ((this.data.todoMetadataVersion || 0) >= 2) return;
    for (const file of this.rootTicketFiles()) {
      await this.app.vault.process(file, (markdown) => {
        const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
        const lines = markdown.split(/\r?\n/);
        let inTodoSection = false;
        let todoHeadingLevel = 0;
        for (let index = 0; index < lines.length; index += 1) {
          const heading = lines[index].match(/^(#{1,6})\s+(.*)$/);
          if (heading) {
            const normalized = String(heading[2] || "").replace(/[^a-z0-9가-힣]/gi, "").toLowerCase();
            if (normalized.includes("todo")) {
              const cleanedHeading = String(heading[2] || "").replace(/\s*[\]\)}]+\s*$/, "").trim();
              if (cleanedHeading !== heading[2]) lines[index] = `${heading[1]} ${cleanedHeading}`;
              inTodoSection = true;
              todoHeadingLevel = heading[1].length;
              continue;
            }
            if (inTodoSection && heading[1].length <= todoHeadingLevel) inTodoSection = false;
          }
          if (!inTodoSection) continue;
          const task = lines[index].match(/^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*)$/);
          if (!task) continue;
          const raw = task[4];
          const dueDate = raw.match(/<!--\s*clt-todo-due:(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?)\s*-->/i)?.[1] || "";
          const completedAt = raw.match(/<!--\s*clt-todo-completed:([^>]+?)\s*-->/i)?.[1]?.trim() || "";
          const inProgress = /<!--\s*clt-todo:in-progress\s*-->/i.test(raw);
          const waiting = /<!--\s*clt-todo:waiting\s*-->/i.test(raw);
          const clean = stripCltTodoMetadata(raw);
          const statusMarker = task[2].toLowerCase() !== "x"
            ? (waiting ? " <!-- clt-todo:waiting -->" : inProgress ? " <!-- clt-todo:in-progress -->" : "") : "";
          const dueMarker = dueDate ? ` <!-- clt-todo-due:${dueDate} -->` : "";
          const completedMarker = task[2].toLowerCase() === "x" && completedAt
            ? ` <!-- clt-todo-completed:${completedAt} -->`
            : "";
          const details = raw.match(/<!--\s*clt-todo-detail:[^>]*-->/i)?.[0] || "";
          const result = raw.match(/<!--\s*clt-todo-result:[^>]*-->/i)?.[0] || "";
          lines[index] = `${task[1]}${task[2]}${task[3]}${clean}${statusMarker}${dueMarker}${completedMarker}${details ? ` ${details}` : ""}${result ? ` ${result}` : ""}${todoWaitingMarker(readTodoWaiting(raw))}`;
        }
        return lines.join(newline);
      });
    }
    this.data.todoMetadataVersion = 2;
    await this.savePluginData();
  }

  async ensureStatusBlocksForAllRootTickets() {
    for (const file of this.rootTicketFiles()) {
      const ticketId = this.rootTicketIdFromFile(file);
      await this.app.vault.process(file, (markdown) => {
        let next = markdown;
        if (!/```clt-ticket-status\b/.test(next)) {
          const block = `\n\`\`\`clt-ticket-status\nticket: ${ticketId}\n\`\`\`\n`;
          const frontmatter = next.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
          next = frontmatter
            ? `${frontmatter[0]}${block}\n${next.slice(frontmatter[0].length)}`
            : `${block}\n${next}`;
        }
        next = next.replace(/(^##[^\r\n]*To-Do[^\r\n]*\r?\n(?:\r?\n)*)(?:- \[ \][ \t]*(?:\r?\n|$))/mi, "$1");
        next = ensureSectionActionBlock(next, ticketId, "📝 작업 일지", "clt-ticket-worklog-actions");
        next = ensureSectionActionBlock(next, ticketId, "🗓️ 회의록", "clt-ticket-meeting-actions");
        return ensureSectionActionBlock(next, ticketId, "✅ To-Do", "clt-ticket-todo-actions");
      });
    }
  }

  statusGuideFile(category) {
    const normalized = String(category || "").toUpperCase();
    const fileName = `${normalized} 상태별 업무 가이드.md`;
    return this.app.vault.getMarkdownFiles().find((file) =>
      file.name === fileName && file.path.split("/").includes(normalized)
    ) || null;
  }

  async openStatusGuideNote(category) {
    const file = this.statusGuideFile(category);
    if (!(file instanceof TFile)) {
      return new Notice(`${String(category || "").toUpperCase()} 전체 업무 가이드 노트를 찾을 수 없습니다. 현재 상태 가이드는 팝업에 내장되어 있습니다.`, 7000);
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  openCurrentStatusGuide(ticketId) {
    const normalized = normalizeTicketId(ticketId);
    const file = this.rootTicketFile(normalized);
    const frontmatter = file ? this.app.metadataCache.getFileCache(file)?.frontmatter || {} : {};
    const category = String(frontmatter.category || normalized.slice(0, 2)).toUpperCase();
    const status = String(frontmatter.status || this.data.tickets[normalized]?.state || "").trim();
    const guideMap = this.organizationPack?.statusGuides?.[category] || STATUS_GUIDES[category] || {};
    const guideKey = Object.keys(guideMap).find((key) => key.toLowerCase() === status.toLowerCase());
    new StatusGuideModal(this.app, this, normalized, category, status, guideKey ? guideMap[guideKey] : null).open();
  }

  renderTicketStatusControl(el, ticketId) {
    el.addClass("clt-sn-ticket-status");
    const ticket = this.data.tickets[ticketId];
    if (ticket?.shortDescription || ticket?.description) {
      const summary = el.createDiv({ cls: "clt-ticket-summary" });
      if (ticket.shortDescription) {
        summary.createDiv({ cls: "clt-sn-summary-label", text: "Short Description" });
        summary.createDiv({ cls: "clt-ticket-summary-title", text: ticket.shortDescription });
      }
      if (ticket.description) {
        const originalDescription = summary.createEl("details", { cls: "clt-ticket-summary-details" });
        originalDescription.createEl("summary", { text: "Description 펼치기" });
        originalDescription.createEl("pre", { text: ticket.description });
      }
      const languages = new Set([
        ...Object.keys(ticket.translations?.shortDescription || {}),
        ...Object.keys(ticket.translations?.description || {})
      ]);
      for (const language of languages) {
        const translatedShort = ticket.translations?.shortDescription?.[language] || "";
        const translatedDescription = ticket.translations?.description?.[language] || "";
        if (!translatedShort && !translatedDescription) continue;
        const languageLabel = language === "ko" ? "한국어" : language === "vi" ? "베트남어" : language;
        const translation = summary.createEl("details", { cls: "clt-ticket-translation-details" });
        translation.createEl("summary", { text: `${languageLabel} 번역 펼치기` });
        if (translatedShort) {
          translation.createDiv({ cls: "clt-sn-summary-label", text: "Short Description" });
          translation.createDiv({ cls: "clt-ticket-summary-title clt-sn-translation", text: translatedShort });
        }
        if (translatedDescription) {
          translation.createDiv({ cls: "clt-sn-summary-label", text: "Description" });
          translation.createEl("pre", { cls: "clt-sn-translation", text: translatedDescription });
        }
      }
    }

    const controls = el.createDiv({ cls: "clt-ticket-status-controls" });
    const status = controls.createSpan({ cls: "clt-sn-ticket-status-value" });
    const readStatus = () => {
      const file = this.rootTicketFile(ticketId);
      const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter || {} : {};
      status.setText(`ServiceNow 상태: ${String(fm.status || "미확인")}`);
    };
    readStatus();
    const guideButton = controls.createEl("button", {
      text: "현재 상태 업무 가이드",
      cls: "clt-status-guide-button"
    });
    guideButton.hidden = !this.organizationFeatureEnabled("statusGuides");
    guideButton.addEventListener("click", () => this.openCurrentStatusGuide(ticketId));
    const aiPrompt = controls.createEl("button", { text: "AI 티켓 분석 프롬프트 생성" });
    aiPrompt.hidden = !this.organizationFeatureEnabled("aiPrompt");
    const meetingAnalysis = controls.createEl("button", { text: "AI 회의록 분석" });
    meetingAnalysis.addEventListener("click", () => this.openMeetingAnalysisPromptModal(ticketId));
    const button = controls.createEl("button", { text: "상태·기본정보 갱신" });
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.setText("갱신 중…");
      try {
        const result = await this.syncTicketStatus(ticketId, { notify: true });
        if (result?.state) status.setText(`ServiceNow 상태: ${result.state}`);
        else readStatus();
      } catch (_) {
        readStatus();
      } finally {
        button.disabled = false;
        button.setText("상태·기본정보 갱신");
      }
    });
    const meetingImport = controls.createEl("button", { text: "회의록 가져오기" });
    meetingImport.addEventListener("click", () => this.openDriveMeetingCandidateModal(ticketId));
    const documents = controls.createEl("button", { text: "BS·FS·DS·UT 문서 갱신" });
    documents.hidden = !this.documentAutomationEnabled();
    documents.addEventListener("click", async () => {
      documents.disabled = true;
      documents.setText("문서 검색 중…");
      try {
        await this.refreshTicketDocuments(ticketId, { notify: true });
      } catch (error) {
        new Notice(`${ticketId} 문서 갱신 실패: ${error.message || error}`, 9000);
      } finally {
        documents.disabled = false;
        documents.setText("BS·FS·DS·UT 문서 갱신");
      }
    });
    const aiPromptDetails = el.createEl("details", { cls: "clt-ai-prompt-details" });
    aiPromptDetails.hidden = true;
    aiPromptDetails.createEl("summary", { text: "AI 티켓 분석 프롬프트 펼치기" });
    const aiPromptToolbar = aiPromptDetails.createDiv({ cls: "clt-ai-prompt-toolbar" });
    const copyPrompt = aiPromptToolbar.createEl("button", { text: "프롬프트 복사" });
    const aiPromptContent = aiPromptDetails.createEl("pre", { cls: "clt-ai-prompt-content" });
    let currentPrompt = "";
    copyPrompt.addEventListener("click", async (event) => {
      event.preventDefault();
      if (!currentPrompt) return;
      try {
        await navigator.clipboard.writeText(currentPrompt);
        new Notice(`${ticketId} AI 티켓 분석 프롬프트를 클립보드에 복사했습니다.`, 5000);
      } catch (error) {
        new Notice(`AI 프롬프트 복사 실패: ${error.message || error}`, 8000);
      }
    });
    aiPrompt.addEventListener("click", async () => {
      aiPrompt.disabled = true;
      aiPrompt.setText("티켓 분석 프롬프트 생성 중…");
      try {
        const generated = await this.generateAiPromptForTicket(ticketId);
        if (generated?.prompt) {
          currentPrompt = generated.prompt;
          aiPromptContent.setText(currentPrompt);
          aiPromptDetails.hidden = false;
          aiPromptDetails.open = true;
          if (generated.messages.length) new Notice(generated.messages.join("\n"), 10000);
        }
      } catch (error) {
        console.error(`[ServiceNow Manage] ${ticketId} AI 티켓 분석 프롬프트 생성 실패`, error);
        new Notice(`AI 티켓 분석 프롬프트 생성 실패: ${error.message || error}`, 10000);
      } finally {
        aiPrompt.disabled = false;
        aiPrompt.setText("AI 티켓 분석 프롬프트 생성");
      }
    });
  }

  async generateAiPromptForTicket(ticketId) {
    if (!this.organizationFeatureEnabled("aiPrompt")) {
      return new Notice("설정에서 업무가이드팩을 등록하고 업무가이드 기능을 켜세요.", 7000);
    }
    const normalized = normalizeTicketId(ticketId);
    const category = normalized.slice(0, 2);
    const rootFile = this.rootTicketFile(normalized);
    if (!rootFile || !["CR", "SR"].includes(category)) {
      return new Notice("CR/SR 원본 티켓 노트를 찾을 수 없습니다.", 7000);
    }
    const templateFile = this.app.vault.getAbstractFileByPath(this.aiPromptTemplatePath());
    const source = templateFile instanceof TFile
      ? await this.app.vault.read(templateFile)
      : this.organizationPack?.promptTemplate || defaultAiPromptTemplate();
    let prompt = selectAiPromptTemplate(source, category);
    if (!prompt) {
      return new Notice(`AI 내용 노트에서 ${category}_TEMPLATE.md 구간을 찾을 수 없습니다.`, 7000);
    }

    const fm = this.app.metadataCache.getFileCache(rootFile)?.frontmatter || {};
    const messages = [];
    const previousTicket = this.data.tickets[normalized] || { ticketId: normalized, entries: [] };
    let ticket = previousTicket;
    try {
      const fresh = await this.fetchTicket(normalized);
      const oldById = new Map((previousTicket.entries || []).map((entry) => [entry.id, entry]));
      fresh.entries = (fresh.entries || []).map((entry) => ({
        ...entry,
        translations: oldById.get(entry.id)?.translations || entry.translations || {}
      }));
      fresh.translations = {};
      for (const field of ["shortDescription", "description"]) {
        if (fresh[field] === previousTicket[field] && previousTicket.translations?.[field]) {
          fresh.translations[field] = previousTicket.translations[field];
        }
      }
      fresh.documentSearchInitialized = Boolean(previousTicket.documentSearchInitialized);
      ticket = fresh;
      this.data.tickets[normalized] = fresh;
    } catch (error) {
      console.warn(`[ServiceNow Manage] ${normalized} AI 프롬프트용 최신 조회 실패`, error);
      messages.push(`ServiceNow 최신 조회에 실패하여 마지막 저장 데이터를 사용했습니다: ${error.message || error}`);
    }

    let documentSync = { local: {}, downloaded: [], warnings: [], failures: {}, renamedBs: "" };
    try {
      documentSync = await this.downloadTicketCltDocuments(normalized, fm);
    } catch (error) {
      console.warn(`[ServiceNow Manage] ${normalized} AI 프롬프트용 문서 확인 실패`, error);
      const reason = String(error.message || error);
      documentSync.failures.GENERAL = reason;
      messages.push(`관련 문서 확인에 실패했지만 나머지 정보로 프롬프트를 생성했습니다: ${reason}`);
    }

    let savedImages = 0;
    try {
      savedImages = await this.persistTicketAttachmentImages(normalized, ticket);
    } catch (error) {
      console.warn(`[ServiceNow Manage] ${normalized} AI 프롬프트용 이미지 저장 실패`, error);
      messages.push(`ServiceNow 이미지 저장에 실패했지만 나머지 정보로 프롬프트를 생성했습니다: ${error.message || error}`);
    }
    ticket.documentDownloadFailures = { ...documentSync.failures };
    ticket.documentDownloadCheckedAt = new Date().toISOString();
    this.data.tickets[normalized] = ticket;
    await this.savePluginData();
    const workNotes = (ticket.entries || [])
      .filter((entry) => String(entry.type || "").toLowerCase() === "work note")
      .sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")))
      .map((entry) => entry.content || [entry.time, entry.author].filter(Boolean).join(" - "))
      .filter(Boolean)
      .join("\n\n");

    const numberLabel = category === "CR" ? "CR No" : "SR No";
    prompt = replacePromptField(prompt, numberLabel, "Short Description", normalized);
    prompt = replacePromptField(prompt, "Short Description", "Long Description", ticket.shortDescription || "");
    const longDescription = ticket.description
      || fm["Long Description"]
      || fm["long_description"]
      || fm.description
      || "(확인된 Long Description 없음)";
    prompt = replacePromptField(prompt, "Long Description", "My Position", longDescription);
    prompt = replacePromptField(
      prompt,
      "My Position",
      "Current Service now Status",
      String(this.organizationPack?.roleDescription || "Ticket coordinator / analyst")
    );
    prompt = replacePromptField(
      prompt,
      "Current Service now Status",
      "Service now Working note(시간순)",
      fm.status || ticket.state || ""
    );
    prompt = replacePromptWorkingNotes(prompt, workNotes);

    const documentValues = {
      BS: { link: fm.BS || "", local: documentSync.local.BS || "" },
      FS: { link: fm.FS || "", local: documentSync.local.FS || "" },
      DS: { link: fm.DS || "", local: documentSync.local.DS || "" },
      UT: { link: fm.ut || fm.UT || "", local: documentSync.local.UT || "" }
    };
    const documentAvailability = classifyPromptDocuments(documentValues, documentSync.failures);
    const { availableTypes, inaccessibleTypes } = documentAvailability;
    prompt = adaptPromptToAvailableDocuments(prompt, availableTypes, Boolean(documentSync.local.BS_KO));

    const documentLines = [
      "",
      "문서 사용 원칙:",
      "- 아래 로컬 경로에 직접 접근할 수 있으면 해당 파일을 읽어 분석하세요.",
      "- 로컬 경로에 접근할 수 없는 일반 채팅 AI라면 사용자가 이 채팅에 첨부한 동일 유형의 파일을 분석하세요.",
      "- 필요한 파일이 경로에도 없고 채팅에도 첨부되지 않았다면 내용을 추측하지 말고 사용자에게 파일 첨부를 요청하세요.",
      "- ServiceNow 및 Google Drive 원본 링크에 접근할 수 있다고 가정하지 마세요.",
      "",
      "티켓 및 분석 문서:",
      `- 티켓 노트: ${rootFile.path}`,
    ];
    for (const type of availableTypes) {
      documentLines.push(`- ${type} 로컬 파일: ${documentValues[type].local}`);
    }
    for (const type of inaccessibleTypes) {
      const reason = documentAvailability.failures[type]
        ? ` · 실패 사유: ${documentAvailability.failures[type]}`
        : "";
      documentLines.push(`- ${type}: 원본 링크는 등록되어 있으나 로컬 파일을 확보하지 못함${reason}`);
    }
    if (inaccessibleTypes.length) {
      documentLines.push(`- 중요: ${inaccessibleTypes.join("·")} 문서는 '없는 문서'가 아니라 '링크는 있으나 현재 접근할 수 없는 문서'입니다. 내용을 검토했다고 주장하지 말고 사용자에게 파일 첨부 또는 문서 권한 확인을 요청하세요.`);
    }
    if (documentSync.local.BS_KO) documentLines.push(`- BS-한글 번역본: ${documentSync.local.BS_KO}`);
    if (!availableTypes.length && !inaccessibleTypes.length) documentLines.push("- 분석 문서: 확인된 링크 또는 로컬 파일 없음");
    const imageContexts = serviceNowImageContext(ticket);
    if (imageContexts.length) {
      documentLines.push(
        "",
        "ServiceNow 이미지와 워킹노트 문맥:",
        "- 아래 이미지는 ServiceNow 첨부 시각을 기준으로 앞뒤 Work Note를 연결한 문맥상 위치입니다. ServiceNow가 본문 내 직접 삽입 관계를 제공하지 않은 경우 확정 관계로 단정하지 마세요."
      );
      for (const { entry, before, after } of imageContexts) {
        documentLines.push(
          `- 이미지 로컬 파일: ${this.absoluteVaultPath(entry.localPath)}`,
          `  - 첨부 정보: ${[entry.time, entry.author, entry.content].filter(Boolean).join(" · ")}`,
          `  - 직전 Work Note: ${workNoteContextSnippet(before)}`,
          `  - 직후 Work Note: ${workNoteContextSnippet(after)}`
        );
      }
      documentLines.push("- 분석 시 이미지의 화면·오류·표·강조 표시를 읽고, 위 앞뒤 Work Note와 함께 해석하세요.");
    } else {
      documentLines.push("- ServiceNow 로컬 이미지: 확인된 이미지 첨부 없음");
    }
    const documentBlock = documentLines.join("\n");
    const environmentBlock = buildAiEnvironmentInstructions(category, {
      templatePath: this.absoluteVaultPath(this.analysisTemplatePath(category)),
      ticketPath: this.absoluteVaultPath(rootFile.path),
      assetsPath: this.absoluteVaultPath(this.ticketAssetsFolder(normalized))
    });
    prompt = `${prompt.trim()}\n\n${environmentBlock}\n${documentBlock}\n`;

    if (documentSync.downloaded.length) {
      messages.push(`${documentSync.downloaded.join("·")} 문서를 ${this.ticketAssetsFolder(normalized)}에 저장했습니다.`);
    }
    if (savedImages) messages.push(`ServiceNow 이미지 ${savedImages}개를 ${this.ticketAssetsFolder(normalized)}/ServiceNow에 저장했습니다.`);
    if (documentSync.renamedBs) messages.push(`BS 문서를 ${documentSync.renamedBs}로 자동 정리했습니다.`);
    if (!documentSync.local.BS && fm.BS) {
      messages.push(`BS는 별도 권한이 필요한 문서이므로 ${this.ticketAssetsFolder(normalized)}에 직접 다운로드해 주세요.`);
    }
    messages.push(...documentSync.warnings);
    return { prompt, messages, availableTypes };
  }

  async autoCreateWorkNotesForFile(file, allowExisting = false) {
    if (!this.settings.autoCreateWorkNotes || this.autoLinking.has(file.path)) return;
    if (!allowExisting && !this.pendingNewTicketFiles.has(file.path)) return;
    const ticketId = this.rootTicketIdFromFile(file);
    if (!ticketId) return;

    this.autoLinking.add(file.path);
    try {
      if (allowExisting) {
        await this.openOrCreateWorkNotes(file, { open: false, ticketId });
        this.pendingNewTicketFiles.delete(file.path);
        return;
      }
      const synced = await this.initializeNewTicket(file, ticketId);
      this.pendingNewTicketFiles.delete(file.path);
      this.queueTicketChangeNotice({
        kind: "worknotes",
        ticketId,
        failed: !synced,
        message: synced
          ? `${ticketId} 워킹노트 생성·상태·최초 데이터 갱신을 완료했습니다.`
          : `${ticketId} 워킹노트를 연결했지만 최초 갱신에 실패했습니다. 워킹노트에서 다시 시도해 주세요.`,
        duration: 7000
      });
    } finally {
      this.autoLinking.delete(file.path);
    }
  }

  async initializeNewTicket(parentFile, ticketId) {
    const normalized = normalizeTicketId(ticketId || this.ticketIdFromFile(parentFile));
    if (!normalized) return null;
    await this.ensureFolder(this.ticketAssetsFolder(normalized));
    const existingTicket = this.data.tickets[normalized];
    const wasPreviouslySynced = Boolean(existingTicket?.lastSyncedAt);
    const frontmatter = this.app.metadataCache.getFileCache(parentFile)?.frontmatter || {};
    const hasExistingDocumentLink = [frontmatter.BS, frontmatter.FS, frontmatter.DS, frontmatter.ut]
      .some((value) => Boolean(String(value || "").trim()));
    await this.openOrCreateWorkNotes(parentFile, { open: false, ticketId: normalized });
    const fresh = await this.syncTicket(normalized, { rootFile: parentFile });
    const shouldSearchDocuments = fresh
      && this.documentAutomationEnabled()
      && this.settings.autoDocumentSearchOnNewTicket
      && !existingTicket?.documentSearchInitialized
      && !wasPreviouslySynced
      && !hasExistingDocumentLink;
    if (shouldSearchDocuments) {
      await this.refreshTicketDocuments(normalized, { ticket: fresh, initial: true });
    }
    if (fresh) {
      fresh.documentSearchInitialized = true;
      await this.savePluginData();
    }
    return fresh;
  }

  async openOrCreateWorkNotes(parentFile, options = {}) {
    const ticketId = normalizeTicketId(options.ticketId || this.ticketIdFromFile(parentFile));
    if (!ticketId) {
      new Notice("현재 노트의 id 또는 파일명에서 CR/SR/INC 번호를 확인할 수 없습니다.");
      return;
    }
    const fm = this.app.metadataCache.getFileCache(parentFile)?.frontmatter || {};
    let target = await this.resolveExistingWorkNotes(parentFile, fm);
    if (!target) {
      const folder = this.settings.workNotesFolder
        ? normalizePath(this.settings.workNotesFolder)
        : parentFile.parent?.path || "";
      await this.ensureFolder(folder);
      const targetPath = normalizePath(`${folder ? `${folder}/` : ""}${ticketId} 워킹노트.md`);
      const existing = this.app.vault.getAbstractFileByPath(targetPath);
      if (existing instanceof TFile) {
        target = existing;
      } else {
        const template = await this.readTemplate(this.workNotesTemplatePath(), defaultWorkNotesTemplate());
        target = await this.app.vault.create(targetPath, fillTemplate(template, {
          ticketId,
          parentName: parentFile.basename
        }));
      }
    }

    if (target.stat.size === 0) {
      const template = await this.readTemplate(this.workNotesTemplatePath(), defaultWorkNotesTemplate());
      await this.app.vault.process(target, () => fillTemplate(template, {
        ticketId,
        parentName: parentFile.basename
      }));
    }

    await this.app.fileManager.processFrontMatter(parentFile, (frontmatter) => {
      frontmatter["워킹노트"] = `[[${target.basename}]]`;
    });
    if (!this.data.tickets[ticketId]) {
      this.data.tickets[ticketId] = {
        ticketId,
        shortDescription: "",
        description: "",
        entries: [],
        lastSyncedAt: "",
        lastAttemptAt: "",
        lastError: ""
      };
      await this.savePluginData();
    }
    if (options.open !== false) await this.app.workspace.getLeaf(false).openFile(target);
  }

  async connectServiceNow() {
    if (this.settings.authMode === "bearer") {
      new BearerTokenModal(this.app, this).open();
      return;
    }
    const instanceUrl = cleanInstanceUrl(this.settings.instanceUrl);
    if (!instanceUrl || !this.settings.clientId) {
      new Notice("설정에서 ServiceNow 주소와 OAuth client ID를 먼저 입력하세요.", 6000);
      this.app.setting?.open?.();
      this.app.setting?.openTabById?.(PLUGIN_ID);
      return;
    }
    let redirect;
    try { redirect = new URL(this.settings.redirectUri); }
    catch (_) { return new Notice("OAuth callback URL 형식이 올바르지 않습니다."); }
    if (!['127.0.0.1', 'localhost'].includes(redirect.hostname) || redirect.protocol !== "http:") {
      return new Notice("현재 버전은 http://127.0.0.1 또는 localhost callback만 지원합니다.", 7000);
    }

    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const state = crypto.randomBytes(24).toString("base64url");
    this.pendingOAuth = { verifier, state };
    await this.startOAuthServer(redirect);

    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.settings.clientId,
      redirect_uri: this.settings.redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state
    });
    if (this.settings.oauthScope) params.set("scope", this.settings.oauthScope);
    await shell.openExternal(`${instanceUrl}/oauth_auth.do?${params.toString()}`);
    new Notice("브라우저에서 ServiceNow 로그인을 완료하세요.", 6000);
  }

  async startOAuthServer(redirect) {
    if (this.oauthServer) {
      try { this.oauthServer.close(); } catch (_) { /* no-op */ }
    }
    this.oauthServer = http.createServer(async (req, res) => {
      const requestUrlObject = new URL(req.url, this.settings.redirectUri);
      if (requestUrlObject.pathname !== redirect.pathname) {
        res.writeHead(404); res.end("Not found"); return;
      }
      const code = requestUrlObject.searchParams.get("code");
      const state = requestUrlObject.searchParams.get("state");
      const error = requestUrlObject.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body style='font-family:sans-serif;padding:40px'><h2>Obsidian으로 돌아가도 됩니다.</h2><p>이 창을 닫으세요.</p></body></html>");
      this.oauthServer.close();
      this.oauthServer = null;
      if (error) return new Notice(`ServiceNow 연결이 거부되었습니다: ${error}`, 7000);
      if (!code || !this.pendingOAuth || state !== this.pendingOAuth.state) {
        return new Notice("OAuth 응답을 확인할 수 없습니다. 다시 연결하세요.", 7000);
      }
      try {
        await this.exchangeAuthorizationCode(code, this.pendingOAuth.verifier);
        new Notice("ServiceNow 연결이 완료되었습니다.", 6000);
        this.views.forEach((views) => views.forEach((view) => view.render()));
      } catch (exchangeError) {
        new Notice(`ServiceNow 연결 실패: ${exchangeError.message}`, 9000);
      } finally {
        this.pendingOAuth = null;
      }
    });
    await new Promise((resolve, reject) => {
      this.oauthServer.once("error", reject);
      this.oauthServer.listen(Number(redirect.port || 80), redirect.hostname, resolve);
    });
  }

  async tokenRequest(params) {
    const response = await this.serviceNowRequest({
      url: `${cleanInstanceUrl(this.settings.instanceUrl)}/oauth_token.do`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      const message = response.json?.error_description || response.json?.error || response.text || `HTTP ${response.status}`;
      throw new Error(String(message).slice(0, 300));
    }
    return response.json;
  }

  async exchangeAuthorizationCode(code, verifier) {
    const token = await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.settings.redirectUri,
      client_id: this.settings.clientId,
      code_verifier: verifier
    });
    this.setSecret(ACCESS_TOKEN_KEY, token.access_token);
    if (token.refresh_token) this.setSecret(REFRESH_TOKEN_KEY, token.refresh_token);
    this.settings.tokenExpiresAt = Date.now() + Number(token.expires_in || 1800) * 1000;
    this.settings.connectedAt = localIsoDateTime();
    await this.savePluginData();
  }

  async saveManualBearerToken(token) {
    this.setSecret(ACCESS_TOKEN_KEY, cleanBearerToken(token));
    this.deleteSecret(REFRESH_TOKEN_KEY);
    this.settings.authMode = "bearer";
    this.settings.tokenExpiresAt = 0;
    this.settings.connectedAt = "";
    await this.savePluginData();
  }

  async testConnection() {
    const ticketId = Object.keys(this.data.tickets).map(normalizeTicketId).find(Boolean) || "";
    const table = ticketId ? this.serviceNowTableForTicket(ticketId) : (this.settings.changeRequestTable || "change_request");
    const response = await this.apiGet(`/api/now/table/${table}`, {
      ...(ticketId ? { sysparm_query: `number=${ticketId}` } : {}),
      sysparm_fields: "sys_id,number,short_description",
      sysparm_limit: 1
    });
    if (ticketId && !response.result?.length) {
      throw new Error(`${ticketId} 조회 결과가 없습니다. 토큰 권한과 티켓 접근 범위를 확인하세요.`);
    }
    this.settings.connectedAt = localIsoDateTime();
    await this.savePluginData();
    new Notice(ticketId
      ? `ServiceNow 연결 확인 완료 · ${ticketId} 조회 가능`
      : "ServiceNow 연결 확인 완료 · Change Request API 접근 가능", 7000);
    return true;
  }

  async refreshAccessToken() {
    const refreshToken = this.getSecret(REFRESH_TOKEN_KEY);
    if (!refreshToken) throw new Error("다시 로그인이 필요합니다.");
    const token = await this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.settings.clientId
    });
    this.setSecret(ACCESS_TOKEN_KEY, token.access_token);
    if (token.refresh_token) this.setSecret(REFRESH_TOKEN_KEY, token.refresh_token);
    this.settings.tokenExpiresAt = Date.now() + Number(token.expires_in || 1800) * 1000;
    await this.savePluginData();
    return token.access_token;
  }

  async validAccessToken() {
    const accessToken = this.getSecret(ACCESS_TOKEN_KEY);
    if (!accessToken) throw new Error("ServiceNow 연결이 필요합니다.");
    if (!this.settings.tokenExpiresAt || Date.now() < this.settings.tokenExpiresAt - 60_000) return accessToken;
    return this.refreshAccessToken();
  }

  async disconnectServiceNow() {
    const tokens = [this.getSecret(ACCESS_TOKEN_KEY), this.getSecret(REFRESH_TOKEN_KEY)].filter(Boolean);
    if (this.settings.authMode === "oauth") {
      for (const token of tokens) {
        try {
          await this.serviceNowRequest({
            url: `${cleanInstanceUrl(this.settings.instanceUrl)}/oauth_revoke_token.do?token=${encodeURIComponent(token)}`,
            method: "GET",
            throw: false
          });
        } catch (_) { /* local cleanup still proceeds */ }
      }
    }
    this.deleteSecret(ACCESS_TOKEN_KEY);
    this.deleteSecret(REFRESH_TOKEN_KEY);
    this.settings.tokenExpiresAt = 0;
    this.settings.connectedAt = "";
    await this.savePluginData();
    new Notice("ServiceNow 연결을 해제했습니다.");
  }

  organizationPackPath() {
    const configDir = this.app.vault.configDir || ".obsidian";
    return normalizePath(`${configDir}/plugins/${PLUGIN_ID}/organization-pack.json`);
  }

  validateOrganizationPack(pack) {
    if (!pack || Number(pack.schemaVersion) !== 1) throw new Error("지원하지 않는 업무가이드팩 형식입니다.");
    if (!String(pack.packId || "").trim() || !String(pack.name || "").trim()) {
      throw new Error("packId 또는 name이 없습니다.");
    }
    if (!pack.statusGuides && !pack.analysisTemplates && !pack.promptTemplate) {
      throw new Error("상태 가이드나 분석 템플릿이 없는 팩입니다.");
    }
    return pack;
  }

  async loadOrganizationPack() {
    try {
      const raw = await this.app.vault.adapter.read(this.organizationPackPath());
      return this.validateOrganizationPack(JSON.parse(raw));
    } catch (_) {
      return null;
    }
  }

  hasOrganizationPack() {
    return Boolean(this.organizationPack?.packId);
  }

  organizationFeatureEnabled(feature) {
    if (!this.settings.organizationFeaturesEnabled || !this.hasOrganizationPack()) return false;
    return this.organizationPack.features?.[feature] !== false;
  }

  organizationFeaturesEnabled() {
    return this.organizationFeatureEnabled("statusGuides") || this.organizationFeatureEnabled("aiPrompt");
  }

  documentAutomationEnabled() {
    return Boolean(this.settings.enableDocumentAutomation || (
      this.settings.organizationFeaturesEnabled
      && this.organizationPack?.features?.documentAutomation
    ));
  }

  importOrganizationPack(onDone) {
    const modal = new SettingsJsonImportModal(this.app, this, onDone);
    modal.open();
    return modal;
  }

  async applyOrganizationPack(value) {
    const previousPack = this.organizationPack;
    const pack = this.validateOrganizationPack(value);
    await this.app.vault.adapter.write(this.organizationPackPath(), `${JSON.stringify(pack, null, 2)}\n`);
    this.organizationPack = pack;
    this.settings.organizationFeaturesEnabled = true;
    const templateResult = await this.ensureOrganizationTemplates({ previousPack });
    await this.savePluginData();
    this.lastOrganizationPackApplyResult = templateResult;
    return pack;
  }

  async removeOrganizationPack(onDone) {
    try {
      if (await this.app.vault.adapter.exists(this.organizationPackPath())) {
        await this.app.vault.adapter.remove(this.organizationPackPath());
      }
      this.organizationPack = null;
      this.settings.organizationFeaturesEnabled = false;
      await this.savePluginData();
      new Notice("업무가이드팩을 제거했습니다. 기존 Vault 문서는 삭제하지 않습니다.", 7000);
      onDone?.();
    } catch (error) {
      new Notice(`업무가이드팩 제거 실패: ${error.message || error}`, 9000);
    }
  }

  async ensureOrganizationTemplates(options = {}) {
    if (!this.settings.organizationFeaturesEnabled || !this.hasOrganizationPack()) return;
    await this.ensureFolder(normalizePath(`${this.rootFolder()}/지침`));
    const files = [
      [
        this.aiPromptTemplatePath(),
        this.organizationPack.promptTemplate || defaultAiPromptTemplate(),
        options.previousPack?.promptTemplate || defaultAiPromptTemplate()
      ],
      [
        this.analysisTemplatePath("CR"),
        this.organizationPack.analysisTemplates?.CR || "",
        options.previousPack?.analysisTemplates?.CR || ""
      ],
      [
        this.analysisTemplatePath("SR"),
        this.organizationPack.analysisTemplates?.SR || "",
        options.previousPack?.analysisTemplates?.SR || ""
      ]
    ];
    const result = { created: 0, updated: 0, preserved: 0 };
    for (const [filePath, content, previousContent] of files) {
      if (!content) continue;
      const existing = this.app.vault.getAbstractFileByPath(filePath);
      if (!(existing instanceof TFile)) {
        await this.app.vault.create(filePath, content);
        result.created += 1;
        continue;
      }
      if (!options.previousPack || content === previousContent) continue;
      const currentContent = await this.app.vault.read(existing);
      if (currentContent === previousContent) {
        await this.app.vault.modify(existing, content);
        result.updated += 1;
      } else {
        result.preserved += 1;
      }
    }
    return result;
  }

  importGoogleOAuthJson(onDone) {
    const modal = new SettingsJsonImportModal(this.app, this, onDone, "google-oauth");
    modal.open();
    return modal;
  }

  async applyGoogleOAuthJson(value) {
    const credentials = value?.installed || value?.web;
    const clientId = String(credentials?.client_id || "").trim();
    const clientSecret = String(credentials?.client_secret || "").trim();
    if (!clientId || !clientSecret) throw new Error("client_id 또는 client_secret을 찾을 수 없습니다.");
    this.settings.googleClientId = clientId;
    this.setSecret(GOOGLE_CLIENT_SECRET_KEY, clientSecret);
    await this.savePluginData();
    return { clientId };
  }

  googleOAuthCredentials() {
    const clientId = String(this.settings.googleClientId || "").trim();
    const clientSecret = this.getSecret(GOOGLE_CLIENT_SECRET_KEY);
    if (!clientId || !clientSecret) {
      throw new Error("설정에서 Google Desktop OAuth JSON을 먼저 선택하세요.");
    }
    return { clientId, clientSecret };
  }

  hasGoogleDriveDownloadScope(scopes) {
    const list = Array.isArray(scopes)
      ? scopes
      : String(scopes || "").split(/\s+/).filter(Boolean);
    if (!list.length) return false;
    return list.some((s) => {
      const lower = String(s).toLowerCase();
      return lower.includes("/auth/drive.readonly")
        || lower.endsWith("/auth/drive")
        || lower === "https://www.googleapis.com/auth/drive";
    });
  }

  getGooglePermissionInfo() {
    const connected = Boolean(this.getSecret(GOOGLE_REFRESH_TOKEN_KEY) || this.getSecret(GOOGLE_ACCESS_TOKEN_KEY));
    if (!connected) {
      return {
        connected: false,
        hasDownloadPermission: false,
        hasMetadataPermission: false,
        scopes: [],
        permissionLabel: "",
        badge: "",
        needsReauth: false
      };
    }
    const grantedScopes = String(this.settings.googleGrantedScopes || "").split(/\s+/).filter(Boolean);
    const hasDownload = this.hasGoogleDriveDownloadScope(grantedScopes);
    const hasMetadata = grantedScopes.some((s) => s.toLowerCase().includes("/auth/drive.metadata"));
    const hasDownloadPermission = hasDownload || (this.settings.googleDriveContentAccess === true && !grantedScopes.length);
    const hasMetadataPermission = hasMetadata || hasDownloadPermission;

    let permissionLabel = "";
    let badge = "";
    let needsReauth = false;

    if (hasDownloadPermission) {
      permissionLabel = "파일 보기 및 다운로드 (drive.readonly)";
      badge = "🟢 파일 다운로드 권한 보유";
    } else if (hasMetadataPermission || this.settings.googleDriveContentAccess === false) {
      permissionLabel = "메타데이터 전용 (drive.metadata.readonly · 다운로드 권한 없음)";
      badge = "⚠️ 메타데이터 전용 (재인증 필요)";
      needsReauth = true;
    } else {
      permissionLabel = "권한 확인 필요 (이전 방식 연결)";
      badge = "⚠️ 재인증 필요";
      needsReauth = true;
    }

    return {
      connected: true,
      hasDownloadPermission,
      hasMetadataPermission,
      scopes: grantedScopes,
      permissionLabel,
      badge,
      needsReauth
    };
  }

  async inspectGoogleTokenScopes() {
    try {
      const token = await this.validGoogleAccessToken();
      const response = await requestUrl({
        url: `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${encodeURIComponent(token)}`,
        method: "GET",
        headers: { Accept: "application/json" },
        throw: false
      });
      if (response.status >= 200 && response.status < 300 && response.json?.scope) {
        const rawScope = String(response.json.scope || "").trim();
        this.settings.googleGrantedScopes = rawScope;
        this.settings.googleDriveContentAccess = this.hasGoogleDriveDownloadScope(rawScope);
        if (response.json.email && !this.settings.googleAccountEmail) {
          this.settings.googleAccountEmail = response.json.email;
        }
        await this.savePluginData();
        return { success: true, scope: rawScope, hasDownload: this.settings.googleDriveContentAccess };
      }
    } catch (error) {
      console.warn("[ServiceNow Manage] Google tokeninfo 확인 실패", error);
    }
    return { success: false, scope: "", hasDownload: Boolean(this.settings.googleDriveContentAccess) };
  }

  async connectGoogleDrive() {
    let clientId;
    try {
      ({ clientId } = this.googleOAuthCredentials());
    } catch (error) {
      new Notice(error.message, 8000);
      return;
    }
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const state = crypto.randomBytes(24).toString("base64url");
    const redirectUri = "http://127.0.0.1:42814/oauth/callback";
    this.pendingGoogleOAuth = { verifier, state, redirectUri };
    await this.startGoogleOAuthServer();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.metadata.readonly",
      access_type: "offline",
      prompt: "consent select_account",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state
    });
    await shell.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
    new Notice("브라우저에서 Google 계정을 선택하고 Drive 문서 읽기 및 다운로드 권한을 승인하세요.", 8000);
  }

  async startGoogleOAuthServer() {
    if (this.googleOAuthServer) {
      try { this.googleOAuthServer.close(); } catch (_) { /* no-op */ }
    }
    this.googleOAuthServer = http.createServer(async (req, res) => {
      const request = new URL(req.url, "http://127.0.0.1:42814");
      if (request.pathname !== "/oauth/callback") {
        res.writeHead(404); res.end("Not found"); return;
      }
      const code = request.searchParams.get("code");
      const state = request.searchParams.get("state");
      const error = request.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body style='font-family:sans-serif;padding:40px'><h2>Google Drive 연결 처리 완료</h2><p>Obsidian으로 돌아가세요.</p></body></html>");
      this.googleOAuthServer.close();
      this.googleOAuthServer = null;
      if (error) return new Notice(`Google 연결이 거부되었습니다: ${error}`, 8000);
      if (!code || !this.pendingGoogleOAuth || state !== this.pendingGoogleOAuth.state) {
        return new Notice("Google OAuth 응답을 확인할 수 없습니다. 다시 연결하세요.", 8000);
      }
      try {
        await this.exchangeGoogleAuthorizationCode(code, this.pendingGoogleOAuth);
        const about = await this.googleDriveApiGet("/drive/v3/about", { fields: "user(displayName,emailAddress)" });
        this.settings.googleAccountEmail = about.user?.emailAddress || about.user?.displayName || "";
        this.settings.googleConnectedAt = localIsoDateTime();
        await this.savePluginData();
        const permission = this.getGooglePermissionInfo();
        const scopeNotice = permission.hasDownloadPermission ? " · 파일 다운로드 권한 확인됨" : " · 파일 다운로드 권한 누락 (재인증 필요)";
        new Notice(`Google Drive 연결 완료 · ${this.settings.googleAccountEmail || "계정 확인됨"}${scopeNotice}`, 8000);
        if (this.workNotesSettingTab?.containerEl?.isShown()) {
          this.workNotesSettingTab.display();
        }
      } catch (exchangeError) {
        new Notice(`Google Drive 연결 실패: ${exchangeError.message || exchangeError}`, 10000);
      } finally {
        this.pendingGoogleOAuth = null;
      }
    });
    await new Promise((resolve, reject) => {
      this.googleOAuthServer.once("error", reject);
      this.googleOAuthServer.listen(42814, "127.0.0.1", resolve);
    });
  }

  async googleTokenRequest(params) {
    const response = await requestUrl({
      url: "https://oauth2.googleapis.com/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      const detail = response.json?.error_description || response.json?.error || response.text || `HTTP ${response.status}`;
      throw new Error(String(detail).slice(0, 400));
    }
    return response.json;
  }

  async exchangeGoogleAuthorizationCode(code, pending) {
    const { clientId, clientSecret } = this.googleOAuthCredentials();
    const params = {
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: pending.verifier
    };
    const token = await this.googleTokenRequest(params);
    this.setSecret(GOOGLE_ACCESS_TOKEN_KEY, token.access_token);
    if (token.refresh_token) this.setSecret(GOOGLE_REFRESH_TOKEN_KEY, token.refresh_token);
    this.settings.googleTokenExpiresAt = Date.now() + Number(token.expires_in || 3600) * 1000;
    const rawScope = String(token.scope || "").trim();
    if (rawScope) {
      this.settings.googleGrantedScopes = rawScope;
      this.settings.googleDriveContentAccess = this.hasGoogleDriveDownloadScope(rawScope);
    } else {
      await this.inspectGoogleTokenScopes();
    }
    await this.savePluginData();
  }

  async validGoogleAccessToken() {
    const accessToken = this.getSecret(GOOGLE_ACCESS_TOKEN_KEY);
    if (accessToken && Date.now() < Number(this.settings.googleTokenExpiresAt || 0) - 60_000) return accessToken;
    const refreshToken = this.getSecret(GOOGLE_REFRESH_TOKEN_KEY);
    if (!refreshToken) throw new Error("설정에서 Google Drive 계정을 연결하세요.");
    const { clientId, clientSecret } = this.googleOAuthCredentials();
    const params = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret
    };
    const token = await this.googleTokenRequest(params);
    this.setSecret(GOOGLE_ACCESS_TOKEN_KEY, token.access_token);
    this.settings.googleTokenExpiresAt = Date.now() + Number(token.expires_in || 3600) * 1000;
    await this.savePluginData();
    return token.access_token;
  }

  async googleDriveApiGet(path, query = {}) {
    const token = await this.validGoogleAccessToken();
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    });
    const response = await requestUrl({
      url: `https://www.googleapis.com${path}${params.size ? `?${params}` : ""}`,
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      const detail = response.json?.error?.message || response.text || `HTTP ${response.status}`;
      throw new Error(String(detail).slice(0, 400));
    }
    return response.json;
  }

  async googleDriveBinaryGet(path, query = {}) {
    const token = await this.validGoogleAccessToken();
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    });
    const response = await requestUrl({
      url: `https://www.googleapis.com${path}${params.size ? `?${params}` : ""}`,
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "*/*" },
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      const detail = response.json?.error?.message || response.text || `HTTP ${response.status}`;
      throw new Error(String(detail).slice(0, 400));
    }
    return response.arrayBuffer;
  }

  async googleWorkspaceDirectExport(fileId, mimeType) {
    const routes = {
      "application/vnd.google-apps.document": ["document", "docx"],
      "application/vnd.google-apps.spreadsheet": ["spreadsheets", "xlsx"],
      "application/vnd.google-apps.presentation": ["presentation", "pptx"],
      "application/vnd.google-apps.drawing": ["drawings", "pdf"]
    };
    const route = routes[mimeType];
    if (!route) throw new Error("대용량 Google 문서의 직접 다운로드 형식을 지원하지 않습니다.");
    const token = await this.validGoogleAccessToken();
    const [product, format] = route;
    const response = await requestUrl({
      url: `https://docs.google.com/${product}/d/${encodeURIComponent(fileId)}/export?format=${format}`,
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "*/*" },
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      const detail = response.json?.error?.message || response.text || `HTTP ${response.status}`;
      throw new Error(`대용량 직접 다운로드 실패: ${String(detail).slice(0, 300)}`);
    }
    return response.arrayBuffer;
  }

  findLocalTicketDocument(ticketId, type) {
    const normalizedType = String(type || "").toUpperCase();
    const folders = normalizedType === "BS"
      ? [`${this.ticketAssetsFolder(ticketId)}/`, `${this.ticketDocumentsFolder(ticketId)}/`]
      : [`${this.ticketAssetsFolder(ticketId)}/`];
    const prefix = `${normalizeTicketId(ticketId)} ${normalizedType}`;
    const candidates = this.app.vault.getFiles().filter((file) =>
      folders.some((folder) => file.path.startsWith(folder))
        && (
          file.basename.toUpperCase().startsWith(prefix.toUpperCase())
          || documentTypeFromFileName(file.basename) === normalizedType
        )
        && (normalizedType !== "BS" || !/BS[-_\s]*한글/i.test(file.basename))
    );
    candidates.sort((left, right) => {
      const leftPrefixed = left.basename.toUpperCase().startsWith(prefix.toUpperCase()) ? 0 : 1;
      const rightPrefixed = right.basename.toUpperCase().startsWith(prefix.toUpperCase()) ? 0 : 1;
      return leftPrefixed - rightPrefixed || left.path.localeCompare(right.path, "ko");
    });
    return candidates[0]?.path || "";
  }

  findLocalBsTranslation(ticketId) {
    const folder = `${this.ticketAssetsFolder(ticketId)}/`;
    const prefix = `${normalizeTicketId(ticketId)} BS-`;
    const candidates = this.app.vault.getFiles().filter((file) =>
      file.path.startsWith(folder)
        && file.basename.toUpperCase().startsWith(prefix.toUpperCase())
        && /BS[-_\s]*한글/i.test(file.basename)
    );
    candidates.sort((left, right) =>
      Number(right.stat?.mtime || 0) - Number(left.stat?.mtime || 0)
        || left.path.localeCompare(right.path, "ko")
    );
    return candidates[0]?.path || "";
  }

  ticketIdFromAssetsPath(path) {
    const prefix = `${this.ticketsFolder()}/`;
    const relative = normalizePath(String(path || ""));
    if (!relative.startsWith(prefix)) return "";
    const parts = relative.slice(prefix.length).split("/");
    const ticketId = normalizeTicketId(parts[0]);
    return /^(?:CR|SR)\d+$/.test(ticketId) && parts[1] === "assets" ? ticketId : "";
  }

  async onTicketAssetChanged(file) {
    if (!(file instanceof TFile)) return;
    const ticketId = this.ticketIdFromAssetsPath(file.path);
    if (!ticketId || this.linkingLocalBs.has(ticketId)) return;
    const type = documentTypeFromFileName(file.basename);
    if (type && type !== "BS") return;
    if (/BS[-_\s]*한글/i.test(file.basename)) return;
    const supported = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"]);
    if (!supported.has(String(file.extension || "").toLowerCase())) return;
    this.linkingLocalBs.add(ticketId);
    try {
      const bs = await this.normalizeManualBsDocument(ticketId);
      const linked = await this.linkLocalBsDocument(ticketId, bs.path);
      if (bs.renamed || linked.changed) {
        this.queueTicketChangeNotice({
          kind: "documents",
          ticketId,
          message: `${ticketId} 로컬 BS 문서를 티켓 노트에 연결했습니다.`,
          duration: 6000
        });
      }
    } catch (error) {
      console.error(`[ServiceNow Manage] ${ticketId} 로컬 BS 연결 실패`, error);
    } finally {
      this.linkingLocalBs.delete(ticketId);
    }
  }

  async linkExistingLocalBsDocuments() {
    for (const rootFile of this.rootTicketFiles()) {
      const ticketId = this.rootTicketIdFromFile(rootFile);
      if (!ticketId || this.linkingLocalBs.has(ticketId)) continue;
      this.linkingLocalBs.add(ticketId);
      try {
        const bs = await this.normalizeManualBsDocument(ticketId);
        await this.linkLocalBsDocument(ticketId, bs.path);
      } catch (error) {
        console.error(`[ServiceNow Manage] ${ticketId} 기존 로컬 BS 연결 실패`, error);
      } finally {
        this.linkingLocalBs.delete(ticketId);
      }
    }
  }

  async linkLocalBsDocument(ticketId, path) {
    if (!path) return { changed: false, value: "", source: "" };
    const normalized = normalizeTicketId(ticketId);
    const rootFile = this.rootTicketFile(normalized);
    if (!(rootFile instanceof TFile)) return { changed: false, value: "", source: "" };
    const remoteCandidates = extractDescriptionLinks(this.data.tickets[normalized]?.description || "");
    const localLink = `[[${normalizePath(path)}]]`;
    let result = { changed: false, value: "", source: "" };
    await this.app.fileManager.processFrontMatter(rootFile, (frontmatter) => {
      const current = String(frontmatter.BS || "").trim();
      const currentIsLocal = isLocalBsWikiLink(current, this.ticketAssetsFolder(normalized));
      if (remoteCandidates.length === 1 && (!current || currentIsLocal)) {
        const remote = remoteCandidates[0].url;
        if (current !== remote) frontmatter.BS = remote;
        result = { changed: current !== remote, value: remote, source: "ServiceNow Description" };
        return;
      }
      if (remoteCandidates.length > 0) return;
      if (!current || currentIsLocal) {
        if (current !== localLink) frontmatter.BS = localLink;
        result = { changed: current !== localLink, value: localLink, source: "local" };
      }
    });
    return result;
  }

  async linkLocalBsTranslation(ticketId, path) {
    if (!path) return;
    const rootFile = this.rootTicketFile(ticketId);
    if (!(rootFile instanceof TFile)) return;
    const link = `[[${path}]]`;
    await this.app.fileManager.processFrontMatter(rootFile, (frontmatter) => {
      frontmatter["BS-한글"] = link;
    });
  }

  async normalizeManualBsDocument(ticketId) {
    const existing = this.findLocalTicketDocument(ticketId, "BS");
    if (existing) {
      const source = this.app.vault.getAbstractFileByPath(existing);
      if (
        !(source instanceof TFile)
        || source.parent?.path !== this.ticketAssetsFolder(ticketId)
        || isStandardBsFileName(ticketId, source.basename)
      ) return { path: existing, renamed: "", warning: "" };
      return this.renameLocalBsToStandard(ticketId, source);
    }
    const assetsPrefix = `${this.ticketAssetsFolder(ticketId)}/`;
    const supported = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"]);
    const candidates = this.app.vault.getFiles().filter((file) =>
      file.parent?.path === this.ticketAssetsFolder(ticketId)
        && file.path.startsWith(assetsPrefix)
        && supported.has(String(file.extension || "").toLowerCase())
        && !documentTypeFromFileName(file.basename)
    );
    if (candidates.length !== 1) {
      return {
        path: "",
        renamed: "",
        warning: candidates.length > 1
          ? `BS로 판단할 수 있는 문서가 ${candidates.length}개입니다. BS 파일명에 BS를 넣어 주세요.`
          : ""
      };
    }
    return this.renameLocalBsToStandard(ticketId, candidates[0]);
  }

  async renameLocalBsToStandard(ticketId, source) {
    const extension = source.extension ? `.${source.extension}` : "";
    const base = standardBsBaseName(ticketId, source.basename);
    let target = normalizePath(`${this.ticketAssetsFolder(ticketId)}/${base}${extension}`);
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(target)) {
      target = normalizePath(`${this.ticketAssetsFolder(ticketId)}/${base} (${suffix})${extension}`);
      suffix += 1;
    }
    await this.app.fileManager.renameFile(source, target);
    return { path: target, renamed: target, warning: "" };
  }

  async saveDownloadedDocument(path, data) {
    const normalized = normalizePath(path);
    const parent = normalized.split("/").slice(0, -1).join("/");
    await this.ensureFolder(parent);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, data);
    else await this.app.vault.createBinary(normalized, data);
    return normalized;
  }

  async downloadGoogleDriveDocument(ticketId, type, link) {
    const fileId = googleDriveFileId(link);
    if (!fileId) throw new Error("Google Drive 파일 ID를 확인할 수 없습니다.");
    const encodedId = encodeURIComponent(fileId);
    let metadata;
    try {
      metadata = await this.googleDriveApiGet(`/drive/v3/files/${encodedId}`, {
        fields: "id,name,mimeType,modifiedTime",
        supportsAllDrives: "true"
      });
    } catch (error) {
      if (String(error.message || "").includes("403") || /insufficient/i.test(String(error.message || ""))) {
        throw new Error("Google Drive 권한 부족 (Google 계정 연결 시 Drive 체크박스 권한 허용 또는 Cloud Console 테스트 사용자 등록 필요)");
      }
      throw error;
    }
    const format = googleDownloadFormat(metadata.mimeType, metadata.name);
    let data;
    try {
      data = format.native
        ? await this.googleDriveBinaryGet(`/drive/v3/files/${encodedId}/export`, {
            mimeType: format.exportMime,
            supportsAllDrives: "true"
          })
        : await this.googleDriveBinaryGet(`/drive/v3/files/${encodedId}`, {
            alt: "media",
            supportsAllDrives: "true",
            acknowledgeAbuse: "true"
          });
    } catch (downloadError) {
      if (format.native && /too large|large to be exported|export size/i.test(String(downloadError.message || downloadError))) {
        data = await this.googleWorkspaceDirectExport(fileId, metadata.mimeType);
      } else {
        if (String(downloadError.message || "").includes("403")) {
          throw new Error("파일 다운로드 권한 부족 (Google 권한 동의 체크박스 또는 공유 드라이브 접근 확인 필요)");
        }
        throw downloadError;
      }
    }
    const target = `${this.ticketAssetsFolder(ticketId)}/${safeFileName(`${normalizeTicketId(ticketId)} ${type}`)}${format.extension}`;
    return this.saveDownloadedDocument(target, data);
  }

  async downloadTicketCltDocuments(ticketId, frontmatter) {
    const bs = await this.normalizeManualBsDocument(ticketId);
    const local = {
      BS: bs.path,
      BS_KO: this.findLocalBsTranslation(ticketId),
      FS: this.findLocalTicketDocument(ticketId, "FS"),
      DS: this.findLocalTicketDocument(ticketId, "DS"),
      UT: this.findLocalTicketDocument(ticketId, "UT")
    };
    const result = { downloaded: [], warnings: bs.warning ? [bs.warning] : [], failures: {}, local, renamedBs: bs.renamed, linkedBs: null };
    await this.linkLocalBsTranslation(ticketId, local.BS_KO);
    result.linkedBs = await this.linkLocalBsDocument(ticketId, local.BS);
    const links = {
      FS: frontmatter.FS,
      DS: frontmatter.DS,
      UT: frontmatter.ut || frontmatter.UT
    };
    if (!Object.values(links).some(Boolean)) return result;
    const cltConnected = Boolean(this.getSecret(GOOGLE_REFRESH_TOKEN_KEY) || this.getSecret(GOOGLE_ACCESS_TOKEN_KEY));
    if (!cltConnected) return result;
    if (!this.settings.googleDriveContentAccess) {
      result.warnings.push("현재 Google 연결에 파일 다운로드 권한(drive.readonly)이 없습니다. 설정에서 [재인증 필요]를 눌러 Google 권한을 다시 승인해 주세요.");
      return result;
    }
    for (const [type, link] of Object.entries(links)) {
      if (!link) continue;
      try {
        result.local[type] = await this.downloadGoogleDriveDocument(ticketId, type, link);
        result.downloaded.push(type);
      } catch (error) {
        const reason = String(error.message || error);
        result.failures[type] = reason;
        result.warnings.push(`${type} 다운로드 실패: ${reason}`);
      }
    }
    result.local.BS = this.findLocalTicketDocument(ticketId, "BS");
    return result;
  }

  async searchGoogleDriveDocuments(ticketId) {
    const normalized = normalizeTicketId(ticketId);
    if (!normalized) throw new Error("올바른 티켓 번호를 입력해 주세요.");
    const baseQuery = {
      // Search the ticket prefix, then enforce the document separator locally.
      // Titles such as CR0000000 _FS must not be excluded by the API query.
      q: `name contains '${normalized}' and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)",
      orderBy: "modifiedTime desc",
      pageSize: 100,
      spaces: "drive",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true"
    };
    const responses = [];
    for (const corpora of ["user", "allDrives"]) {
      try {
        let pageToken = "";
        const seenTokens = new Set();
        do {
          const response = await this.googleDriveApiGet("/drive/v3/files", { ...baseQuery, corpora, pageToken });
          responses.push(response);
          pageToken = response.nextPageToken || "";
          if (pageToken && seenTokens.has(pageToken)) throw new Error("Google Drive 검색 페이지가 반복되었습니다. 다시 검색해 주세요.");
          if (pageToken) seenTokens.add(pageToken);
        } while (pageToken);
      } catch (error) {
        if (corpora === "user") throw error;
        console.warn("[Google Drive] 공유 드라이브 통합 검색 제외", error);
      }
    }
    const filesById = new Map();
    responses.flatMap((response) => response.files || []).forEach((file) => filesById.set(file.id, file));
    const groups = { FS: [], DS: [], UT: [] };
    [...filesById.values()]
      .sort((left, right) => String(right.modifiedTime || "").localeCompare(String(left.modifiedTime || "")))
      .forEach((file) => {
      const match = String(file.name || "").trim().toUpperCase().match(new RegExp(`^${normalized}\\s*_\\s*(FS|DS|UT)(?:_|\\b)`));
      if (!match) return;
      groups[match[1]].push({
        type: match[1],
        name: file.name,
        url: file.webViewLink || `https://drive.google.com/open?id=${encodeURIComponent(file.id)}`,
        modifiedTime: file.modifiedTime ? localIsoDateTime(new Date(file.modifiedTime)) : "",
        source: "Google Drive"
      });
      });
    return groups;
  }

  async searchGoogleDriveMeetingDocuments(ticketId, searchText = "") {
    const normalized = normalizeTicketId(ticketId);
    const manualQuery = String(searchText || "").trim();
    const searchTerms = manualQuery.split(/\s+/).filter(Boolean);
    const escapeDriveQuery = (value) => String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const nameQuery = searchTerms.length
      ? searchTerms.map((term) => `name contains '${escapeDriveQuery(term)}'`).join(" and ")
      : `name contains '${normalized}' and name contains 'Gemini가 작성한 회의록'`;
    const baseQuery = {
      q: `${nameQuery} and mimeType = 'application/vnd.google-apps.document' and trashed = false`,
      fields: "files(id,name,mimeType,createdTime,modifiedTime,webViewLink,owners(displayName,emailAddress))",
      orderBy: "modifiedTime desc",
      pageSize: 100,
      spaces: "drive",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true"
    };
    const responses = [];
    for (const corpora of ["user", "allDrives"]) {
      try {
        responses.push(await this.googleDriveApiGet("/drive/v3/files", { ...baseQuery, corpora }));
      } catch (error) {
        if (corpora === "user") throw error;
        console.warn("[Google Drive] 공유 드라이브 회의록 검색 제외", error);
      }
    }
    const files = new Map();
    responses.flatMap((response) => response.files || []).forEach((file) => files.set(file.id, file));
    return [...files.values()]
      .filter((file) => {
        const name = String(file.name || "");
        if (searchTerms.length) {
          const comparableName = name.toLocaleLowerCase();
          return searchTerms.every((term) => comparableName.includes(term.toLocaleLowerCase()));
        }
        return name.toUpperCase().includes(normalized) && name.includes("Gemini가 작성한 회의록");
      })
      .map((file) => {
        const fallback = new Date(file.createdTime || file.modifiedTime || Date.now());
        return {
          ...file,
          meetingDate: parseMeetingDate(file.name, fallback),
          modifiedTime: file.modifiedTime ? localIsoDateTime(new Date(file.modifiedTime)).slice(0, 16) : "",
          owner: file.owners?.[0]?.displayName || file.owners?.[0]?.emailAddress || ""
        };
      })
      .sort((left, right) => String(right.meetingDate).localeCompare(String(left.meetingDate)));
  }

  async importGoogleDriveMeeting(ticketId, candidate) {
    const ticketIds = normalizeMeetingTicketIds(ticketId);
    const normalized = ticketIds[0] || "";
    const rootFiles = ticketIds.map((id) => ({ id, file: this.rootTicketFile(id) }));
    const missing = rootFiles.filter(({ file }) => !(file instanceof TFile)).map(({ id }) => id);
    if (missing.length) throw new Error(`${missing.join(", ")} 원본 티켓 노트를 찾을 수 없습니다.`);
    if (!candidate?.id) throw new Error("Google Drive 회의록 ID가 없습니다.");
    if (ticketIds.some((id) => this.listTicketMeetings(id).some((meeting) => meeting.sourceDriveId === candidate.id))) {
      return { note: null, warnings: [`${candidate.name}: 이미 추가된 회의록입니다.`] };
    }
    const encodedId = encodeURIComponent(candidate.id);
    const markdownData = await this.googleDriveBinaryGet(`/drive/v3/files/${encodedId}/export`, {
      mimeType: "text/markdown"
    });
    const sourceText = new TextDecoder("utf-8").decode(markdownData);
    if (!sourceText.trim()) throw new Error(`${candidate.name}의 Markdown 내용이 비어 있습니다.`);
    const folder = ticketIds.length === 1 ? this.ticketMeetingsFolder(normalized) : this.generalMeetingsFolder();
    await this.ensureFolder(folder);
    const meetingDate = candidate.meetingDate || parseMeetingDate(candidate.name);
    const titleFromBody = sourceText.match(/^##\s+(?:\*\*)?(.+?)(?:\*\*)?\s*$/m)?.[1] || candidate.name;
    const title = cleanMeetingTitle(titleFromBody, normalized);
    const fileStem = `${meetingDate.slice(0, 10)} ${meetingDate.slice(11, 16).replace(":", "-")} - ${safeFileName(title).slice(0, 90)}`;
    const warnings = [];
    let pdfPath = "";
    try {
      const pdfData = await this.googleDriveBinaryGet(`/drive/v3/files/${encodedId}/export`, {
        mimeType: "application/pdf"
      });
      pdfPath = await this.uniqueVaultPath(`${folder}/${fileStem} - Gemini 원본.pdf`);
      await this.saveDownloadedDocument(pdfPath, pdfData);
    } catch (error) {
      warnings.push(`${candidate.name}: PDF 원본 저장 실패 - ${error.message || error}`);
    }
    const notePath = await this.uniqueVaultPath(`${folder}/${fileStem}.md`);
    const markdown = buildMeetingNoteMarkdown({
      ticketId: normalized,
      ticketIds,
      sourceName: candidate.name,
      sourceText,
      meetingDate,
      title,
      pdfPath,
      sourceDriveId: candidate.id
    });
    const note = await this.app.vault.create(notePath, markdown);
    this.pendingMeetingTicketLinks ||= new Map();
    this.pendingMeetingTicketLinks.set(note.path, ticketIds);
    for (const { id, file } of rootFiles) await this.ensureMeetingSection(file, id);
    ticketIds.forEach((id) => this.refreshViews(id));
    return { note, warnings };
  }

  async refreshTicketDocuments(ticketId, options = {}) {
    const normalized = normalizeTicketId(ticketId);
    const rootFile = this.rootTicketFile(normalized);
    if (!rootFile) throw new Error(`${normalized} 원본 티켓 노트를 찾을 수 없습니다.`);
    let ticket = options.ticket || this.data.tickets[normalized];
    if (!ticket?.lastSyncedAt) ticket = await this.syncTicket(normalized, { rootFile });
    if (!ticket) throw new Error("ServiceNow 상세 내용을 먼저 가져오지 못했습니다.");

    const frontmatter = this.app.metadataCache.getFileCache(rootFile)?.frontmatter || {};
    const currentValues = {
      BS: String(frontmatter.BS || ""),
      FS: String(frontmatter.FS || ""),
      DS: String(frontmatter.DS || ""),
      UT: String(frontmatter.ut || "")
    };
    const candidateGroups = {
      BS: extractDescriptionLinks(ticket.description),
      FS: [],
      DS: [],
      UT: []
    };
    const warnings = [];
    const googleConnected = Boolean(this.getSecret(GOOGLE_REFRESH_TOKEN_KEY) || this.getSecret(GOOGLE_ACCESS_TOKEN_KEY));
    if (googleConnected) {
      try {
        const driveGroups = await this.searchGoogleDriveDocuments(normalized);
        candidateGroups.FS = driveGroups.FS;
        candidateGroups.DS = driveGroups.DS;
        candidateGroups.UT = driveGroups.UT;
      } catch (error) {
        warnings.push(`Google Drive 검색 실패: ${error.message || error}`);
      }
    } else {
      warnings.push("Google Drive가 연결되지 않아 FS·DS·UT 검색을 건너뛰었습니다.");
    }

    const updates = {};
    const multiple = {};
    Object.entries(candidateGroups).forEach(([type, candidates]) => {
      if (options.initial && currentValues[type]) return;
      if (candidates.length === 1) updates[type] = candidates[0].url;
      if (candidates.length > 1) {
        multiple[type] = candidates;
      }
    });
    for (const type of ["BS", "FS", "DS", "UT"]) {
      const candidates = multiple[type];
      if (!candidates) continue;
      const selected = await new Promise((resolve) => {
        new DocumentCandidateModal(this.app, normalized, { [type]: candidates }, currentValues, resolve).open();
      });
      Object.assign(updates, selected);
    }

    const changedFields = Object.entries(updates).filter(([type, url]) => url && currentValues[type] !== url);
    if (changedFields.length) {
      await this.app.fileManager.processFrontMatter(rootFile, (fm) => {
        changedFields.forEach(([type, url]) => {
          fm[type === "UT" ? "ut" : type] = url;
        });
      });
    }

    const effectiveFrontmatter = { ...frontmatter };
    changedFields.forEach(([type, url]) => {
      effectiveFrontmatter[type === "UT" ? "ut" : type] = url;
    });
    const downloadResult = await this.downloadTicketCltDocuments(normalized, effectiveFrontmatter);
    warnings.push(...downloadResult.warnings);

    if (options.notify || options.initial) {
      const candidateCount = Object.values(candidateGroups).reduce((sum, list) => sum + list.length, 0);
      const result = changedFields.length
        ? `${changedFields.map(([type]) => type).join("·")} 링크 반영 완료`
        : downloadResult.linkedBs?.changed
          ? "BS 로컬 파일 연결 완료"
          : candidateCount ? "선택한 새 링크가 없습니다." : "검색된 문서 링크가 없습니다.";
      const downloaded = downloadResult.downloaded.length
        ? `\n${downloadResult.downloaded.join("·")} 파일 다운로드 완료`
        : "";
      new Notice(`${normalized} 문서 검색 · ${result}${downloaded}${warnings.length ? `\n${warnings.join("\n")}` : ""}`, 10000);
    }
    return { changedFields, candidateGroups, warnings, downloaded: downloadResult.downloaded };
  }

  async disconnectGoogleDrive() {
    const token = this.getSecret(GOOGLE_REFRESH_TOKEN_KEY) || this.getSecret(GOOGLE_ACCESS_TOKEN_KEY);
    if (token) {
      try {
        await requestUrl({
          url: `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          throw: false
        });
      } catch (_) { /* local cleanup still proceeds */ }
    }
    this.deleteSecret(GOOGLE_ACCESS_TOKEN_KEY);
    this.deleteSecret(GOOGLE_REFRESH_TOKEN_KEY);
    this.settings.googleTokenExpiresAt = 0;
    this.settings.googleConnectedAt = "";
    this.settings.googleAccountEmail = "";
    this.settings.googleDriveContentAccess = false;
    this.settings.googleGrantedScopes = "";
    await this.savePluginData();
    new Notice("Google Drive 연결을 해제했습니다.");
  }

  async apiGet(path, query = {}) {
    const token = await this.validAccessToken();
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    });
    const url = `${cleanInstanceUrl(this.settings.instanceUrl)}${path}${params.size ? `?${params}` : ""}`;
    const response = await this.serviceNowRequest({
      url,
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      throw: false
    });
    if (response.status === 401) {
      this.settings.tokenExpiresAt = 0;
      await this.savePluginData();
      throw new Error("ServiceNow 인증이 만료되었습니다. 다시 연결하세요.");
    }
    if (response.status < 200 || response.status >= 300) {
      const detail = response.json?.error?.message || response.json?.error?.detail || response.text || `HTTP ${response.status}`;
      throw new Error(String(detail).slice(0, 400));
    }
    return response.json;
  }

  async serviceNowRequest(options) {
    try {
      return await requestUrl(options);
    } catch (error) {
      if (!isClientAuthCertificateError(error)) throw error;
      console.warn("[ServiceNow Manage] Obsidian requestUrl 인증서 오류로 Node HTTPS 재시도", error);
      return nodeHttpsRequest(options);
    }
  }

  async attachmentImageDataUrl(entry) {
    const attachmentId = String(entry?.attachmentId || "").trim();
    if (!attachmentId) throw new Error("첨부파일 ID가 없습니다.");
    if (Number(entry.sizeBytes || 0) > 15 * 1024 * 1024) throw new Error("15MB를 초과해 미리보기를 생략했습니다.");
    if (this.attachmentImageCache.has(attachmentId)) return this.attachmentImageCache.get(attachmentId);
    const loading = (async () => {
      const token = await this.validAccessToken();
      const response = await this.serviceNowRequest({
        url: `${cleanInstanceUrl(this.settings.instanceUrl)}/api/now/attachment/${encodeURIComponent(attachmentId)}/file`,
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: entry.contentType || "image/*" },
        throw: false
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(response.text || `HTTP ${response.status}`);
      }
      const responseType = response.headers?.["content-type"] || response.headers?.["Content-Type"] || "";
      const contentType = String(entry.contentType || responseType || "image/png").split(";")[0];
      if (!contentType.toLowerCase().startsWith("image/")) throw new Error("이미지 형식이 아닙니다.");
      return `data:${contentType};base64,${Buffer.from(response.arrayBuffer).toString("base64")}`;
    })();
    this.attachmentImageCache.set(attachmentId, loading);
    try {
      return await loading;
    } catch (error) {
      this.attachmentImageCache.delete(attachmentId);
      throw error;
    }
  }

  async persistTicketAttachmentImages(ticketId, ticket) {
    const images = (ticket?.entries || []).filter((entry) =>
      entry.type === "Attachment"
      && isImageAttachment(entry.content, entry.contentType)
      && entry.attachmentId
      && Number(entry.sizeBytes || 0) <= 15 * 1024 * 1024
    );
    if (!images.length) return 0;
    const folder = normalizePath(`${this.ticketAssetsFolder(ticketId)}/ServiceNow`);
    await this.ensureFolder(folder);
    let saved = 0;
    for (const entry of images) {
      const original = String(entry.content || "attachment-image")
        .replace(/[\\/:*?"<>|#[\]^]/g, "_")
        .trim() || "attachment-image";
      const id = String(entry.attachmentId).slice(0, 12);
      const fileName = `SN-${id}-${original}`;
      const path = normalizePath(`${folder}/${fileName}`);
      entry.localPath = path;
      if (this.app.vault.getAbstractFileByPath(path)) continue;
      try {
        const dataUrl = await this.attachmentImageDataUrl(entry);
        const encoded = String(dataUrl).split(",", 2)[1] || "";
        const bytes = Buffer.from(encoded, "base64");
        const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        await this.app.vault.createBinary(path, arrayBuffer);
        saved += 1;
      } catch (error) {
        ticket.warnings = [...(ticket.warnings || []), `이미지 로컬 저장 제외 (${original}): ${error.message || error}`];
      }
    }
    return saved;
  }

  async ensureAttachmentVideoFile(ticketId, entry) {
    if (!isVideoAttachment(entry?.content, entry?.contentType)) throw new Error("영상 형식이 아닙니다.");
    const size = Number(entry?.sizeBytes || 0);
    if (size > 100 * 1024 * 1024) throw new Error("100MB를 초과해 자동 재생 준비를 생략했습니다.");
    const attachmentId = serviceNowAttachmentId(entry);
    if (!attachmentId) throw new Error("첨부파일 ID가 없습니다.");
    const folder = normalizePath(`${this.ticketAssetsFolder(ticketId)}/ServiceNow`);
    await this.ensureFolder(folder);
    const original = String(entry.content || "attachment-video")
      .replace(/[\\/:*?"<>|#[\]^]/g, "_")
      .trim() || "attachment-video.mp4";
    const path = normalizePath(`${folder}/SN-${attachmentId.slice(0, 12)}-${original}`);
    entry.localPath = path;
    if (this.app.vault.getAbstractFileByPath(path)) return path;
    const token = await this.validAccessToken();
    const response = await this.serviceNowRequest({
      url: `${cleanInstanceUrl(this.settings.instanceUrl)}/api/now/attachment/${encodeURIComponent(attachmentId)}/file`,
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: entry.contentType || "video/*" },
      throw: false
    });
    if (response.status < 200 || response.status >= 300) throw new Error(response.text || `HTTP ${response.status}`);
    const responseType = response.headers?.["content-type"] || response.headers?.["Content-Type"] || "";
    const contentType = String(entry.contentType || responseType).split(";")[0].toLowerCase();
    if (!contentType.startsWith("video/") && !isVideoAttachment(original, contentType)) {
      throw new Error("ServiceNow가 영상 형식으로 반환하지 않았습니다.");
    }
    const bytes = Buffer.from(response.arrayBuffer);
    if (bytes.byteLength > 100 * 1024 * 1024) throw new Error("다운로드된 영상이 100MB를 초과합니다.");
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    await this.app.vault.createBinary(path, arrayBuffer);
    await this.savePluginData();
    return path;
  }

  async persistTicketAttachmentVideos(ticketId, ticket) {
    const videos = (ticket?.entries || []).filter((entry) =>
      entry.type === "Attachment"
      && isVideoAttachment(entry.content, entry.contentType)
      && serviceNowAttachmentId(entry)
      && Number(entry.sizeBytes || 0) <= 100 * 1024 * 1024
    );
    let saved = 0;
    for (const entry of videos) {
      const existed = entry.localPath && this.app.vault.getAbstractFileByPath(entry.localPath);
      try {
        await this.ensureAttachmentVideoFile(ticketId, entry);
        if (!existed) saved += 1;
      } catch (error) {
        ticket.warnings = [...(ticket.warnings || []), `영상 로컬 저장 제외 (${entry.content || "첨부 영상"}): ${error.message || error}`];
      }
    }
    return saved;
  }

  async fetchTicket(ticketId) {
    const table = this.serviceNowTableForTicket(ticketId);
    if (!table) throw new Error("지원하지 않는 티켓 번호입니다.");
    const lookup = await this.apiGet(`/api/now/table/${table}`, {
      sysparm_query: `number=${ticketId}`,
      sysparm_display_value: "all",
      sysparm_limit: 1
    });
    const record = lookup.result?.[0];
    if (!record?.sys_id) throw new Error(`${ticketId} 티켓을 찾을 수 없습니다.`);
    const sysId = rawFieldValue(record.sys_id);

    const detailResponse = await this.apiGet(`/api/now/table/${table}/${sysId}`, {
      sysparm_fields: "number,short_description,description,work_notes,state,assignment_group,assigned_to,sys_updated_on",
      sysparm_display_value: "all"
    });
    const detail = detailResponse.result || {};
    const metadata = extractTicketMetadata(record);

    const warnings = [];
    let attachmentResponse = { result: [] };
    try {
      attachmentResponse = await this.apiGet("/api/now/table/sys_attachment", {
        sysparm_query: `table_name=${table}^table_sys_id=${sysId}`,
        sysparm_fields: "sys_id,file_name,content_type,size_bytes,sys_created_on,sys_created_by",
        sysparm_limit: 200
      });
    } catch (error) {
      warnings.push(`첨부파일 이력 제외: ${error.message}`);
    }
    const attachments = (attachmentResponse.result || []).map((file) => {
      const attachmentId = fieldValue(file.sys_id);
      return {
        id: `attachment-${attachmentId || hashId(JSON.stringify(file))}`,
        time: utcServiceNowToKst(fieldValue(file.sys_created_on)),
        type: "Attachment",
        author: fieldValue(file.sys_created_by),
        content: fieldValue(file.file_name) || "첨부파일",
        attachmentId,
        contentType: fieldValue(file.content_type),
        sizeBytes: Number(rawFieldValue(file.size_bytes) || 0),
        priority: 3,
        url: `${cleanInstanceUrl(this.settings.instanceUrl)}/sys_attachment.do?sys_id=${encodeURIComponent(attachmentId)}&view=true`
      };
    });

    let workNotes = parseWorkNotes(fieldValue(detail.work_notes));
    if (!workNotes.length) {
      try {
        const journalResponse = await this.apiGet("/api/now/table/sys_journal_field", {
          sysparm_query: `element_id=${sysId}^element=work_notes^ORDERBYDESCsys_created_on`,
          sysparm_fields: "sys_id,sys_created_on,sys_created_by,value,element",
          sysparm_limit: 1000,
          sysparm_display_value: "all"
        });
        workNotes = buildJournalWorkNotes(journalResponse.result || []);
      } catch (error) {
        warnings.push(`Work Notes history excluded: ${error.message}`);
      }
    }
    return {
      ticketId,
      table,
      sysId,
      shortDescription: fieldValue(detail.short_description),
      description: fieldValue(detail.description),
      state: fieldValue(detail.state),
      ...metadata,
      assignmentGroup: metadata.assignmentGroup || fieldValue(detail.assignment_group),
      assignedTo: metadata.assignedTo || fieldValue(detail.assigned_to),
      serviceNowUpdatedAt: metadata.serviceNowUpdated || fieldValue(detail.sys_updated_on),
      serviceNowUrl: `${cleanInstanceUrl(this.settings.instanceUrl)}/${table}.do?sys_id=${encodeURIComponent(sysId)}`,
      entries: mergeEntries(workNotes, attachments),
      lastSyncedAt: localIsoDateTime(),
      lastAttemptAt: localIsoDateTime(),
      lastError: "",
      warnings
    };
  }

  async fetchTicketMetadata(ticketId) {
    const table = this.serviceNowTableForTicket(ticketId);
    if (!table) throw new Error("지원하지 않는 티켓 번호입니다.");
    const response = await this.apiGet(`/api/now/table/${table}`, {
      sysparm_query: `number=${ticketId}`,
      sysparm_display_value: "all",
      sysparm_limit: 1
    });
    const record = response.result?.[0];
    if (!record) throw new Error(`${ticketId} 티켓을 찾을 수 없습니다.`);
    const sysId = rawFieldValue(record.sys_id).trim();
    const state = fieldValue(record.state).trim();
    if (!state) throw new Error(`${ticketId} 상태를 확인할 수 없습니다.`);
    return { state, sysId, table, ...extractTicketMetadata(record) };
  }

  async fetchTicketStatus(ticketId) {
    return (await this.fetchTicketMetadata(ticketId)).state;
  }

  async applyTicketState(ticketId, state, rootFile = null) {
    const normalized = normalizeTicketId(ticketId);
    const nextState = String(state || "").trim();
    const file = rootFile instanceof TFile ? rootFile : this.rootTicketFile(normalized);
    if (!file || !nextState) return { ticketId: normalized, state: nextState, skipped: true };
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const previous = String(fm.status || "");
    const changed = previous !== nextState;
    if (changed) {
      await this.applyExternalStatus(file, nextState);
    }
    return { ticketId: normalized, state: nextState, previous, changed };
  }

  async updateTicketMetadata(ticketId, metadata, rootFile = null) {
    const normalized = normalizeTicketId(ticketId);
    const file = rootFile instanceof TFile ? rootFile : this.rootTicketFile(normalized);
    if (!file || !metadata) return false;
    const values = {
      purpose: metadata.purpose,
      short_description: metadata.shortDescription,
      service_now_priority: metadata.serviceNowPriority,
      ticket_creator: metadata.ticketCreator,
      ticket_requester: metadata.ticketRequester,
      service_now_created: metadata.serviceNowCreated,
      assignment_group: metadata.assignmentGroup,
      assigned_person: metadata.assignedTo,
      service_now_category: metadata.serviceNowCategory,
      service_now_updated: metadata.serviceNowUpdated || metadata.serviceNowUpdatedAt,
      estimated_qa_completion_date: metadata.estimatedQaCompletionDate,
      target_qa_completion_date: metadata.targetQaCompletionDate,
      actual_release_date: metadata.actualReleaseDate,
      "배포일": metadata.deploymentFinish,
      ui_interface_id: metadata.uiInterfaceIds
    };
    let changed = false;
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      for (const [key, value] of Object.entries(values)) {
        const next = String(value || "").trim();
        if (String(frontmatter[key] || "").trim() === next) continue;
        frontmatter[key] = next;
        changed = true;
      }
    });
    return changed;
  }

  async syncTicketStatus(ticketId, options = {}) {
    const normalized = normalizeTicketId(ticketId);
    if (!normalized) throw new Error("유효한 티켓 번호가 아닙니다.");
    if (this.statusSyncing.has(normalized)) return { ticketId: normalized, skipped: true };
    const file = this.rootTicketFile(normalized);
    if (!file) throw new Error(`${normalized} 원본 티켓 노트를 찾을 수 없습니다.`);

    this.statusSyncing.add(normalized);
    try {
      const metadata = await this.fetchTicketMetadata(normalized);
      const metadataChanged = await this.updateTicketMetadata(normalized, metadata, file);
      const state = metadata.state;
      const result = await this.applyTicketState(normalized, state, file);
      result.metadataChanged = metadataChanged;
      const stored = this.data.tickets[normalized] || { ticketId: normalized, entries: [] };
      stored.state = state;
      stored.entries = (stored.entries || []).filter((entry) => entry.type !== "Field Change");
      stored.warnings = (stored.warnings || []).filter((warning) =>
        !/(?:Field Changes|History Set|Activity Stream)/i.test(String(warning))
      );
      delete stored.stateHistory;
      delete stored.historyDiagnostics;
      delete stored.lastHistorySyncedAt;
      this.data.tickets[normalized] = stored;
      await this.savePluginData();
      this.refreshViews(normalized);
      const { previous, changed } = result;
      if (options.notify) {
        new Notice(changed
          ? `${normalized} 상태 갱신: ${previous || "미확인"} → ${state}`
          : `${normalized} 상태는 ${state}로 동일합니다.${metadataChanged ? " 기본정보는 최신 값으로 갱신했습니다." : ""}`, 7000);
      }
      return result;
    } catch (error) {
      if (options.notify) new Notice(`${normalized} 상태 갱신 실패: ${error.message || error}`, 9000);
      throw error;
    } finally {
      this.statusSyncing.delete(normalized);
    }
  }

  async syncAllTicketStatuses(options = {}) {
    const files = this.rootTicketFiles();
    const results = [];
    let failed = 0;
    for (const file of files) {
      const ticketId = this.rootTicketIdFromFile(file);
      try {
        results.push(await this.syncTicketStatus(ticketId));
      } catch (error) {
        failed += 1;
        console.error(`[ServiceNow Manage] ${ticketId} 상태 갱신 실패`, error);
      }
    }
    const changed = results.filter((result) => result?.changed).length;
    if (options.notify) {
      new Notice(`ServiceNow 상태 전체 갱신 완료 · 변경 ${changed}건 · 동일 ${results.length - changed}건${failed ? ` · 실패 ${failed}건` : ""}`, 9000);
    }
    return { total: files.length, changed, unchanged: results.length - changed, failed };
  }

  async syncAllTickets(options = {}) {
    const files = this.rootTicketFiles();
    let completed = 0;
    let failed = 0;
    for (const file of files) {
      const ticketId = this.rootTicketIdFromFile(file);
      try {
        const fresh = await this.syncTicket(ticketId);
        if (fresh) completed += 1;
        else failed += 1;
      } catch (error) {
        failed += 1;
        console.error(`[ServiceNow Manage] ${ticketId} 전체 갱신 실패`, error);
      }
    }
    if (options.notify) {
      new Notice(`ServiceNow 전체 갱신 완료 · 상태·기본정보·워킹노트 ${completed}건${failed ? ` · 실패 ${failed}건` : ""}`, 9000);
    }
    return { total: files.length, completed, failed };
  }

  async syncTicket(ticketId, options = {}) {
    const normalized = normalizeTicketId(ticketId);
    if (!normalized || this.syncing.has(normalized)) return;
    this.syncing.add(normalized);
    const previous = this.data.tickets[normalized] || { ticketId: normalized, entries: [] };
    previous.lastAttemptAt = localIsoDateTime();
    previous.lastError = "";
    this.data.tickets[normalized] = previous;
    this.refreshViews(normalized);
    try {
      const fresh = await this.fetchTicket(normalized);
      const workNotesLookupFailed = (fresh.warnings || []).some((warning) => warning.startsWith("Work Notes history excluded:"));
      const freshWorkNotes = (fresh.entries || []).filter((entry) => entry.type === "Work Note");
      const previousWorkNotes = (previous.entries || []).filter((entry) => entry.type === "Work Note");
      if (workNotesLookupFailed && !freshWorkNotes.length && previousWorkNotes.length) {
        fresh.entries = mergeEntries(
          previousWorkNotes,
          (fresh.entries || []).filter((entry) => entry.type !== "Work Note")
        );
        fresh.warnings.push("ServiceNow Work Notes 조회 실패로 기존 대화 내역을 보존했습니다.");
      }
      const oldById = new Map((previous.entries || []).map((entry) => [entry.id, entry]));
      fresh.entries = fresh.entries.map((entry) => ({
        ...entry,
        translations: oldById.get(entry.id)?.translations || entry.translations || {}
      }));
      fresh.translations = {};
      for (const field of ["shortDescription", "description"]) {
        if (fresh[field] === previous[field] && previous.translations?.[field]) {
          fresh.translations[field] = previous.translations[field];
        }
      }
      fresh.documentSearchInitialized = Boolean(previous.documentSearchInitialized);
      await this.persistTicketAttachmentImages(normalized, fresh);
      await this.persistTicketAttachmentVideos(normalized, fresh);
      await this.updateTicketMetadata(normalized, fresh, options.rootFile);
      await this.applyTicketState(normalized, fresh.state, options.rootFile);
      await this.updateTicketServiceNowLink(normalized, fresh.serviceNowUrl, options.rootFile);
      this.data.tickets[normalized] = fresh;
      const localBs = this.findLocalTicketDocument(normalized, "BS");
      if (localBs) await this.linkLocalBsDocument(normalized, localBs);
      await this.updateWorkNotesFrontMatter(normalized, "Success", fresh.lastSyncedAt);
      await this.savePluginData();
      this.refreshViews(normalized);
      if (options.notify) {
        const warningText = fresh.warnings?.length ? `\n${fresh.warnings.join("\n")}` : "";
        new Notice(`${normalized} 워킹노트 갱신 완료 · ${fresh.entries.length}건${warningText}`, 8000);
      }
      return fresh;
    } catch (error) {
      previous.lastError = error.message || String(error);
      previous.lastAttemptAt = localIsoDateTime();
      this.data.tickets[normalized] = previous;
      await this.updateWorkNotesFrontMatter(normalized, "Failed", "");
      await this.savePluginData();
      this.refreshViews(normalized);
      if (options.notify) new Notice(`${normalized} 갱신 실패: ${previous.lastError}`, 9000);
      return null;
    } finally {
      this.syncing.delete(normalized);
    }
  }

  async updateWorkNotesFrontMatter(ticketId, status, lastSynced) {
    const files = this.app.vault.getMarkdownFiles();
    const target = files.find((file) => {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      return normalizeTicketId(fm.ticket) === ticketId && String(fm.category || "") === "Work Notes";
    });
    if (!target) return;
    await this.app.fileManager.processFrontMatter(target, (fm) => {
      fm.sync_status = status;
      if (lastSynced) fm.last_synced = lastSynced;
    });
  }

  async updateTicketServiceNowLink(ticketId, serviceNowUrl, rootFile = null) {
    const normalized = normalizeTicketId(ticketId);
    const url = String(serviceNowUrl || "").trim();
    const file = rootFile instanceof TFile ? rootFile : this.rootTicketFile(normalized);
    if (!file || !url) return false;
    let changed = false;
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      if (String(frontmatter["서비스나우"] || "").trim()) return;
      frontmatter["서비스나우"] = url;
      changed = true;
    });
    return changed;
  }

  openTicketInBrowser(ticketId) {
    const ticket = this.data.tickets[ticketId];
    const url = ticket?.serviceNowUrl || cleanInstanceUrl(this.settings.instanceUrl);
    shell.openExternal(url);
  }

  getTranslateApi() {
    return this.app.plugins?.plugins?.translate?.api || null;
  }

  async ensureTranslateApi() {
    const translatePlugin = this.app.plugins?.plugins?.translate;
    const api = translatePlugin?.api;
    if (!api?.translate) return { api: null, reason: "missing" };

    try {
      if (!translatePlugin.translator && translatePlugin.reactivity?.getTranslationService) {
        const serviceId = api.settings?.translation_service;
        if (serviceId) {
          translatePlugin.translator = await translatePlugin.reactivity.getTranslationService(serviceId);
        }
      }

      if (translatePlugin.translator && !translatePlugin.translator.valid
        && typeof translatePlugin.translator.validate === "function") {
        const validation = await translatePlugin.translator.validate();
        if (!validation?.valid) {
          return {
            api,
            reason: "not-ready",
            message: validation?.message || "번역 서비스 검증에 실패했습니다."
          };
        }
      }
    } catch (error) {
      return { api, reason: "not-ready", message: error.message };
    }

    return api.canTranslate
      ? { api, reason: null }
      : { api, reason: "not-ready", message: "Translate 설정에서 번역 서비스를 선택하고 검증해 주세요." };
  }

  async translateTextForExport(content, target = "en") {
    const source = String(content || "").trim();
    if (!source) return "";
    const translate = await this.ensureTranslateApi();
    if (!translate.api || translate.reason) {
      const message = translate.reason === "missing"
        ? "Translate 플러그인이 설치되어 있지 않거나 비활성화되어 있습니다."
        : `Translate 플러그인의 번역 서비스가 준비되지 않았습니다. ${translate.message || ""}`;
      throw new Error(message.trim());
    }
    const { masked, urls } = protectUrls(source);
    const output = await translate.api.translate(masked, "auto", target);
    if (output?.status_code !== 200 || !output.translation) {
      throw new Error(output?.message || `번역 실패 (status ${output?.status_code || "unknown"})`);
    }
    return restoreUrls(output.translation, urls);
  }

  async translateTicket(ticketId, language, options = {}) {
    const target = language === "ko" ? "ko" : language === "vi" ? "vi" : "";
    if (!target || this.translating.has(`${ticketId}:${target}`)) return;
    const translate = await this.ensureTranslateApi();
    const api = translate.api;
    if (!api || translate.reason) {
      if (options.notify) {
        const message = translate.reason === "missing"
          ? "Translate 플러그인이 설치되어 있지 않거나 비활성화되어 있습니다."
          : `Translate 플러그인은 설치되어 있지만 번역 서비스가 준비되지 않았습니다. ${translate.message || ""}`;
        new Notice(message.trim(), 9000);
      }
      return;
    }
    const ticket = this.data.tickets[ticketId];
    if (!ticket) return;
    const key = `${ticketId}:${target}`;
    this.translating.add(key);
    let completed = 0;
    let consecutiveFailures = 0;
    let stoppedEarly = false;
    const failures = [];
    try {
      ticket.translations = ticket.translations || {};
      const summaryFields = [
        ["shortDescription", "Short description"],
        ["description", "Description"]
      ];
      for (const [field, label] of summaryFields) {
        const content = ticket[field];
        if (!content) continue;
        const existing = ticket.translations[field]?.[target];
        if (existing) {
          const repaired = restoreUrls(existing, protectUrls(content).urls);
          if (repaired !== existing) {
            ticket.translations[field][target] = repaired;
            completed++;
          }
          continue;
        }
        const { masked, urls } = protectUrls(content);
        try {
          const output = await api.translate(masked, "auto", target);
          if (output?.status_code !== 200 || !output.translation) {
            throw new Error(output?.message || `status ${output?.status_code || "unknown"}`);
          }
          ticket.translations[field] = ticket.translations[field] || {};
          ticket.translations[field][target] = restoreUrls(output.translation, urls);
          completed++;
          consecutiveFailures = 0;
        } catch (error) {
          failures.push(`${label}: ${error.message}`);
          consecutiveFailures++;
          if (!api.canTranslate || consecutiveFailures >= 3) {
            stoppedEarly = true;
            break;
          }
        }
      }
      if (!stoppedEarly) {
        for (const entry of ticket.entries || []) {
          if (entry.type === "Attachment" || !entry.content) continue;
          const existing = entry.translations?.[target];
          if (existing) {
            const repaired = restoreUrls(existing, protectUrls(entry.content).urls);
            if (repaired !== existing) {
              entry.translations[target] = repaired;
              completed++;
            }
            continue;
          }
          const { masked, urls } = protectUrls(entry.content);
          try {
            const output = await api.translate(masked, "auto", target);
            if (output?.status_code !== 200 || !output.translation) {
              throw new Error(output?.message || `status ${output?.status_code || "unknown"}`);
            }
            entry.translations = entry.translations || {};
            entry.translations[target] = restoreUrls(output.translation, urls);
            completed++;
            consecutiveFailures = 0;
            if (completed % 10 === 0) {
              await this.savePluginData();
              this.refreshViews(ticketId);
            }
          } catch (error) {
            failures.push(`${entry.time}: ${error.message}`);
            consecutiveFailures++;
            if (!api.canTranslate || consecutiveFailures >= 3) {
              stoppedEarly = true;
              break;
            }
          }
        }
      }
      await this.savePluginData();
      this.refreshViews(ticketId);
      if (options.notify) {
        const label = target === "ko" ? "한국어" : "베트남어";
        const firstError = failures[0]?.replace(/^.*?:\s*/, "").slice(0, 180);
        const detail = firstError ? ` · ${firstError}` : "";
        new Notice(
          `${label} 번역 완료 · ${completed}건${failures.length ? ` · 실패 ${failures.length}건` : ""}${stoppedEarly ? " · 반복 실패로 중단" : ""}${detail}`,
          10000
        );
      }
    } finally {
      this.translating.delete(key);
    }
  }

  async runCatchUpSync() {
    if (!this.settings.autoSync) return;
    const today = localIsoDateTime().slice(0, 10);
    const ids = Object.keys(this.data.tickets).filter((id) => {
      const last = this.data.tickets[id]?.lastSyncedAt || "";
      return last.slice(0, 10) < today;
    });
    for (const id of ids) await this.syncTicket(id);
  }

  async syncUninitializedTickets() {
    const ids = this.rootTicketFiles()
      .map((file) => this.rootTicketIdFromFile(file))
      .filter((id) => id && !this.data.tickets[id]?.lastSyncedAt);
    for (const id of ids) await this.syncTicket(id);
  }

  async runDailyStatusSyncIfDue() {
    if (!this.settings.autoStatusSync || this.dailyStatusSyncing) return;
    const now = new Date();
    const today = localIsoDate(now);
    if (this.settings.lastStatusSyncDate === today) return;
    const configuredTime = /^\d{2}:\d{2}$/.test(this.settings.statusSyncTime || "")
      ? this.settings.statusSyncTime
      : "09:00";
    const currentTime = localIsoDateTime(now).slice(11, 16);
    if (currentTime < configuredTime) return;
    this.dailyStatusSyncing = true;
    try {
      const result = await this.syncAllTickets();
      this.settings.lastStatusSyncDate = today;
      await this.savePluginData();
      new Notice(`일일 ServiceNow 전체 갱신 완료 · 상태·기본정보·워킹노트 ${result.completed}건${result.failed ? ` · 실패 ${result.failed}건` : ""}`, 8000);
    } finally {
      this.dailyStatusSyncing = false;
    }
  }

  async automationTick() {
    await this.runDailyStatusSyncIfDue();
    if (!this.settings.autoSync || !this.settings.syncAtTopOfHour) return;
    const now = new Date();
    if (now.getMinutes() !== 0) return;
    const marker = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
    if (marker === this.lastAutomationHour) return;
    this.lastAutomationHour = marker;
    for (const id of Object.keys(this.data.tickets)) await this.syncTicket(id);
  }
}

module.exports = CltServiceNowWorkNotes;
module.exports.__test = {
  addCalendarDays,
  addWorkingDays,
  appendEntryToMarkdownSection,
  cleanBearerToken,
  defaultTicketTemplate,
  defaultWorkNotesTemplate,
  defaultAiPromptTemplate,
  bundledAnalysisTemplate,
  upgradeDashboardRuntime,
  upgradeDashboardPopupFieldGrid,
  upgradeDashboardTodoCreation,
  upgradeDashboardControlVisibility,
  upgradeDashboardTodoDetails,
  upgradeDashboardTodoSummaryColumn,
  upgradeDashboardSharedTodoModal,
  upgradeDashboardFieldOrdering,
  upgradeDashboardTodoPagination,
  extractDescriptionLinks,
  extractTicketMetadata,
  selectAiPromptTemplate,
  replacePromptField,
  replacePromptWorkingNotes,
  buildAiEnvironmentInstructions,
  googleDriveFileId,
  googleDownloadFormat,
  safeFileName,
  documentTypeFromFileName,
  isStandardBsFileName,
  standardBsBaseName,
  wikiLinkTarget,
  isLocalBsWikiLink,
  adaptPromptToAvailableDocuments,
  fieldValue,
  fillTemplate,
  ensureSectionActionBlock,
  mergeEntries,
  normalizeTicketId,
  parseWikiLink,
  buildMeetingNoteMarkdown,
  buildMeetingAnalysisPrompt,
  parseWorkNotes,
  protectUrls,
  restoreUrls,
  serviceNowField,
  tableForTicket,
  utcServiceNowToKst
};
