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
  parseYaml,
  stringifyYaml,
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
  popupWidthPercent: 75,
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

function normalizePopupWidthPercent(value) {
  if (value == null || String(value).trim() === "" || !Number.isFinite(Number(value))) return 75;
  return Math.max(50, Math.min(95, Math.round(Number(value) / 5) * 5));
}

function responsiveActionRows(count, width, minimum = 180) {
  if (count < 1) return [];
  const columns = Math.max(1, Math.min(count, Math.floor((Math.max(0, width) + 8) / (minimum + 8))));
  const rowCount = Math.ceil(count / columns);
  const size = Math.floor(count / rowCount), extra = count % rowCount;
  return Array.from({ length: rowCount }, (_, index) => size + (index < extra ? 1 : 0));
}

function layoutResponsiveActions(container, minimum = 180) {
  const children = Array.from(container.children).filter(child => !child.hidden && !child.classList.contains("opus-hidden") && child.style.display !== "none");
  if (!container.clientWidth || !children.length) return;
  container.classList.add("snm-balanced-actions");
  let offset = 0;
  for (const size of responsiveActionRows(children.length, container.clientWidth, minimum)) {
    const basis = `calc((100% - ${(size - 1) * 8}px) / ${size})`;
    for (let index = 0; index < size; index++) {
      const child = children[offset++];
      if (child.style.getPropertyValue("--snm-action-basis") !== basis) child.style.setProperty("--snm-action-basis", basis);
    }
  }
}

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
  // All tickets use the same policy. Legacy per-ticket overrides are retained in
  // the private activity store for recovery, but no longer affect classification.
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
  const hasCurrentRuntime = Boolean(runtimeDeclaration && current.includes(runtimeDeclaration) && current.includes('tableTools.classList.add("opus-table-tools")'));
  const hasWaitingRuntime = current.includes('key: "waiting", label: "Pending · 대기"')
    && current.includes("function readTodoWaiting(");
  const hasTodoWorkflowRuntime = current.includes("function activeTodoStatuses(");
  const hasLegacyDeploymentFinish = current.includes('{ key: "deploymentFinish", label: "Deployment Finish"');
  const sharedPluginDeclarations = current.match(/const\s+sharedPlugin\s*=/g) || [];
  if (hasCurrentRuntime && hasWaitingRuntime && hasTodoWorkflowRuntime && current.includes("selectedTodoStatuses") && current.includes("memoConfirm") && current.includes("matchesTicketActivityScope") && current.includes('ticketActivityConfigure.textContent = "활성·휴면·보관 전역 설정";') && current.includes("plugin.openMeetingTicketLinksModal(meeting.file.path, renderMeetingOverview)") && sharedPluginDeclarations.length <= 2 && !hasLegacyDeploymentFinish) return current;
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
    this.modalEl.addClass("snm-content-modal");
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

function updateMeetingTicketLinksMarkdown(markdown, ticketIds, { expectedTicketIds = null, fallbackTicketIds = [] } = {}) {
  const ids = normalizeMeetingTicketIds(ticketIds);
  const source = String(markdown || "");
  const match = source.match(/^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const metadata = match ? parseYaml(match[1]) : {};
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("회의록 속성을 읽지 못했습니다. 원본은 변경하지 않았습니다.");
  if (String(metadata.meeting_kind || "").toLowerCase() === "analysis") throw new Error("티켓별 AI 분석 자료 대신 원본 회의록에서 티켓 연결을 변경해 주세요.");
  const currentIds = normalizeMeetingTicketIds(Object.prototype.hasOwnProperty.call(metadata, "tickets") ? metadata.tickets : Object.prototype.hasOwnProperty.call(metadata, "ticket") ? metadata.ticket : fallbackTicketIds);
  if (expectedTicketIds && JSON.stringify(currentIds) !== JSON.stringify(normalizeMeetingTicketIds(expectedTicketIds))) throw new Error("다른 화면에서 티켓 연결이 변경되었습니다. 창을 다시 열어 확인해 주세요.");
  metadata.ticket = ids[0] || "";
  metadata.tickets = ids;
  if (ids.length) { metadata.Parent = `[[${ids[0]}]]`; metadata.Parents = ids.map(id => `[[${id}]]`); }
  else { delete metadata.Parent; delete metadata.Parents; }
  metadata.type ||= "meeting-minutes";
  metadata.meeting_kind ||= "gemini";
  const body = (match ? source.slice(match[0].length) : source).replace(/^>\s*\|\s*(?:관련 티켓|티켓)\s*\|.*$/m, `> | 관련 티켓 | ${ids.length ? ids.map(id => `[[${id}]]`).join(" · ") : "티켓 없음"} |`);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  return `---${eol}${stringifyYaml(metadata).trimEnd().replace(/\r?\n/g, eol)}${eol}---${eol}${body}`;
}

class MeetingTicketLinksModal extends Modal {
  constructor(app, plugin, file, onChanged = null) {
    super(app); this.plugin = plugin; this.file = file; this.onChanged = onChanged;
    this.initialIds = plugin.meetingTicketIdsForFile(file);
    this.selectedTicketIds = new Set(this.initialIds);
  }
  onOpen() {
    this.modalEl.addClass("clt-meeting-links-modal");
    this.titleEl.setText("회의록 티켓 연결 편집");
    this.contentEl.createEl("p", { text: this.file.basename });
    this.contentEl.createDiv({ cls: "clt-meeting-import-lead", text: "기존 회의록에 티켓을 나중에 연결하거나 변경·해제할 수 있습니다. 파일과 PDF는 이동·복사하지 않으며, 회의 내용은 그대로 유지합니다." });
    const picker = this.contentEl.createDiv({ cls: "clt-meeting-ticket-picker" });
    const summary = picker.createDiv({ cls: "clt-meeting-ticket-empty" });
    const withoutTicket = createMeetingTicketLinkChoice(picker, this.selectedTicketIds, () => { controls.classList.toggle("is-hidden", withoutTicket.checked); render(); });
    const controls = picker.createDiv({ cls: "clt-meeting-ticket-link-options" });
    controls.classList.toggle("is-hidden", withoutTicket.checked);
    const search = controls.createEl("input", { type: "search", placeholder: "CR/SR 번호 또는 제목 검색 · 여러 개 선택 가능" });
    const list = controls.createDiv({ cls: "clt-meeting-ticket-options" });
    const allIds = [...new Set([...this.initialIds, ...this.plugin.rootTicketFiles().map(file => this.plugin.rootTicketIdFromFile(file)).filter(Boolean)])].sort();
    const updateSummary = () => summary.setText(this.selectedTicketIds.size ? `연결할 티켓 ${this.selectedTicketIds.size}개 · ${[...this.selectedTicketIds].join(" · ")}` : "티켓 없음 · 주간·공통 회의로 표시");
    const render = () => {
      updateSummary();
      list.empty();
      const needle = search.value.trim().toLowerCase();
      for (const id of allIds.filter(id => `${id} ${this.plugin.data?.tickets?.[id]?.shortDescription || ""}`.toLowerCase().includes(needle))) {
        const row = list.createEl("label", { cls: "clt-meeting-ticket-option" });
        const input = row.createEl("input", { type: "checkbox", attr: { "aria-label": id } }); input.checked = this.selectedTicketIds.has(id);
        row.createSpan({ text: id });
        input.addEventListener("change", () => { input.checked ? this.selectedTicketIds.add(id) : this.selectedTicketIds.delete(id); updateSummary(); });
      }
      if (!list.children.length) list.createDiv({ cls: "clt-meeting-ticket-empty", text: "일치하는 티켓이 없습니다." });
    };
    search.addEventListener("input", render); render();
    const status = this.contentEl.createDiv(); status.setAttr("role", "status");
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    actions.createEl("button", { text: "취소" }).addEventListener("click", () => this.close());
    const save = actions.createEl("button", { text: "연결 저장", cls: "mod-cta" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        const result = await this.plugin.updateMeetingTicketLinks(this.file, [...this.selectedTicketIds], { expectedTicketIds: this.initialIds });
        this.close();
        if (typeof this.onChanged === "function") {
          try { await this.onChanged(); }
          catch (error) { result.warnings.push(`연결은 저장했지만 목록을 다시 표시하지 못했습니다: ${error.message || error}`); }
        }
        new Notice(`회의록 티켓 연결을 저장했습니다.${result.warnings.length ? `\n${result.warnings.join("\n")}` : ""}`, 7000);
      } catch (error) { status.setText(error.message || String(error)); save.disabled = false; }
    });
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
    this.modalEl?.addClass?.("snm-content-modal");
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

// DS schedule import reads only workbook XML. It never executes macros or formulas.
function dsScheduleXmlText(value) {
  return String(value || "").replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, entity) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity.toLowerCase()] || all;
  });
}

