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
