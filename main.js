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

function buildMeetingNoteMarkdown({ ticketId, sourceName, sourceText, meetingDate, title, pdfPath = "" }) {
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
    `type: meeting-minutes\n` +
    `meeting_date: "${resolvedDate}"\n` +
    `source_name: "${String(sourceName || "").replace(/"/g, "'")}"\n` +
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
    const add = actions.createEl("button", { text: "＋ 새 회의록", cls: "mod-cta" });
    add.addEventListener("click", () => new MeetingImportModal(this.app, this.plugin, this.ticketId, () => this.render()).open());
    const list = this.contentEl.createDiv({ cls: "clt-meeting-list" });
    const meetings = this.plugin.listTicketMeetings(this.ticketId, this.sortDirection);
    count.setText(`${meetings.length}개의 회의 기록`);
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
      this.renderTicketMeetingSection(el, ticketId);
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
          file,
          title: file.basename.replace(/^\d{4}-\d{2}-\d{2}[ T_-]*\d{0,2}[-:]?\d{0,2}\s*-?\s*/, "") || file.basename,
          meetingDate,
          sourceName: String(frontmatter.source_name || "")
        };
      });
    meetings.sort((left, right) => {
      const compared = String(left.meetingDate || left.file.stat.ctime).localeCompare(String(right.meetingDate || right.file.stat.ctime));
      return sortDirection === "asc" ? compared : -compared;
    });
    return meetings;
  }

  renderMeetingCards(container, meetings, { emptyText = "등록된 회의록이 없습니다." } = {}) {
    container.empty?.();
    if (!meetings.length) {
      container.createDiv({ cls: "clt-meeting-empty", text: emptyText });
      return;
    }
    for (const meeting of meetings) {
      const card = container.createEl("button", {
        cls: "clt-meeting-card",
        attr: { type: "button", title: `${meeting.title} 열기` }
      });
      const date = String(meeting.meetingDate || "").replace("T", " ") || "일시 미지정";
      card.createDiv({ cls: "clt-meeting-card-date", text: date });
      card.createDiv({ cls: "clt-meeting-card-title", text: meeting.title });
      const meta = card.createDiv({ cls: "clt-meeting-card-meta" });
      meta.createSpan({ text: meeting.sourceName || "회의록" });
      meta.createSpan({ text: "열기 ›" });
      card.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await this.app.workspace.getLeaf(false).openFile(meeting.file);
      });
    }
  }

  renderTicketMeetingSection(el, ticketId) {
    el.addClass("clt-ticket-meeting-action");
    el.closest(".markdown-preview-view, .markdown-rendered")?.classList.add("clt-ticket-note-render");
    const toolbar = el.createDiv({ cls: "clt-meeting-inline-toolbar" });
    const count = toolbar.createSpan({ cls: "clt-meeting-list-count" });
    const sort = toolbar.createEl("button", { text: "최신순 ↓", attr: { type: "button" } });
    const add = toolbar.createEl("button", { text: "＋ 새 회의록 추가", cls: "mod-cta", attr: { type: "button" } });
    const list = el.createDiv({ cls: "clt-meeting-list" });
    let direction = "desc";
    const refresh = () => {
      const meetings = this.listTicketMeetings(ticketId, direction);
      count.setText(`${meetings.length}개의 회의 기록`);
      sort.setText(direction === "desc" ? "최신순 ↓" : "오래된순 ↑");
      this.renderMeetingCards(list, meetings);
    };
    sort.addEventListener("click", () => {
      direction = direction === "desc" ? "asc" : "desc";
      refresh();
    });
    add.addEventListener("click", () => new MeetingImportModal(this.app, this, ticketId, refresh).open());
    refresh();
  }

  openMeetingImportModal(ticketId, onImported = null) {
    new MeetingImportModal(this.app, this, ticketId, onImported).open();
  }

  openMeetingListModal(ticketId) {
    new MeetingListModal(this.app, this, ticketId).open();
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
  parseWorkNotes,
  protectUrls,
  restoreUrls,
  serviceNowField,
  tableForTicket,
  utcServiceNowToKst
};
