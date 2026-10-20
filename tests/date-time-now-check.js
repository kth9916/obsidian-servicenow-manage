const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
const nowFieldRule = css.match(/\.snm-now-field\s*\{([^}]+)\}/)?.[1];
assert(nowFieldRule && /flex:\s*0\s+1\s+auto\s*;/.test(nowFieldRule), "shared Now wrappers must retain natural height in column labels, not a horizontal pixel flex-basis");
assert(/width:\s*100%/.test(nowFieldRule), "horizontal date controls must still fill their container");
let notify, watched, stopped = false;
class Element {
  constructor(tag = "div", type = "") { this.tag = tag; this.type = type; this.nodeType = 1; this.children = []; this.attrs = {}; this.events = {}; this.disabled = false; this.readOnly = false; this.className = ""; this.value = "";
    this.classList = { add: value => { this.className += " " + value; }, remove: value => { this.className = this.className.split(" ").filter(item => item !== value).join(" "); } }; }
  get isConnected() { return this === doc.body || Boolean(this.parent?.isConnected); }
  append(child) { child.remove(); this.children.push(child); child.parent = this; }
  before(child) { const parent = this.parent; child.remove(); parent.children.splice(parent.children.indexOf(this), 0, child); child.parent = parent; }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  replaceWith(child) { if (!this.parent) return; child.remove(); const parent = this.parent, index = parent.children.indexOf(this); parent.children.splice(index, 1, child); child.parent = parent; this.parent = null; }
  matches() { return this.tag === "input" && ["date", "time", "datetime-local"].includes(this.type); }
  closest(selector) { if (selector === "label") return null; if (selector === ".clt-todo-due-fields") return this.className.includes("clt-todo-due-fields") ? this : this.parent?.closest(selector); return this.scoped ? this : this.parent?.closest(selector); }
  querySelectorAll() { return this.children.flatMap(child => [...(child.matches() ? [child] : []), ...child.querySelectorAll()]); }
  querySelector(selector) { const type = selector.match(/type="([^"]+)"/)?.[1]; return this.querySelectorAll().find(child => !type || child.type === type); }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key] || ""; }
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  dispatchEvent(event) { for (const fn of this.events[event.type] || []) fn(event); }
}
const doc = { nodeType: 9, createElement: tag => new Element(tag), defaultView: {
  Event: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
  MutationObserver: class { constructor(fn) { notify = fn; } observe(_body, options) { watched = options; } disconnect() { stopped = true; } }
} };
doc.body = new Element(); doc.querySelectorAll = () => doc.body.querySelectorAll();
const scope = new Element(); scope.scoped = true; doc.body.append(scope);
const add = (type, parent = scope) => { const input = new Element("input", type); parent.append(input); return input; };
const date = add("date"), time = add("time"), datetime = add("datetime-local"), external = add("date", doc.body);
const pair = new Element(); pair.className = "clt-todo-due-fields"; scope.append(pair);
const pairDate = add("date", pair), pairTime = add("time", pair); pairTime.disabled = true;
pairDate.addEventListener("change", () => { pairTime.disabled = false; });
const sequence = [];
for (const [name, input] of [["date", pairDate], ["time", pairTime]]) for (const type of ["input", "change"]) input.addEventListener(type, () => sequence.push(`${name}.${type}`));
const helper = main.match(/function installDateTimeNowControls\([^]*?\n\}/)[0];
const context = vm.createContext({ localIsoDateTime: () => "2026-10-19T16:42:59" });
vm.runInContext(helper, context);
const dispose = context.installDateTimeNowControls(doc);
const button = input => input.parent.children.find(child => child.tag === "button");
const click = input => button(input).dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {} });
click(date); click(time); click(datetime); click(pairDate);
assert.equal(date.value, "2026-10-19"); assert.equal(time.value, "16:42"); assert.equal(datetime.value, "2026-10-19T16:42");
assert.equal(pairDate.value, "2026-10-19"); assert.equal(pairTime.value, "16:42");
assert.deepEqual(sequence, ["date.input", "date.change", "time.input", "time.change"]);
assert.equal(pair.children.filter(child => child.tag === "button").length, 1, "date/time pair gets exactly one button");
assert.equal(external.parent, doc.body, "never alter core Obsidian or other plugin inputs");
notify([{ type: "childList", addedNodes: [scope] }]);
assert.equal(pair.children.filter(child => child.tag === "button").length, 1, "repeat scans remain idempotent");
const late = add("date"); late.disabled = true;
notify([{ type: "childList", addedNodes: [late] }]); assert(button(late).disabled);
late.disabled = false; notify([{ type: "attributes", target: late }]); assert(!button(late).disabled);
late.readOnly = true; notify([{ type: "attributes", target: late }]); assert(button(late).disabled); click(late); assert.equal(late.value, "");
assert(watched.childList && watched.subtree && watched.attributeFilter.includes("disabled"));
dispose(); assert(stopped); assert.equal(date.parent, scope); assert.equal(pair.children.length, 2);
assert(main.includes('containerEl.addClass("snm-plugin-settings")') && main.includes("this.ensureDateTimeNowControls?.(doc)"));
assert(main.includes("this.dateTimeNowDocuments?.forEach(dispose => dispose())"));
console.log("Current-time controls checks passed: local date/time, paired events, dynamic editors, disabled/readonly fields, plugin-only scope, idempotence and unload cleanup.");
