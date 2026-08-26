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

  const hasCurrentRuntime = current.includes('const DASHBOARD_RUNTIME_VERSION = "2.7.0";');
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
      "estimated_qa_completion_date", "target_qa_completion_date", "actual_release_date", "배포일", "BS-한글"
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
      target_qa_completion_date: metadata.targetQaCompletionDate,
      actual_release_date: metadata.actualReleaseDate
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
