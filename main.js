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
  const current = String(markdown || "");
  const bundled = String(bundledDashboard || "");
  if (!current || !bundled) return current;
  const hasCurrentRuntime = current.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.6";');
  const sharedPluginDeclarations = current.match(/const\s+sharedPlugin\s*=/g) || [];
  if (hasCurrentRuntime && sharedPluginDeclarations.length <= 2) return current;
  const currentStart = current.indexOf("```dataviewjs");
  const currentEnd = current.lastIndexOf("\n```");
  const bundledStart = bundled.indexOf("```dataviewjs");
  const bundledEnd = bundled.lastIndexOf("\n```");
  if (currentStart < 0 || currentEnd < currentStart || bundledStart < 0 || bundledEnd < bundledStart) {
    return current;
  }
  const bundledBlock = bundled.slice(bundledStart, bundledEnd + 4);
  return `${current.slice(0, currentStart)}${bundledBlock}${current.slice(currentEnd + 4)}`;
}

function upgradeDashboardPopupFieldGrid(markdown) {
  let next = String(markdown || "");
  if (!next || next.includes(".opus-popup-field-grid")) return next;
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
  if (!current || !bundled || current.includes("function openTodoCreateModal(")) return current;
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
  if (!current || !bundled || current.includes("showAppliedControls:")) return current;
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
  if (!current || !bundled) return current;
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
  if (!current || !bundled || current.includes('key: "todoSummary"')) return current;
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
  if (!current || !bundled || current.includes('app.plugins.getPlugin("servicenow-manage")')) return current;
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
  if (!current || !bundled) return current;
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
  if (!current || !bundled || current.includes("const TODO_PAGE_SIZE = 10;")) return current;
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
    contentEl.createEl("p", {
      text: "Google Drive 문서 검색을 사용할 때만 등록하세요. Desktop OAuth JSON 파일을 선택하거나 JSON 원문을 붙여넣을 수 있습니다."
    });
    if (ready) {
      const card = contentEl.createDiv({ cls: "snm-setup-dependency-card" });
      card.createEl("strong", { text: `Google OAuth JSON 등록됨 · ${this.plugin.settings.googleClientId}` });
      card.createEl("p", { text: "OAuth JSON이 성공적으로 등록되었습니다. 티켓 생성 시 Google Drive 문서 자동 검색을 사용할 수 있습니다." });
      const actions = card.createDiv({ cls: "snm-setup-inline-actions" });
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
      contentEl.createDiv({ cls: "snm-setup-note", text: "Google 계정 연결은 초기 설정 완료 후 일반 설정에서 진행할 수 있습니다." });
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
    const googleConnection = new Setting(containerEl)
      .setName("Google 계정")
      .setDesc(googleConnected
        ? `${this.plugin.settings.googleAccountEmail || "연결됨"}${this.plugin.settings.googleConnectedAt ? ` · ${this.plugin.settings.googleConnectedAt}` : ""}`
        : "연결되지 않음");
    googleConnection.addButton((button) => button
      .setButtonText(googleConnected ? "다시 연결" : "Google 계정 연결")
      .setCta()
      .setDisabled(!googleCredentialsReady)
      .onClick(() => this.plugin.connectGoogleDrive()));
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

    this.app.workspace.onLayoutReady(async () => {
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
    });
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
      scope: "https://www.googleapis.com/auth/drive.readonly",
      access_type: "offline",
      prompt: "consent select_account",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state
    });
    await shell.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
    new Notice("브라우저에서 Google 계정을 선택하고 Drive 문서 읽기 권한을 승인하세요.", 8000);
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
        new Notice(`Google Drive 연결 완료 · ${this.settings.googleAccountEmail || "계정 확인됨"}`, 8000);
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
    this.settings.googleDriveContentAccess = !token.scope || String(token.scope).includes("/auth/drive.readonly");
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
      result.warnings.push("현재 Google 연결은 이전 권한 방식입니다. 계정을 다시 연결하면 FS·DS·UT를 자동 다운로드할 수 있습니다.");
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
