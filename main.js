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
  return remainder.replace(/^[\s*_`~:.,-]+/, "").trim();
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

  const hasCurrentRuntime = current.includes('const DASHBOARD_RUNTIME_VERSION = "2.10.1";');
  const hasLegacyDeploymentFinish = current.includes('{ key: "deploymentFinish", label: "Deployment Finish"');
  const sharedPluginDeclarations = current.match(/const\s+sharedPlugin\s*=/g) || [];
  if (hasCurrentRuntime && sharedPluginDeclarations.length <= 2 && !hasLegacyDeploymentFinish) return current;
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
            detail.value
          );
          if (typeof this.onSaved === "function") await this.onSaved("");
          new Notice("To-Do를 추가했습니다.");
        } else {
          await this.plugin.addTodoToTicket(
            this.selectedTicketId,
            content.value,
            composeTodoDueValue(dueDate.value, dueTime.value),
            status.value,
            detail.value
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
      await navigator.clipboard.writeText([content.value, detail.value].filter((value) => String(value || "").trim()).join("\n\n"));
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
      await this.migrateDeploymentFinishFields();
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

  async migrateDeploymentFinishFields() {
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.rootTicketIdFromPathStructure(file)) continue;
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        mergeDeploymentFinishField(frontmatter);
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
      filePath: file.path,
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

  async addTodoToGeneral(content, dueDate = "", status = "pending", details = "") {
    const file = await this.ensureGeneralTodoFile();
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
    return { ticketId: "", time, path: file.path };
  }

  async addTodoToTicket(ticketId, content, dueDate = "", status = "pending", details = "") {
    const normalized = normalizeTicketId(ticketId);
    if (!normalized) return this.addTodoToGeneral(content, dueDate, status, details);
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
