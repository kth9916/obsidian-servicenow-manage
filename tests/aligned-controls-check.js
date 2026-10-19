const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const root = path.join(__dirname, "..");
const dashboard = fs.readFileSync(path.join(root, "resources", "업무현황.md"), "utf8");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const context = vm.createContext({ Set, Number, Boolean });
vm.runInContext(dashboard.slice(dashboard.indexOf("const TABLE_EDITABLE_DATE_MIN_WIDTH"), dashboard.indexOf("const DEFAULT_COLUMN_WIDTHS")) + "\nconst DEFAULT_COLUMN_WIDTHS = {releaseDate:190,scheduledDate:190,lastChecked:190,id:120};", context);
for (const field of ["releaseDate", "lastChecked", "scheduledDate"]) {
  for (const width of [undefined, null, 0, 36, 62, 92, "92", "invalid", Infinity, -100]) {
    context.width = width;
    assert.equal(vm.runInContext(`tableColumnWidth(${JSON.stringify(field)}, width)`, context), 190);
  }
  context.width = 240;
  assert.equal(vm.runInContext(`tableColumnWidth(${JSON.stringify(field)}, width)`, context), 240, "wider user preferences must remain intact");
}
assert.equal(vm.runInContext('tableColumnWidth("id", 70)', context), 70);
assert(dashboard.includes("const width = tableColumnWidth(column.key, settings.columnWidths[column.key]);"));
assert(dashboard.includes("editableDateColumns.has(key) ? TABLE_EDITABLE_DATE_MIN_WIDTH : 36,"), "column resize must enforce the same date minimum");
const upgrade = main.match(/function upgradeDashboardRuntime\([^]*?\n\}/)[0];
vm.runInContext(main.match(/function cleanDashboardFrontmatter\([^]*?\n\}/)[0] + "\n" + upgrade, context);
const previous = dashboard.replace('const DASHBOARD_LAYOUT_REVISION = "2026-10-19-compact-toolbars";', "// Earlier layout");
context.oldNote = "---\nuser_tag: preserved\n---\n\n" + previous + "\nManual ending";
context.bundle = dashboard;
const updated = vm.runInContext("upgradeDashboardRuntime(oldNote, bundle)", context);
assert(updated.includes('const DASHBOARD_LAYOUT_REVISION = "2026-10-19-compact-toolbars";'));
assert(updated.startsWith("---\nuser_tag: preserved\n---\n\n") && updated.endsWith("\nManual ending"), "upgrading managed UI must preserve metadata and trailing notes");
context.updated = updated;
assert.equal(vm.runInContext("upgradeDashboardRuntime(updated, bundle)", context), updated);
assert(dashboard.includes('remove.textContent = "삭제";'));
assert(dashboard.includes('cardActions.className = "opus-meeting-card-actions";'));
assert(dashboard.includes("cardActions.appendChild(edit);") && dashboard.includes("cardActions.appendChild(remove);"));
assert(main.includes('const actions = card.createDiv({ cls: "clt-meeting-card-actions" });'));
assert(main.includes('const remove = actions.createEl("button", {\n        cls: "clt-meeting-card-delete",\n        text: "삭제"'));
assert(!css.includes(".clt-meeting-card-delete { position: absolute"));
assert(!css.includes(".opus-meeting-link-edit { position: absolute"));
assert(css.includes(".opus-meeting-card-actions { align-items: center; display: flex; flex-wrap: nowrap;"));
assert(dashboard.includes(".opus-todo-board-toolbar { display: grid; grid-template-columns: minmax(0, 1fr);"));
assert(dashboard.includes("grid-template-columns: 116px minmax(166px, 1fr) 12px minmax(166px, 1fr) 96px"));
assert(css.includes(".snm-now-field > .snm-now-button { width: 28px; min-width: 28px; padding: 3px; font-size: 0; }"), "compact clock must override themed button font sizes");
console.log("Aligned controls checks passed: saved date widths and resize clamp, existing dashboard migration, shared horizontal meeting actions and responsive date-range groups.");