function dsScheduleXmlElements(xml, tag) {
  const pattern = new RegExp(`<(?:(?:[\\w.-]+):)?${tag}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/(?:(?:[\\w.-]+):)?${tag}\\s*>)`, "g");
  return [...String(xml || "").matchAll(pattern)].map(match => ({
    attrs: Object.fromEntries([...match[1].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(attr => [attr[1], dsScheduleXmlText(attr[2] ?? attr[3])])),
    body: match[2] || ""
  }));
}

function dsScheduleZipReader(data) {
  const bytes = Buffer.from(data);
  const fail = () => { throw new Error("DS XLSX 파일이 손상되었거나 지원하지 않는 압축 형식입니다."); };
  if (bytes.length < 22 || bytes.length > 128 * 1024 * 1024) fail();
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < Math.max(0, bytes.length - 65557)) fail();
  if (end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) fail();
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12);
  let position = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || count > 10000 || position + directorySize > end) fail();
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) fail();
    const nameSize = bytes.readUInt16LE(position + 28), extraSize = bytes.readUInt16LE(position + 30), commentSize = bytes.readUInt16LE(position + 32);
    const next = position + 46 + nameSize + extraSize + commentSize;
    if (next > end) fail();
    const name = bytes.subarray(position + 46, position + 46 + nameSize).toString("utf8");
    if (entries.has(name)) fail();
    entries.set(name, { flags: bytes.readUInt16LE(position + 8), method: bytes.readUInt16LE(position + 10), size: bytes.readUInt32LE(position + 24), compressed: bytes.readUInt32LE(position + 20), offset: bytes.readUInt32LE(position + 42) });
    position = next;
  }
  let total = 0;
  return name => {
    const entry = entries.get(name);
    if (!entry) return "";
    if (entry.flags & 1 || ![0, 8].includes(entry.method) || entry.size > 16 * 1024 * 1024 || (total += entry.size) > 64 * 1024 * 1024) fail();
    const offset = entry.offset;
    if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50) fail();
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    if (start + entry.compressed > bytes.length) fail();
    const compressed = bytes.subarray(start, start + entry.compressed);
    const output = entry.method === 8 ? zlib.inflateRawSync(compressed, { maxOutputLength: 16 * 1024 * 1024 }) : compressed;
    if (output.length !== entry.size) fail();
    const xml = output.toString("utf8");
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail();
    return xml;
  };
}

