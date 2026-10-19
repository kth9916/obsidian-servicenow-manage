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
  ticketLifecycle: { enabled: true, dormantMonths: 3, unchangedMonths: 6, archiveGraceDays: 7, protectOpenTodos: true, archiveStates: ["Implemented", "Closed", "Resolved", "Cancelled"] },
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

// BEGIN TICKET LIFECYCLE HELPERS
const TICKET_ACTIVITY_LABELS = { active: "활성", archived: "보관", dormant: "휴면" };
function normalizeTicketLifecycle(value = {}) {
  value = value && typeof value === "object" ? value : {};
  const number = (key, fallback, max) => Number.isFinite(Number(value[key])) ? Math.max(1, Math.min(max, Math.floor(Number(value[key])))) : fallback;
  return { enabled: value.enabled !== false, dormantMonths: number("dormantMonths", 3, 36), unchangedMonths: number("unchangedMonths", 6, 60), archiveGraceDays: number("archiveGraceDays", 7, 90), protectOpenTodos: value.protectOpenTodos !== false,
    archiveStates: [...new Set((Array.isArray(value.archiveStates) ? value.archiveStates : ["Implemented", "Closed", "Resolved", "Cancelled"]).map(state => String(state).trim()).filter(Boolean))] };
}
function ticketActivityTime(value) {
  const time = typeof value === "number" ? value : Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : 0;
}
function ticketMonthsAgo(now, months) {
  const date = new Date(now), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() - months);
  date.setUTCDate(Math.min(day, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()));
  return date.getTime();
}
function classifyTicketActivity(record, status, settings, now = Date.now()) {
  const config = normalizeTicketLifecycle(settings);
  const result = (kind, reason) => ({ kind, label: TICKET_ACTIVITY_LABELS[kind], reason, lastOpenedAt: record?.lastOpenedAt || "", lastChangedAt: record?.lastMeaningfulChangeAt || "" });
  if (!config.enabled || !record?.initialized) return result("active", config.enabled ? "최초 기록 준비 중" : "자동 보관·휴면 사용 안 함");
  if (record.manualMode === "active") return result("active", "사용자가 활성 유지를 지정함");
  if (record.manualMode === "archived") return result("archived", "사용자가 보관함 · 원본을 열면 활성화됨");
  if (config.protectOpenTodos && record.hasOpenTodos) return result("active", "미완료 To-Do 보호");
  const opened = ticketActivityTime(record.lastOpenedAt);
  if (opened > ticketMonthsAgo(now, config.dormantMonths)) return result("active", "최근 원본 노트를 직접 열어봄");
  const changed = ticketActivityTime(record.lastMeaningfulChangeAt) || now;
  if (config.archiveStates.some(state => state.toLowerCase() === String(status || "").trim().toLowerCase()) && changed <= now - config.archiveGraceDays * 86400000) return result("archived", `종료 상태 · 실제 변경 후 ${config.archiveGraceDays}일 경과`);
  const observed = opened || ticketActivityTime(record.firstObservedAt) || now;
  if (observed <= ticketMonthsAgo(now, config.dormantMonths) && changed <= ticketMonthsAgo(now, config.unchangedMonths)) return result("dormant", `${config.dormantMonths}개월 미열람 · ${config.unchangedMonths}개월 실제 변경 없음`);
  return result("active", "활성 업무 또는 관찰 기간 중");
}
function ticketActivityHash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function ticketBusinessSignature(ticket = {}) {
  const fields = ["state", "shortDescription", "description", "assignmentGroup", "assignedTo", "serviceNowPriority", "purpose", "estimatedQaCompletionDate", "targetQaCompletionDate", "actualReleaseDate", "deploymentFinish", "uiInterfaceIds"];
  return ticketActivityHash(JSON.stringify([fields.map(key => ticket[key] || ""), (ticket.entries || []).map(entry => [entry.id, entry.time, entry.type, entry.author, entry.content]).sort((left, right) => String(left[0]).localeCompare(String(right[0])))]));
}
function ticketNoteSignature(markdown, frontmatter = {}) {
  const ignored = new Set(["position", "updated", "service_now_updated", "마지막확인", "last_checked", "last_synced", "sync_status"]);
  const metadata = Object.keys(frontmatter).filter(key => !ignored.has(key)).sort().map(key => [key, frontmatter[key]]);
  const body = String(markdown).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").replace(/\r\n?/g, "\n").trim();
  return ticketActivityHash(JSON.stringify(metadata) + body);
}
// END TICKET LIFECYCLE HELPERS

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

  const runtimeDeclaration = String(bundledDashboard || "").match(/const DASHBOARD_RUNTIME_VERSION\s*=\s*"[^"]+";/)?.[0];
  const hasCurrentRuntime = Boolean(runtimeDeclaration && current.includes(runtimeDeclaration));
  const hasWaitingRuntime = current.includes('key: "waiting", label: "Pending · 대기"')
    && current.includes("function readTodoWaiting(");
  const hasTodoWorkflowRuntime = current.includes("function activeTodoStatuses(");
  const hasLegacyDeploymentFinish = current.includes('{ key: "deploymentFinish", label: "Deployment Finish"');
  const sharedPluginDeclarations = current.match(/const\s+sharedPlugin\s*=/g) || [];
  if (hasCurrentRuntime && hasWaitingRuntime && hasTodoWorkflowRuntime && current.includes("selectedTodoStatuses") && current.includes("memoConfirm") && current.includes("matchesTicketActivityScope") && sharedPluginDeclarations.length <= 2 && !hasLegacyDeploymentFinish) return current;
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

