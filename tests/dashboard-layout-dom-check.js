const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const dashboard = fs.readFileSync(path.join(__dirname, "..", "resources", "업무현황.md"), "utf8");
const plugin = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const bundled = plugin.match(/const EMBEDDED_DASHBOARD_GZIP_BASE64 = "([^"]+)";/);
assert(bundled, "embedded dashboard is required for installed-vault updates");
const embedded = require("zlib").gunzipSync(Buffer.from(bundled[1], "base64")).toString("utf8");
assert(embedded.replace(/\r\n/g, "\n") === dashboard.replace(/\r\n/g, "\n"), "regenerate the embedded dashboard before testing or installing a layout change");
class Element {
  constructor(tag, doc) { this.tagName = tag; this.ownerDocument = doc; this.children = []; this.attributes = {}; this.listeners = {}; this.textContent = ""; }
  appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
}
const document = { createElement(tag) { return new Element(tag, this); } };
const container = document.createElement("section");
let saves = 0, renders = 0;
const context = vm.createContext({ document, container, settings: { todoDisplayMode: "board", todoCalendarAnchor: "" }, saveSettings: () => saves++, renderTodoBoard: () => renders++, formatDateTime: () => "2026-10-19 14:30", dv: { el: () => { throw new Error("Markdown rendering must not be used for structural layout"); } } });
vm.runInContext(dashboard.match(/function dashboardElement\([^]*?\n\}/)[0], context);
const raw = vm.runInContext('dashboardElement("div", "")', context);
assert.equal(raw.children.length, 0, "empty structural containers must contain no Markdown span/grid item");
context.parent = raw;
vm.runInContext('dashboardElement("h3", "Title", {container:parent}); dashboardElement("div", "", {container:parent,cls:["actions","compact"]});', context);
assert.deepEqual(raw.children.map(child => child.tagName), ["h3", "div"]);
assert.equal(raw.children[1].className, "actions compact");
const input = vm.runInContext('dashboardElement("input", "", {placeholder:"Search", attr:{"aria-label":"Search"}})', context);
assert.equal(input.attributes.placeholder, "Search"); assert.equal(input.attributes["aria-label"], "Search");
const popoutDocument = { createElement(tag) { return new Element(tag, this); } };
context.popoutParent = popoutDocument.createElement("div");
assert.equal(vm.runInContext('dashboardElement("button", "Refresh", {container:popoutParent})', context).ownerDocument, popoutDocument);
assert(!/\bdv\.el\s*\(/.test(dashboard), "do not reintroduce empty Markdown wrapper elements in a layout node");
const selectStart = dashboard.indexOf('    const displaySelect = document.createElement("select");');
const selectEnd = dashboard.indexOf('    const addButton =', selectStart);
assert(selectStart >= 0 && selectEnd > selectStart);
vm.runInContext(dashboard.slice(selectStart, selectEnd) + "\nthis.viewSelect = displaySelect;", context);
assert.deepEqual(context.viewSelect.children.map(child => [child.value, child.textContent]), [["board", "보드"], ["calendar", "달력"]]);
context.viewSelect.value = "calendar"; context.viewSelect.listeners.change();
assert.equal(context.settings.todoDisplayMode, "calendar"); assert.equal(context.settings.todoCalendarAnchor, "2026-10-19");
context.viewSelect.value = "board"; context.viewSelect.listeners.change();
assert.equal(context.settings.todoDisplayMode, "board"); assert.equal(context.settings.todoCalendarAnchor, "2026-10-19");
assert.equal(saves, 2); assert.equal(renders, 2);
assert(dashboard.includes("viewOptions.append(groupToggle, displaySelect);"), "the view selector belongs to the right of ticket grouping");
assert(dashboard.includes('groupCheckbox.disabled = settings.todoDisplayMode === "calendar";'));
assert(!dashboard.includes("observeResponsiveActions?.(boardActions") && !dashboard.includes("observeResponsiveActions?.(actions, 145)"), "compact navigation toolbars must not stretch into command tiles");
assert(dashboard.includes(".opus-toolbar .opus-popup-panel { top: calc(100% + 6px);"), "menus must open below the entire toolbar rather than covering the controls");
console.log("Dashboard DOM layout checks passed: no Markdown placeholder spans, native ownership/attributes, compact grouped controls and persisted Board/Calendar selector.");
