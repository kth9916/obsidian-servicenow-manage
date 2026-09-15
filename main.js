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

function buildMeetingNoteMarkdown({ ticketId, sourceName, sourceText, meetingDate, title, pdfPath = "", sourceDriveId = "" }) {
  const normalized = normalizeTicketId(ticketId);
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
  return `---\n` +
    `ticket: "${normalized}"\n` +
    `Parent: "[[${normalized}]]"\n` +
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
    `> | 티켓 | [[${normalized}|${normalized}]] |\n` +
    `> | 참석자 | ${participantLine || "확인 필요"} |\n` +
    `> | 원본 | ${sourceLink} |\n` +
    `${calendarLine ? `> | 일정 | ${calendarLine} |\n` : ""}` +
    `${recordLine ? `> | 기록 | ${recordLine} |\n` : ""}` +
    `\n${sections.join("\n\n")}\n`;
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

class MeetingImportModal extends Modal {
  constructor(app, plugin, ticketId, onImported = null) {
    super(app);
    this.plugin = plugin;
    this.ticketId = normalizeTicketId(ticketId);
    this.onImported = onImported;
  }
  onOpen() {
    this.modalEl.addClass("clt-meeting-import-modal");
    this.contentEl.empty();
    this.titleEl.setText(`${this.ticketId} 새 회의록 추가`);
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
    fileLabel.createStrong({ text: "회의록 파일 선택" });
    fileLabel.createSpan({ text: ".md 또는 .txt 1개 + 선택 PDF 1개" });
    const fileInput = fileLabel.createEl("input", { type: "file" });
    fileInput.accept = ".md,.txt,.pdf,text/markdown,text/plain,application/pdf";
    fileInput.multiple = true;
    const selected = form.createDiv({ cls: "clt-meeting-selected-files", text: "선택된 파일 없음" });
    fileInput.addEventListener("change", () => {
      selected.empty();
      const files = [...(fileInput.files || [])];
      if (!files.length) selected.setText("선택된 파일 없음");
      else files.forEach((file) => selected.createDiv({ text: `${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB` }));
    });
    const grid = form.createDiv({ cls: "clt-meeting-import-grid" });
    const titleLabel = grid.createEl("label");
    titleLabel.createSpan({ text: "회의 제목 (선택)" });
    const titleInput = titleLabel.createEl("input", { type: "text", placeholder: `${this.ticketId} 회의` });
    const dateLabel = grid.createEl("label");
    dateLabel.createSpan({ text: "회의 일시 (선택)" });
    const dateInput = dateLabel.createEl("input", { type: "datetime-local" });
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
        const note = await this.plugin.importMeetingFiles(this.ticketId, files, {
          title: titleInput.value.trim(), meetingDate: dateInput.value
        });
        this.close();
        if (typeof this.onImported === "function") await this.onImported(note);
        await this.app.workspace.getLeaf(false).openFile(note);
        new Notice(`${this.ticketId} 회의록을 만들었습니다.`);
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
  constructor(app, plugin, ticketId, onImported = null) {
    super(app);
    this.plugin = plugin;
    this.ticketId = normalizeTicketId(ticketId);
    this.onImported = onImported;
    this.selectedIds = new Set();
  }

  async onOpen() {
    this.modalEl.addClass("clt-meeting-drive-modal");
    this.titleEl.setText(`${this.ticketId} Google Drive 회의록 가져오기`);
    this.contentEl.createDiv({
      cls: "clt-meeting-import-lead",
      text: `파일명에 '${this.ticketId}'와 'Gemini가 작성한 회의록'이 모두 포함된 Google Docs만 검색합니다.`
    });
    const loading = this.contentEl.createDiv({ cls: "clt-meeting-empty", text: "Google Drive에서 회의록을 찾는 중…" });
    try {
      const candidates = await this.plugin.searchGoogleDriveMeetingDocuments(this.ticketId);
      this.renderCandidates(candidates);
      loading.remove();
    } catch (error) {
      console.error(`[ServiceNow Manage] ${this.ticketId} Drive 회의록 후보 표시 실패`, error);
      loading.setText(`회의록 검색 실패: ${error.message || error}`);
    }
  }

  renderCandidates(candidates) {
    const imported = new Set(this.plugin.listTicketMeetings(this.ticketId).map((meeting) => meeting.sourceDriveId).filter(Boolean));
    const list = this.contentEl.createDiv({ cls: "clt-meeting-drive-candidates" });
    if (!candidates.length) {
      list.createDiv({ cls: "clt-meeting-empty", text: "조건에 맞는 Gemini 회의록을 찾지 못했습니다." });
    }
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
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
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
          const result = await this.plugin.importGoogleDriveMeeting(this.ticketId, candidate);
          if (result?.note) importedCount += 1;
          warnings.push(...(result?.warnings || []));
        }
        if (typeof this.onImported === "function") await this.onImported();
        this.close();
        new Notice(`${this.ticketId} 회의록 ${importedCount}건을 추가했습니다.${warnings.length ? `\n${warnings.join("\n")}` : ""}`, 9000);
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
        for (const item of selected) {
          const details = item.owner ? `회의 Action Item · 담당: ${item.owner}` : "회의 Action Item";
          await this.plugin.addTodoToTicket(this.ticketId, item.title, item.dueDate || today, "pending", details);
        }
        new Notice(`${this.ticketId}에 진행 전 To-Do ${selected.length}건을 만들었습니다.`);
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
  }
  async onOpen() {
    this.modalEl.addClass("clt-meeting-list-modal");
    this.titleEl.setText(`${this.ticketId} 회의록`);
    const refreshIfRelevant = (file, oldPath = "") => {
      const folder = `${this.plugin.ticketMeetingsFolder(this.ticketId)}/`;
      if (!String(file?.path || "").startsWith(folder) && !String(oldPath || "").startsWith(folder)) return;
      window.setTimeout(() => this.render(), 120);
    };
    this.registerEvent(this.app.vault.on("create", refreshIfRelevant));
    this.registerEvent(this.app.vault.on("delete", refreshIfRelevant));
    this.registerEvent(this.app.vault.on("rename", refreshIfRelevant));
    this.registerEvent(this.app.vault.on("modify", refreshIfRelevant));
    this.registerEvent(this.app.metadataCache.on("changed", refreshIfRelevant));
    await this.render();
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
    const drive = actions.createEl("button", { text: "Drive에서 가져오기" });
    drive.addEventListener("click", () => new DriveMeetingCandidateModal(this.app, this.plugin, this.ticketId, () => this.render()).open());
    const refresh = actions.createEl("button", { text: "새로고침", attr: { title: "회의록 목록 새로고침" } });
    refresh.addEventListener("click", () => this.render());
    const add = actions.createEl("button", { text: "＋ 파일로 추가", cls: "mod-cta" });
    add.addEventListener("click", () => new MeetingImportModal(this.app, this.plugin, this.ticketId, () => this.render()).open());
    const list = this.contentEl.createDiv({ cls: "clt-meeting-list" });
    const meetings = this.plugin.listTicketMeetings(this.ticketId, this.sortDirection);
    count.setText(`${meetings.length}개의 회의 기록`);
    list.dataset.sortDirection = this.sortDirection;
    list.addEventListener("clt-meeting-deleted", () => this.render());
    this.plugin.renderMeetingCards(list, meetings, { emptyText: "아직 등록된 회의록이 없습니다." });
  }
  onClose() {
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
    const refreshIfRelevant = (file, oldPath = "") => {
      const folder = `${this.plugin.ticketMeetingsFolder(this.ticketId)}/`;
      if (!String(file?.path || "").startsWith(folder) && !String(oldPath || "").startsWith(folder)) return;
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
    this.registerMarkdownPostProcessor(async (el, ctx) => {
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      const frontmatter = file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter || {} : {};
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
    if (this.ticketNoticeTimer) window.clearTimeout(this.ticketNoticeTimer);
    this.viewRefreshTimers?.forEach((timer) => window.clearTimeout(timer));
    this.viewRefreshTimers?.clear();
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

  scheduleViewRefresh(ticketId, kind) {
    const normalized = normalizeTicketId(ticketId);
    if (!normalized) return;
    const key = `${kind}:${normalized}`;
    const previousTimer = this.viewRefreshTimers.get(key);
    if (previousTimer) window.clearTimeout(previousTimer);
    const timer = window.setTimeout(() => {
      this.viewRefreshTimers.delete(key);
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
      const ticketId = normalizeTicketId(frontmatter.ticket || this.ticketIdFromPath(file.path));
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

  listTicketMeetings(ticketId, sortDirection = "desc") {
    const folder = `${this.ticketMeetingsFolder(ticketId)}/`;
    const meetings = this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(folder))
      .map((file) => {
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
        const meetingDate = String(frontmatter.meeting_date || "");
        return {
          ticketId: normalizeTicketId(ticketId),
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
      meta.createSpan({ text: "열기 ›" });
      open.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await this.app.workspace.getLeaf(false).openFile(meeting.file);
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
    refresh();
  }

  openMeetingImportModal(ticketId, onImported = null) {
    new MeetingImportModal(this.app, this, ticketId, onImported).open();
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
    const withContent = await Promise.all(inputMeetings.map(async (meeting) => ({
      ...meeting,
      content: meeting.file instanceof TFile ? await this.app.vault.cachedRead(meeting.file) : ""
    })));
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
    const folder = `${this.ticketMeetingsFolder(meeting.ticketId)}/`;
    if (!meeting.file.path.startsWith(folder)) throw new Error("티켓 회의록 폴더 밖의 파일은 삭제할 수 없습니다.");
    if (meeting.sourcePdf) {
      const pdf = this.app.vault.getAbstractFileByPath(normalizePath(meeting.sourcePdf));
      if (pdf instanceof TFile && pdf.path.startsWith(folder)) await this.app.vault.trash(pdf, true);
    }
    await this.app.vault.trash(meeting.file, true);
    new Notice("회의록을 휴지통으로 이동했습니다.");
  }

  async importMeetingFiles(ticketId, files, options = {}) {
    const normalized = normalizeTicketId(ticketId);
    const rootFile = this.rootTicketFile(normalized);
    if (!(rootFile instanceof TFile)) throw new Error(`${normalized} 원본 티켓 노트를 찾을 수 없습니다.`);
    const selected = [...(files || [])];
    const textFiles = selected.filter((file) => /\.(?:md|txt)$/i.test(file.name));
    const pdfFiles = selected.filter((file) => /\.pdf$/i.test(file.name));
    if (textFiles.length !== 1) throw new Error("Markdown(.md) 또는 텍스트(.txt) 파일을 정확히 1개 선택해 주세요.");
    if (pdfFiles.length > 1) throw new Error("PDF 원본은 1개만 함께 선택할 수 있습니다.");
    const source = textFiles[0];
    const sourceText = await source.text();
    if (!sourceText.trim()) throw new Error("선택한 회의록 파일이 비어 있습니다.");
    const folder = this.ticketMeetingsFolder(normalized);
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
      sourceName: source.name,
      sourceText,
      meetingDate,
      title,
      pdfPath
    });
    const note = await this.app.vault.create(notePath, markdown);
    await this.ensureMeetingSection(rootFile, normalized);
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

  async searchGoogleDriveMeetingDocuments(ticketId) {
    const normalized = normalizeTicketId(ticketId);
    const baseQuery = {
      q: `name contains '${normalized}' and name contains 'Gemini가 작성한 회의록' and mimeType = 'application/vnd.google-apps.document' and trashed = false`,
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
    const normalized = normalizeTicketId(ticketId);
    const rootFile = this.rootTicketFile(normalized);
    if (!(rootFile instanceof TFile)) throw new Error(`${normalized} 원본 티켓 노트를 찾을 수 없습니다.`);
    if (!candidate?.id) throw new Error("Google Drive 회의록 ID가 없습니다.");
    if (this.listTicketMeetings(normalized).some((meeting) => meeting.sourceDriveId === candidate.id)) {
      return { note: null, warnings: [`${candidate.name}: 이미 추가된 회의록입니다.`] };
    }
    const encodedId = encodeURIComponent(candidate.id);
    const markdownData = await this.googleDriveBinaryGet(`/drive/v3/files/${encodedId}/export`, {
      mimeType: "text/markdown"
    });
    const sourceText = new TextDecoder("utf-8").decode(markdownData);
    if (!sourceText.trim()) throw new Error(`${candidate.name}의 Markdown 내용이 비어 있습니다.`);
    const folder = this.ticketMeetingsFolder(normalized);
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
      sourceName: candidate.name,
      sourceText,
      meetingDate,
      title,
      pdfPath,
      sourceDriveId: candidate.id
    });
    const note = await this.app.vault.create(notePath, markdown);
    await this.ensureMeetingSection(rootFile, normalized);
    return { note, warnings };
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

  async syncAllTickets(options = {}) {
    const files = this.rootTicketFiles();
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
    return { total: files.length, completed, failed };
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
      const result = await this.syncAllTickets();
      this.settings.lastStatusSyncDate = today;
      await this.savePluginData();
      new Notice(`일일 ServiceNow 전체 갱신 완료 · 상태·기본정보·워킹노트 ${result.completed}건${result.failed ? ` · 실패 ${result.failed}건` : ""}`, 8000);
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
  buildMeetingNoteMarkdown,
  buildMeetingAnalysisPrompt,
  parseWorkNotes,
  protectUrls,
  restoreUrls,
  serviceNowField,
  tableForTicket,
  utcServiceNowToKst
};
