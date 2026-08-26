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
const zlib = require("zlib");
const { shell } = require("electron");

function formatMarkdownListEntry(prefix, content) {
  const lines = String(content || "").trim().split(/\r?\n/);
  const first = lines.shift() || "";
  return [`${prefix}${first}`, ...lines.map((line) => `    ${line}`)].join("\n");
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
      current = { raw: topLevel[1].trim(), index: entries.length };
    } else if (current && line.trim()) {
      current.raw += `\n${line.replace(/^\s{1,4}/, "")}`;
    }
  }
  if (current) entries.push(current);
  return entries.map((entry) => {
    const dateTime = entry.raw.match(/\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?/)?.[0] || "";
    const contentMarkdown = entry.raw
      .replace(dateTime, "")
      .replace(/^[\s*_`~:.,-]+/, "")
      .trim();
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
      "u_est_qa_completion_date",
      "u_estimated_qa_date",
      "u_estimated_qa_end_date"
    ]),
    targetQaCompletionDate: serviceNowField(record, [
      "u_target_qa_completion_date",
      "target_qa_completion_date",
      "u_target_qa_completion",
      "target_qa_completion",
      "u_tgt_qa_completion_date",
      "u_target_qa_date",
      "u_target_qa_end_date"
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

function upgradeDashboardRuntime(markdown, bundledDashboard) {
  let current = String(markdown || "").replace(/^\uFEFF/, "");
  const bundled = String(bundledDashboard || "").replace(/^\uFEFF/, "");
  if (!current || !bundled) return current;

  // Clean any duplicate frontmatters before dataviewjs
  current = current.replace(/^(---[\s\S]*?---)[\s\r\n\uFEFF]*---[\s\S]*?---[\s\r\n\uFEFF]*(```dataviewjs)/, "$1\n\n$2");

  const hasCurrentRuntime = current.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.7";');
  const sharedPluginDeclarations = current.match(/const\s+sharedPlugin\s*=/g) || [];
  if (hasCurrentRuntime && sharedPluginDeclarations.length <= 2) return current;
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
  if (!next || next.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.7";') || next.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.6";') || next.includes(".opus-popup-field-grid")) return next;
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
      "- 완료 전 결과 PDF의 모든 페이지를 렌더링해 육안 검수하고 원본과 페이지 단위로 비교하여 누락된 표·이미지·요구사항, 잘림, 겹침, 깨진 한글이 없는지 확인하세요."
    );
  }
  return `${next}\n${instructions.join("\n")}`.trim();
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
  constructor(app, title, message, onConfirm) {
    super(app);
    this.modalTitle = title;
    this.message = message;
    this.onConfirm = onConfirm;
  }
  onOpen() {
    this.contentEl.empty();
    this.titleEl.setText(this.modalTitle);
    this.contentEl.createEl("p", { text: this.message });
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    const cancel = actions.createEl("button", { text: "취소" });
    cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { text: "확인하고 이동", cls: "mod-cta" });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        await this.onConfirm();
        this.close();
      } catch (error) {
        new Notice(`이동 실패: ${error.message || error}`, 9000);
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

class TodoEntryModal extends Modal {
  constructor(app, plugin, preselectedTicketId = "", onSaved = null, preselectedStatus = "pending") {
    super(app);
    this.plugin = plugin;
    this.preselectedTicketId = normalizeTicketId(preselectedTicketId);
    this.onSaved = onSaved;
    this.preselectedStatus = ["pending", "in-progress", "done"].includes(preselectedStatus)
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
    ticketSection.createDiv({ cls: "clt-todo-field-label", text: "티켓 · 필수" });
    const search = ticketSection.createEl("input", {
      type: "search",
      cls: "clt-todo-ticket-search",
      placeholder: "티켓 번호 또는 제목 검색 · 예: 12"
    });
    if (this.selectedTicketId) search.value = this.selectedTicketId;
    const resultInfo = ticketSection.createDiv({ cls: "clt-todo-ticket-result-info" });
    const results = ticketSection.createDiv({ cls: "clt-todo-ticket-results" });

    const renderTickets = () => {
      const query = search.value.trim().toLowerCase();
      const filtered = tickets.filter((item) =>
        !query || [item.ticketId, item.title, item.status]
          .some((value) => String(value || "").toLowerCase().includes(query))
      );
      if (filtered.length === 1) this.selectedTicketId = filtered[0].ticketId;
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
      ["done", "✓ 완료"]
    ].forEach(([value, label]) => {
      const option = status.createEl("option", { value, text: label });
      option.value = value;
      option.selected = value === this.preselectedStatus;
    });

    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    const cancel = actions.createEl("button", { text: "취소" });
    cancel.addEventListener("click", () => this.close());
    const add = actions.createEl("button", { text: "To-Do 추가", cls: "mod-cta" });
    const submit = async () => {
      if (!this.selectedTicketId) {
        search.focus();
        return new Notice("티켓을 선택해 주세요.");
      }
      if (!content.value.trim()) {
        content.focus();
        return new Notice("할 일을 입력해 주세요.");
      }
      add.disabled = true;
      add.setText("추가 중…");
      try {
        await this.plugin.addTodoToTicket(
          this.selectedTicketId,
          content.value,
          composeTodoDueValue(dueDate.value, dueTime.value),
          status.value,
          detail.value
        );
        if (typeof this.onSaved === "function") await this.onSaved(this.selectedTicketId);
        new Notice(`${this.selectedTicketId}에 To-Do를 추가했습니다.`);
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

function stripCltTodoMetadata(value) {
  return String(value || "")
    .replace(/\s*<!--\s*clt-todo:(?:pending|in-progress|done)\s*-->\s*/gi, " ")
    .replace(/\s*<!--\s*clt-todo-due:\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?\s*-->\s*/gi, " ")
    .replace(/\s*<!--\s*clt-todo-completed:[^>]+?\s*-->\s*/gi, " ")
    .replace(/\s*<!--\s*clt-todo-detail:[^>]*?\s*-->\s*/gi, " ")
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
    copy.createEl("strong", { text: `${this.ticketId}의 To-Do를 삭제하시겠습니까?` });
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
    const title = this.titleEl.createSpan({ cls: "clt-todo-modal-title" });
    title.createSpan({ cls: "clt-todo-modal-icon", text: "✓" });
    title.createSpan({ text: `${this.task.ticketId} To-Do` });

    const layout = this.contentEl.createDiv({ cls: "clt-todo-detail-layout" });
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
    const row = form.createDiv({ cls: "clt-todo-entry-row" });
    const statusLabel = row.createEl("label", { cls: "clt-todo-entry-field" });
    statusLabel.createSpan({ cls: "clt-todo-field-label", text: "상태" });
    const status = statusLabel.createEl("select");
    [["pending", "진행 전"], ["in-progress", "진행 중"], ["done", "완료"]]
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
        ticketId: this.task.ticketId,
        title: this.task.text || "",
        onConfirm: async () => {
          await this.plugin.deleteTodoTask(this.task);
          if (typeof this.onSaved === "function") await this.onSaved({ ...this.task, deleted: true });
          new Notice(`${this.task.ticketId} To-Do를 삭제했습니다.`);
          this.close();
        }
      }).open();
    });
    const copy = actions.createEl("button", { text: "내용 복사" });
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText([content.value, detail.value].filter((value) => String(value || "").trim()).join("\n\n"));
      new Notice("To-Do 내용을 복사했습니다.");
    });
    const open = actions.createEl("button", { text: "원본 티켓 열기" });
    open.addEventListener("click", async () => {
      const file = this.plugin.rootTicketFile(this.task.ticketId);
      if (!file) return;
      this.close();
      await this.app.workspace.getLeaf(false).openFile(file);
    });
    const save = actions.createEl("button", { text: "저장", cls: "mod-cta" });
    save.addEventListener("click", async () => {
      if (!content.value.trim()) return new Notice("할 일을 입력해 주세요.");
      save.disabled = true;
      try {
        this.task = await this.plugin.updateTodoTaskDetails(this.task, {
          text: content.value,
          details: detail.value,
          dueDate: composeTodoDueValue(dueDate.value, dueTime.value),
          status: status.value
        });
        if (typeof this.onSaved === "function") await this.onSaved(this.task);
        new Notice(`${this.task.ticketId} To-Do를 저장했습니다.`);
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
    language.addEventListener("change", () => { this.state.language = language.value; this.render(); });

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
  }
  onunload() {
    this.plugin.unregisterView(this.ticketId, this);
  }
  render() {
    this.containerEl.empty();
    this.plugin.renderTicketStatusControl(this.containerEl, this.ticketId);
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
    const quickApply = contentEl.createEl("button", {
      cls: this.plugin.isReadingViewDefault() ? "" : "mod-cta",
      text: this.plugin.isReadingViewDefault() ? "현재 읽기 화면으로 설정됨" : "지금 읽기 화면을 기본값으로 적용"
    });
    quickApply.addEventListener("click", async () => {
      try {
        await this.plugin.setReadingViewDefault(true, { notify: false });
        this.readingViewDefaultValue = true;
        this.statusMessage = "새 탭 기본 화면을 읽기 화면으로 설정했습니다.";
      } catch (error) {
        this.statusMessage = `화면 설정 실패: ${error.message || error}`;
      }
      this.render();
    });
    contentEl.createDiv({
      cls: "snm-setup-note",
      text: "이미 열려 있는 탭의 화면은 바뀌지 않습니다. 설정 후 새 탭을 열거나 기존 탭을 다시 열어 확인해 주세요."
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
    if (this.step === 1) return this.plugin.setReadingViewDefault(this.readingViewDefaultValue, { notify: false });
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
      .setDesc(`Obsidian이 열려 있을 때 ${this.plugin.settings.rootFolder}/티켓의 상태를 지정 시간 이후 하루 한 번 갱신합니다.`)
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
      .setDesc("Obsidian이 열려 있을 때 등록된 티켓의 워킹노트를 자동 갱신합니다.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoSync)
        .onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("워킹노트 매 정각 갱신")
      .setDesc("워킹노트 자동 갱신이 켜진 경우 매 정각에 순차적으로 갱신합니다.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.syncAtTopOfHour)
        .onChange(async (value) => {
          this.plugin.settings.syncAtTopOfHour = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("실행 시 누락분 갱신")
      .setDesc("마지막 성공 이후 날짜가 바뀌었으면 Obsidian 실행 후 한 번 갱신합니다.")
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
      .setDesc("업무현황.md의 코드를 플러그인 최신 런타임(v2.6.7: 필드 순서 버튼 및 컬럼 너비 리사이즈 지원)으로 갱신합니다.")
      .addButton((button) => button
        .setButtonText("대시보드 템플릿 갱신")
        .onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("갱신 중…");
          try {
            const updated = await this.plugin.forceUpgradeDashboard();
            if (updated) {
              new Notice("업무현황 대시보드를 최신 버전(v2.6.7)으로 갱신했습니다.", 6000);
            } else {
              new Notice("업무현황 대시보드가 이미 최신 버전(v2.6.7)입니다.", 5000);
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
    this.registerMarkdownCodeBlockProcessor("clt-ticket-todo-actions", (source, el, ctx) => {
      const configured = source.match(/^ticket:\s*(\S+)\s*$/m)?.[1];
      const ticketId = normalizeTicketId(configured || this.ticketIdFromPath(ctx.sourcePath));
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!ticketId || !(file instanceof TFile)) return;
      this.renderTicketSectionAction(el, file, ticketId, "todo");
    });
    this.registerMarkdownPostProcessor(async (el, ctx) => {
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
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
      name: "업무현황 대시보드를 최신 버전(v2.6.7)으로 갱신",
      callback: async () => {
        try {
          const updated = await this.forceUpgradeDashboard();
          if (updated) {
            new Notice("업무현황 대시보드를 최신 버전(v2.6.7)으로 갱신했습니다.", 6000);
          } else {
            new Notice("업무현황 대시보드가 이미 최신 버전(v2.6.7)입니다.", 5000);
          }
        } catch (error) {
          new Notice(`업무현황 갱신 실패: ${error.message || error}`, 8000);
        }
      }
    });

    const initLayout = async () => {
      await this.ensureWorkspaceScaffold();
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
      "estimated_qa_completion_date", "target_qa_completion_date", "BS-한글"
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
      next = next.replace(/(^##[^\r\n]*To-Do[^\r\n]*\r?\n(?:\r?\n)*)(?:- \[ \][ \t]*(?:\r?\n|$))/mi, "$1");
      next = ensureSectionActionBlock(next, "{{ticketId}}", "📝 작업 일지", "clt-ticket-worklog-actions");
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
      card.createDiv({ cls: "clt-ticket-worklog-time", text: entry.dateTime || "날짜 없음" });
      const body = card.createDiv({ cls: "clt-ticket-worklog-body markdown-rendered" });
      if (entry.contentMarkdown) void this.renderMarkdownInto(body, entry.contentMarkdown, sourcePath);
      else body.createSpan({ cls: "clt-ticket-worklog-empty", text: "내용 없음" });
    }
    sourceList.parentElement?.insertBefore(container, sourceList);
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
      const inProgress = /<!--\s*clt-todo:in-progress\s*-->/i.test(rawContent);
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
        text,
        rawContent,
        status: done ? "done" : inProgress ? "in-progress" : "pending"
      });
      taskIndex += 1;
    }
    return tasks;
  }

  async updateTodoTaskDetails(task, changes = {}) {
    const normalized = normalizeTicketId(task?.ticketId);
    const file = this.rootTicketFile(normalized);
    if (!(file instanceof TFile)) throw new Error(`${normalized} 티켓 노트를 찾을 수 없습니다.`);
    const cleanText = stripCltTodoMetadata(
      String(changes.text ?? task.text ?? "").replace(/\r?\n+/g, " ")
    );
    if (!cleanText) throw new Error("할 일을 입력해 주세요.");
    const status = ["pending", "in-progress", "done"].includes(changes.status)
      ? changes.status
      : task.status;
    const dueDate = String(changes.dueDate ?? task.dueDate ?? "").trim();
    const details = String(changes.details ?? task.details ?? "").trim();
    const completedAt = status === "done"
      ? (task.completedAt || localIsoDateTime().slice(0, 16))
      : "";
    const dateTime = task.dateTime || localIsoDateTime().slice(0, 16);
    const checkbox = status === "done" ? "x" : " ";
    const statusMarker = status === "in-progress" ? " <!-- clt-todo:in-progress -->" : "";
    const dueMarker = dueDate ? ` <!-- clt-todo-due:${dueDate} -->` : "";
    const completedMarker = completedAt ? ` <!-- clt-todo-completed:${completedAt} -->` : "";
    const detailMarker = details ? ` <!-- clt-todo-detail:${encodeTodoDetail(details)} -->` : "";
    const replacement = `- [${checkbox}] ${dateTime} : ${cleanText}${statusMarker}${dueMarker}${completedMarker}${detailMarker}`;
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
      text: cleanText,
      status,
      dueDate,
      details,
      completedAt,
      dateTime,
      rawContent: replacement.replace(/^\s*-\s*\[[ xX]\]\s*/, "")
    };
  }

  async deleteTodoTask(task) {
    const normalized = normalizeTicketId(task?.ticketId);
    const file = this.rootTicketFile(normalized);
    if (!(file instanceof TFile)) throw new Error(`${normalized} 티켓 노트를 찾을 수 없습니다.`);
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
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter["마지막확인"] = today;
    });
    return today;
  }

  async addTodoToTicket(ticketId, content, dueDate = "", status = "pending", details = "") {
    const normalized = normalizeTicketId(ticketId);
    const file = this.rootTicketFile(normalized);
    if (!(file instanceof TFile)) throw new Error(`${normalized} 티켓 노트를 찾을 수 없습니다.`);
    const cleanContent = stripCltTodoMetadata(String(content || "").replace(/\r?\n+/g, " "));
    if (!cleanContent) throw new Error("할 일을 입력해 주세요.");
    const safeStatus = ["pending", "in-progress", "done"].includes(status) ? status : "pending";
    const time = localIsoDateTime().slice(0, 16);
    const checkbox = safeStatus === "done" ? "x" : " ";
    const statusMarker = safeStatus === "in-progress" ? " <!-- clt-todo:in-progress -->" : "";
    const dueMarker = dueDate ? ` <!-- clt-todo-due:${dueDate} -->` : "";
    const completedMarker = safeStatus === "done" ? ` <!-- clt-todo-completed:${time} -->` : "";
    const detailMarker = String(details || "").trim() ? ` <!-- clt-todo-detail:${encodeTodoDetail(details)} -->` : "";
    await this.app.vault.process(file, (markdown) => appendEntryToMarkdownSection(
      markdown,
      "✅ To-Do",
      `- [${checkbox}] ${time} : ${cleanContent}${statusMarker}${dueMarker}${completedMarker}${detailMarker}`
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
          const clean = stripCltTodoMetadata(raw);
          const statusMarker = task[2].toLowerCase() !== "x" && inProgress ? " <!-- clt-todo:in-progress -->" : "";
          const dueMarker = dueDate ? ` <!-- clt-todo-due:${dueDate} -->` : "";
          const completedMarker = task[2].toLowerCase() === "x" && completedAt
            ? ` <!-- clt-todo-completed:${completedAt} -->`
            : "";
          lines[index] = `${task[1]}${task[2]}${task[3]}${clean}${statusMarker}${dueMarker}${completedMarker}`;
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
    const aiPrompt = controls.createEl("button", { text: "AI 프롬프트 생성" });
    aiPrompt.hidden = !this.organizationFeatureEnabled("aiPrompt");
    const aiPromptDetails = el.createEl("details", { cls: "clt-ai-prompt-details" });
    aiPromptDetails.hidden = true;
    aiPromptDetails.createEl("summary", { text: "AI 프롬프트 펼치기" });
    const aiPromptToolbar = aiPromptDetails.createDiv({ cls: "clt-ai-prompt-toolbar" });
    const copyPrompt = aiPromptToolbar.createEl("button", { text: "프롬프트 복사" });
    const aiPromptContent = aiPromptDetails.createEl("pre", { cls: "clt-ai-prompt-content" });
    let currentPrompt = "";
    copyPrompt.addEventListener("click", async (event) => {
      event.preventDefault();
      if (!currentPrompt) return;
      try {
        await navigator.clipboard.writeText(currentPrompt);
        new Notice(`${ticketId} AI 프롬프트를 클립보드에 복사했습니다.`, 5000);
      } catch (error) {
        new Notice(`AI 프롬프트 복사 실패: ${error.message || error}`, 8000);
      }
    });
    aiPrompt.addEventListener("click", async () => {
      aiPrompt.disabled = true;
      aiPrompt.setText("프롬프트 생성 중…");
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
        console.error(`[ServiceNow Manage] ${ticketId} AI 프롬프트 생성 실패`, error);
        new Notice(`AI 프롬프트 생성 실패: ${error.message || error}`, 10000);
      } finally {
        aiPrompt.disabled = false;
        aiPrompt.setText("AI 프롬프트 생성");
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

    let documentSync = { local: {}, downloaded: [], warnings: [], renamedBs: "" };
    try {
      documentSync = await this.downloadTicketCltDocuments(normalized, fm);
    } catch (error) {
      console.warn(`[ServiceNow Manage] ${normalized} AI 프롬프트용 문서 확인 실패`, error);
      messages.push(`관련 문서 확인에 실패했지만 나머지 정보로 프롬프트를 생성했습니다: ${error.message || error}`);
    }

    let savedImages = 0;
    try {
      savedImages = await this.persistTicketAttachmentImages(normalized, ticket);
    } catch (error) {
      console.warn(`[ServiceNow Manage] ${normalized} AI 프롬프트용 이미지 저장 실패`, error);
      messages.push(`ServiceNow 이미지 저장에 실패했지만 나머지 정보로 프롬프트를 생성했습니다: ${error.message || error}`);
    }
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
    const availableTypes = Object.entries(documentValues)
      .filter(([, value]) => value.link || value.local)
      .map(([type]) => type);
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
      if (documentValues[type].local) documentLines.push(`- ${type} 로컬 파일: ${documentValues[type].local}`);
      else documentLines.push(`- ${type} 파일: 로컬 파일 없음 · 채팅 첨부 파일을 사용하고, 첨부되지 않았다면 요청 필요`);
    }
    if (documentSync.local.BS_KO) documentLines.push(`- BS-한글 번역본: ${documentSync.local.BS_KO}`);
    if (!availableTypes.length) documentLines.push("- 분석 문서: 없음");
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
    const response = await requestUrl({
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
          await requestUrl({
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
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const pack = await this.applyOrganizationPack(JSON.parse(await file.text()));
        const templateResult = this.lastOrganizationPackApplyResult || {};
        new Notice(`업무가이드팩을 등록했습니다: ${pack.name}${templateResult.updated ? ` · 기본 템플릿 갱신 ${templateResult.updated}개` : ""}${templateResult.preserved ? ` · 사용자 수정 템플릿 보존 ${templateResult.preserved}개` : ""}`, 8000);
        onDone?.();
      } catch (error) {
        new Notice(`업무가이드팩 등록 실패: ${error.message || error}`, 10000);
      }
    }, { once: true });
    input.click();
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
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        await this.applyGoogleOAuthJson(JSON.parse(await file.text()));
        new Notice("Google Desktop OAuth JSON을 등록했습니다. 이제 Google 계정을 연결할 수 있습니다.", 8000);
        onDone?.();
      } catch (error) {
        new Notice(`Google OAuth JSON 등록 실패: ${error.message || error}`, 10000);
      }
    }, { once: true });
    input.click();
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
    return this.app.vault.getFiles().find((file) =>
      file.path.startsWith(folder)
        && file.basename.toUpperCase().startsWith(prefix.toUpperCase())
        && /BS[-_\s]*한글/i.test(file.basename)
    )?.path || "";
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
      const current = String(frontmatter["BS-한글"] || "").trim();
      if (!current || current === link) frontmatter["BS-한글"] = link;
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
      if (String(downloadError.message || "").includes("403")) {
        throw new Error("파일 다운로드 권한 부족 (Google 권한 동의 체크박스 또는 공유 드라이브 접근 확인 필요)");
      }
      throw downloadError;
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
    const result = { downloaded: [], warnings: bs.warning ? [bs.warning] : [], local, renamedBs: bs.renamed, linkedBs: null };
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
        result.warnings.push(`${type} 다운로드 실패: ${error.message || error}`);
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
    const response = await requestUrl({
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

  async attachmentImageDataUrl(entry) {
    const attachmentId = String(entry?.attachmentId || "").trim();
    if (!attachmentId) throw new Error("첨부파일 ID가 없습니다.");
    if (Number(entry.sizeBytes || 0) > 15 * 1024 * 1024) throw new Error("15MB를 초과해 미리보기를 생략했습니다.");
    if (this.attachmentImageCache.has(attachmentId)) return this.attachmentImageCache.get(attachmentId);
    const loading = (async () => {
      const token = await this.validAccessToken();
      const response = await requestUrl({
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
    const response = await requestUrl({
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
      target_qa_completion_date: metadata.targetQaCompletionDate
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
        if (!content || ticket.translations[field]?.[target]) continue;
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
          if (entry.type === "Attachment" || entry.translations?.[target] || !entry.content) continue;
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
      const result = await this.syncAllTicketStatuses();
      this.settings.lastStatusSyncDate = today;
      await this.savePluginData();
      new Notice(`일일 ServiceNow 상태 갱신 완료 · 변경 ${result.changed}건${result.failed ? ` · 실패 ${result.failed}건` : ""}`, 8000);
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
  parseWorkNotes,
  protectUrls,
  restoreUrls,
  serviceNowField,
  tableForTicket,
  utcServiceNowToKst
};
