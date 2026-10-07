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
  const hasLegacyDeploymentFinish = current.includes('{ key: "deploymentFinish", label: "Deployment Finish"');
  const sharedPluginDeclarations = current.match(/const\s+sharedPlugin\s*=/g) || [];
  if (hasCurrentRuntime && hasWaitingRuntime && sharedPluginDeclarations.length <= 2 && !hasLegacyDeploymentFinish) return current;
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
        for (const item of selected) {
          const details = item.owner ? `회의 Action Item · 담당: ${item.owner}` : "회의 Action Item";
          await this.plugin.addTodoToTicket(this.ticketId, item.title, item.dueDate || today, "pending", details);
        }
        new Notice(`${this.ticketId}에 진행 전 To-Do ${selected.length}건을 만들었습니다.`);
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
    [
      ["pending", "○ 진행 전"],
      ["in-progress", "◐ 진행 중"],
      ["waiting", "⏸ Pending · 대기"],
      ["done", "✓ 완료"]
    ].forEach(([value, label]) => {
      const option = status.createEl("option", { value, text: label });
      option.value = value;
      option.selected = value === this.preselectedStatus;
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
    [["pending", "진행 전"], ["in-progress", "진행 중"], ["waiting", "Pending · 대기"], ["done", "완료"]]
      .forEach(([value, label]) => {
        const option = status.createEl("option", { text: label });
        option.value = value;
        option.selected = value === this.task.status;
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
    const existing = sourceList.previousElementSibling;
    if (existing?.matches?.(".clt-ticket-mini-todo-board")) existing.remove();
    sourceList.addClass("clt-ticket-todo-source-hidden");

    const board = document.createElement("div");
    board.className = "clt-ticket-mini-todo-board";
    const definitions = [
      ["pending", "진행 전", "○"],
      ["in-progress", "진행 중", "◐"],
      ["waiting", "Pending · 대기", "⏸"],
      ["done", "완료", "✓"]
    ];
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

  async addTodoToGeneral(content, dueDate = "", status = "pending", details = "", result = "", waitingDetails = {}) {
    const file = await this.ensureGeneralTodoFile();
    const cleanContent = stripCltTodoMetadata(String(content || "").replace(/\r?\n+/g, " "));
    if (!cleanContent) throw new Error("할 일을 입력해 주세요.");
    const safeStatus = ["pending", "in-progress", "waiting", "done"].includes(status) ? status : "pending";
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

  async addTodoToTicket(ticketId, content, dueDate = "", status = "pending", details = "", result = "", waitingDetails = {}) {
    const normalized = normalizeTicketId(ticketId);
    if (!normalized) return this.addTodoToGeneral(content, dueDate, status, details, result, waitingDetails);
    const file = this.rootTicketFile(normalized);
    if (!(file instanceof TFile)) throw new Error(`${normalized} 티켓 노트를 찾을 수 없습니다.`);
    const cleanContent = stripCltTodoMetadata(String(content || "").replace(/\r?\n+/g, " "));
    if (!cleanContent) throw new Error("할 일을 입력해 주세요.");
    const safeStatus = ["pending", "in-progress", "waiting", "done"].includes(status) ? status : "pending";
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
