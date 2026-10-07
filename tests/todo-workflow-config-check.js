const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "main.js"), "utf8");
const dashboard = fs.readFileSync(path.join(root, "resources", "업무현황.md"), "utf8");
function fn(name) {
  const start = source.search(new RegExp(`^function ${name}\\(`, "m"));
  assert(start >= 0, name);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n(?:async )?function /);
  return rest.slice(0, end + 1);
}
function method(name) {
  let start = source.indexOf(`  async ${name}(`);
  if (start < 0) start = source.indexOf(`  ${name}(`);
  assert(start >= 0, name);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n  (?:async )?\w+\(/);
  return rest.slice(0, end + 1).trim();
}
class TFile { constructor() { this.path = "ServiceNow/티켓/CR1/CR1.md"; } }
class Select {
  constructor() { this.options = []; }
  replaceChildren() { this.options = []; }
  appendChild(option) { this.options.push(option); }
}
const context = vm.createContext({ document: { createElement: () => ({}) }, TFile, Map, Set, encodeURIComponent, decodeURIComponent,
  normalizeTicketId: value => value, localIsoDateTime: () => "2026-10-07 09:00:00",
  appendEntryToMarkdownSection: (text, _section, entry) => text + "\n" + entry });
vm.runInContext(source.slice(source.indexOf("const DEFAULT_TODO_WORKFLOW ="), source.indexOf("const CR_STATES =")), context);
for (const name of ["stripCltTodoMetadata", "encodeTodoDetail", "readTodoWaiting", "todoWaitingChanges", "todoWaitingMarker"]) vm.runInContext(fn(name), context);
const plugin = vm.runInContext("({" + ["getTodoWorkflow", "assertTodoStatusEnabled", "saveTodoWorkflow", "addTodoToGeneral", "addTodoToTicket"].map(method).join(",") + "})", context);
plugin.settings = {};
const events = [];
let writes = 0, ensured = 0, refreshes = 0, persisted = null, markdown = "## ✅ To-Do\n- [ ] Legacy\n";
plugin.savePluginData = async () => { persisted = JSON.parse(JSON.stringify(plugin.settings)); };
plugin.refreshTodoWorkflowViews = () => { refreshes++; };
plugin.app = { workspace: { trigger: event => events.push(event) }, vault: { process: async (_file, transform) => { writes++; markdown = transform(markdown); } } };
plugin.rootTicketFile = () => new TFile();
plugin.ensureGeneralTodoFile = async () => { ensured++; return new TFile(); };
plugin.touchTodoLastChecked = async () => {};
(async () => {
  assert.deepStrictEqual(Array.from(plugin.getTodoWorkflow(), s => s.key), ["pending", "in-progress", "waiting", "done"]);
  const configured = [
    { key: "in-progress", label: "작업 중", enabled: true }, { key: "done", label: "처리 완료", enabled: true },
    { key: "waiting", label: "승인 대기", enabled: false }, { key: "pending", label: "준비", enabled: false }
  ];
  await plugin.saveTodoWorkflow(configured);
  assert.equal(writes, 0, "Workflow changes must never rewrite task notes");
  assert.equal(refreshes, 1); assert(events.includes("servicenow-manage:todo-workflow-changed"));
  plugin.settings = JSON.parse(JSON.stringify(persisted));
  assert.deepStrictEqual(Array.from(plugin.getTodoWorkflow(), s => s.label), ["작업 중", "처리 완료", "승인 대기", "준비"]);
  const select = new Select(); context.fillTodoStatusSelect(select, plugin, "pending");
  assert.deepStrictEqual(select.options.map(o => o.value), ["in-progress", "done"]); assert.equal(select.value, "in-progress");
  context.fillTodoStatusSelect(select, plugin, "waiting", true);
  assert.equal(select.value, "waiting"); assert(select.options[0].disabled); assert(select.options[0].textContent.includes("기존 상태"));
  await assert.rejects(plugin.addTodoToTicket("CR1", "Forbidden", "", "waiting"), /사용하지 않는/);
  await assert.rejects(plugin.addTodoToGeneral("Forbidden", "", "pending"), /사용하지 않는/);
  assert.equal(writes, 0); assert.equal(ensured, 0);
  await plugin.addTodoToTicket("CR1", "Default task"); assert(markdown.includes("clt-todo:in-progress"));
  await plugin.addTodoToGeneral("Completed", "", "done"); assert(markdown.includes("- [x]")); assert(markdown.includes("clt-todo-completed:"));
  const before = JSON.stringify(plugin.settings);
  await assert.rejects(plugin.saveTodoWorkflow(configured.map(s => ({ ...s, enabled: false }))), /최소 한/);
  assert.equal(JSON.stringify(plugin.settings), before);
  plugin.savePluginData = async () => { throw new Error("disk error"); };
  await assert.rejects(plugin.saveTodoWorkflow(configured.slice().reverse()), /disk error/); assert.equal(JSON.stringify(plugin.settings), before);
  const normalized = context.normalizeTodoWorkflow([{ key: "done", label: "", enabled: true }, { key: "done", label: "duplicate" }, { key: "unknown" }]);
  assert.equal(normalized.length, 4); assert.equal(normalized[0].key, "done"); assert.equal(normalized[0].label, "완료");
  assert(dashboard.includes("function activeTodoStatuses(")); assert(dashboard.includes("fillDashboardTodoStatusSelect(statusSelect, preselectedStatus)"));
  assert(dashboard.includes("fillDashboardTodoStatusSelect(statusSelect, task.status, true)"));
  assert(dashboard.includes("workflowPlugin.openTodoWorkflowSettings()")); assert(dashboard.includes("비활성화 상태 보기"));
  assert(dashboard.includes('dv.component.registerEvent(todoWorkflowRef)'));
  assert(source.includes("fillTodoStatusSelect(status, this.plugin, this.preselectedStatus)"));
  console.log("Shared To-Do workflow checks passed: names, enabled states, order, reload, creation gates, preserved tasks, defaults, rollback and both UI paths.");
})().catch(error => { console.error(error); process.exitCode = 1; });
