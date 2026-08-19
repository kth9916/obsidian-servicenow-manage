const fs = require("fs");
const path = require("path");

const dashboard = fs.readFileSync(path.resolve(__dirname, "..", "resources", "업무현황.md"), "utf8");
const required = [
  'data-todo-list-ticket-id="${escapeAttribute(page.id || page.file.name)}"',
  "function openTicketTodoListModal(item)",
  "opus-ticket-todo-layout",
  "opus-ticket-todo-list-pane",
  "opus-ticket-todo-detail-pane",
  "appendLinkedText(description, selectedTask.text)",
  "navigator.clipboard.writeText(String(selectedTask.text || \"\"))",
  "openTodoDetailModal(selectedTask, () => refreshTasks(selectedId))",
  "function handleTodoListClick(event)",
  'tableArea.addEventListener("click", handleTodoListClick)'
];
for (const marker of required) {
  if (!dashboard.includes(marker)) throw new Error(`Missing ticket To-Do list marker: ${marker}`);
}

const start = dashboard.indexOf("function handleTodoListClick(");
const end = dashboard.indexOf('\ntableArea.addEventListener("click", handleTodoListClick)', start);
if (start < 0 || end < 0) throw new Error("Ticket To-Do list click handler was not found");
const calls = [];
const button = { dataset: { todoListTicketId: "SR0000000" } };
const event = {
  target: { closest: selector => selector === "[data-todo-list-ticket-id]" ? button : null },
  preventDefault: () => calls.push("preventDefault"),
  stopPropagation: () => calls.push("stopPropagation")
};
const tableArea = { contains: target => target === button };
const pages = [{ page: { id: "SR0000000", file: { name: "SR0000000" } }, todos: [] }];
const notices = [];
const handler = Function(
  "tableArea", "pages", "openTicketTodoListModal", "Notice",
  `${dashboard.slice(start, end)}; return handleTodoListClick;`
)(tableArea, pages, item => calls.push(item.page.id), function Notice(message) { notices.push(message); });

if (handler(event) !== true) throw new Error("Ticket To-Do list click was not handled");
if (!calls.includes("SR0000000")) throw new Error("Ticket-specific To-Do modal did not open");
if (!calls.includes("preventDefault") || !calls.includes("stopPropagation")) throw new Error("Ticket list click was not isolated");
if (notices.length) throw new Error(`Unexpected notice: ${notices[0]}`);
console.log("Ticket-specific To-Do list checks passed");
