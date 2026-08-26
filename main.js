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

  const hasCurrentRuntime = current.includes('const DASHBOARD_RUNTIME_VERSION = "2.9.0";');
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
    `deployment_finish:\n` +
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
  constructor(app, title, message, onConfirm, confirmText = "확인하고 이동") {
    super(app);
    this.modalTitle = title;
    this.message = message;
    this.onConfirm = onConfirm;
    this.confirmText = confirmText;
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
      "estimated_qa_completion_date", "target_qa_completion_date", "actual_release_date",
      "deployment_finish", "배포일", "ui_interface_id", "BS-한글"
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
      actual_release_date: metadata.actualReleaseDate,
      deployment_finish: metadata.deploymentFinish,
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
