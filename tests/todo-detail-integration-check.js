const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const dashboard = fs.readFileSync(path.join(root, "resources", "업무현황.md"), "utf8");

const requiredMainMarkers = [
  "class TodoDetailEntryModal extends Modal",
  "stripCltTodoMetadata(value)",
  "navigator.clipboard.writeText(String(content.value || \"\"))",
  "openTodoDetailEntryModal(task, onSaved = null)",
  "async readTodoTasks(ticketId)",
  "async updateTodoTaskDetails(task, changes = {})",
  "async deleteTodoTask(task)",
  "composeTodoDueValue(date, time)",
  "this.registerMarkdownPostProcessor(async (el, ctx) =>",
  "this.registerDomEvent(document, \"click\", (event) =>",
  "async handleLivePreviewTodoClick(event)",
  ".markdown-source-view.mod-cm6 .HyperMD-task-line",
  "posAtMouse?.(event)",
  "renderTicketTodoBoard(sourceList, ticketId, tasks)",
  "clt-ticket-mini-todo-board",
  "async normalizeTodoMetadataOnce()",
  "this.close();\n      await this.app.workspace.getLeaf(false).openFile(file);",
  "text: \"저장\", cls: \"mod-cta\""
];
for (const marker of requiredMainMarkers) {
  if (!main.includes(marker)) throw new Error(`Missing shared To-Do detail marker: ${marker}`);
}
if (!main.includes('text: "삭제", cls: "mod-warning clt-todo-delete-button"')) {
  throw new Error("To-Do delete action is missing");
}
if (!styles.includes(".clt-todo-due-fields") || !styles.includes(".clt-todo-delete-button")) {
  throw new Error("To-Do due-time or delete styling is missing");
}

if (!dashboard.includes('sharedPlugin.openTodoDetailEntryModal(task')) {
  throw new Error("Dashboard does not delegate To-Do details to the shared plugin modal");
}
if (!dashboard.includes("Object.assign(task, updatedTask || {})")) {
  throw new Error("Dashboard does not refresh a task after shared modal edits");
}
const closeBeforeOpenMatches = dashboard.match(/close\(\);\s*await openTodoTicket\(/g) || [];
if (closeBeforeOpenMatches.length < 2) {
  throw new Error("Dashboard To-Do popups do not close before opening the original ticket");
}
if (!styles.includes(".clt-todo-detail-description") || !styles.includes("user-select: text")) {
  throw new Error("To-Do detail text selection styling is missing");
}
if (!styles.includes(".clt-ticket-mini-todo-board") || !styles.includes(".clt-ticket-mini-card")) {
  throw new Error("Ticket-note mini To-Do board styling is missing");
}
if (main.includes('text: "수정하기", cls: "mod-cta"')) throw new Error("Legacy two-step edit button remains");

console.log("Shared To-Do detail integration checks passed");
