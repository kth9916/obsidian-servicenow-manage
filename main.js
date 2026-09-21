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
const https = require("https");
const zlib = require("zlib");
const { shell } = require("electron");

function isClientAuthCertificateError(error) {
  return /ERR_SSL_CLIENT_AUTH_CERT_NEEDED|SSL_CLIENT_AUTH_CERT_NEEDED/i.test(
    `${String(error?.code || "")} ${String(error?.message || error || "")}`
  );
}

function nodeHttpsRequest(options) {
  return new Promise((resolve, reject) => {
    const requestBody = options.body == null ? null : Buffer.from(String(options.body));
    const headers = { ...(options.headers || {}) };
    if (requestBody && !Object.keys(headers).some((key) => key.toLowerCase() === "content-length")) {
      headers["Content-Length"] = String(requestBody.byteLength);
    }
    const request = https.request(options.url, {
      method: options.method || "GET",
      headers
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString("utf8");
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON response */ }
        const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        resolve({ status: Number(response.statusCode || 0), headers: response.headers || {}, text, json, arrayBuffer });
      });
    });
    request.setTimeout(30_000, () => request.destroy(new Error("ServiceNow 요청 시간이 초과되었습니다.")));
    request.on("error", reject);
    if (requestBody) request.write(requestBody);
    request.end();
  });
}

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
  return remainder.replace(/^[\s*_`~:.,]+/, "").trim();
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
    const searchBar = this.contentEl.createDiv({ cls: "clt-meeting-drive-search" });
    const searchInput = searchBar.createEl("input", { type: "search", placeholder: "Google Drive 파일 제목 직접 검색" });
    const searchButton = searchBar.createEl("button", { text: "직접 검색" });
    const resetButton = searchBar.createEl("button", { text: "자동 검색" });
    this.resultsEl = this.contentEl.createDiv({ cls: "clt-meeting-drive-results" });
    const runSearch = async (query = "") => {
      this.selectedIds.clear();
      this.resultsEl.empty();
      const loading = this.resultsEl.createDiv({ cls: "clt-meeting-empty", text: query ? `'${query}' 검색 중…` : "Google Drive에서 회의록을 찾는 중…" });
      searchButton.disabled = true;
      resetButton.disabled = true;
      try {
        const candidates = await this.plugin.searchGoogleDriveMeetingDocuments(this.ticketId, query);
        loading.remove();
        this.renderCandidates(candidates, Boolean(query));
      } catch (error) {
        console.error(`[ServiceNow Manage] ${this.ticketId} Drive 회의록 후보 표시 실패`, error);
        loading.setText(`회의록 검색 실패: ${error.message || error}`);
      } finally {
        searchButton.disabled = false;
        resetButton.disabled = false;
      }
    };
    searchButton.addEventListener("click", () => {
      const query = searchInput.value.trim();
      if (!query) return new Notice("검색할 Google Drive 파일 제목을 입력해 주세요.");
      void runSearch(query);
    });
    resetButton.addEventListener("click", () => { searchInput.value = ""; void runSearch(); });
    searchInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); searchButton.click(); } });
    try {
      await runSearch();
    } catch (error) {
      console.error(`[ServiceNow Manage] ${this.ticketId} Drive 회의록 후보 표시 실패`, error);
    }
  }

  renderCandidates(candidates, manualSearch = false) {
    const imported = new Set(this.plugin.listTicketMeetings(this.ticketId).map((meeting) => meeting.sourceDriveId).filter(Boolean));
    const list = this.resultsEl.createDiv({ cls: "clt-meeting-drive-candidates" });
    if (!candidates.length) {
      list.createDiv({ cls: "clt-meeting-empty", text: manualSearch ? "입력한 제목과 일치하는 Google Docs를 찾지 못했습니다." : "조건에 맞는 Gemini 회의록을 찾지 못했습니다." });
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
    const actions = this.resultsEl.createDiv({ cls: "clt-sn-document-actions" });
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
    this.selectedKinds = new Set(["gemini", "analysis"]);
    this.eventRefs = [];
  }
  async onOpen() {
    this.modalEl.addClass("clt-meeting-list-modal");
    this.titleEl.setText(`${this.ticketId} 회의록`);
    await this.render();
    const refreshIfRelevant = (file, oldPath = "") => {
      const folder = `${this.plugin.ticketMeetingsFolder(this.ticketId)}/`;
      if (!String(file?.path || "").startsWith(folder) && !String(oldPath || "").startsWith(folder)) return;
      window.setTimeout(() => this.render(), 120);
    };
    this.eventRefs = [
      [this.app.vault, this.app.vault.on("create", refreshIfRelevant)],
      [this.app.vault, this.app.vault.on("delete", refreshIfRelevant)],
      [this.app.vault, this.app.vault.on("rename", refreshIfRelevant)],
      [this.app.vault, this.app.vault.on("modify", refreshIfRelevant)],
      [this.app.metadataCache, this.app.metadataCache.on("changed", refreshIfRelevant)]
    ];
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
    const filter = actions.createEl("details", { cls: "clt-meeting-label-filter" });
    filter.createEl("summary", { text: "라벨 필터" });
    const filterMenu = filter.createDiv({ cls: "clt-meeting-label-filter-menu" });
    [["gemini", "Gemini 회의록"], ["analysis", "AI 회의록 분석"]].forEach(([kind, label]) => {
      const option = filterMenu.createEl("label");
      const checkbox = option.createEl("input", { type: "checkbox" });
      checkbox.checked = this.selectedKinds.has(kind);
      option.createSpan({ text: label });
      checkbox.addEventListener("change", () => {
        checkbox.checked ? this.selectedKinds.add(kind) : this.selectedKinds.delete(kind);
        void this.render();
      });
    });
    const drive = actions.createEl("button", { text: "Drive에서 가져오기" });
    drive.addEventListener("click", () => new DriveMeetingCandidateModal(this.app, this.plugin, this.ticketId, () => this.render()).open());
    const refresh = actions.createEl("button", { text: "새로고침", attr: { title: "회의록 목록 새로고침" } });
    refresh.addEventListener("click", () => this.render());
    const add = actions.createEl("button", { text: "＋ 파일로 추가", cls: "mod-cta" });
    add.addEventListener("click", () => new MeetingImportModal(this.app, this.plugin, this.ticketId, () => this.render()).open());
    const list = this.contentEl.createDiv({ cls: "clt-meeting-list" });
    const allMeetings = this.plugin.listTicketMeetings(this.ticketId, this.sortDirection);
    const meetings = allMeetings.filter((meeting) => this.selectedKinds.has(meeting.kind));
    count.setText(`${meetings.length}개의 회의 기록${meetings.length !== allMeetings.length ? ` · 전체 ${allMeetings.length}개` : ""}`);
    list.dataset.sortDirection = this.sortDirection;
    list.addEventListener("clt-meeting-deleted", () => this.render());
    this.plugin.renderMeetingCards(list, meetings, {
      emptyText: allMeetings.length
        ? "선택한 라벨에 해당하는 회의록이 없습니다. 라벨 필터를 변경해 주세요."
        : "아직 등록된 회의록이 없습니다. 위의 'Drive에서 가져오기' 또는 '＋ 파일로 추가'로 첫 회의록을 등록할 수 있습니다."
    });
  }
  onClose() {
    this.eventRefs.forEach(([emitter, eventRef]) => emitter?.offref?.(eventRef));
    this.eventRefs = [];
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
    const response = await this.serviceNowRequest({
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
          await this.serviceNowRequest({
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

  async searchGoogleDriveMeetingDocuments(ticketId, searchText = "") {
    const normalized = normalizeTicketId(ticketId);
    const manualQuery = String(searchText || "").trim();
    const searchTerms = manualQuery.split(/\s+/).filter(Boolean);
    const escapeDriveQuery = (value) => String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const nameQuery = searchTerms.length
      ? searchTerms.map((term) => `name contains '${escapeDriveQuery(term)}'`).join(" and ")
      : `name contains '${normalized}' and name contains 'Gemini가 작성한 회의록'`;
    const baseQuery = {
      q: `${nameQuery} and mimeType = 'application/vnd.google-apps.document' and trashed = false`,
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
        if (searchTerms.length) {
          const comparableName = name.toLocaleLowerCase();
          return searchTerms.every((term) => comparableName.includes(term.toLocaleLowerCase()));
        }
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
    const response = await this.serviceNowRequest({
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

  async serviceNowRequest(options) {
    try {
      return await requestUrl(options);
    } catch (error) {
      if (!isClientAuthCertificateError(error)) throw error;
      console.warn("[ServiceNow Manage] Obsidian requestUrl 인증서 오류로 Node HTTPS 재시도", error);
      return nodeHttpsRequest(options);
    }
  }

  async attachmentImageDataUrl(entry) {
    const attachmentId = String(entry?.attachmentId || "").trim();
    if (!attachmentId) throw new Error("첨부파일 ID가 없습니다.");
    if (Number(entry.sizeBytes || 0) > 15 * 1024 * 1024) throw new Error("15MB를 초과해 미리보기를 생략했습니다.");
    if (this.attachmentImageCache.has(attachmentId)) return this.attachmentImageCache.get(attachmentId);
    const loading = (async () => {
      const token = await this.validAccessToken();
      const response = await this.serviceNowRequest({
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
    const response = await this.serviceNowRequest({
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
