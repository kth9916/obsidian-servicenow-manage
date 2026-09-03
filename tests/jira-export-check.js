const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dashboard = fs.readFileSync(path.join(root, "resources", "업무현황.md"), "utf8");

const required = [
  'const DASHBOARD_RUNTIME_VERSION = "2.10.1";',
  'exportButton.textContent = "Jira 용 Export";',
  "function openJiraExportModal()",
  "function buildJiraExportPayload(tasks, fields)",
  'label: "No."',
  'label: "Ticket No."',
  'label: "Description"',
  'label: "Phase"',
  'label: "Status"',
  'pending: "TO DO"',
  '"in-progress": "IN PROGRESS"',
  'done: "DONE"',
  "selectedTaskIds",
  "selectedFieldKeys",
  "fieldOrder",
  'basisSelect',
  'startInput.type = "date"',
  'endInput.type = "date"',
  'document.createTextNode("완료 태스크 제외")',
  'document.createTextNode("같은 티켓끼리 하나로 묶기")',
  "function collapseJiraTasksByTicket(tasks)",
  'label: "To-Do (할 일)"',
  'label: "To-Do Details (상세 내용)"',
  'document.createTextNode("선택한 To-Do를 영어로 번역")',
  "function syncTranslationOption()",
  "async function ensureEnglishTranslations()",
  'plugin.translateTextForExport(source, "en")',
  "function matchesExportFilters(task)",
  'excludeCompleted && task.status === "done"',
  '"text/html"',
  '"text/plain"',
  "opus-modal-backdrop",
  "Jira 표 복사"
];

for (const marker of required) {
  if (!dashboard.includes(marker)) throw new Error(`Jira Export marker is missing: ${marker}`);
}

if (!dashboard.includes("ticketCheckbox.indeterminate")) {
  throw new Error("Ticket and individual task selection are not synchronized");
}
if (!dashboard.includes("[fieldOrder[index - 1], fieldOrder[index]]")) {
  throw new Error("Export field reordering is missing");
}
if (!dashboard.includes("pluginTicket?.shortDescription") || !dashboard.includes("page?.short_description")) {
  throw new Error("Description is not populated from the ticket Short Description");
}
if (!dashboard.includes("page?.status")) {
  throw new Error("Phase is not populated from the ServiceNow ticket state");
}
if (!dashboard.includes('row.className = "opus-jira-export-task-row"')) {
  throw new Error("Compact Jira task row is missing");
}
if (!dashboard.includes('more.textContent = "더 보기"')) {
  throw new Error("Jira task expand control is missing");
}
if (!dashboard.includes('ticketToggle.className = "opus-jira-export-ticket-toggle"')
    || !dashboard.includes('taskChildren.className = "opus-jira-export-ticket-tasks"')
    || !dashboard.includes("const expandedTicketIds = new Set()")
    || !dashboard.includes('chevron.textContent = expanded ? "▼" : "▶"')) {
  throw new Error("Collapsible Jira ticket task groups are missing");
}
if (!dashboard.includes(".opus-jira-export-ticket-tasks.is-collapsed")) {
  throw new Error("Collapsed Jira ticket group styling is missing");
}
if (!dashboard.includes("overflow-y: scroll") || !dashboard.includes("scrollbar-gutter: stable")) {
  throw new Error("Dedicated Jira ticket list scrollbar is missing");
}
if (!dashboard.includes("height: auto !important") || !dashboard.includes("overflow: visible !important")) {
  throw new Error("Expanded Jira ticket groups can still be clipped");
}
if (!dashboard.includes("-webkit-line-clamp: 2")) {
  throw new Error("Jira task preview clamp is missing");
}
if (!dashboard.includes('data-jira-field="${escapeAttribute(field.key)}"')) {
  throw new Error("Jira preview field sizing hooks are missing");
}
if (!dashboard.includes('.opus-jira-export-preview [data-jira-field="ticket"]')) {
  throw new Error("Jira preview Ticket No. minimum width is missing");
}
if (!dashboard.includes("width: min(1580px, 98vw)")) throw new Error("Jira Export modal width was not expanded");

const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
if (!main.includes('async translateTextForExport(content, target = "en")')
    || !main.includes('translate.api.translate(masked, "auto", target)')) {
  throw new Error("Jira Export English translation bridge is missing");
}

const collapseStart = dashboard.indexOf("function collapseJiraTasksByTicket(");
const collapseEnd = dashboard.indexOf("\nasync function copyJiraExportPayload", collapseStart);
if (collapseStart < 0 || collapseEnd < 0) throw new Error("Jira ticket grouping function was not found");
const collapse = Function(`${dashboard.slice(collapseStart, collapseEnd)}; return collapseJiraTasksByTicket;`)();
const grouped = collapse([
  { ticketId: "CR1", status: "done", text: "첫 번째", details: "상세 A", dueDate: "2026-08-24" },
  { ticketId: "CR1", status: "in-progress", text: "두 번째", details: "상세 B", dueDate: "2026-08-25" },
  { ticketId: "SR1", status: "pending", text: "세 번째", details: "" }
]);
if (grouped.length !== 2) throw new Error("Same-ticket Jira rows were not collapsed");
if (grouped[0].status !== "in-progress" || !grouped[0].text.includes("첫 번째") || !grouped[0].details.includes("상세 B")) {
  throw new Error("Grouped Jira row did not preserve task titles, details, or mixed status");
}

console.log("Jira export checks passed");
