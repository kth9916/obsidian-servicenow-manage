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
