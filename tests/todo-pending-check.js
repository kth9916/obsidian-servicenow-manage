const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const dashboard = fs.readFileSync(path.join(root, "resources", "업무현황.md"), "utf8");
function fn(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert(start >= 0, name);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n(?:async )?function /);
  return end < 0 ? rest : rest.slice(0, end + 1);
}
const context = vm.createContext({ console, Date, encodeURIComponent, decodeURIComponent });
for (const name of ["stripMarkdown", "formatDateTime", "findTodoSection", "readTodoWaiting", "todoWaitingChanges", "todoWaitingMarker", "todoFollowUpInfo", "extractTodos", "appendTodoToMarkdown", "touchTodoLastChecked", "updateTodoDetails", "updateTodoStatus"]) {
  vm.runInContext(fn(dashboard, name), context);
}
const page = { id: "CR1", file: { path: "ServiceNow/티켓/CR1/CR1.md", name: "CR1" } };
let markdown = "## ✅ To-Do\n\n- [ ] 2026-10-01 10:00 : Legacy unchecked\n- [ ] 2026-10-01 10:00 : Running <!-- clt-todo:in-progress -->\n- [x] 2026-10-01 10:00 : Done\n";
let tasks = context.extractTodos(markdown, page);
assert.deepStrictEqual(Array.from(tasks, t => t.status), ["pending", "in-progress", "done"]);
markdown = context.appendTodoToMarkdown(markdown, "2026-10-07 09:00", "Customer approval", "2026-10-20", "waiting", "- scope", "", { waitingReason: "CLV 답변 / 고객 승인 <대기>", followUpDate: "2026-10-09" });
tasks = context.extractTodos(markdown, page);
const task = tasks[3];
assert.equal(task.status, "waiting");
assert.equal(task.waitingReason, "CLV 답변 / 고객 승인 <대기>");
assert.equal(task.followUpDate, "2026-10-09");
assert.equal(task.waitingSince, "2026-10-07 09:00");
assert.equal(task.dueDate, "2026-10-20");
assert(!task.text.includes("clt-todo"));
assert(!context.todoFollowUpInfo(task, new Date(2026, 9, 8)).needsFollowUp);
assert(context.todoFollowUpInfo(task, new Date(2026, 9, 9)).needsFollowUp);
assert(context.todoFollowUpInfo(task, new Date(2026, 9, 10)).needsFollowUp);
assert.equal(context.todoFollowUpInfo({ ...task, status: "done" }), null);
assert.equal(context.readTodoWaiting("<!-- clt-todo-wait:bad% -->").waitingReason, "");
context.app = { vault: { getAbstractFileByPath: () => page.file, process: async (_f, transform) => { markdown = transform(markdown); } } };

(async () => {
  await context.updateTodoDetails(task, { waitingReason: "고객 회신 대기", followUpDate: "2026-10-12" });
  assert.equal(context.extractTodos(markdown, page)[3].waitingSince, task.waitingSince);
  await context.updateTodoStatus(task, "in-progress");
  assert(!markdown.includes("clt-todo:waiting"));
  assert.equal(context.extractTodos(markdown, page)[3].status, "in-progress");
  assert.equal(context.extractTodos(markdown, page)[3].waitingReason, "고객 회신 대기");
  await context.updateTodoStatus(task, "waiting");
  assert.equal(context.extractTodos(markdown, page)[3].status, "waiting");
  await context.updateTodoStatus(task, "done");
  assert(context.extractTodos(markdown, page)[3].completedAt);
  assert.equal(context.extractTodos(markdown, page)[3].status, "done");
  assert.equal(context.extractTodos(markdown, page)[3].dueDate, "2026-10-20");
  assert.equal(context.extractTodos(markdown, page)[3].details, "- scope");

  const mainContext = vm.createContext({ Date, encodeURIComponent, decodeURIComponent });
  for (const name of ["readTodoWaiting", "todoWaitingChanges", "todoWaitingMarker", "todoFollowUpInfo", "stripCltTodoMetadata"]) vm.runInContext(fn(main, name), mainContext);
  assert.equal(mainContext.readTodoWaiting(markdown.split("\n").find(l => l.includes("Customer approval"))).waitingReason, "고객 회신 대기");
  assert.equal(mainContext.stripCltTodoMetadata(`Title${mainContext.todoWaitingMarker(task)}`), "Title");
  const sameWait = mainContext.todoWaitingChanges({ ...task, status: "waiting" }, { waitingReason: "edited" }, "waiting", "later");
  assert.equal(sameWait.waitingSince, task.waitingSince);
  const resume = mainContext.todoWaitingChanges({ ...task, status: "in-progress" }, {}, "waiting", "new start");
  assert.equal(resume.waitingSince, "new start");
  assert(main.includes('key: "waiting", label: "Pending · 대기", icon: "⏸"'));
  assert(dashboard.includes('waiting: "PENDING"'));
  assert(dashboard.includes('key: "todoWaitingReason"'));
  assert(dashboard.includes('key: "followUpDate"'));
  assert(dashboard.includes('quickFilter === "follow-up"'));
  assert(dashboard.includes('"completed", "follow-up"'));
  assert(main.includes("hasWaitingRuntime"));
  // Exercise the native ticket read/write methods, not just shared metadata helpers.
  const nativeFile = new (class TFile { constructor() { this.path = page.file.path; } })();
  Object.assign(mainContext, {
    TFile: nativeFile.constructor,
    normalizeTicketId: value => value,
    matchTodoHeading: line => line.match(/^(#{1,6})\s+.*To-Do/),
    localIsoDateTime: () => "2026-10-07 12:00:00"
  });
  for (const name of ["encodeTodoDetail", "decodeTodoDetail"]) vm.runInContext(fn(main, name), mainContext);
  const readStart = main.indexOf("  async readTodoTasks(");
  const updateStart = main.indexOf("  async updateTodoTaskDetails(");
  const native = vm.runInContext("({" + main.slice(readStart, main.indexOf("\n  generalTodoFile(", readStart))
    + "," + main.slice(updateStart, main.indexOf("\n  async deleteTodoTask(", updateStart)) + "})", mainContext);
  native.rootTicketFile = () => nativeFile;
  native.touchTodoLastChecked = async () => {};
  native.app = { vault: { read: async () => markdown, getAbstractFileByPath: () => nativeFile,
    process: async (_file, transform) => { markdown = transform(markdown); } } };
  let nativeTask = (await native.readTodoTasks("CR1"))[3];
  nativeTask = await native.updateTodoTaskDetails(nativeTask, { status: "waiting", result: "- confirmed", waitingReason: "승인 대기", followUpDate: "2026-10-15" });
  nativeTask = (await native.readTodoTasks("CR1"))[3];
  assert.equal(nativeTask.status, "waiting");
  assert.equal(nativeTask.waitingReason, "승인 대기");
  assert.equal(nativeTask.followUpDate, "2026-10-15");
  assert.equal(nativeTask.waitingSince, "2026-10-07 12:00");
  assert.equal(nativeTask.details, "- scope");
  assert.equal(nativeTask.result, "- confirmed");
  assert.equal(nativeTask.dueDate, "2026-10-20");
  await native.updateTodoTaskDetails(nativeTask, { status: "in-progress" });
  assert.equal((await native.readTodoTasks("CR1"))[3].status, "in-progress");
  assert.deepStrictEqual(Array.from((await native.readTodoTasks("CR1")).slice(0, 3), t => t.status), ["pending", "in-progress", "done"]);
  console.log("Pending storage, legacy compatibility, transitions, follow-up, and shared UI checks passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
