const fs = require("fs");
const path = require("path");

const dashboard = fs.readFileSync(path.resolve(__dirname, "..", "resources", "업무현황.md"), "utf8");
const source = dashboard.match(/```dataviewjs\r?\n([\s\S]*?)\r?\n```/)?.[1] || "";

function loadFunction(name) {
  let start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  if (source.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

eval(loadFunction("stripMarkdown"));
eval(loadFunction("formatDateTime"));
eval(loadFunction("findTodoSection"));
eval(loadFunction("extractTodos"));
eval(loadFunction("appendTodoToMarkdown"));

let markdown = [
  "## ✅ To-Do",
  "",
  "- [ ] 2026-08-13 09:00 : 첫 번째 작업",
  "- [ ] 2026-08-13 09:10 : 진행 작업 <!-- clt-todo:in-progress --> <!-- clt-todo-due:2026-08-12T14:30 --> <!-- clt-todo-due:2026-08-12T14:30 -->",
  "- [x] 2026-08-13 09:20 : 완료 작업",
  "",
  "## 다음 섹션"
].join("\n");
const page = { id: "CR0000000", file: { path: "ServiceNow/티켓/CR0000000/CR0000000.md", name: "CR0000000" } };
let todos = extractTodos(markdown, page);
if (todos.map(todo => todo.status).join(",") !== "pending,in-progress,done") throw new Error("Three To-Do states were not parsed");
if (todos[1].dueDate !== "2026-08-12T14:30" || todos[1].text.includes("clt-todo-due")) throw new Error("To-Do due date/time was not parsed cleanly");
const withNewTodo = appendTodoToMarkdown(markdown, "2026-08-13 10:00", "새 만료 작업", "2026-08-20", "pending");
if (!withNewTodo.includes("새 만료 작업 <!-- clt-todo-due:2026-08-20 -->")) throw new Error("Due date marker was not saved");

const file = { path: page.file.path };
global.app = {
  vault: {
    getAbstractFileByPath: () => file,
    process: async (_file, transform) => { markdown = transform(markdown); }
  }
};
eval(loadFunction("updateTodoDetails"));
eval(loadFunction("updateTodoStatus"));

(async () => {
  await updateTodoStatus(todos[0], "in-progress");
  if (!markdown.includes("첫 번째 작업 <!-- clt-todo:in-progress -->")) throw new Error("In-progress marker was not saved");
  todos = extractTodos(markdown, page);
  await updateTodoStatus(todos[1], "done");
  if (!markdown.includes("- [x] 2026-08-13 09:10 : 진행 작업")) throw new Error("Completed checkbox was not saved");
  if (!markdown.includes("<!-- clt-todo-due:2026-08-12T14:30 -->")) throw new Error("Status change removed the due date/time");
  if (!markdown.includes("<!-- clt-todo-completed:")) throw new Error("Completion timestamp was not saved");
  if ((markdown.match(/clt-todo-due:2026-08-12T14:30/g) || []).length !== 1) throw new Error("Duplicate due-date markers were not normalized");
  todos = extractTodos(markdown, page);
  if (!todos[1].completedAt) throw new Error("Completion timestamp was not parsed");
  await updateTodoDetails(todos[1], { text: "수정된 완료 작업", dueDate: "2026-08-22", status: "in-progress" });
  if (!markdown.includes("수정된 완료 작업 <!-- clt-todo:in-progress --> <!-- clt-todo-due:2026-08-22 -->")) throw new Error("To-Do details were not updated");
  if (markdown.includes("진행 작업 <!-- clt-todo-completed:")) throw new Error("Completion timestamp remained after reopening");
  if (!source.includes("min-height: min(620px") || !source.includes("To-Do 보드") || !source.includes("티켓별로 구분")) {
    throw new Error("Dashboard layout safeguards or board controls are missing");
  }
  if (!source.includes("opus-popup-field-grid") || !source.includes("repeat(4, minmax(0, 1fr))")) {
    throw new Error("Sort/filter field grid is missing");
  }
  if (!source.includes("openTodoCreateModal") || !source.includes("data-todo-ticket-id") || !source.includes("opus-todo-due-badge")) {
    throw new Error("To-Do creation or due-date UI is missing");
  }
  if (!source.includes("openTodoDetailModal") || !source.includes("todoSearchKeyword") || !source.includes("기한 지남")) {
    throw new Error("To-Do details or smart search UI is missing");
  }
  if (!source.includes('key: "todoSummary"') || !source.includes("opus-todo-summary-counts") || !source.includes("진행 전 ${pending}")) {
    throw new Error("Ticket-level To-Do summary column is missing");
  }
  if (source.includes("opus-file-todo-add")) throw new Error("Legacy File-cell To-Do button remains");
  if (!source.includes('app.plugins.getPlugin("servicenow-manage")') || !source.includes("openTodoEntryModal")) {
    throw new Error("Shared searchable To-Do modal integration is missing");
  }
  console.log("To-Do board checks passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
