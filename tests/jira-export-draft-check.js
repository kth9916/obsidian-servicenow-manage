const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const source = fs.readFileSync(path.join(__dirname, "..", "resources", "업무현황.md"), "utf8");
const page = Object.freeze({ file: Object.freeze({ path: "tickets/source.md" }), short_description: "Original description", status: "In Progress" });
const context = vm.createContext({
  pages: [{ page }], normalizeValue: value => value == null ? "" : String(value),
  escapeHtml: value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
  escapeAttribute: value => String(value).replaceAll('"', "&quot;")
});
for (const name of ["jiraExportRowKey", "jiraExportDraftValues", "buildJiraEditableJson", "parseJiraEditableJson", "jiraExportValue", "jiraWikiCell", "jiraHtmlCell", "normalizeJiraDetailLines", "jiraGroupedTodoDetails", "buildJiraExportPayload", "buildJiraCellTextPayload", "buildJiraJsonPayload", "collapseJiraTasksByTicket"]) {
  const match = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert(match, name); vm.runInContext(match[0], context);
}
const fields = [
  { key: "number", label: "No.", value: (_t, _p, i) => i + 1 },
  { key: "ticket", label: "Ticket No.", value: t => t.ticketId || "" },
  { key: "description", label: "Description", value: (_t, p) => p?.short_description || "" },
  { key: "todo", label: "To-Do", value: t => t.text || "" },
  { key: "memo", label: "Memo", value: t => t.jiraMemo || "" }
];
const tasks = [
  { id: "linked-a", ticketId: "CR0000000", filePath: page.file.path, text: "Linked A", status: "pending" },
  { id: "linked-b", ticketId: "CR0000000", filePath: page.file.path, text: "Linked B", status: "done" },
  { id: "general-a", ticketId: "", text: "Independent A", status: "pending" },
  { id: "general-b", ticketId: "", text: "Independent B", status: "in-progress" },
  { id: "general-c", ticketId: "  ", text: "Independent C", status: "done" },
  { id: "general-d", text: "Independent D", status: "pending" }
].map(Object.freeze);
Object.freeze(tasks);
const before = JSON.stringify({ tasks, page });
const grouped = Array.from(context.collapseJiraTasksByTicket(tasks));
assert.equal(grouped.length, 5);
assert.equal(grouped[0].groupedTaskCount, 2);
assert.deepEqual(grouped.slice(1).map(row => row.text), tasks.slice(2).map(row => row.text));
assert.equal(new Set(grouped.map(context.jiraExportRowKey)).size, 5);
const drafts = new Map([
  ["task:general-a", { ticket: "CR0000000", description: "Export only", memo: "First paragraph\n\n- A\n  - Nested" }],
  ["task:general-b", { ticket: "CR0000000", description: "Another independent job" }],
  ["ticket:CR0000000", { description: "" }]
]);
const rows = grouped.map(task => ({ ...task, jiraExportValues: context.jiraExportDraftValues(task, drafts, fields) }));
assert.equal(context.jiraExportValue(fields[2], rows[0], 0), "", "intentional blank must not fall back to the ticket description");
assert.equal(context.jiraExportValue(fields[2], rows[1], 1), "Export only");
assert.equal(context.jiraExportValue(fields[2], rows[2], 2), "Another independent job");
assert.equal(context.collapseJiraTasksByTicket(rows).length, 5, "edited display numbers must not regroup unrelated work");
const table = context.buildJiraExportPayload(rows, fields), text = context.buildJiraCellTextPayload(rows, fields), json = context.buildJiraJsonPayload(rows, fields);
assert.equal(JSON.stringify(table.rows), JSON.stringify(text.rows));
assert.deepEqual(JSON.parse(JSON.stringify(table.rows)), JSON.parse(json.text).map(row => fields.map(field => row[field.label])));
assert(text.text.includes("Export only") && text.text.includes("Another independent job"));
assert(!json.text.includes("jiraExportGroupId") && !json.text.includes("jiraExportMembers"));
const raw = JSON.parse(context.buildJiraEditableJson(rows, fields));
raw[1].Description = "JSON edited\n\n- Bullet"; raw[2]["Ticket No."] = "";
const changes = context.parseJiraEditableJson(JSON.stringify(raw), rows, fields);
assert.equal(changes.find(change => change.task.id === "general-a").values.description, "JSON edited\n\n- Bullet");
assert.equal(changes.find(change => change.task.id === "general-b").values.ticket, "");
assert.throws(() => context.parseJiraEditableJson("{oops", rows, fields), /JSON/);
const valid = JSON.parse(context.buildJiraEditableJson(rows, fields));
for (const alter of [
  data => data.reverse(),
  data => data.pop(), data => { data[1]["No."] = data[0]["No."]; },
  data => { delete data[0]["No."]; }, data => { delete data[0].Description; },
  data => { data[0].Unknown = "extra"; }, data => { data[0].Description = { nested: true }; },
  data => { data[0] = null; }, data => { data[0]["No."] = "01"; },
  data => { Object.defineProperty(data[0], "__proto__", { value: { polluted: true }, enumerable: true }); }
]) {
  const copy = JSON.parse(JSON.stringify(valid)); alter(copy);
  assert.throws(() => context.parseJiraEditableJson(JSON.stringify(copy), rows, fields));
}
assert.equal({}.polluted, undefined);
const noNumber = fields.filter(field => field.key !== "number");
assert(Object.hasOwn(JSON.parse(context.buildJiraEditableJson(rows, noNumber))[0], "No."));
assert(!Object.hasOwn(JSON.parse(context.buildJiraJsonPayload(rows, noNumber).text)[0], "No."));
assert.throws(() => context.buildJiraEditableJson(rows, [...fields, { key: "duplicate", label: "Description" }]), /중복/);
drafts.set("task:linked-a", { description: "Individual override" });
assert.equal(context.jiraExportDraftValues(tasks[0], drafts, fields).description, "Individual override");
assert(context.jiraExportDraftValues(grouped[0], drafts, fields).description.includes("Individual override"));
const unsafe = { ...rows[1], jiraExportValues: { description: '<img src=x onerror="alert(1)">' } };
assert(!context.buildJiraExportPayload([unsafe], fields).html.includes("<img"));
assert.equal(JSON.stringify({ tasks, page }), before, "export drafts and grouping must never mutate original tasks or metadata");
const modal = source.slice(source.indexOf("function openJiraExportModal("), source.indexOf("\nfunction todoCalendarDate("));
context.jiraExportEdits = new Map([["task:linked-a", { description: "A draft" }], ["task:linked-b", { description: "Hidden B draft" }]]);
context.jiraMemoValues = new Map(); context.memoKey = row => context.jiraExportRowKey(row);
vm.runInContext(modal.match(/    function writeExportField\([^]*?\n    \}/)[0], context);
context.writeExportField(context.collapseJiraTasksByTicket([tasks[0]])[0], "description", "Filtered group edit");
assert(!context.jiraExportEdits.has("task:linked-a"));
assert.equal(context.jiraExportEdits.get("task:linked-b").description, "Hidden B draft", "a filtered group edit must preserve excluded individual drafts");
context.writeExportField(grouped[0], "description", "Whole group edit");
assert(!context.jiraExportEdits.has("task:linked-b"));
context.writeExportField(tasks[2], "number", "999");
assert(!context.jiraExportEdits.get("task:general-a"));
assert(!/\.vault\.(?:modify|append|create|process)\s*\(|processFrontMatter\s*\(|updateTodoTaskDetails\s*\(|savePluginData\s*\(/.test(modal));
assert(modal.includes('value: (_task, page, _index, item) => page ? col.value(page, item) : ""'), "ticket-only custom columns must be blank rather than throwing for independent work");
for (const marker of ['cell.addEventListener("dblclick", edit)', 'event.key === "F2"', 'pre.addEventListener("dblclick"', 'editButton.addEventListener("click"', 'jsonEditButton.addEventListener("click"', 'closeActiveExportEditor?.()', 'document.removeEventListener("keydown", trapKeys, true)', 'const exportSourceTasks = todoItems.map']) assert(modal.includes(marker), marker);
console.log("Jira Export draft checks passed: independent ticketless rows, stable identity, intentional blanks, grouped/individual drafts, all output formats, full JSON validation, XSS escaping, original immutability and editor wiring.");
