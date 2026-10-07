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
  if (hasCurrentRuntime && hasWaitingRuntime && hasTodoWorkflowRuntime && sharedPluginDeclarations.length <= 2 && !hasLegacyDeploymentFinish) return current;
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
    const baseQuery = {
      q: `name contains '${ticketId}_' and trashed = false`,
      fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
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
        console.warn("[Google Drive] 공유 드라이브 통합 검색 제외", error);
      }
    }
    const filesById = new Map();
    responses.flatMap((response) => response.files || []).forEach((file) => filesById.set(file.id, file));
    const groups = { FS: [], DS: [], UT: [] };
    [...filesById.values()]
      .sort((left, right) => String(right.modifiedTime || "").localeCompare(String(left.modifiedTime || "")))
      .forEach((file) => {
      const match = String(file.name || "").toUpperCase().match(new RegExp(`^${ticketId}_(FS|DS|UT)(?:_|\\b)`));
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
