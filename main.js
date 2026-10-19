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
  const layoutDeclaration = String(bundledDashboard || "").match(/const DASHBOARD_LAYOUT_REVISION\s*=\s*"[^"]+";/)?.[0];
  const hasCurrentRuntime = Boolean(runtimeDeclaration && layoutDeclaration && current.includes(runtimeDeclaration) && current.includes(layoutDeclaration) && current.includes('tableTools.classList.add("opus-table-tools")'));
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

function createMeetingTicketPicker(parent, plugin, selectedTicketIds, { noTicketDefault = false, onChange = () => {} } = {}) {
  const records = new Map();
  for (const file of plugin.rootTicketFiles()) {
    const id = normalizeMeetingTicketIds(plugin.rootTicketIdFromFile(file))[0];
    if (!id) continue;
    const metadata = plugin.app?.metadataCache?.getFileCache(file)?.frontmatter;
    records.set(id, { id, title: String(plugin.data?.tickets?.[id]?.shortDescription || metadata?.short_description || "") });
  }
  for (const id of normalizeMeetingTicketIds([...selectedTicketIds])) if (!records.has(id)) records.set(id, { id, title: "기존 연결 티켓" });
  let ticketless = Boolean(noTicketDefault), disabled = false;
  if (ticketless) selectedTicketIds.clear();
  const heading = parent.createDiv({ cls: "clt-meeting-ticket-picker-heading" });
  heading.createEl("strong", { text: "관련 티켓" });
  const count = heading.createSpan({ attr: { "aria-live": "polite" } });
  const option = parent.createEl("label", { cls: "clt-meeting-no-ticket-choice" });
  const withoutTicket = option.createEl("input", { type: "checkbox", attr: { "aria-label": "티켓 없음 (주간·공통 회의)" } });
  withoutTicket.checked = ticketless;
  option.createSpan({ text: "티켓 없음 (주간·공통 회의)" });
  const search = parent.createEl("input", { cls: "clt-meeting-ticket-search", type: "search", placeholder: "티켓 번호 또는 제목 검색 · 체크하여 여러 개 선택", attr: { "aria-label": "회의록 연결 티켓 검색" } });
  const list = parent.createDiv({ cls: "clt-meeting-ticket-options", attr: { role: "group", "aria-label": "회의록 연결 티켓 검색 결과" } });
  const resultCount = parent.createDiv({ cls: "clt-meeting-ticket-empty" });
  const chips = parent.createDiv({ cls: "clt-meeting-selected-tickets", attr: { role: "group", "aria-label": "선택한 회의록 티켓" } });
  const hint = parent.createDiv({ cls: "clt-meeting-ticket-empty" });
  const getTicketIds = () => ticketless ? [] : [...selectedTicketIds];
  const syncDisabled = () => {
    withoutTicket.disabled = disabled;
    search.disabled = disabled || ticketless;
    list.querySelectorAll("input").forEach(input => { input.disabled = disabled || ticketless; });
    chips.querySelectorAll("button").forEach(button => { button.disabled = disabled; });
  };
  const renderChips = () => {
    chips.empty();
    const ids = getTicketIds();
    count.setText(ticketless ? "티켓 없음으로 고정" : `${ids.length}개 선택`);
    if (ticketless) chips.createSpan({ cls: "clt-meeting-ticket-chip is-ticketless", text: "티켓 없음" });
    for (const id of ids) {
      const chip = chips.createSpan({ cls: "clt-meeting-ticket-chip", attr: { title: records.get(id)?.title || id } });
      chip.createSpan({ text: id });
      chip.createEl("button", { text: "×", attr: { type: "button", "aria-label": `${id} 선택 해제` } }).addEventListener("click", event => {
        event.preventDefault();
        if (disabled || ticketless) return;
        selectedTicketIds.delete(id); render(); onChange(getTicketIds(), { ticketless });
      });
    }
    hint.setText(ticketless ? "티켓 없이 저장합니다. 연결하려면 체크를 해제하고 티켓을 새로 선택하세요. 이전 선택은 복원되지 않습니다."
      : ids.length ? "선택한 모든 티켓의 회의록 목록에 표시됩니다. 라벨의 ×를 눌러 선택을 해제할 수 있습니다."
      : "검색 결과를 체크하면 아래에 선택한 티켓이 표시됩니다. 연결이 필요 없으면 ‘티켓 없음’을 체크하세요.");
    syncDisabled();
  };
  const render = () => {
    list.empty();
    const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = [...records.values()].filter(record => terms.every(term => `${record.id} ${record.title}`.toLowerCase().includes(term))).sort((a, b) => a.id.localeCompare(b.id));
    for (const record of matches.slice(0, 30)) {
      const row = list.createEl("label", { cls: "clt-meeting-ticket-option" });
      const checkbox = row.createEl("input", { type: "checkbox", attr: { "aria-label": `${record.id} 선택` } });
      checkbox.checked = !ticketless && selectedTicketIds.has(record.id);
      const body = row.createSpan({ cls: "clt-meeting-ticket-option-body" });
      body.createEl("strong", { text: record.id });
      if (record.title) body.createSpan({ cls: "clt-meeting-ticket-description", text: record.title });
      checkbox.addEventListener("change", () => {
        if (disabled || ticketless) { checkbox.checked = !ticketless && selectedTicketIds.has(record.id); return; }
        checkbox.checked ? selectedTicketIds.add(record.id) : selectedTicketIds.delete(record.id);
        renderChips(); onChange(getTicketIds(), { ticketless });
      });
    }
    if (!matches.length) list.createDiv({ cls: "clt-meeting-ticket-empty", text: "일치하는 티켓이 없습니다." });
    resultCount.setText(matches.length > 30 ? `검색 결과 ${matches.length}개 · 처음 30개 표시 (검색어를 입력해 좁혀 주세요)` : `검색 결과 ${matches.length}개`);
    renderChips();
  };
  withoutTicket.addEventListener("change", () => {
    if (disabled) { withoutTicket.checked = ticketless; return; }
    ticketless = withoutTicket.checked;
    if (ticketless) { selectedTicketIds.clear(); search.value = ""; }
    render(); onChange(getTicketIds(), { ticketless });
  });
  search.addEventListener("input", render);
  render(); onChange(getTicketIds(), { ticketless });
  return { getTicketIds, setDisabled(value) { disabled = Boolean(value); syncDisabled(); } };
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
    const ticketPicker = createMeetingTicketPicker(picker, this.plugin, this.selectedTicketIds, { noTicketDefault: !this.initialIds.length });
    const status = this.contentEl.createDiv(); status.setAttr("role", "status");
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    actions.createEl("button", { text: "취소" }).addEventListener("click", () => this.close());
    const save = actions.createEl("button", { text: "연결 저장", cls: "mod-cta" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      ticketPicker.setDisabled(true);
      try {
        const result = await this.plugin.updateMeetingTicketLinks(this.file, ticketPicker.getTicketIds(), { expectedTicketIds: this.initialIds });
        this.close();
        if (typeof this.onChanged === "function") {
          try { await this.onChanged(); }
          catch (error) { result.warnings.push(`연결은 저장했지만 목록을 다시 표시하지 못했습니다: ${error.message || error}`); }
        }
        new Notice(`회의록 티켓 연결을 저장했습니다.${result.warnings.length ? `\n${result.warnings.join("\n")}` : ""}`, 7000);
      } catch (error) { status.setText(error.message || String(error)); save.disabled = false; ticketPicker.setDisabled(false); }
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
    const ticketPickerHost = form.createDiv({ cls: "clt-meeting-ticket-picker" });
    let titleEdited = false;
    fileInput.addEventListener("change", () => {
      selected.empty();
      const files = [...(fileInput.files || [])];
      if (!files.length) {
        selected.setText("선택된 파일 없음");
      } else {
        files.forEach((file) => selected.createDiv({ text: `${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB` }));
        const textFile = files.find((file) => /\.(?:md|txt)$/i.test(file.name));
        if (textFile && !titleEdited) titleInput.value = textFile.name.replace(/\.(?:md|txt)$/i, "");
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
    const ticketPicker = createMeetingTicketPicker(ticketPickerHost, this.plugin, this.selectedTicketIds, {
      onChange: ids => { titleInput.placeholder = ids.length === 1 ? `${ids[0]} 회의` : "회의 제목"; }
    });
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    const cancel = actions.createEl("button", { text: "취소" });
    cancel.addEventListener("click", () => this.close());
    const submit = actions.createEl("button", { text: "회의록 만들기", cls: "mod-cta" });
    submit.addEventListener("click", async () => {
      const files = [...(fileInput.files || [])];
      if (!files.length) return new Notice("회의록 Markdown 파일을 선택해 주세요.");
      submit.disabled = true;
      ticketPicker.setDisabled(true);
      submit.setText("회의록 만드는 중…");
      try {
        const selectedTicketIds = ticketPicker.getTicketIds();
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
        ticketPicker.setDisabled(false);
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
  constructor(app, plugin, ticketId, onImported = null) {
    super(app);
    this.plugin = plugin;
    this.ticketId = normalizeTicketId(ticketId);
    this.onImported = onImported;
    this.selectedIds = new Set();
    this.selectedTicketIds = new Set(this.ticketId ? [this.ticketId] : []);
  }

  async onOpen() {
    this.modalEl.addClass("clt-meeting-drive-modal");
    this.titleEl.setText(this.ticketId ? `${this.ticketId} Google Drive 회의록 가져오기` : "Google Drive 회의록 가져오기");
    this.contentEl.createDiv({
      cls: "clt-meeting-import-lead",
      text: "회의록을 고르고 아래에서 관련 티켓을 검색·체크하세요. 자동 검색은 선택 티켓이 1개면 해당 번호의 Gemini 회의록을, 그 외에는 Gemini 회의록 전체를 찾습니다. 주간 보고 등은 파일 제목으로 직접 검색할 수 있습니다."
    });
    const searchBar = this.contentEl.createDiv({ cls: "clt-meeting-drive-search" });
    const searchInput = searchBar.createEl("input", { type: "search", placeholder: "Google Drive 파일 제목 직접 검색" });
    const searchButton = searchBar.createEl("button", { text: "직접 검색" });
    const resetButton = searchBar.createEl("button", { text: "자동 검색" });
    this.searchControls = [searchInput, searchButton, resetButton];
    this.resultsEl = this.contentEl.createDiv({ cls: "clt-meeting-drive-results" });
    const ticketPickerHost = this.contentEl.createDiv({ cls: "clt-meeting-ticket-picker" });
    this.ticketPicker = createMeetingTicketPicker(ticketPickerHost, this.plugin, this.selectedTicketIds);
    this.actionsEl = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    const runSearch = async (query = "") => {
      this.selectedIds.clear();
      this.resultsEl.empty();
      this.actionsEl.empty();
      const linkedIds = this.ticketPicker.getTicketIds();
      const searchTicket = linkedIds.length === 1 ? linkedIds[0] : "";
      const loading = this.resultsEl.createDiv({ cls: "clt-meeting-empty", text: query ? `'${query}' 검색 중…` : "Google Drive에서 회의록을 찾는 중…" });
      searchButton.disabled = true;
      resetButton.disabled = true;
      try {
        const candidates = await this.plugin.searchGoogleDriveMeetingDocuments(searchTicket, query);
        if (!query) this.resultsEl.createDiv({ cls: "clt-meeting-ticket-empty", text: `자동 검색 기준: ${searchTicket || "전체"} · Gemini가 작성한 회의록` });
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
      });
      row.dataset.candidateId = candidate.id;
    }
    const actions = this.actionsEl;
    const cancel = actions.createEl("button", { text: "취소" });
    cancel.addEventListener("click", () => this.close());
    const submit = actions.createEl("button", { text: "선택한 회의록 추가", cls: "mod-cta" });
    submit.addEventListener("click", async () => {
      const selected = candidates.filter((candidate) => this.selectedIds.has(candidate.id));
      if (!selected.length) return new Notice("추가할 회의록을 선택해 주세요.");
      const ticketIds = this.ticketPicker.getTicketIds();
      submit.disabled = true;
      this.ticketPicker.setDisabled(true);
      this.searchControls.forEach(control => { control.disabled = true; });
      submit.setText("회의록 가져오는 중…");
      try {
        let importedCount = 0;
        const warnings = [];
        for (const candidate of selected) {
          const result = await this.plugin.importGoogleDriveMeeting(ticketIds, candidate);
          if (result?.note) importedCount += 1;
          warnings.push(...(result?.warnings || []));
        }
        if (typeof this.onImported === "function") await this.onImported();
        this.close();
        new Notice(`${ticketIds.length ? `티켓 ${ticketIds.length}개에` : "주간·공통 회의로"} 회의록 ${importedCount}건을 추가했습니다.${warnings.length ? `\n${warnings.join("\n")}` : ""}`, 9000);
      } catch (error) {
        new Notice(`회의록 가져오기 실패: ${error.message || error}`, 9000);
        submit.disabled = false;
        this.ticketPicker.setDisabled(false);
        this.searchControls.forEach(control => { control.disabled = false; });
        submit.setText("선택한 회의록 추가");
      }
    });
  }

  onClose() {
    this.modalEl.removeClass("clt-meeting-drive-modal");
    this.contentEl.empty();
  }
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
    this.footerEl?.remove();
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

    const actions = this.modalEl.createDiv({ cls: "clt-sn-document-actions clt-todo-detail-actions" });
    this.footerEl = actions;
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
    this.footerEl?.remove();
    this.footerEl = null;
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
      const actions = card.createDiv({ cls: "clt-meeting-card-actions" });
      if (meeting.kind !== "analysis") actions.createEl("button", { cls: "clt-meeting-card-link-edit", text: "티켓 연결", attr: { type: "button" } }).addEventListener("click", event => {
        event.preventDefault(); event.stopPropagation();
        this.openMeetingTicketLinksModal(meeting.file, () => { container.dispatchEvent(new CustomEvent("clt-meeting-links-changed", { bubbles: true })); });
      });
      const remove = actions.createEl("button", {
        cls: "clt-meeting-card-delete",
        text: "삭제",
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
    new DriveMeetingCandidateModal(this.app, this, "", onImported).open();
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
