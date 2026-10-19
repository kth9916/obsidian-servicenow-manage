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
  todoSort: "smart",
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

// Enhance only plugin-owned editors, including dynamically rendered dashboard/popout inputs.
function installDateTimeNowControls(doc) {
  const scope = '.modal[class*="clt-"], .modal[class*="snm-"], .clt-sn-root, .clt-sn-ticket-status, .snm-plugin-settings, .snm-todo-waiting-editor, .opus-dashboard, .opus-modal-backdrop';
  const selector = 'input[type="date"],input[type="time"],input[type="datetime-local"]';
  const bindings = new Map();
  const dispose = binding => {
    binding.button.remove();
    if (binding.wrapper) binding.wrapper.replaceWith(binding.input);
    else binding.host.classList.remove("snm-now-pair");
  };
  const enhance = candidate => {
    if (!candidate.matches(selector) || !candidate.closest(scope)) return;
    const pair = candidate.closest(".clt-todo-due-fields");
    const input = pair?.querySelector('input[type="date"]') || candidate;
    let binding = bindings.get(input);
    if (!binding) {
      const host = pair || doc.createElement("span");
      if (!pair) { host.className = "snm-now-field"; input.before(host); host.append(input); }
      else host.classList.add("snm-now-pair");
      const button = doc.createElement("button");
      button.type = "button"; button.className = "snm-now-button";
      button.textContent = "현재 시간";
      button.title = input.type === "date" && !pair ? "오늘 날짜 설정" : "현재 날짜·시간 설정";
      const label = input.getAttribute("aria-label") || input.title || input.closest("label")?.textContent?.trim() || "날짜·시간";
      button.setAttribute("aria-label", `${label} · 현재 시간`);
      host.append(button);
      binding = { input, host, button, wrapper: pair ? null : host };
      bindings.set(input, binding);
      button.addEventListener("click", event => {
        event.preventDefault(); event.stopPropagation();
        if (input.disabled || input.readOnly) return;
        const now = localIsoDateTime().slice(0, 16);
        const set = (field, value) => {
          if (!field || field.disabled || field.readOnly) return;
          field.value = value;
          field.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
          field.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
        };
        set(input, input.type === "time" ? now.slice(11) : input.type === "date" ? now.slice(0, 10) : now);
        const pairedTime = pair?.querySelector('input[type="time"]');
        if (pairedTime !== input) set(pairedTime, now.slice(11));
      });
    }
    binding.button.disabled = input.disabled || input.readOnly;
  };
  const scan = node => {
    if (node.nodeType !== 1 && node !== doc) return;
    if (node.matches?.(selector)) enhance(node);
    node.querySelectorAll?.(selector).forEach(enhance);
  };
  const observer = new doc.defaultView.MutationObserver(records => {
    for (const [input, binding] of bindings) {
      if (!input.isConnected || !input.matches(selector) || !input.closest(scope)) { dispose(binding); bindings.delete(input); }
    }
    for (const record of records) {
      if (record.type === "attributes") enhance(record.target);
      else record.addedNodes.forEach(scan);
    }
  });
  scan(doc);
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "readonly", "type"] });
  return () => { observer.disconnect(); bindings.forEach(dispose); bindings.clear(); };
}