function dsScheduleDate(value, date1904 = false) {
  const raw = String(value ?? "").trim();
  if (!raw || /^(?:-|n\/?a|tbd)$/i.test(raw)) return { display: raw, due: "" };
  if (/^\d+(?:\.\d+)?$/.test(raw) && Number(raw) >= 1 && Number(raw) < 100000) {
    const serial = Number(raw);
    const stamp = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : serial < 60 ? 31 : 30) + Math.round(serial * 1440) * 60000;
    const iso = new Date(stamp).toISOString();
    const timed = Math.abs(serial - Math.floor(serial)) > 0.000001;
    const due = iso.slice(0, timed ? 16 : 10);
    return { display: due.replace("T", " "), due };
  }
  let match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/);
  if (!match) {
    const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (us) match = [raw, us[3], us[1], us[2]];
  }
  if (match) {
    const [, year, month, day, hour, minute] = match;
    const stamp = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (stamp.getUTCFullYear() === Number(year) && stamp.getUTCMonth() + 1 === Number(month) && stamp.getUTCDate() === Number(day) && (!hour || Number(hour) < 24) && (!minute || Number(minute) < 60)) {
      const due = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}${hour ? `T${hour.padStart(2, "0")}:${minute}` : ""}`;
      return { display: due.replace("T", " "), due };
    }
  }
  return { display: raw, due: "" };
}

function dsScheduleActivityDetails(activity) {
  const key = String(activity || "").trim().toLowerCase().replace(/\s*\([^)]*\)\s*/g, " ").replace(/[\s_-]+/g, " ").trim();
  const descriptions = {
    development: "개발", "pair test": "메인 테스트가 아닌 후보 테스트 진행", ds: "DS 문서 작성",
    tas: "Test Automation System을 통한 테스트", "code review": "코드 리뷰",
    testing: "테스트 진행 (주로 Tester 팀 담당)", it: "Integration Test",
    qa: "QA 일정 진행\n- FS·DS 문서 작성\n- CTASK 생성\n- ServiceNow에서 QA Complete으로 전환",
    "approved for production": "ServiceNow에서 Approved for Production으로 전환",
    deployment: "세레나 리퀘스트 상태를 Staging으로 전환", "final verification": "Final Verification",
    "ready for prod": "세레나 리퀘스트를 Ready for Prod로 전환", implemented: "ServiceNow에서 Implemented로 전환"
  };
  return descriptions[key] || `DS 일정에 따라 ${String(activity || "").trim()} 진행`;
}

function readDsScheduleWorkbook(data) {
  const read = dsScheduleZipReader(data);
  const workbook = read("xl/workbook.xml");
  if (!workbook) throw new Error("일정 탭을 읽으려면 Google Sheets 또는 XLSX 형식의 DS가 필요합니다.");
  const date1904 = /^(?:1|true)$/i.test(dsScheduleXmlElements(workbook, "workbookPr")[0]?.attrs.date1904 || "");
  const relationships = new Map(dsScheduleXmlElements(read("xl/_rels/workbook.xml.rels"), "Relationship").filter(rel => rel.attrs.TargetMode !== "External").map(rel => [rel.attrs.Id, rel.attrs.Target]));
  const strings = dsScheduleXmlElements(read("xl/sharedStrings.xml"), "si").map(item => dsScheduleXmlElements(item.body, "t").map(text => dsScheduleXmlText(text.body)).join(""));
  const allSheets = dsScheduleXmlElements(workbook, "sheet");
  const normalize = value => String(value || "").replace(/[\s_-]+/g, "").toLowerCase();
  const sheets = [];
  for (const sheet of allSheets) {
    if (!["schedule", "prodschedule"].includes(normalize(sheet.attrs.name))) continue;
    const target = relationships.get(sheet.attrs["r:id"] || Object.entries(sheet.attrs).find(([key]) => key.endsWith(":id"))?.[1]);
    if (!target) throw new Error(`${sheet.attrs.name} 탭의 파일 위치를 읽을 수 없습니다.`);
    const parts = (target.startsWith("/") ? target.slice(1) : `xl/${target}`).split("/");
    const path = [];
    for (const part of parts) { if (part === "..") path.pop(); else if (part && part !== ".") path.push(part); }
    if (path[0] !== "xl") throw new Error("DS 일정 탭 경로가 올바르지 않습니다.");
    const xml = read(path.join("/"));
    if (!xml) throw new Error(`${sheet.attrs.name} 탭의 내용이 없습니다.`);
    const rows = dsScheduleXmlElements(xml, "row").map((row, index) => {
      const cells = new Map();
      for (const cell of dsScheduleXmlElements(row.body, "c")) {
        const column = cell.attrs.r?.match(/^[A-Z]+/i)?.[0]?.toUpperCase();
        if (!column) continue;
        const value = dsScheduleXmlElements(cell.body, "v")[0]?.body ?? "";
        cells.set(column, cell.attrs.t === "s" ? (value ? strings[Number(value)] || "" : "") : cell.attrs.t === "inlineStr" ? dsScheduleXmlElements(cell.body, "t").map(text => dsScheduleXmlText(text.body)).join("") : value || !dsScheduleXmlElements(cell.body, "f").length ? dsScheduleXmlText(value) : "계산 결과 없음");
      }
      return { number: Number(row.attrs.r) || index + 1, cells };
    });
    let header = null;
    const items = [], occurrences = new Map();
    for (const row of rows) {
      const candidate = {};
      for (const [column, value] of row.cells) {
        const field = { activity: "activity", pic: "pic", start: "start", end: "end", "startdate": "start", "enddate": "end" }[normalize(value)];
        if (field && !candidate[field]) candidate[field] = column;
      }
      if (["activity", "pic", "start", "end"].every(field => candidate[field])) { header = candidate; continue; }
      if (!header) continue;
      const activity = String(row.cells.get(header.activity) || "").trim();
      if (!activity || /^(?:activity|total|summary|합계|비고|guideline)$/i.test(activity)) continue;
      const pic = String(row.cells.get(header.pic) || "").trim();
      const start = dsScheduleDate(row.cells.get(header.start), date1904), end = dsScheduleDate(row.cells.get(header.end), date1904);
      const identity = `${normalize(activity)}|${normalize(pic)}`;
      const occurrence = (occurrences.get(identity) || 0) + 1;
      occurrences.set(identity, occurrence);
      items.push({ id: `${sheet.attrs.name}:${row.number}`, sheet: sheet.attrs.name, row: row.number, activity, pic, start: start.display, end: end.display, dueDate: end.due, occurrence, details: dsScheduleActivityDetails(activity), dateWarning: Boolean((start.display && !start.due) || (end.display && !end.due)) });
    }
    sheets.push({ name: sheet.attrs.name, items, error: header ? "" : "Activity·PIC·Start·End 열을 찾지 못했습니다." });
  }
  if (!sheets.length) throw new Error("DS에 Schedule 또는 PROD Schedule 탭이 없습니다.");
  return { sheets };
}

function dsScheduleSourceLine(source, item) {
  // Readable provenance stays inside the existing detail metadata, so normal edits preserve it.
  const identity = [source.fileId, item.sheet, item.activity.trim().toLowerCase(), item.pic.trim().toLowerCase(), item.occurrence || 1].join("|");
  const key = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 20);
  return `DS 일정 참조: ${key} · ${item.sheet} · ${item.activity}`;
}

class DsScheduleModal extends Modal {
  constructor(app, plugin, ticketId) {
    super(app); this.plugin = plugin; this.ticketId = normalizeTicketId(ticketId);
    this.selected = new Set(); this.closed = false; this.busy = false;
  }

  onOpen() {
    this.modalEl.addClass("clt-ds-schedule-modal");
    this.titleEl.setText(`${this.ticketId} DS 일정 → To-Do`);
    this.contentEl.createDiv({ cls: "clt-meeting-import-lead", text: "열 때마다 DS를 다시 다운로드합니다. 생성은 이 티켓의 To-Do에만 반영되며 ServiceNow·세레나 상태는 변경하지 않습니다." });
    this.statusEl = this.contentEl.createDiv({ cls: "clt-ds-schedule-status", attr: { role: "status" } });
    this.body = this.contentEl.createDiv();
    this.reloadButton = this.contentEl.createEl("button", { text: "DS 다시 다운로드", attr: { type: "button" } });
    this.reloadButton.addEventListener("click", () => this.load());
    void this.load();
  }

  async load() {
    if (this.busy) return;
    this.busy = true; this.reloadButton.disabled = true; this.body.empty(); this.source = null;
    this.statusEl.setText("최신 DS를 다운로드하고 일정을 읽는 중…");
    try {
      const source = await this.plugin.loadLatestDsSchedule(this.ticketId);
      if (this.closed) return;
      this.source = source; this.selected.clear();
      this.statusEl.setText(`DS 최신 다운로드 완료 · ${source.loadedAt.replace("T", " ")} · ${source.path.split("/").pop()}`);
      await this.renderSelection();
    } catch (error) {
      if (!this.closed) this.statusEl.setText(`일정 불러오기 실패: ${error.message || error} (이전 DS로 대신 생성하지 않습니다.)`);
    } finally { this.busy = false; if (!this.closed) this.reloadButton.disabled = false; }
  }

  async renderSelection() {
    const source = this.source;
    const existing = await this.plugin.dsScheduleExistingSources(this.ticketId);
    if (this.closed || source !== this.source) return;
    const toolbar = this.body.createDiv({ cls: "clt-ds-schedule-toolbar" });
    const tabs = toolbar.createDiv({ cls: "clt-ds-schedule-tabs", attr: { role: "group", "aria-label": "DS 일정 탭" } });
    const stateLabel = toolbar.createEl("label", { text: "생성 상태 " });
    const state = stateLabel.createEl("select", { attr: { "aria-label": "To-Do 생성 상태" } });
    for (const status of this.plugin.getTodoWorkflow().filter(item => item.enabled)) state.createEl("option", { value: status.key, text: status.label }).value = status.key;
    this.body.createDiv({ cls: "clt-meeting-analysis-hint", text: "완료 예정일은 End 기준입니다. 날짜가 없으면 미지정으로 생성합니다. 이미 생성된 일정은 건너뛰며, 기존 To-Do는 덮어쓰지 않습니다." });
    const list = this.body.createDiv({ cls: "clt-ds-schedule-list" });
    const summary = this.body.createDiv({ attr: { role: "status" } });
    const review = { id: "review-preparation", sheet: "추가 업무", activity: "리뷰 준비", pic: "", occurrence: 1, details: "리뷰를 위한 자료 및 설명 준비", dueDate: "" };
    const reviewLabel = this.body.createEl("label", { cls: "clt-ds-review" });
    const reviewCheck = reviewLabel.createEl("input", { type: "checkbox", attr: { "aria-label": "리뷰 준비 추가" } });
    reviewLabel.createSpan({ text: "리뷰 준비 추가 (선택)" });
    const reviewDate = reviewLabel.createEl("input", { type: "date", attr: { "aria-label": "리뷰 준비 목표일" } });
    reviewDate.disabled = true;
    reviewLabel.createSpan({ text: "날짜를 비우면 기한 없이 생성" });
    const reviewExists = existing.has(dsScheduleSourceLine(source, review));
    if (reviewExists) { reviewCheck.disabled = true; reviewLabel.createSpan({ text: "이미 생성됨" }); }
    const actions = this.body.createDiv({ cls: "clt-sn-document-actions" });
    actions.createEl("button", { text: "취소" }).addEventListener("click", () => this.close());
    const create = actions.createEl("button", { text: "선택 일정 생성", cls: "mod-cta" });
    const allItems = source.sheets.flatMap(sheet => sheet.items);
    const update = () => { const count = this.selected.size + (reviewCheck.checked ? 1 : 0); summary.setText(`선택 ${count}개 · 생성할 상태: ${state.selectedOptions[0]?.textContent || ""}`); create.disabled = !count; };
    reviewCheck.addEventListener("change", () => { reviewDate.disabled = !reviewCheck.checked; update(); });
    state.addEventListener("change", update);
    const buttons = [];
    const draw = sheet => {
      list.empty(); buttons.forEach(([button, name]) => button.setAttribute("aria-pressed", String(name === sheet.name)));
      if (sheet.error || !sheet.items.length) { list.createDiv({ text: sheet.error || "이 탭에 생성할 일정이 없습니다." }); return; }
      const table = list.createEl("table");
      const header = table.createEl("thead").createEl("tr");
      const selectAll = header.createEl("th").createEl("input", { type: "checkbox", attr: { "aria-label": `${sheet.name} 전체 선택` } });
      ["Activity", "PIC", "Start", "End"].forEach(text => header.createEl("th", { text }));
      const checks = [];
      const syncAll = () => { selectAll.checked = checks.length > 0 && checks.every(box => box.checked); selectAll.indeterminate = !selectAll.checked && checks.some(box => box.checked); selectAll.disabled = !checks.length; };
      const body = table.createEl("tbody");
      for (const item of sheet.items) {
        const row = body.createEl("tr");
        const checkbox = row.createEl("td").createEl("input", { type: "checkbox", attr: { "aria-label": `${item.activity} · ${item.pic || "담당 미지정"} · ${item.row}행` } });
        const exists = existing.has(dsScheduleSourceLine(source, item));
        checkbox.checked = this.selected.has(item.id); checkbox.disabled = exists;
        if (!exists) checks.push(checkbox);
        checkbox.addEventListener("change", () => { if (checkbox.checked) this.selected.add(item.id); else this.selected.delete(item.id); syncAll(); update(); });
        const activity = row.createEl("td"); activity.createEl("strong", { text: item.activity });
        activity.createDiv({ cls: "clt-ds-schedule-description", text: item.details });
        if (exists) activity.createDiv({ text: "이미 생성됨", cls: "clt-ds-schedule-description" });
        row.createEl("td", { text: item.pic || "—" });
        row.createEl("td", { text: item.start || "미지정", cls: "clt-ds-schedule-date" });
        const end = row.createEl("td", { text: item.end || "미지정", cls: "clt-ds-schedule-date" });
        if (item.dateWarning) end.createDiv({ text: "원본 날짜 형식 확인 필요", cls: "clt-ds-schedule-description" });
      }
      selectAll.addEventListener("change", () => { for (const item of sheet.items) { if (existing.has(dsScheduleSourceLine(source, item))) continue; if (selectAll.checked) this.selected.add(item.id); else this.selected.delete(item.id); } draw(sheet); update(); });
      syncAll();
    };
    for (const sheet of source.sheets) {
      const button = tabs.createEl("button", { text: `${sheet.name} (${sheet.items.length})`, attr: { type: "button" } });
      buttons.push([button, sheet.name]); button.addEventListener("click", () => draw(sheet));
    }
    draw(source.sheets[0]); update();
    create.addEventListener("click", async () => {
      if (this.busy) return;
      const selected = allItems.filter(item => this.selected.has(item.id));
      if (reviewCheck.checked) selected.push({ ...review, dueDate: reviewDate.value, end: reviewDate.value });
      if (!selected.length) return;
      if (!reviewDate.checkValidity()) return new Notice("리뷰 준비 날짜를 확인해 주세요.");
      this.busy = true; create.disabled = true; this.reloadButton.disabled = true;
      try {
        const result = await this.plugin.createDsScheduleTodos(this.ticketId, source, selected, state.value);
        new Notice(`${this.ticketId} To-Do ${result.created}건 생성${result.skipped ? ` · 기존 ${result.skipped}건 제외` : ""}`);
        this.close();
      } catch (error) {
        this.statusEl.setText(`일정 생성 실패: ${error.message || error}`);
        create.disabled = false;
      } finally { this.busy = false; if (!this.closed) this.reloadButton.disabled = false; }
    });
  }

  onClose() { this.closed = true; this.contentEl.empty(); }
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
      [this.app.metadataCache, this.app.metadataCache.on("changed", refreshIfRelevant)],
      [this.app.workspace, this.app.workspace.on("servicenow-manage:meeting-links-changed", () => this.render())]
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
    this.modalEl.addClass("snm-content-modal");
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

function relatedNoteTitle(value) {
  const title = String(value || "").replace(/[\r\n]+/g, " ").trim();
  if (!title) throw new Error("문서 제목을 입력해 주세요.");
  let stem = Array.from(safeFileName(title.replace(/\.md$/i, "")).replace(/[\[\]#^]/g, "_").replace(/[. ]+$/, "")).slice(0, 100).join("");
  if (!stem || /^\.+$/.test(stem)) throw new Error("파일명으로 사용할 수 있는 문서 제목을 입력해 주세요.");
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  return { title, stem };
}

function relatedDocumentValues(value) {
  if (value == null || value === "") return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some(item => typeof item !== "string")) throw new Error("‘관련 문서’ 속성은 링크 또는 링크 목록이어야 합니다. 기존 값은 변경하지 않았습니다.");
  return [...new Set(values.map(item => item.trim()).filter(Boolean))];
}

function relatedNoteFrontmatter(markdown) {
  const match = String(markdown || "").match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match && /^\uFEFF?---\r?\n/.test(String(markdown || ""))) throw new Error("노트 속성의 시작·끝 구분자를 확인해 주세요.");
  const value = match ? parseYaml(match[1]) || {} : {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("노트 속성을 읽을 수 없습니다.");
  return value;
}

function updateRelatedNotesIndexMarkdown(markdown, ticketId, links) {
  const newline = String(markdown).includes("\r\n") ? "\r\n" : "\n";
  let current = String(markdown || "");
  const action = current.match(/```clt-related-note-actions\s*\r?\n([\s\S]*?)```/);
  if (action && normalizeTicketId(action[1].match(/^ticket:\s*(\S+)\s*$/m)?.[1]) !== ticketId) throw new Error("관련 문서 목록의 티켓 설정이 다릅니다. 기존 목록은 변경하지 않았습니다.");
  if (!action) {
    const frontmatter = current.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] || "";
    const toolbar = `\`\`\`clt-related-note-actions${newline}ticket: ${ticketId}${newline}\`\`\`${newline}${newline}`;
    current = frontmatter + (frontmatter && !frontmatter.endsWith("\n") ? newline : "") + toolbar + current.slice(frontmatter.length);
  }
  const start = "<!-- servicenow-manage:related-notes:start -->", end = "<!-- servicenow-manage:related-notes:end -->";
  if (current.includes(start) !== current.includes(end) || (current.includes(start) && (current.indexOf(end) < current.indexOf(start) || current.indexOf(start) !== current.lastIndexOf(start) || current.indexOf(end) !== current.lastIndexOf(end)))) throw new Error("관련 문서 목록의 관리 영역이 손상되었습니다. 기존 목록은 변경하지 않았습니다.");
  const additions = [];
  for (const link of links) {
    if (!link || current.includes(link) || additions.includes(link)) continue;
    const target = parseWikiLink(link);
    if (target && [...current.matchAll(/\[\[([^\]]+)\]\]/g)].some(match => parseWikiLink(match[0]) === target)) continue;
    additions.push(link);
  }
  if (!additions.length) return current;
  const lines = additions.map(link => `- ${link.replace(/\r?\n/g, `${newline}  `)}`).join(newline);
  if (current.includes(end)) return current.replace(end, `${lines}${newline}${end}`);
  return `${current}${current.endsWith("\n") ? newline : newline + newline}${start}${newline}## 관련 노트 목록${newline}${newline}${lines}${newline}${end}${newline}`;
}