function createMeetingTicketLinkChoice(parent, selectedTicketIds, onChange) {
  const option = parent.createEl("label", { cls: "clt-meeting-no-ticket-choice" });
  const checkbox = option.createEl("input", { type: "checkbox", attr: { "aria-label": "티켓 없이 저장 (주간·공통 회의)" } });
  checkbox.checked = selectedTicketIds.size === 0;
  option.createSpan({ text: "티켓 없이 저장 (주간·공통 회의)" });
  let previousIds = [...selectedTicketIds];
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) { previousIds = [...selectedTicketIds]; selectedTicketIds.clear(); }
    else previousIds.forEach(id => selectedTicketIds.add(id));
    onChange();
  });
  return checkbox;
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
    const withoutTicket = createMeetingTicketLinkChoice(ticketPicker, this.selectedTicketIds, () => {
      ticketControls.classList.toggle("is-hidden", withoutTicket.checked);
      renderTicketOptions(); updateTicketSummary();
    });
    const ticketControls = ticketPicker.createDiv({ cls: "clt-meeting-ticket-link-options" });
    ticketControls.classList.toggle("is-hidden", withoutTicket.checked);
    const ticketSearch = ticketControls.createEl("input", { type: "search", placeholder: "CR/SR 번호 검색 · 여러 개 선택 가능" });
    const ticketList = ticketControls.createDiv({ cls: "clt-meeting-ticket-options" });
    ticketPicker.createDiv({ cls: "clt-meeting-ticket-empty", text: "티켓 연결은 선택 사항입니다. 티켓 없이 저장한 회의록은 업무현황의 회의록 탭에서 확인합니다." });
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
    this.titleEl.setText(this.multiTicketMode ? "복수 티켓 Google Drive 회의록 가져오기" : this.ticketId ? `${this.ticketId} Google Drive 회의록 가져오기` : "주간·공통 회의 Google Drive에서 가져오기");
    this.contentEl.createDiv({
      cls: "clt-meeting-import-lead",
      text: this.ticketId
        ? `먼저 가져올 회의록을 선택한 뒤 관련 티켓을 선택합니다. 자동 검색은 '${this.ticketId}'와 'Gemini가 작성한 회의록'이 모두 포함된 Google Docs를 찾습니다.`
        : "티켓을 선택하지 않아도 저장할 수 있습니다. 자동 검색은 Gemini가 작성한 회의록을 찾습니다. 주간 보고 등 다른 제목은 직접 검색하고, 필요할 때만 관련 티켓을 연결하세요."
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
    const withoutTicket = createMeetingTicketLinkChoice(linkedTickets, this.selectedTicketIds, () => {
      linkedControls.classList.toggle("is-hidden", withoutTicket.checked);
      renderLinkedOptions(); updateLinkedSummary();
    });
    const linkedControls = linkedTickets.createDiv({ cls: "clt-meeting-ticket-link-options" });
    linkedControls.classList.toggle("is-hidden", withoutTicket.checked);
    const linkedSearch = linkedControls.createEl("input", { type: "search", placeholder: "추가로 연결할 CR/SR 검색" });
    const linkedOptions = linkedControls.createDiv({ cls: "clt-meeting-ticket-options" });
    linkedTickets.createDiv({ cls: "clt-meeting-ticket-empty", text: "티켓 없이 저장하면 업무현황의 회의록 탭에 주간·공통 회의로 표시됩니다." });
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
        new Notice(`${this.selectedTicketIds.size ? `티켓 ${this.selectedTicketIds.size}개에` : "주간·공통 회의로"} 회의록 ${importedCount}건을 추가했습니다.${warnings.length ? `\n${warnings.join("\n")}` : ""}`, 9000);
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
    this.titleEl.setText("Drive 회의록 가져오기");
    this.contentEl.createDiv({ cls: "clt-meeting-import-lead", text: "주간 보고·공통 회의는 티켓 없이 가져올 수 있습니다. 티켓을 선택하면 해당 번호로 자동 검색하며, 복수 티켓 연결은 회의록을 고른 뒤 설정할 수 있습니다." });
    const select = this.contentEl.createEl("select");
    select.setAttr("aria-label", "회의록 연결 티켓 (선택 사항)");
    select.style.width = "100%";
    select.createEl("option", { value: "", text: "티켓 없이 저장 · 주간/공통 회의" });
    this.plugin.rootTicketFiles().map((file) => this.plugin.rootTicketIdFromFile(file)).filter(Boolean).sort().forEach((ticketId) => {
      select.createEl("option", { value: ticketId, text: ticketId });
    });
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    actions.createEl("button", { text: "취소" }).addEventListener("click", () => this.close());
    const openSearch = (multiTicketMode) => {
      const ticketId = normalizeTicketId(select.value);
      this.close();
      new DriveMeetingCandidateModal(this.app, this.plugin, ticketId, this.onImported, multiTicketMode).open();
    };
    const next = actions.createEl("button", { text: "회의록 검색" });
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

class TicketLifecycleSettingsModal extends Modal {
  constructor(app, plugin, ticketId = "") { super(app); this.plugin = plugin; this.ticketId = ticketId; this.draft = normalizeTicketLifecycle(plugin.settings.ticketLifecycle); }
  onOpen() {
    this.titleEl.setText("활성 업무 · 보관 · 휴면 설정");
    this.modalEl.addClass("snm-todo-workflow-modal");
    this.modalEl.addClass("snm-ticket-lifecycle-modal");
    this.contentEl.createEl("p", { text: "보관·휴면은 정기 갱신과 기본 목록에서만 제외합니다. 파일은 이동·삭제하지 않으며, 원본 티켓 노트를 직접 열면 다시 활성화됩니다. 검색 결과 표시·자동 갱신·백그라운드 읽기는 열람으로 기록하지 않습니다." });
    this.contentEl.createEl("p", { text: "과거 열람 이력은 추정하지 않습니다. 처음 기록한 날부터 관찰하며, 원본 열람과 실제 내용 변경 시각을 따로 보관합니다. 새 기록은 이 Vault의 플러그인 폴더에만 저장됩니다." });
    new Setting(this.contentEl).setName("활성·보관·휴면 구분 사용").setDesc("끄면 모든 티켓을 활성으로 취급하며 기존 활동 기록은 유지합니다.").addToggle(toggle => toggle.setValue(this.draft.enabled).onChange(value => { this.draft.enabled = value; }));
    for (const [key, name, desc] of [["dormantMonths", "휴면: 원본 미열람 기간 (개월)", "기본 3개월. 직접 열면 이 시각이 갱신됩니다."], ["unchangedMonths", "휴면: 실제 업무 변경 없음 (개월)", "기본 6개월. 두 조건을 모두 충족해야 휴면 처리합니다. 매일 동일 내용을 갱신한 시각은 사용하지 않습니다."], ["archiveGraceDays", "종료 상태 보관 유예 (일)", "기본 7일. 최근 직접 열어본 티켓은 미열람 기간 동안 활성 상태를 유지합니다."]]) {
      new Setting(this.contentEl).setName(name).setDesc(desc).addText(text => { text.inputEl.type = "number"; text.inputEl.min = "1"; text.setValue(String(this.draft[key])).onChange(value => { this.draft[key] = value; }); });
    }
    new Setting(this.contentEl).setName("미완료 To-Do가 있으면 활성 유지").addToggle(toggle => toggle.setValue(this.draft.protectOpenTodos).onChange(value => { this.draft.protectOpenTodos = value; }));
    new Setting(this.contentEl).setName("자동 보관할 ServiceNow 상태").setDesc("쉼표로 구분합니다. ServiceNow 상태 자체는 변경하지 않습니다.").addText(text => {
      text.inputEl.addClass("snm-ticket-archive-states");
      text.setValue(this.draft.archiveStates.join(", ")).onChange(value => { this.draft.archiveStates = value.split(","); });
    });
    if (this.ticketId) {
      const info = this.plugin.getTicketActivity(this.ticketId);
      this.contentEl.createEl("p", { text: `${this.ticketId} · ${info.label}: ${info.reason}` });
      this.contentEl.createEl("p", { text: `마지막 원본 열람: ${info.lastOpenedAt ? localIsoDateTime(new Date(info.lastOpenedAt)) : "미기록 (과거 열람 이력은 추정하지 않음)"} · 마지막 실제 변경: ${info.lastChangedAt ? localIsoDateTime(new Date(info.lastChangedAt)) : "미기록"}` });
      const modes = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
      for (const [mode, label] of [["active", "이 티켓 활성 유지"], ["archived", "이 티켓 지금 보관"], ["auto", "이 티켓 자동 분류"]]) modes.createEl("button", { text: label }).addEventListener("click", async () => { try { await this.plugin.setTicketActivityMode(this.ticketId, mode); this.close(); } catch (error) { new Notice(`보관 설정 저장 실패: ${error.message || error}`); } });
    }
    const status = this.contentEl.createDiv(); status.setAttr("role", "status");
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    actions.createEl("button", { text: "취소" }).addEventListener("click", () => this.close());
    const save = actions.createEl("button", { text: "저장", cls: "mod-cta" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try { await this.plugin.saveTicketLifecycleSettings(this.draft); this.close(); new Notice("활성·보관·휴면 설정을 적용했습니다."); }
      catch (error) { status.setText(error.message || String(error)); save.disabled = false; }
    });
  }
  onClose() { this.contentEl.empty(); }
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

    containerEl.createEl("h3", { text: "활성 업무 · 보관 이력" });
    new Setting(containerEl).setName("보관·휴면 정책").setDesc("정기 갱신 제외 상태, 미열람·미변경 기간, 미완료 To-Do 보호를 설정합니다.").addButton(button => button.setButtonText("보관·휴면 설정").onClick(() => this.plugin.openTicketLifecycleSettings()));
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
    this.ticketNoteSnapshots = new Map();
    await this.loadTicketActivityStore();
    this.registerEvent(this.app.workspace.on("file-open", file => this.recordTicketOpened(file)));

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
      void this.observeTicketNote(file).catch(error => console.warn("[ServiceNow Manage] 업무 활동 기록 실패", error));
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
      await this.prepareTicketActivity();
      this.recordTicketOpened(this.app.workspace.getActiveFile());
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
    this.ticketActivityDisposed = true;
    if (this.ticketActivitySaveTimer) window.clearTimeout(this.ticketActivitySaveTimer);
    if (this.ticketActivityEventTimer) window.clearTimeout(this.ticketActivityEventTimer);
    void this.flushTicketActivityStore().catch(() => {});
    this.ticketNoteSnapshots?.clear();
    if (this.ticketNoticeTimer) window.clearTimeout(this.ticketNoticeTimer);
    this.todoBoardViews?.clear();
    this.ticketDashboardDetailCache?.clear();
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

  ticketActivityStorePath() { return normalizePath(`${this.manifest.dir || `${this.app.vault.configDir}/plugins/${PLUGIN_ID}`}/ticket-activity.json`); }

  async loadTicketActivityStore() {
    this.ticketActivity = { schemaVersion: 1, tickets: {} };
    try {
      if (await this.app.vault.adapter.exists(this.ticketActivityStorePath())) {
        const saved = JSON.parse(await this.app.vault.adapter.read(this.ticketActivityStorePath()));
        if (saved.schemaVersion !== 1 || !saved.tickets || typeof saved.tickets !== "object" || Array.isArray(saved.tickets)) throw new Error("기록 형식 오류");
        this.ticketActivity = saved;
      }
    } catch (error) {
      this.ticketActivityWriteBlocked = true;
      new Notice("업무 활동 기록을 읽지 못해 자동 보관·휴면을 적용하지 않습니다. 기존 기록 파일은 덮어쓰지 않습니다.", 10000);
    }
  }

  ticketActivityRecord(ticketId) {
    this.ticketActivity ||= { schemaVersion: 1, tickets: {} };
    return this.ticketActivity.tickets[ticketId] ||= { firstObservedAt: new Date().toISOString(), lastOpenedAt: "", lastMeaningfulChangeAt: new Date().toISOString(), initialized: false, manualMode: "auto" };
  }

  queueTicketActivitySave() {
    if (this.ticketActivityWriteBlocked || this.ticketActivityDisposed) return;
    this.ticketActivityDirty = true;
    if (this.ticketActivitySaveTimer) window.clearTimeout(this.ticketActivitySaveTimer);
    this.ticketActivitySaveTimer = window.setTimeout(() => { this.ticketActivitySaveTimer = null; void this.flushTicketActivityStore().catch(() => {}); }, 400);
  }

  async flushTicketActivityStore() {
    if (!this.ticketActivityDirty || this.ticketActivityWriteBlocked) return this.ticketActivityWrite;
    const snapshot = JSON.stringify(this.ticketActivity);
    this.ticketActivityDirty = false;
    this.ticketActivityWrite = (this.ticketActivityWrite || Promise.resolve()).catch(() => {}).then(() => this.app.vault.adapter.write(this.ticketActivityStorePath(), snapshot));
    try { await this.ticketActivityWrite; }
    catch (error) { this.ticketActivityDirty = true; console.warn("[ServiceNow Manage] 업무 활동 기록 저장 실패", error); throw error; }
  }

  notifyTicketActivityChanged() {
    if (this.ticketActivityEventTimer || this.ticketActivityDisposed) return;
    this.ticketActivityEventTimer = window.setTimeout(() => {
      this.ticketActivityEventTimer = null;
      this.app.workspace.trigger("servicenow-manage:ticket-activity-changed");
    }, 150);
  }

  getTicketActivity(ticketId, status = "") {
    if (this.ticketActivityWriteBlocked) return { kind: "active", label: "활성", reason: "기록 오류로 자동 분류 중지" };
    const record = this.ticketActivity?.tickets?.[ticketId];
    if (record?.readFailed) return { kind: "active", label: "활성", reason: "원본 읽기 실패로 자동 보관 보류" };
    return classifyTicketActivity(record, status || record?.status || this.data.tickets[ticketId]?.state, this.settings.ticketLifecycle);
  }

  getTicketActivitySearchText(ticketId) { return this.ticketActivity?.tickets?.[ticketId]?.indexText || ""; }

  async prepareTicketActivity() {
    if (!this.ticketActivityPreparation) this.ticketActivityPreparation = (async () => {
      for (const file of this.rootTicketFiles()) {
        if (this.ticketActivityDisposed) break;
        try { await this.observeTicketNote(file); }
        catch (error) { this.ticketActivityRecord(this.rootTicketIdFromFile(file)).readFailed = true; console.warn("[ServiceNow Manage] 원본 활동 확인 실패", error); }
      }
      await this.flushTicketActivityStore();
    })().catch(error => { this.ticketActivityPreparation = null; console.warn("[ServiceNow Manage] 업무 활동 준비 실패", error); });
    return this.ticketActivityPreparation;
  }

  async readTicketNoteSnapshot(file) {
    const cached = this.ticketNoteSnapshots?.get(file.path);
    if (cached && cached.mtime === file.stat.mtime) return cached.markdown;
    const mtime = file.stat.mtime;
    const markdown = await this.app.vault.cachedRead(file);
    this.ticketNoteSnapshots ||= new Map();
    if (this.ticketNoteSnapshots.size >= 256 && !this.ticketNoteSnapshots.has(file.path)) this.ticketNoteSnapshots.delete(this.ticketNoteSnapshots.keys().next().value);
    this.ticketNoteSnapshots.set(file.path, { mtime, markdown });
    return markdown;
  }

  async observeTicketNote(file) {
    const ticketId = this.rootTicketIdFromFile(file);
    if (!ticketId || this.ticketActivityWriteBlocked) return;
    const record = this.ticketActivityRecord(ticketId);
    if (record.initialized && record.notePath === file.path && record.noteMtime === file.stat.mtime && typeof record.rootIndexText === "string") return;
    const observedMtime = file.stat.mtime;
    const markdown = await this.readTicketNoteSnapshot(file);
    delete record.readFailed;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const signature = ticketNoteSignature(markdown, fm);
    const meaningfulChange = !record.initialized || record.noteSignature !== signature;
    const now = new Date().toISOString();
    if (!record.initialized) {
      const sourceTime = ticketActivityTime(fm.service_now_updated || fm.status_changed || fm.created);
      record.lastMeaningfulChangeAt = sourceTime > 0 && sourceTime <= Date.now() ? new Date(sourceTime).toISOString() : now;
      record.serverSignature = ticketBusinessSignature(this.data.tickets[ticketId]);
    } else if (record.noteSignature !== signature) record.lastMeaningfulChangeAt = now;
    record.noteSignature = signature;
    record.noteMtime = observedMtime;
    record.notePath = file.path;
    record.status = String(fm.status || this.data.tickets[ticketId]?.state || "");
    record.hasOpenTodos = /^\s*[-*+]\s+\[ \]\s+/m.test(markdown);
    const server = this.data.tickets[ticketId];
    const references = JSON.stringify([server?.description, (server?.entries || []).map(entry => entry.content)]).match(/\b(?:CR|SR|INC)\d+\b/gi) || [];
    record.rootIndexText = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---/, "").slice(0, 10000);
    record.indexText = `${ticketId} ${fm.short_description || server?.shortDescription || ""} ${references.join(" ")} ${record.rootIndexText}`.slice(0, 12000).toLowerCase();
    record.initialized = true;
    if (meaningfulChange) { this.queueTicketActivitySave(); this.notifyTicketActivityChanged(); }
    if (file.stat.mtime !== observedMtime) window.setTimeout(() => { if (!this.ticketActivityDisposed) void this.observeTicketNote(file); }, 100);
  }

  observeServerTicketActivity(ticketId, ticket) {
    const record = this.ticketActivityRecord(ticketId);
    const signature = ticketBusinessSignature(ticket);
    const changed = record.serverSignature !== signature || record.status !== ticket.state;
    if (record.serverSignature && record.serverSignature !== signature) record.lastMeaningfulChangeAt = new Date().toISOString();
    record.serverSignature = signature;
    record.status = ticket.state || record.status;
    if (changed) {
      const references = JSON.stringify([ticket.description, (ticket.entries || []).map(entry => entry.content)]).match(/\b(?:CR|SR|INC)\d+\b/gi) || [];
      record.indexText = `${ticketId} ${ticket.shortDescription || ""} ${references.join(" ")} ${record.rootIndexText || ""}`.slice(0, 12000).toLowerCase();
    }
    if (changed) { this.queueTicketActivitySave(); this.notifyTicketActivityChanged(); }
  }

  recordTicketOpened(file) {
    if (!file || this.app.workspace.getActiveFile()?.path !== file.path) return;
    const ticketId = this.rootTicketIdFromFile(file);
    if (!ticketId) return;
    const previousKind = this.getTicketActivity(ticketId).kind;
    const record = this.ticketActivityRecord(ticketId);
    record.lastOpenedAt = new Date().toISOString();
    if (record.manualMode !== "active") record.manualMode = "auto";
    this.queueTicketActivitySave();
    this.notifyTicketActivityChanged();
    this.refreshViews(ticketId);
    if (previousKind !== "active") new Notice(`${ticketId}를 활성 업무로 복귀했습니다. ServiceNow 상태는 변경하지 않았습니다.`, 5000);
  }

  activeRootTicketFiles(files = this.rootTicketFiles()) { return files.filter(file => this.getTicketActivity(this.rootTicketIdFromFile(file)).kind === "active"); }
  openTicketLifecycleSettings(ticketId = "") { new TicketLifecycleSettingsModal(this.app, this, ticketId).open(); }
  async setTicketActivityMode(ticketId, mode) {
    if (this.ticketActivityWriteBlocked) throw new Error("기존 업무 활동 기록을 읽지 못해 보관 설정을 저장할 수 없습니다.");
    if (!["auto", "active", "archived"].includes(mode)) throw new Error("지원하지 않는 업무 보관 설정입니다.");
    const record = this.ticketActivityRecord(ticketId), previous = record.manualMode;
    record.manualMode = mode;
    this.queueTicketActivitySave();
    try { await this.flushTicketActivityStore(); } catch (error) { record.manualMode = previous; throw error; }
    this.notifyTicketActivityChanged(); this.refreshViews(ticketId);
  }
  async saveTicketLifecycleSettings(value) {
    for (const [key, max] of [["dormantMonths", 36], ["unchangedMonths", 60], ["archiveGraceDays", 90]]) {
      if (value[key] != null && (!String(value[key]).trim() || !Number.isInteger(Number(value[key])) || Number(value[key]) < 1 || Number(value[key]) > max)) throw new Error(`기간은 1~${max} 사이 정수로 입력해 주세요.`);
    }
    const previous = this.settings.ticketLifecycle;
    this.settings.ticketLifecycle = normalizeTicketLifecycle(value);
    try { await this.savePluginData(); } catch (error) { this.settings.ticketLifecycle = previous; throw error; }
    this.notifyTicketActivityChanged();
    for (const ticketId of this.views.keys()) this.refreshViews(ticketId);
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
    if (this.getTicketActivity(normalized).kind !== "active") return;
    const key = `${kind}:${normalized}`;
    const previousTimer = this.viewRefreshTimers.get(key);
    if (previousTimer) window.clearTimeout(previousTimer);
    const timer = window.setTimeout(() => {
      this.viewRefreshTimers.delete(key);
      if (this.getTicketActivity(normalized).kind !== "active") return;
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
        if (normalizedTicketId && file.path.startsWith(folder)) return true;
        if (!file.path.startsWith(generalFolder)) return false;
        const linkedIds = this.meetingTicketIdsForFile(file);
        return normalizedTicketId ? linkedIds.includes(normalizedTicketId) : linkedIds.length === 0;
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
    const activity = this.getTicketActivity(ticketId);
    controls.createSpan({ cls: "clt-ticket-activity-badge", text: `${activity.label} · ${activity.reason}` });
    controls.createEl("button", { text: "보관·휴면 설정" }).addEventListener("click", () => this.openTicketLifecycleSettings(ticketId));
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
      : normalized ? `name contains '${normalized}' and name contains 'Gemini가 작성한 회의록'` : "name contains 'Gemini가 작성한 회의록'";
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
    const duplicateScopes = ticketIds.length ? ticketIds : [""];
    if (duplicateScopes.some((id) => this.listTicketMeetings(id).some((meeting) => meeting.sourceDriveId === candidate.id))) {
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
      this.observeServerTicketActivity?.(normalized, stored);
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
    const allFiles = this.rootTicketFiles();
    const files = options.activeOnly ? this.activeRootTicketFiles(allFiles) : allFiles;
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
    return { total: files.length, skipped: allFiles.length - files.length, changed, unchanged: results.length - changed, failed };
  }

  async syncAllTickets(options = {}) {
    const allFiles = this.rootTicketFiles();
    const files = options.activeOnly ? this.activeRootTicketFiles(allFiles) : allFiles;
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
    return { total: files.length, skipped: allFiles.length - files.length, completed, failed };
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
      this.observeServerTicketActivity?.(normalized, fresh);
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
      if (this.getTicketActivity(id).kind !== "active") return false;
      const last = this.data.tickets[id]?.lastSyncedAt || "";
      return last.slice(0, 10) < today;
    });
    for (const id of ids) await this.syncTicket(id);
  }

  async syncUninitializedTickets() {
    const ids = this.rootTicketFiles()
      .map((file) => this.rootTicketIdFromFile(file))
      .filter((id) => id && this.getTicketActivity(id).kind === "active" && !this.data.tickets[id]?.lastSyncedAt);
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
      const result = await this.syncAllTickets({ activeOnly: true });
      this.settings.lastStatusSyncDate = today;
      await this.savePluginData();
      new Notice(`일일 ServiceNow 활성 업무 갱신 완료 · ${result.completed}건 · 보관·휴면 제외 ${result.skipped}건${result.failed ? ` · 실패 ${result.failed}건` : ""}`, 8000);
    } finally {
      this.dailyStatusSyncing = false;
    }
  }

  async automationTick() {
    const activityDay = localIsoDate(new Date());
    if (this.lastTicketActivityDay !== activityDay) { this.lastTicketActivityDay = activityDay; this.notifyTicketActivityChanged(); }
    await this.runDailyStatusSyncIfDue();
    if (!this.settings.autoSync || !this.settings.syncAtTopOfHour) return;
    const now = new Date();
    if (now.getMinutes() !== 0) return;
    const marker = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
    if (marker === this.lastAutomationHour) return;
    this.lastAutomationHour = marker;
    for (const file of this.activeRootTicketFiles()) await this.syncTicket(this.rootTicketIdFromFile(file));
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
