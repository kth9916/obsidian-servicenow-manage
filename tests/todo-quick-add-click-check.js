const fs = require("fs");
const path = require("path");

const dashboard = fs.readFileSync(path.resolve(__dirname, "..", "resources", "업무현황.md"), "utf8");
const start = dashboard.indexOf("function handleTodoQuickAddClick(");
const end = dashboard.indexOf("\ntableArea.addEventListener", start);
if (start < 0 || end < 0) throw new Error("To-Do quick-add click handler was not found");

const calls = [];
const button = { dataset: { todoTicketId: "CR0000000" } };
const event = {
  target: { closest: (selector) => selector === "[data-todo-ticket-id]" ? button : null },
  preventDefault: () => calls.push("preventDefault"),
  stopPropagation: () => calls.push("stopPropagation")
};
const tableArea = { contains: (target) => target === button };
const pages = [{ page: { id: "CR0000000", file: { name: "CR0000000" } } }];
const notices = [];
const handler = Function(
  "tableArea", "pages", "openTodoCreateModal", "Notice",
  `${dashboard.slice(start, end)}; return handleTodoQuickAddClick;`
)(tableArea, pages, (item) => calls.push(item.page.id), function Notice(message) { notices.push(message); });

if (handler(event) !== true) throw new Error("Quick-add click was not handled");
if (!calls.includes("CR0000000")) throw new Error("Quick-add did not open the selected ticket modal");
if (!calls.includes("preventDefault") || !calls.includes("stopPropagation")) throw new Error("Quick-add event was not isolated");
if (notices.length) throw new Error(`Unexpected notice: ${notices[0]}`);
console.log("To-Do quick-add click checks passed");
