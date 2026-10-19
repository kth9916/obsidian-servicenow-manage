const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
class Element {
  constructor(tag, options = {}) { this.tag = tag; this.children = []; this.events = {}; this.attrs = options.attr || {}; this.cls = options.cls || ""; this.text = options.text || ""; this.type = options.type || ""; this.value = ""; this.checked = false; this.disabled = false; }
  createEl(tag, options) { const child = new Element(tag, options); this.children.push(child); return child; }
  createDiv(options) { return this.createEl("div", options); }
  createSpan(options) { return this.createEl("span", options); }
  empty() { this.children = []; this.text = ""; }
  setText(value) { this.text = value; }
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  trigger(name) { for (const fn of this.events[name] || []) fn({ preventDefault() {} }); }
  all() { return this.children.flatMap(child => [child, ...child.all()]); }
  querySelectorAll(tag) { return this.all().filter(child => child.tag === tag); }
}
const context = vm.createContext({ console, normalizeTicketId: value => String(value || "").trim().toUpperCase() });
for (const name of ["normalizeMeetingTicketIds", "createMeetingTicketPicker"]) vm.runInContext(main.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0], context);
const create = vm.runInContext("createMeetingTicketPicker", context);
const plugin = { rootTicketFiles: () => [{ id: "CR0000000" }, { id: "SR0000000" }, { id: "CR00000000" }], rootTicketIdFromFile: file => file.id,
  data: { tickets: { CR0000000: { shortDescription: "Booking follow-up" }, SR0000000: { shortDescription: "Weekly support" } } },
  app: { metadataCache: { getFileCache: () => ({ frontmatter: { short_description: "Deployment Review" } }) } } };
const host = new Element("div"), selected = new Set(), changes = [];
const picker = create(host, plugin, selected, { onChange: (ids, mode) => changes.push({ ids: Array.from(ids), mode: mode.ticketless }) });
const named = label => host.all().find(node => node.attrs["aria-label"] === label);
const search = named("회의록 연결 티켓 검색"), none = named("티켓 없음 (주간·공통 회의)");
const filter = text => { search.value = text; search.trigger("input"); };
const check = (id, value = true) => { const input = named(`${id} 선택`); assert(input, id); input.checked = value; input.trigger("change"); };
const chips = () => host.all().filter(node => node.cls === "clt-meeting-ticket-chip");
assert(!none.checked && !search.disabled, "new empty selection must not hide or disable ticket search");
filter("booking"); check("CR0000000");
filter("weekly support"); check("SR0000000");
assert.deepEqual([...selected], ["CR0000000", "SR0000000"]); assert.equal(chips().length, 2);
filter("CR0000000"); assert(named("CR0000000 선택").checked); check("CR0000000", false); assert.equal(chips().length, 1);
filter("deployment review"); check("CR00000000"); assert.equal(chips().length, 2, "metadata title is searchable");
named("SR0000000 선택 해제").trigger("click"); assert.deepEqual([...selected], ["CR00000000"]);
none.checked = true; none.trigger("change");
assert.equal(selected.size, 0); assert.equal(chips().length, 0); assert(search.disabled);
assert(host.querySelectorAll("input").filter(input => input.type === "checkbox" && input !== none).every(input => input.disabled && !input.checked));
check("CR0000000"); assert.equal(selected.size, 0, "even programmatic checkbox changes cannot defeat ticketless lock");
selected.add("CR0000000"); assert.equal(picker.getTicketIds().length, 0, "submit remains ticketless even if a stale caller mutates its Set"); selected.clear();
none.checked = false; none.trigger("change"); assert(!search.disabled); assert.equal(selected.size, 0, "old selections must never be restored");
check("CR0000000"); picker.setDisabled(true); assert(search.disabled && none.disabled); assert(named("CR0000000 선택 해제").disabled);
named("CR0000000 선택 해제").trigger("click"); assert.equal(selected.size, 1);
picker.setDisabled(false); assert(!search.disabled); assert.equal(picker.getTicketIds()[0], "CR0000000");
const emptyHost = new Element("div"), empty = create(emptyHost, { rootTicketFiles: () => [], rootTicketIdFromFile: () => "" }, new Set());
assert.equal(empty.getTicketIds().length, 0); assert(emptyHost.all().some(node => node.text === "일치하는 티켓이 없습니다."));
// Distinct all-zero placeholders keep public fixtures unrelated to real tickets.
const manyHost = new Element("div"), manyFiles = Array.from({ length: 50 }, (_, index) => ({ id: `CR${"0".repeat(index + 8)}` }));
create(manyHost, { rootTicketFiles: () => manyFiles, rootTicketIdFromFile: file => file.id }, new Set());
assert.equal(manyHost.querySelectorAll("input").filter(input => input.attrs["aria-label"]?.endsWith(" 선택")).length, 30, "large inventories remain bounded");
const manySearch = manyHost.all().find(node => node.attrs["aria-label"] === "회의록 연결 티켓 검색");
manySearch.value = manyFiles[49].id; manySearch.trigger("input");
assert(manyHost.all().some(node => node.attrs["aria-label"] === `${manyFiles[49].id} 선택`), "tickets outside the first page remain searchable");
const editHost = new Element("div"), oldIds = new Set(["CR0000000"]);
assert.equal(create(editHost, plugin, oldIds).getTicketIds().length, 1);
const editEmpty = new Element("div"); create(editEmpty, plugin, new Set(), { noTicketDefault: true });
assert(editEmpty.all().find(node => node.attrs["aria-label"] === "티켓 없음 (주간·공통 회의)").checked);
assert.equal((main.match(/= createMeetingTicketPicker\(/g) || []).length, 3, "file, Drive and later-link editor share one UI");
assert(!main.includes("복수 티켓 선택하기") && !main.includes("createMeetingTicketLinkChoice") && !main.includes("previousIds.forEach"));
assert(main.includes('new DriveMeetingCandidateModal(this.app, this, "", onImported).open()'));
assert(main.includes("const ticketIds = this.ticketPicker.getTicketIds();") && main.includes("importGoogleDriveMeeting(ticketIds, candidate)"), "Drive batches snapshot linked tickets once");
console.log("Meeting ticket picker checks passed: immediate searchable multi-select, title/number filters, persistent/removable chips, explicit ticketless lock without restoration, submit snapshots, disabled state, empty inventory and shared file/Drive/link UI.");
