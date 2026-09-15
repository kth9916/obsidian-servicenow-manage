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
    `${normalized ? `ticket: "${normalized}"\nParent: "[[${normalized}]]"\n` : `ticket: ""\n`}` +
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
    `> | 티켓 | ${normalized ? `[[${normalized}|${normalized}]]` : "티켓 없음"} |\n` +
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
  constructor(app, plugin, ticketId, onImported = null, allowTicketSelection = false) {
    super(app);
    this.plugin = plugin;
    this.ticketId = normalizeTicketId(ticketId);
    this.onImported = onImported;
    this.allowTicketSelection = allowTicketSelection;
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
    let selectedTicketId = this.ticketId;
    if (this.allowTicketSelection) {
      const ticketLabel = form.createEl("label", { cls: "clt-meeting-ticket-select" });
      ticketLabel.createSpan({ text: "연결할 티켓" });
      const ticketSelect = ticketLabel.createEl("select");
      ticketSelect.createEl("option", { value: "", text: "티켓 없이 등록" });
      this.plugin.rootTicketFiles().map((file) => this.plugin.rootTicketIdFromFile(file)).filter(Boolean).sort().forEach((ticketId) => {
        ticketSelect.createEl("option", { value: ticketId, text: ticketId });
      });
      ticketSelect.value = selectedTicketId;
      ticketSelect.addEventListener("change", () => {
        selectedTicketId = normalizeTicketId(ticketSelect.value);
        titleInput.placeholder = selectedTicketId ? `${selectedTicketId} 회의` : "회의 제목";
      });
    }
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
        const note = await this.plugin.importMeetingFiles(selectedTicketId, files, {
          title: titleInput.value.trim(), meetingDate: dateInput.value
        });
        this.close();
        if (typeof this.onImported === "function") await this.onImported(note);
        await this.app.workspace.getLeaf(false).openFile(note);
        new Notice(`${selectedTicketId || "티켓 없는"} 회의록을 만들었습니다.`);
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

class GlobalDriveMeetingTicketModal extends Modal {
  constructor(app, plugin, onImported = null) {
    super(app);
    this.plugin = plugin;
    this.onImported = onImported;
  }
  onOpen() {
    this.titleEl.setText("Drive 회의록을 가져올 티켓 선택");
    this.contentEl.createDiv({ cls: "clt-meeting-import-lead", text: "Drive 검색은 회의 제목의 티켓 번호를 기준으로 하므로 연결할 CR/SR을 먼저 선택해 주세요." });
    const select = this.contentEl.createEl("select");
    select.style.width = "100%";
    this.plugin.rootTicketFiles().map((file) => this.plugin.rootTicketIdFromFile(file)).filter(Boolean).sort().forEach((ticketId) => {
      select.createEl("option", { value: ticketId, text: ticketId });
    });
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    actions.createEl("button", { text: "취소" }).addEventListener("click", () => this.close());
    const next = actions.createEl("button", { text: "Drive 검색", cls: "mod-cta" });
    next.addEventListener("click", () => {
      const ticketId = normalizeTicketId(select.value);
      if (!ticketId) return new Notice("티켓을 선택해 주세요.");
      this.close();
      new DriveMeetingCandidateModal(this.app, this.plugin, ticketId, this.onImported).open();
    });
  }
  onClose() { this.contentEl.empty(); }
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

  openGlobalMeetingImportModal(onImported = null) {
    new MeetingImportModal(this.app, this, "", onImported, true).open();
  }

  openGlobalDriveMeetingModal(onImported = null) {
    new GlobalDriveMeetingTicketModal(this.app, this, onImported).open();
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
    const folder = `${meeting.ticketId ? this.ticketMeetingsFolder(meeting.ticketId) : this.generalMeetingsFolder()}/`;
    if (!meeting.file.path.startsWith(folder)) throw new Error("티켓 회의록 폴더 밖의 파일은 삭제할 수 없습니다.");
    if (meeting.sourcePdf) {
      const pdf = this.app.vault.getAbstractFileByPath(normalizePath(meeting.sourcePdf));
      if (pdf instanceof TFile && pdf.path.startsWith(folder)) await this.app.vault.trash(pdf, true);
    }
    await this.app.vault.trash(meeting.file, true);
    new Notice("회의록을 휴지통으로 이동했습니다.");
  }

  confirmDeleteMeetingPath(path, onDeleted = null) {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) return new Notice("삭제할 회의록을 찾을 수 없습니다.");
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const meeting = {
      file,
      ticketId: normalizeTicketId(frontmatter.ticket || ""),
      title: file.basename,
      sourcePdf: parseWikiLink(frontmatter.source_pdf || "")
    };
    new ConfirmActionModal(
      this.app,
      "회의록 삭제",
      `'${meeting.title}'을 Obsidian에서 삭제하시겠습니까?`,
      async () => {
        await this.deleteTicketMeeting(meeting);
        if (typeof onDeleted === "function") await onDeleted();
      },
      "삭제",
      "회의록 삭제"
    ).open();
  }

  async importMeetingFiles(ticketId, files, options = {}) {
    const normalized = normalizeTicketId(ticketId);
    const rootFile = this.rootTicketFile(normalized);
    if (normalized && !(rootFile instanceof TFile)) throw new Error(`${normalized} 원본 티켓 노트를 찾을 수 없습니다.`);
    const selected = [...(files || [])];
    const textFiles = selected.filter((file) => /\.(?:md|txt)$/i.test(file.name));
    const pdfFiles = selected.filter((file) => /\.pdf$/i.test(file.name));
    if (textFiles.length !== 1) throw new Error("Markdown(.md) 또는 텍스트(.txt) 파일을 정확히 1개 선택해 주세요.");
    if (pdfFiles.length > 1) throw new Error("PDF 원본은 1개만 함께 선택할 수 있습니다.");
    const source = textFiles[0];
    const sourceText = await source.text();
    if (!sourceText.trim()) throw new Error("선택한 회의록 파일이 비어 있습니다.");
    const folder = normalized ? this.ticketMeetingsFolder(normalized) : this.generalMeetingsFolder();
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
    if (rootFile instanceof TFile) await this.ensureMeetingSection(rootFile, normalized);
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
