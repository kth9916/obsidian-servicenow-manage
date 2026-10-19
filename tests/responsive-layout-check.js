const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
const dashboard = fs.readFileSync(path.join(__dirname, "..", "resources", "업무현황.md"), "utf8");
const context = vm.createContext({ Map, Set, console, cleanDashboardFrontmatter: value => value });
for (const name of ["normalizePopupWidthPercent", "responsiveActionRows", "layoutResponsiveActions", "upgradeDashboardRuntime"]) {
  vm.runInContext(source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0], context);
}
const helpers = vm.runInContext("({normalizePopupWidthPercent, responsiveActionRows, layoutResponsiveActions, upgradeDashboardRuntime})", context);
for (const value of [undefined, null, "", "bad", Infinity]) assert.equal(helpers.normalizePopupWidthPercent(value), 75);
for (const [value, expected] of [[50, 50], [75, 75], [95, 95], [10, 50], [110, 95], [73, 75]]) assert.equal(helpers.normalizePopupWidthPercent(value), expected);
assert.equal(helpers.responsiveActionRows(0, 1000).length, 0);
for (const width of [0, 320, 480, 680, 1024, 1366, 1920, 2560, 3840]) {
  for (let count = 1; count <= 24; count++) {
    const rows = Array.from(helpers.responsiveActionRows(count, width));
    assert.equal(rows.reduce((sum, size) => sum + size, 0), count);
    assert(Math.max(...rows) - Math.min(...rows) <= 1, "rows must be balanced, not a full row followed by a tiny orphan");
    if (width >= 180) assert(rows.every(size => size * 180 + (size - 1) * 8 <= width));
  }
}
assert.deepEqual(Array.from(helpers.responsiveActionRows(9, 1500, 200)), [5, 4]);
assert.deepEqual(Array.from(helpers.responsiveActionRows(10, 850, 180)), [4, 3, 3]);
function style(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getPropertyValue: key => values.get(key) || "", getPropertyPriority: () => "", setProperty: (key, value) => values.set(key, value), removeProperty: key => values.delete(key), display: "" };
}
const children = Array.from({ length: 10 }, () => ({ style: style(), hidden: false, classList: { contains: () => false } }));
children[9].hidden = true;
const bar = { children, clientWidth: 1500, classList: { add: () => {} }, isConnected: true };
helpers.layoutResponsiveActions(bar, 200);
assert.equal(children[0].style.getPropertyValue("--snm-action-basis"), "calc((100% - 32px) / 5)");
assert.equal(children[8].style.getPropertyValue("--snm-action-basis"), "calc((100% - 24px) / 4)");
assert.equal(children[9].style.getPropertyValue("--snm-action-basis"), "", "hidden feature buttons do not create empty slots");
function method(name) {
  const start = source.search(new RegExp(`^  (?:async )?${name}\\(`, "m")); assert(start >= 0, name);
  const rest = source.slice(start), end = rest.slice(1).search(/\n  (?:async )?\w+\(/);
  return rest.slice(0, end + 1).trim();
}
const plugin = vm.runInContext(`({${["applyPopupLayoutSettings", "setPopupWidthPercent", "observeResponsiveActions"].map(method).join(",")}})`, context);
const first = { documentElement: { style: style() } }, second = { documentElement: { style: style({ "--snm-popup-width": "65vw" }) } };
context.document = first;
plugin.settings = { popupWidthPercent: 75, preserved: "unchanged" };
plugin.app = { workspace: { iterateAllLeaves: callback => callback({ view: { containerEl: { ownerDocument: second } } }) } };
let saves = 0, fail = false;
plugin.savePluginData = async () => { saves++; if (fail) throw new Error("simulated save failure"); };
(async () => {
  plugin.applyPopupLayoutSettings();
  for (const doc of [first, second]) assert.equal(doc.documentElement.style.getPropertyValue("--snm-popup-width"), "75vw");
  assert.equal(plugin.popupLayoutDocuments.get(second).value, "65vw", "remember preexisting styles for unload");
  assert.equal(saves, 0, "applying visual preferences must not rewrite ticket data");
  await plugin.setPopupWidthPercent("50");
  for (const doc of [first, second]) assert.equal(doc.documentElement.style.getPropertyValue("--snm-popup-width"), "50vw");
  assert.equal(plugin.settings.preserved, "unchanged"); assert.equal(saves, 1);
  fail = true; await assert.rejects(plugin.setPopupWidthPercent(95), /save failure/);
  assert.equal(plugin.settings.popupWidthPercent, 50);
  for (const doc of [first, second]) assert.equal(doc.documentElement.style.getPropertyValue("--snm-popup-width"), "50vw", "failed save rolls back every window");
  let disconnected = 0;
  plugin.responsiveActionObservers = new Map([[{ isConnected: false }, { disconnect: () => disconnected++ }]]);
  plugin.observeResponsiveActions(bar, 200); assert.equal(disconnected, 1);
  const old = dashboard.replace('tableTools.classList.add("opus-table-tools");', 'tableTools.classList.add("old-tools");');
  const upgraded = helpers.upgradeDashboardRuntime("User intro\n" + old + "\nUser ending", dashboard);
  assert(upgraded.includes('tableTools.classList.add("opus-table-tools");'));
  assert(upgraded.startsWith("User intro\n") && upgraded.endsWith("\nUser ending"));
  assert.equal(helpers.upgradeDashboardRuntime(upgraded, dashboard), upgraded);
  assert(source.includes('setName("팝업 너비 (전역)")'));
  assert(source.includes('this.app.workspace.on("layout-change", () => this.applyPopupLayoutSettings())'));
  assert(source.includes('this.responsiveActionObservers?.forEach(observer => observer.disconnect())'));
  assert(css.includes('var(--snm-popup-width, 75vw)'));
  assert(css.includes('@container snm-popup (max-width: 840px)'));
  assert(dashboard.includes('@container snm-dashboard (max-width: 1100px)'));
  assert(dashboard.includes('boardActions.append(manageActions, createActions, viewOptions)'));
  assert(!dashboard.includes('observeResponsiveActions?.(boardActions'), "navigation controls must not be expanded into equal-width tiles");
  console.log("Responsive layout checks passed: shared 75% default, bounded preferences, all-window updates, rollback, balanced controls, observer cleanup and dashboard upgrade.");
})().catch(error => { console.error(error); process.exitCode = 1; });