const TODO_SORT_OPTIONS = [
  ["smart", "기본 (기한·상태 기준)"], ["due-asc", "완료 예정일 빠른순"], ["due-desc", "완료 예정일 늦은순"],
  ["created-desc", "등록일 최신순"], ["created-asc", "등록일 오래된순"],
  ["title-asc", "제목 가나다순"], ["title-desc", "제목 역순"],
  ["completed-desc", "완료일 최신순"], ["follow-up-asc", "다음 확인일 빠른순"]
];
function normalizeTodoSort(value) { return TODO_SORT_OPTIONS.some(([key]) => key === value) ? value : "smart"; }
function sortTodoTasksBySetting(tasks, value) {
  let sort = normalizeTodoSort(value);
  if (sort === "smart") sort = tasks.length && tasks.every(task => task.status === "done") ? "completed-desc"
    : tasks.length && tasks.every(task => task.status === "waiting") ? "follow-up-asc" : "due-asc";
  const field = { due: "dueDate", created: "dateTime", title: "text", completed: "completedAt", "follow-up": "followUpDate" }[sort.replace(/-(?:asc|desc)$/, "")];
  const direction = sort.endsWith("desc") ? -1 : 1;
  const key = task => String(task[field] || (sort === "completed-desc" ? task.dateTime : "") || "").trim().replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T");
  return [...tasks].sort((left, right) => {
    const a = key(left), b = key(right);
    if (!a !== !b) return a ? -1 : 1; // Unspecified deadlines always remain last.
    return direction * a.localeCompare(b, "ko", { numeric: true })
      || String(right.dateTime || "").localeCompare(String(left.dateTime || ""));
  });
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
  if (hasCurrentRuntime && hasWaitingRuntime && hasTodoWorkflowRuntime && current.includes("selectedTodoStatuses") && current.includes("memoConfirm") && current.includes("matchesTicketActivityScope") && current.includes('ticketActivityConfigure.textContent = "활성·휴면·보관 전역 설정";') && current.includes("plugin.openMeetingTicketLinksModal(meeting.file.path, renderMeetingOverview)") && current.includes("const todoSortRef =") && sharedPluginDeclarations.length <= 2 && !hasLegacyDeploymentFinish) return current;
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

function dsScheduleSelectedDate(item, basis = "end") {
  return basis === "start" ? (item.startDueDate ?? dsScheduleDate(item.start).due)
    : (item.endDueDate ?? item.dueDate ?? dsScheduleDate(item.end).due);
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
      items.push({ id: `${sheet.attrs.name}:${row.number}`, sheet: sheet.attrs.name, row: row.number, activity, pic, start: start.display, end: end.display, startDueDate: start.due, endDueDate: end.due, dueDate: end.due, occurrence, details: dsScheduleActivityDetails(activity), dateWarning: Boolean((start.display && !start.due) || (end.display && !end.due)) });
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
    const basisLabel = toolbar.createEl("label", { text: "완료 예정일 기준 " });
    const basis = basisLabel.createEl("select", { attr: { "aria-label": "DS 완료 예정일 기준" } });
    for (const [value, text] of [["end", "End (종료일)"], ["start", "Start (시작일)"]]) basis.createEl("option", { text, value }).value = value;
    this.body.createDiv({ cls: "clt-meeting-analysis-hint", text: "선택한 Start/End를 완료 예정일로 사용합니다. 날짜만 있으면 생성 시점의 현재 시각을 채우고, 원본에 시간이 있으면 유지합니다. 날짜가 없으면 미지정입니다. 이미 생성된 일정은 건너뛰며 기존 To-Do는 덮어쓰지 않습니다." });
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
    let currentSheet = source.sheets[0];
    const draw = sheet => {
      currentSheet = sheet;
      list.empty(); buttons.forEach(([button, name]) => button.setAttribute("aria-pressed", String(name === sheet.name)));
      if (sheet.error || !sheet.items.length) { list.createDiv({ text: sheet.error || "이 탭에 생성할 일정이 없습니다." }); return; }
      const table = list.createEl("table");
      const header = table.createEl("thead").createEl("tr");
      const selectAll = header.createEl("th").createEl("input", { type: "checkbox", attr: { "aria-label": `${sheet.name} 전체 선택` } });
      ["Activity", "PIC", "Start", "End", "완료 예정일"].forEach(text => header.createEl("th", { text }));
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
        const due = dsScheduleSelectedDate(item, basis.value);
        row.createEl("td", { text: due ? `${due.replace("T", " ")}${due.length === 10 ? " · 생성 시각" : ""}` : "미지정", cls: "clt-ds-schedule-date" });
      }
      selectAll.addEventListener("change", () => { for (const item of sheet.items) { if (existing.has(dsScheduleSourceLine(source, item))) continue; if (selectAll.checked) this.selected.add(item.id); else this.selected.delete(item.id); } draw(sheet); update(); });
      syncAll();
    };
    for (const sheet of source.sheets) {
      const button = tabs.createEl("button", { text: `${sheet.name} (${sheet.items.length})`, attr: { type: "button" } });
      buttons.push([button, sheet.name]); button.addEventListener("click", () => draw(sheet));
    }
    basis.addEventListener("change", () => draw(currentSheet));
    draw(source.sheets[0]); update();
    create.addEventListener("click", async () => {
      if (this.busy) return;
      const selected = allItems.filter(item => this.selected.has(item.id)).map(item => ({ ...item, dueDate: dsScheduleSelectedDate(item, basis.value) }));
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
    containerEl.addClass("snm-plugin-settings");

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
    this.dateTimeNowDocuments?.forEach(dispose => dispose());
    this.dateTimeNowDocuments?.clear();
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
      this.ensureDateTimeNowControls?.(doc);
    }
  }

  async setPopupWidthPercent(value) {
    const previous = this.settings.popupWidthPercent;
    this.settings.popupWidthPercent = normalizePopupWidthPercent(value);
    this.applyPopupLayoutSettings();
    try { await this.savePluginData(); }
    catch (error) { this.settings.popupWidthPercent = previous; this.applyPopupLayoutSettings(); throw error; }
  }

  ensureDateTimeNowControls(doc) {
    this.dateTimeNowDocuments ||= new Map();
    for (const [previous, dispose] of this.dateTimeNowDocuments) {
      if (previous.defaultView?.closed) { dispose(); this.dateTimeNowDocuments.delete(previous); }
    }
    if (!this.dateTimeNowDocuments.has(doc) && doc.body) this.dateTimeNowDocuments.set(doc, installDateTimeNowControls(doc));
  }

  sortTodoTasks(tasks) { return sortTodoTasksBySetting(tasks, this.settings.todoSort); }

  async setTodoSort(value) {
    const previous = this.settings.todoSort;
    this.settings.todoSort = normalizeTodoSort(value);
    try { await this.savePluginData(); }
    catch (error) { this.settings.todoSort = previous; throw error; }
    this.refreshTodoWorkflowViews();
    this.app.workspace.trigger("servicenow-manage:todo-sort-changed");
  }

  renderTodoSortControl(parent) {
    const label = parent.ownerDocument.createElement("label");
    label.className = "snm-todo-sort-control";
    label.append("정렬 ");
    const select = parent.ownerDocument.createElement("select");
    select.setAttribute("aria-label", "To-Do 정렬");
    for (const [key, text] of TODO_SORT_OPTIONS) {
      const option = parent.ownerDocument.createElement("option");
      option.value = key; option.textContent = text; select.append(option);
    }
    select.value = normalizeTodoSort(this.settings.todoSort);
    select.addEventListener("change", async () => {
      select.disabled = true;
      try { await this.setTodoSort(select.value); }
      catch (error) { select.value = normalizeTodoSort(this.settings.todoSort); new Notice(`To-Do 정렬 저장 실패: ${error.message || error}`); }
      finally { select.disabled = false; }
    });
    label.append(select); parent.append(label);
    return select;
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
    this.renderTodoSortControl?.(toolbar);
    toolbar.createEl("button", { text: "상태 설정", attr: { type: "button" } }).addEventListener("click", () => this.openTodoWorkflowSettings());
    const inactiveTasks = tasks.filter(task => !workflow.some(state => state.key === task.status && state.enabled));
    if (inactiveTasks.length) toolbar.createEl("button", { text: `비활성화 상태 보기 · ${inactiveTasks.length}개`, attr: { type: "button" } })
      .addEventListener("click", () => this.openInactiveTodoModal(inactiveTasks));
    for (const [status, label, icon] of definitions) {
      const column = board.createDiv({ cls: `clt-ticket-mini-column is-${status}` });
      const heading = column.createDiv({ cls: "clt-ticket-mini-column-heading" });
      heading.createSpan({ cls: "clt-ticket-mini-status-icon", text: icon });
      heading.createSpan({ text: label });
      const columnTasks = this.sortTodoTasks ? this.sortTodoTasks(tasks.filter(task => task.status === status)) : tasks.filter(task => task.status === status);
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
        let dueDate = item.dueDate || "";
        if (dueDate) {
          const parsed = dsScheduleDate(dueDate).due;
          if (!parsed) throw new Error(`${item.activity}의 완료 예정일을 확인해 주세요.`);
          dueDate = parsed.length === 10 ? `${parsed}T${time.slice(11, 16)}` : parsed;
        }
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
