const fs = require("fs");
const path = require("path");

const main = fs.readFileSync(path.resolve(__dirname, "..", "main.js"), "utf8");
const styles = fs.readFileSync(path.resolve(__dirname, "..", "styles.css"), "utf8");
const start = main.indexOf("  renderTicketTodoBoard(");
const end = main.indexOf("\n  openTicketWorkLogEntry(", start);
if (start < 0 || end < 0) throw new Error("Ticket To-Do board renderer was not found");
const renderer = main.slice(start, end);

for (const marker of [
  'draggable: "true"',
  'card.addEventListener("dragstart"',
  'column.addEventListener("dragover"',
  'column.addEventListener("drop"',
  'await this.updateTodoTaskDetails(task, { status })',
  'this.renderTicketTodoBoard(sourceList, ticketId, refreshed)'
  ,'cls: "clt-ticket-mini-add"'
  ,'this.openTodoEntryModal(ticketId, async () => {'
]) {
  if (!renderer.includes(marker)) throw new Error(`Ticket To-Do drag marker is missing: ${marker}`);
}
if (!styles.includes(".clt-ticket-mini-column.drag-over")) throw new Error("Ticket To-Do drop target styling is missing");
if (!styles.includes(".clt-ticket-mini-card.dragging")) throw new Error("Ticket To-Do dragging styling is missing");
if (!styles.includes(".clt-ticket-mini-add")) throw new Error("Ticket To-Do quick-add styling is missing");
for (const tone of ["overdue", "urgent", "soon", "done"]) {
  if (!styles.includes(`.clt-ticket-mini-card.${tone}`)) throw new Error(`Ticket To-Do ${tone} styling is missing`);
}
if (!main.includes("function todoVisualTone(") || !renderer.includes("todoVisualTone(task)")) {
  throw new Error("Ticket To-Do visual urgency classification is missing");
}

console.log("Ticket To-Do drag checks passed");