class RelatedNoteCreateModal extends Modal {
  constructor(app, plugin, ticketId, indexPath = "") { super(app); this.plugin = plugin; this.ticketId = ticketId; this.indexPath = indexPath; this.created = null; this.linked = false; }
  onOpen() {
    this.modalEl.addClass("clt-related-note-modal");
    this.titleEl.setText(`${this.ticketId} 관련 노트 추가`);
    this.contentEl.createEl("p", { text: "기존 관련 문서 목록은 재사용합니다. 목록이 없으면 자동으로 만들며, 생성 후 새 문서로 이동합니다. 기존 문서 링크도 목록 안에 보존합니다." });
    const label = this.contentEl.createEl("label", { cls: "clt-related-note-title" });
    label.createSpan({ text: "문서 제목" });
    const title = label.createEl("input", { type: "text", attr: { placeholder: "예: 배포 점검 자료", "aria-label": "문서 제목", maxlength: "150" } });
    const preview = this.contentEl.createDiv({ cls: "clt-related-note-preview" });
    title.addEventListener("input", () => { status.setText(""); try { preview.setText(`파일명: ${relatedNoteTitle(title.value).stem}.md · 같은 이름은 (2), (3)으로 보관합니다.`); } catch (_) { preview.setText(""); } });
    this.contentEl.createDiv({ cls: "clt-meeting-analysis-hint", text: "원본 ‘관련 문서’ → 목록 → 새 문서로 연결됩니다. 새 문서의 Parent는 목록, ‘원본 노트’는 티켓을 가리킵니다." });
    const status = this.contentEl.createDiv({ attr: { role: "status" } });
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    actions.createEl("button", { text: "취소" }).addEventListener("click", () => this.close());
    const openSaved = actions.createEl("button", { text: "생성 노트 열기" }); openSaved.hidden = true;
    openSaved.addEventListener("click", async () => { try { await this.app.workspace.getLeaf(false).openFile(this.created.note); this.close(); } catch (error) { status.setText(`노트 열기 실패: ${error.message || error}`); } });
    const create = actions.createEl("button", { text: "생성", cls: "mod-cta" });
    const submit = async () => {
      if (create.disabled) return;
      create.disabled = true;
      try {
        if (!this.created) this.created = await this.plugin.createTicketRelatedNote(this.ticketId, title.value, this.indexPath);
        else if (!this.linked) await this.plugin.linkRelatedNoteToIndex(this.ticketId, this.created.index, this.created.note);
        this.linked = true;
        await this.app.workspace.getLeaf(false).openFile(this.created.note);
        this.close();
      } catch (error) {
        if (error.relatedNote) this.created = error.relatedNote;
        if (this.created) { title.disabled = true; openSaved.hidden = this.linked; create.setText(this.linked ? "생성 노트 열기" : "연결 다시 시도"); }
        status.setText(this.created ? `문서는 저장되었습니다: ${this.created.note.path}\n${error.message || error} · 다시 눌러도 문서를 중복 생성하지 않습니다.` : error.message || String(error));
      } finally { create.disabled = false; }
    };
    create.addEventListener("click", submit);
    title.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); void submit(); } });
    title.focus();
  }
  onClose() { this.contentEl.empty(); }
}

class TicketLifecycleSettingsModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; this.draft = normalizeTicketLifecycle(plugin.settings.ticketLifecycle); }
  onOpen() {
    this.titleEl.setText("활성·휴면·보관 전역 설정");
    this.modalEl.addClass("snm-todo-workflow-modal");
    this.modalEl.addClass("snm-ticket-lifecycle-modal");
    this.contentEl.createEl("p", { text: "이 Vault의 모든 티켓에 공통 적용됩니다. 티켓마다 설정할 필요가 없으며, 원본 티켓 노트를 여는 순간 자동으로 활성 상태로 돌아옵니다." });
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
    const status = this.contentEl.createDiv(); status.setAttr("role", "status");
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    actions.createEl("button", { text: "취소" }).addEventListener("click", () => this.close());
    const save = actions.createEl("button", { text: "전체 티켓에 적용", cls: "mod-cta" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try { await this.plugin.saveTicketLifecycleSettings(this.draft); this.close(); new Notice("활성·휴면·보관 전역 설정을 모든 티켓에 적용했습니다."); }
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
    this.modalEl?.addClass?.("snm-content-modal");
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

    new Setting(containerEl)
      .setName("팝업 너비 (전역)")
      .setDesc("To-Do·작업 일지·회의록·Jira Export 등 내용이 많은 팝업에 공통 적용합니다. 앱 창 너비 기준이며, 좁은 창에서는 자동으로 화면에 맞춥니다.")
      .addDropdown(dropdown => {
        for (let value = 50; value <= 95; value += 5) dropdown.addOption(String(value), `${value}%${value === 75 ? " (기본)" : ""}`);
        dropdown.setValue(String(normalizePopupWidthPercent(this.plugin.settings.popupWidthPercent)))
          .onChange(async value => {
            try { await this.plugin.setPopupWidthPercent(value); }
            catch (error) { dropdown.setValue(String(normalizePopupWidthPercent(this.plugin.settings.popupWidthPercent))); new Notice(`팝업 너비 저장 실패: ${error.message || error}`); }
          });
      });

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
    new Setting(containerEl).setName("활성·휴면·보관 정책 (전역)").setDesc("이 Vault의 모든 티켓에 동일하게 적용합니다. 원본 노트를 직접 열면 자동 활성화됩니다.").addButton(button => button.setButtonText("활성·휴면·보관 전역 설정").onClick(() => this.plugin.openTicketLifecycleSettings()));
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
    this.settings.popupWidthPercent = normalizePopupWidthPercent(this.settings.popupWidthPercent);
    this.applyPopupLayoutSettings();
    this.registerEvent(this.app.workspace.on("layout-change", () => this.applyPopupLayoutSettings()));
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
    this.registerMarkdownCodeBlockProcessor("clt-related-note-actions", (source, el, ctx) => {
      const ticketId = normalizeTicketId(source.match(/^ticket:\s*(\S+)\s*$/m)?.[1] || this.ticketIdFromPath(ctx.sourcePath));
      const index = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!ticketId || !(index instanceof TFile)) return;
      this.renderRelatedNoteActions(el, ticketId, index.path);
    });
    this.registerMarkdownPostProcessor(async (el, ctx) => {
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      const frontmatter = file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter || {} : {};
      this.decorateMeetingTicketLinks(el, file, ctx);
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
    this.popupLayoutDocuments?.forEach((previous, doc) => {
      if (previous.value) doc.documentElement.style.setProperty("--snm-popup-width", previous.value, previous.priority);
      else doc.documentElement.style.removeProperty("--snm-popup-width");
    });
    this.popupLayoutDocuments?.clear();
    this.responsiveActionObservers?.forEach(observer => observer.disconnect());
    this.responsiveActionObservers?.clear();
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

  applyPopupLayoutSettings() {
    const docs = new Set();
    if (typeof document !== "undefined") docs.add(document);
    this.app.workspace.iterateAllLeaves?.(leaf => {
      const doc = leaf.view?.containerEl?.ownerDocument;
      if (doc?.documentElement) docs.add(doc);
    });
    this.popupLayoutDocuments ||= new Map();
    for (const doc of docs) {
      const style = doc.documentElement.style;
      if (!this.popupLayoutDocuments.has(doc)) this.popupLayoutDocuments.set(doc, { value: style.getPropertyValue("--snm-popup-width"), priority: style.getPropertyPriority("--snm-popup-width") });
      style.setProperty("--snm-popup-width", `${normalizePopupWidthPercent(this.settings.popupWidthPercent)}vw`);
    }
  }

  async setPopupWidthPercent(value) {
    const previous = this.settings.popupWidthPercent;
    this.settings.popupWidthPercent = normalizePopupWidthPercent(value);
    this.applyPopupLayoutSettings();
    try { await this.savePluginData(); }
    catch (error) { this.settings.popupWidthPercent = previous; this.applyPopupLayoutSettings(); throw error; }
  }

  observeResponsiveActions(container, minimum = 180) {
    this.responsiveActionObservers ||= new Map();
    for (const [element, observer] of this.responsiveActionObservers) {
      if (!element.isConnected) { observer.disconnect(); this.responsiveActionObservers.delete(element); }
    }
    this.responsiveActionObservers.get(container)?.disconnect();
    layoutResponsiveActions(container, minimum);
    const Observer = container.ownerDocument?.defaultView?.ResizeObserver;
    if (Observer) {
      const observer = new Observer(() => layoutResponsiveActions(container, minimum));
      observer.observe(container);
      this.responsiveActionObservers.set(container, observer);
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
    return this.ticketActivity.tickets[ticketId] ||= { firstObservedAt: new Date().toISOString(), lastOpenedAt: "", lastMeaningfulChangeAt: new Date().toISOString(), initialized: false };
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
    this.queueTicketActivitySave();
    this.notifyTicketActivityChanged();
    this.refreshViews(ticketId);
    if (previousKind !== "active") new Notice(`${ticketId}를 활성 업무로 복귀했습니다. ServiceNow 상태는 변경하지 않았습니다.`, 5000);
  }

  activeRootTicketFiles(files = this.rootTicketFiles()) { return files.filter(file => this.getTicketActivity(this.rootTicketIdFromFile(file)).kind === "active"); }
  openTicketLifecycleSettings() { new TicketLifecycleSettingsModal(this.app, this).open(); }
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

  ticketRelatedNotesFolder(ticketId) { return normalizePath(`${this.ticketFolder(ticketId)}/관련 문서`); }

  resolveRelatedDocumentFile(value, rootFile) {
    const target = parseWikiLink(value);
    if (!target) return null;
    const file = this.app.metadataCache.getFirstLinkpathDest?.(target, rootFile.path)
      || this.app.vault.getAbstractFileByPath(target)
      || this.app.vault.getAbstractFileByPath(`${target}.md`);
    return file instanceof TFile ? file : null;
  }

  async isTicketRelatedIndex(file, ticketId) {
    const root = this.rootTicketFile(ticketId), prefix = `${this.ticketFolder(ticketId)}/`;
    if (!(file instanceof TFile) || file === root || file.extension !== "md" || !file.path.startsWith(prefix)) return false;
    const fm = relatedNoteFrontmatter(await this.app.vault.read(file));
    if (fm.ticket && normalizeTicketId(fm.ticket) !== ticketId) return false;
    if (fm.type === "ticket-related-note") return false;
    return fm.type === "ticket-related-index" || /관련[\s_-]*(?:문서|노트)/.test(file.basename);
  }

  openRelatedNoteCreateModal(ticketId, indexPath = "") { new RelatedNoteCreateModal(this.app, this, normalizeTicketId(ticketId), indexPath).open(); }

  renderRelatedNoteActions(el, ticketId, indexPath) {
    el.addClass("clt-related-note-actions");
    el.createEl("button", { text: "관련 노트 추가", cls: "mod-cta", attr: { type: "button" } }).addEventListener("click", () => this.openRelatedNoteCreateModal(ticketId, indexPath));
    el.createEl("button", { text: "원본 노트 열기", attr: { type: "button" } }).addEventListener("click", async () => {
      try { const root = this.rootTicketFile(ticketId); if (!(root instanceof TFile)) throw new Error("원본 티켓 노트를 찾을 수 없습니다."); await this.app.workspace.getLeaf(false).openFile(root); }
      catch (error) { new Notice(error.message || String(error)); }
    });
  }

  async createTicketRelatedNote(ticketId, value, indexPath = "") {
    const normalized = normalizeTicketId(ticketId), root = this.rootTicketFile(normalized);
    if (!(root instanceof TFile)) throw new Error("원본 티켓 노트를 찾을 수 없습니다.");
    const { title, stem } = relatedNoteTitle(value);
    this.creatingRelatedNotes ||= new Set();
    if (this.creatingRelatedNotes.has(normalized)) throw new Error("이 티켓의 관련 노트를 생성 중입니다. 잠시 후 다시 눌러 주세요.");
    this.creatingRelatedNotes.add(normalized);
    try {
      const fm = relatedNoteFrontmatter(await this.app.vault.read(root));
      const references = relatedDocumentValues(fm["관련 문서"]);
      let index = indexPath ? this.app.vault.getAbstractFileByPath(normalizePath(indexPath)) : null;
      if (indexPath && !await this.isTicketRelatedIndex(index, normalized)) throw new Error("이 티켓의 관련 문서 목록에서만 추가할 수 있습니다.");
      if (!index) for (const reference of references) {
        const candidate = this.resolveRelatedDocumentFile(reference, root);
        if (await this.isTicketRelatedIndex(candidate, normalized)) { index = candidate; break; }
      }
      const folder = this.ticketRelatedNotesFolder(normalized);
      const defaultIndexPath = normalizePath(`${folder}/${normalized}_관련문서.md`);
      if (!index) {
        const candidate = this.app.vault.getAbstractFileByPath(defaultIndexPath);
        if (await this.isTicketRelatedIndex(candidate, normalized)) index = candidate;
      }
      if (!index) {
        await this.ensureFolder(folder);
        const path = await this.uniqueVaultPath(defaultIndexPath);
        const now = localIsoDateTime().slice(0, 16);
        index = await this.app.vault.create(path, `---\n${stringifyYaml({ type: "ticket-related-index", ticket: normalized, Parent: `[[${root.path}]]`, created: now }).trimEnd()}\n---\n\n# 관련 문서 목록\n`);
      }
      const indexFolder = index.path.split("/").slice(0, -1).join("/");
      const path = await this.uniqueVaultPath(`${indexFolder}/${stem}.md`);
      const now = localIsoDateTime().slice(0, 16);
      const escapedTitle = title.replace(/([\\`*_\[\]<>])/g, "\\$1");
      const note = await this.app.vault.create(path, `---\n${stringifyYaml({ type: "ticket-related-note", ticket: normalized, title, Parent: `[[${index.path}]]`, "원본 노트": `[[${root.path}]]`, created: now, updated: now }).trimEnd()}\n---\n\n# ${escapedTitle}\n\n`);
      try { await this.linkRelatedNoteToIndex(normalized, index, note); }
      catch (error) { error.relatedNote = { index, note }; throw error; }
      return { index, note };
    } finally { this.creatingRelatedNotes.delete(normalized); }
  }

  async linkRelatedNoteToIndex(ticketId, index, note) {
    const root = this.rootTicketFile(ticketId);
    if (!(root instanceof TFile) || !await this.isTicketRelatedIndex(index, ticketId)) throw new Error("원본 티켓 또는 관련 문서 목록을 찾을 수 없습니다.");
    if (!(note instanceof TFile) || !note.path.startsWith(`${this.ticketFolder(ticketId)}/`)) throw new Error("연결할 관련 노트를 찾을 수 없습니다.");
    const noteFm = relatedNoteFrontmatter(await this.app.vault.read(note));
    if (noteFm.type !== "ticket-related-note" || normalizeTicketId(noteFm.ticket) !== ticketId || this.resolveRelatedDocumentFile(noteFm.Parent, root)?.path !== index.path) throw new Error("관련 노트의 상위 목록이 일치하지 않습니다.");
    const rootFm = relatedNoteFrontmatter(await this.app.vault.read(root));
    const currentValue = rootFm["관련 문서"];
    const references = relatedDocumentValues(currentValue).filter(value => this.resolveRelatedDocumentFile(value, root)?.path !== index.path);
    const newLink = `[[${note.path}|${note.basename}]]`;
    await this.app.vault.process(index, markdown => updateRelatedNotesIndexMarkdown(markdown, ticketId, [...references, newLink]));
    const indexLink = `[[${index.path}]]`;
    if (currentValue !== indexLink) await this.app.fileManager.processFrontMatter(root, fm => {
      if (JSON.stringify(fm["관련 문서"]) !== JSON.stringify(currentValue)) throw new Error("원본의 ‘관련 문서’가 변경되었습니다. 연결 다시 시도를 눌러 주세요.");
      fm["관련 문서"] = indexLink;
    });
    this.refreshViews(ticketId);
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
      const ticketId = this.meetingTicketIdsForFile(file)[0] || "";
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
    const frontmatter = file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter || {} : {};
    const explicit = Object.prototype.hasOwnProperty.call(frontmatter, "tickets") || Object.prototype.hasOwnProperty.call(frontmatter, "ticket");
    const cached = normalizeMeetingTicketIds(Object.prototype.hasOwnProperty.call(frontmatter, "tickets") ? frontmatter.tickets : frontmatter.ticket);
    if (this.pendingMeetingTicketLinks?.has(file?.path)) {
      const pending = normalizeMeetingTicketIds(this.pendingMeetingTicketLinks.get(file.path));
      if (JSON.stringify(pending) === JSON.stringify(cached)) this.pendingMeetingTicketLinks.delete(file.path);
      return pending;
    }
    if (explicit) return cached;
    const match = String(file?.path || "").match(/\/티켓\/((?:CR|SR)\d+)\/회의록\//i);
    return normalizeMeetingTicketIds(match?.[1] || []);
  }

  isManagedMeetingFile(file) {
    if (!(file instanceof TFile) || !/\.md$/i.test(file.path)) return false;
    if (file.path.startsWith(`${this.generalMeetingsFolder()}/`)) return true;
    const prefix = `${this.ticketsFolder()}/`;
    return file.path.startsWith(prefix) && /^(?:CR|SR)\d+\/회의록\//i.test(file.path.slice(prefix.length));
  }

  openMeetingTicketLinksModal(path, onChanged = null) {
    const file = path instanceof TFile ? path : this.app.vault.getAbstractFileByPath(normalizePath(String(path || "")));
    if (!this.isManagedMeetingFile(file)) return new Notice("편집할 회의록을 찾을 수 없습니다.");
    if (String(this.app.metadataCache.getFileCache(file)?.frontmatter?.meeting_kind || "").toLowerCase() === "analysis") return new Notice("원본 회의록에서 티켓 연결을 변경해 주세요.");
    new MeetingTicketLinksModal(this.app, this, file, onChanged).open();
  }

  async updateMeetingTicketLinks(file, ticketIds, { expectedTicketIds = null } = {}) {
    if (!this.isManagedMeetingFile(file)) throw new Error("회의록 폴더 밖의 파일은 변경할 수 없습니다.");
    const ids = normalizeMeetingTicketIds(ticketIds);
    const roots = ids.map(id => ({ id, file: this.rootTicketFile(id) }));
    const missing = roots.filter(item => !(item.file instanceof TFile)).map(item => item.id);
    if (missing.length) throw new Error(`${missing.join(", ")} 원본 티켓 노트를 찾을 수 없습니다.`);
    const previousIds = this.meetingTicketIdsForFile(file);
    await this.app.vault.process(file, markdown => updateMeetingTicketLinksMarkdown(markdown, ids, { expectedTicketIds, fallbackTicketIds: previousIds }));
    this.pendingMeetingTicketLinks ||= new Map();
    this.pendingMeetingTicketLinks.set(file.path, ids);
    const timer = window.setTimeout(() => {
      if (this.pendingMeetingTicketLinks?.get(file.path) === ids) { this.pendingMeetingTicketLinks.delete(file.path); this.app.workspace.trigger("servicenow-manage:meeting-links-changed", file.path); }
    }, 10000);
    this.register?.(() => window.clearTimeout(timer));
    const warnings = [];
    for (const root of roots) {
      try { await this.ensureMeetingSection(root.file, root.id); }
      catch (error) { warnings.push(`${root.id} 연결은 저장했지만 원본 노트의 회의록 영역을 갱신하지 못했습니다: ${error.message || error}`); }
    }
    [...new Set([...previousIds, ...ids])].forEach(id => this.refreshViews(id));
    this.app.workspace.trigger("servicenow-manage:meeting-links-changed", file.path);
    return { ticketIds: ids, warnings };
  }

  decorateMeetingTicketLinks(el, file, ctx = null) {
    if (!this.isManagedMeetingFile(file)) return;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    if (String(fm.meeting_kind || "").toLowerCase() === "analysis") return;
    const heading = el.matches?.("h1") ? el : el.querySelector("h1");
    if (!heading || heading.nextElementSibling?.classList.contains("clt-meeting-note-links")) return;
    const scope = el.closest?.(".markdown-preview-view, .markdown-rendered") || el;
    const firstHeading = scope.matches?.("h1") ? scope : scope.querySelector("h1");
    if (firstHeading && firstHeading !== heading) return;
    const toolbar = document.createElement("div"); toolbar.className = "clt-meeting-note-links";
    const summary = toolbar.createSpan();
    const refresh = () => { const ids = this.meetingTicketIdsForFile(file); summary.setText(ids.length ? `연결 티켓 · ${ids.join(" · ")}` : "주간·공통 회의 · 연결 티켓 없음"); };
    toolbar.createEl("button", { text: "티켓 연결 편집", attr: { type: "button" } }).addEventListener("click", () => this.openMeetingTicketLinksModal(file, refresh));
    heading.insertAdjacentElement("afterend", toolbar); refresh();
    if (ctx?.addChild) {
      const child = new MarkdownRenderChild(toolbar);
      child.registerEvent(this.app.workspace.on("servicenow-manage:meeting-links-changed", path => { if (path === file.path) refresh(); }));
      ctx.addChild(child);
    }
  }

  isMeetingFileRelevantToTicket(file, ticketId, oldPath = "") {
    const normalized = normalizeTicketId(ticketId);
    const directFolder = `${this.ticketMeetingsFolder(normalized)}/`;
    const paths = [String(file?.path || ""), String(oldPath || "")];
    if (paths.some((path) => path.startsWith(directFolder))) return true;
    if (!this.isManagedMeetingFile(file)) return false;
    return this.meetingTicketIdsForFile(file).includes(normalized);
  }

  listTicketMeetings(ticketId, sortDirection = "desc") {
    const normalizedTicketId = normalizeTicketId(ticketId);
    const generalFolder = `${this.generalMeetingsFolder()}/`;
    const meetings = this.app.vault.getMarkdownFiles()
      .filter((file) => {
        if (!this.isManagedMeetingFile(file)) return false;
        const linkedIds = this.meetingTicketIdsForFile(file);
        return normalizedTicketId ? linkedIds.includes(normalizedTicketId) : linkedIds.length === 0;
      })
      .map((file) => {
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
        const meetingDate = String(frontmatter.meeting_date || "");
        const ticketIds = this.meetingTicketIdsForFile(file);
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
      if (meeting.kind !== "analysis") card.createEl("button", { cls: "clt-meeting-card-link-edit", text: "티켓 연결", attr: { type: "button" } }).addEventListener("click", event => {
        event.preventDefault(); event.stopPropagation();
        this.openMeetingTicketLinksModal(meeting.file, () => { container.dispatchEvent(new CustomEvent("clt-meeting-links-changed", { bubbles: true })); });
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
    list.addEventListener("clt-meeting-links-changed", refresh);
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
    const folder = this.isManagedMeetingFile(meeting.file) ? meeting.file.path.slice(0, meeting.file.path.lastIndexOf("/") + 1) : "";
    if (!folder) throw new Error("티켓 회의록 폴더 밖의 파일은 삭제할 수 없습니다.");
    if (meeting.sourcePdf) {
      const pdf = this.app.vault.getAbstractFileByPath(normalizePath(meeting.sourcePdf));
      if (pdf instanceof TFile && pdf.path.startsWith(folder)) await this.app.vault.trash(pdf, true);
    }
    const linkedIds = this.meetingTicketIdsForFile(meeting.file);
    await this.app.vault.trash(meeting.file, true);
    linkedIds.forEach(id => this.refreshViews(id));
    this.app.workspace.trigger("servicenow-manage:meeting-links-changed", meeting.file.path);
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

    const panel = el.createDiv({ cls: "clt-ticket-status-controls" });
    const info = panel.createDiv({ cls: "clt-ticket-status-info" });
    const controls = panel.createDiv({ cls: "clt-ticket-action-grid" });
    const status = info.createSpan({ cls: "clt-sn-ticket-status-value" });
    const readStatus = () => {
      const file = this.rootTicketFile(ticketId);
      const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter || {} : {};
      status.setText(`ServiceNow 상태: ${String(fm.status || "미확인")}`);
    };
    readStatus();
    const activity = this.getTicketActivity(ticketId);
    info.createSpan({ cls: "clt-ticket-activity-badge", text: `${activity.label} · ${activity.reason}` });
    controls.createEl("button", { text: "활성·휴면·보관 전역 설정" }).addEventListener("click", () => this.openTicketLifecycleSettings());
    controls.createEl("button", { text: "관련 문서 노트 생성", attr: { type: "button" } }).addEventListener("click", () => this.openRelatedNoteCreateModal(ticketId));
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
    controls.createEl("button", { text: "일정 생성", attr: { type: "button" } }).addEventListener("click", () => {
      new DsScheduleModal(this.app, this, ticketId).open();
    });
    this.observeResponsiveActions?.(controls, 200);
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

  async loadLatestDsSchedule(ticketId) {
    const normalized = normalizeTicketId(ticketId);
    const file = this.rootTicketFile(normalized);
    if (!(file instanceof TFile)) throw new Error("원본 티켓 노트를 찾을 수 없습니다.");
    if (!this.settings.googleDriveContentAccess) throw new Error("설정에서 Google Drive 파일 다운로드 권한을 연결해 주세요.");
    const markdown = await this.app.vault.read(file);
    const metadata = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const frontmatter = metadata ? parseYaml(metadata[1]) || {} : {};
    let link = String(frontmatter.DS || "");
    if (!googleDriveFileId(link)) {
      const groups = await this.searchGoogleDriveDocuments(normalized);
      if (!groups.DS.length) throw new Error("Drive에서 DS를 찾지 못했습니다. 원본 노트의 DS 속성에 Google Sheets 또는 XLSX 링크를 지정해 주세요.");
      if (groups.DS.length === 1) link = groups.DS[0].url;
      else {
        const selected = await new Promise(resolve => new DocumentCandidateModal(this.app, normalized, { DS: groups.DS }, { DS: link }, resolve).open());
        link = selected?.DS || "";
        if (!link) throw new Error("DS 문서 선택을 취소했습니다.");
      }
    }
    // Always fetch fresh bytes; an old local DS is never a network-error fallback.
    const path = await this.downloadGoogleDriveDocument(normalized, "DS", link);
    if (!/\.xlsx$/i.test(path)) throw new Error("일정 탭은 Google Sheets 또는 XLSX DS에서 읽을 수 있습니다. PDF·XLS 형식은 지원하지 않습니다.");
    const downloaded = this.app.vault.getAbstractFileByPath(path);
    if (!(downloaded instanceof TFile)) throw new Error("다운로드한 DS 파일을 찾을 수 없습니다.");
    const parsed = readDsScheduleWorkbook(await this.app.vault.readBinary(downloaded));
    if (link !== String(frontmatter.DS || "")) await this.app.fileManager.processFrontMatter(file, current => {
      if (String(current.DS || "") !== String(frontmatter.DS || "")) throw new Error("DS 링크가 변경되었습니다. 일정 생성 창을 다시 열어 주세요.");
      current.DS = link;
    });
    return { ...parsed, path, fileId: googleDriveFileId(link), url: link, loadedAt: localIsoDateTime().slice(0, 16) };
  }

  async dsScheduleExistingSources(ticketId) {
    const file = this.rootTicketFile(ticketId);
    if (!(file instanceof TFile)) throw new Error("원본 티켓 노트를 찾을 수 없습니다.");
    const markdown = await this.app.vault.read(file);
    return new Set([...markdown.matchAll(/<!--\s*clt-todo-detail:([^>]*?)\s*-->/g)].flatMap(match => decodeTodoDetail(match[1]).split(/\r?\n/).filter(line => line.startsWith("DS 일정 참조: "))));
  }

  async createDsScheduleTodos(ticketId, source, items, status) {
    const file = this.rootTicketFile(ticketId);
    if (!(file instanceof TFile)) throw new Error("원본 티켓 노트를 찾을 수 없습니다.");
    this.assertTodoStatusEnabled(status);
    const time = localIsoDateTime().slice(0, 16);
    let created = 0, skipped = 0;
    // A single atomic note update also rechecks duplicates if two dialogs were open.
    await this.app.vault.process(file, markdown => {
      const existing = new Set([...markdown.matchAll(/<!--\s*clt-todo-detail:([^>]*?)\s*-->/g)].flatMap(match => decodeTodoDetail(match[1]).split(/\r?\n/).filter(line => line.startsWith("DS 일정 참조: "))));
      created = 0; skipped = 0;
      for (const item of items) {
        const provenance = dsScheduleSourceLine(source, item);
        if (existing.has(provenance)) { skipped++; continue; }
        const dueDate = item.dueDate || "";
        if (dueDate && !dsScheduleDate(dueDate).due) throw new Error(`${item.activity}의 완료 예정일을 확인해 주세요.`);
        const details = [item.details, "", `PIC: ${item.pic || "미지정"}`, `Start: ${item.start || "미지정"}`, `End: ${item.end || "미지정"}`, `원본 DS: [[${source.path}]] · ${item.sheet}${item.row ? ` · ${item.row}행` : ""}`, provenance].join("\n");
        const markers = `${["in-progress", "waiting"].includes(status) ? ` <!-- clt-todo:${status} -->` : ""}${dueDate ? ` <!-- clt-todo-due:${dueDate} -->` : ""}${status === "done" ? ` <!-- clt-todo-completed:${time} -->` : ""}`;
        const title = stripCltTodoMetadata(item.activity.replace(/\r?\n/g, " "));
        if (!title) throw new Error("일정 Activity가 비어 있습니다.");
        markdown = appendEntryToMarkdownSection(markdown, "✅ To-Do", `- [${status === "done" ? "x" : " "}] ${time} : ${title}${markers} <!-- clt-todo-detail:${encodeTodoDetail(details)} -->`);
        existing.add(provenance); created++;
      }
      return markdown;
    });
    if (created) { await this.touchTodoLastChecked(file); this.refreshViews(ticketId); }
    return { created, skipped };
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
