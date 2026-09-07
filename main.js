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
