const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dashboard = fs.readFileSync(path.join(root, "resources", "업무현황.md"), "utf8");

const required = [
  'const DASHBOARD_RUNTIME_VERSION = "2.1.0";',
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
  "function matchesExportFilters(task)",
  'excludeCompleted && task.status === "done"',
  '"text/html"',
  '"text/plain"',
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

console.log("Jira export checks passed");
