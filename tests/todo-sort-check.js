const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const dashboard = fs.readFileSync(path.join(__dirname, "..", "resources", "업무현황.md"), "utf8");
const start = main.indexOf("const TODO_SORT_OPTIONS ="), end = main.indexOf("function responsiveActionRows(", start);
const context = vm.createContext({});
vm.runInContext(main.slice(start, end), context);
const api = vm.runInContext("({sortTodoTasksBySetting,normalizeTodoSort,TODO_SORT_OPTIONS})", context);
const tasks = [
  { id: "missing", text: "다", dateTime: "2026-10-19T10:00", dueDate: "", status: "pending" },
  { id: "late", text: "나", dateTime: "2026-10-18T10:00", dueDate: "2026-10-22", status: "pending" },
  { id: "early", text: "가", dateTime: "2026-10-17T10:00", dueDate: "2026-10-20T15:30", status: "pending" }
];
const ids = (items, sort) => Array.from(api.sortTodoTasksBySetting(items, sort), task => task.id);
assert.deepEqual(ids(tasks, "smart"), ["early", "late", "missing"]);
assert.deepEqual(ids(tasks, "due-desc"), ["late", "early", "missing"]);
assert.deepEqual(ids(tasks, "created-desc"), ["missing", "late", "early"]);
assert.deepEqual(ids(tasks, "created-asc"), ["early", "late", "missing"]);
assert.deepEqual(ids(tasks, "title-asc"), ["early", "late", "missing"]);
assert.deepEqual(ids(tasks, "title-desc"), ["missing", "late", "early"]);
assert.deepEqual(tasks.map(task => task.id), ["missing", "late", "early"], "do not mutate source arrays");
const waiting = tasks.map((task, index) => ({ ...task, status: "waiting", followUpDate: ["", "2026-10-24", "2026-10-21"][index] }));
assert.deepEqual(ids(waiting, "smart"), ["early", "late", "missing"]);
const done = tasks.map((task, index) => ({ ...task, status: "done", completedAt: ["2026-10-22T10:00", "2026-10-21T10:00", ""][index] }));
assert.deepEqual(ids(done, "smart"), ["missing", "late", "early"]);
assert.equal(api.normalizeTodoSort("invalid"), "smart");
assert.equal(api.TODO_SORT_OPTIONS.length, 9);
function method(name) {
  const start = main.search(new RegExp(`^  (?:async )?${name}\\(`, "m"));
  const rest = main.slice(start), end = rest.slice(1).search(/\n  (?:async )?\w+\(/);
  return rest.slice(0, end + 1).trim();
}
const plugin = vm.runInContext(`({${["sortTodoTasks", "setTodoSort"].map(method).join(",")}})`, context);
plugin.settings = { todoSort: "smart" };
let saves = 0, refreshes = 0, events = 0;
plugin.savePluginData = async () => { saves++; };
plugin.refreshTodoWorkflowViews = () => { refreshes++; };
plugin.app = { workspace: { trigger: name => { assert.equal(name, "servicenow-manage:todo-sort-changed"); events++; } } };
(async () => {
  await plugin.setTodoSort("due-desc");
  assert.deepEqual(Array.from(plugin.sortTodoTasks(tasks), task => task.id), ["late", "early", "missing"]);
  assert.equal(saves, 1); assert.equal(refreshes, 1); assert.equal(events, 1);
  plugin.savePluginData = async () => { throw Error("save failed"); };
  await assert.rejects(plugin.setTodoSort("created-asc"), /save failed/);
  assert.equal(plugin.settings.todoSort, "due-desc"); assert.equal(events, 1);
  assert(method("renderTicketTodoBoard").includes("this.renderTodoSortControl?.(toolbar)"));
  assert(dashboard.includes("workflowPlugin?.renderTodoSortControl?.(manageActions)"));
  assert(dashboard.includes("sortPlugin?.renderTodoSortControl?.(listPane)"));
  assert(dashboard.includes("app.workspace.offref(sortPopupRef)"));
  console.log("To-Do sorting checks passed: nine shared modes, missing dates, stable non-mutating order, workflow-aware default, persistence rollback and cross-view wiring.");
})().catch(error => { console.error(error); process.exitCode = 1; });
