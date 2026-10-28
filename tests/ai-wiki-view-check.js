const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
class Element {
  constructor(tag = "div", options = {}) { this.tag = tag; this.textContent = options.text || ""; this.attrs = options.attr || {}; this.cls = options.cls || ""; this.value = options.value || ""; this.children = []; this.events = {}; this.scrollTop = 0; }
  createEl(tag, options) { const node = new Element(tag, options); this.children.push(node); return node; }
  createDiv(options) { return this.createEl("div", options); } createSpan(options) { return this.createEl("span", options); }
  setText(text) { this.textContent = text; } setAttr(key, value) { this.attrs[key] = value; } addClass(name) { this.cls += " " + name; }
  addEventListener(name, callback) { this.events[name] = callback; } empty() { this.children = []; }
  all() { return this.children.flatMap(child => [child, ...child.all()]); }
}
const opened = [], navigated = [], notices = [], refs = new Set(), files = new Map(), texts = new Map();
let reads = 0, writes = 0, saves = 0, failSave = false, loads = 0, unloads = 0, rendered = [];
class TFile { constructor(path) { this.path = path; this.basename = path.split("/").at(-1).replace(/\.md$/, ""); } }
class Modal {
  constructor(app) { this.app = app; this.contentEl = new Element(); this.modalEl = new Element(); this.titleEl = new Element(); }
  open() { opened.push(this); return this.onOpen?.(); } close() { this.onClose?.(); this.closed = true; }
}
class ConfirmActionModal extends Modal { constructor(app, title, message, confirm) { super(app); this.message = message; this.confirm = confirm; } }
const events = { on(event, callback) { const ref = { event, callback }; refs.add(ref); return ref; }, offref(ref) { refs.delete(ref); } };
const ctx = vm.createContext({ Modal, TFile, ConfirmActionModal, setTimeout, clearTimeout, parseYaml: JSON.parse,
  Notice: class { constructor(message) { notices.push(message); } }, localIsoDateTime: () => "2026-10-28 10:00",
  MarkdownRenderChild: class { load() { loads++; } unload() { unloads++; } },
  MarkdownRenderer: { render: async (app, markdown, target, sourcePath) => { rendered.push([markdown, sourcePath]); target.createEl("p", { text: markdown }); } }
});
vm.runInContext(source.slice(source.indexOf("// BEGIN AI WIKI"), source.indexOf("// END AI WIKI")), ctx);
for (const name of ["normalizedHeadingText", "stripWorkLogEntryPrefix", "extractTicketWorkLogs", "appendEntryToMarkdownSection"]) vm.runInContext(source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0], ctx);
function method(name) {
  const start = source.search(new RegExp(`^  (?:async )?${name}\\(`, "m")), rest = source.slice(start), end = rest.slice(1).search(/\n  (?:async )?\w+\(/);
  assert(start >= 0); return rest.slice(0, end + 1).trim();
}
const plugin = vm.runInContext("({" + ["setAiWikiLayout", "linkAiWikiRecordToTickets"].map(method).join(",") + "})", ctx);
plugin.settings = { aiWikiEnabled: true, aiWikiLayout: "cards", untouched: "preserve" };
plugin.aiWikiFolder = () => "Team/Wiki"; plugin.aiWikiViews = new Set();
plugin.savePluginData = async () => { saves++; if (failSave) throw Error("disk unavailable"); };
plugin.refreshViews = () => {};
plugin.rootTicketFile = ticket => files.get(`Team/Tickets/${ticket}.md`);
plugin.app = { metadataCache: events, workspace: { getLeaf: () => ({ openFile: async file => navigated.push(file.path) }), openLinkText: async link => navigated.push(link) }, vault: { ...events,
  getAbstractFileByPath: name => files.get(name), read: async file => { reads++; if (!texts.has(file.path)) throw Error("missing"); return texts.get(file.path); },
  process: async (file, transform) => { const next = transform(texts.get(file.path)); if (next !== texts.get(file.path)) { writes++; texts.set(file.path, next); } }
} };
const add = (name, text) => { const file = new TFile(name); files.set(name, file); texts.set(name, text); return file; };
const fields = { type: "ai-wiki-record", record_id: "record-1", chat_id: "chat-1", task_id: "task-1", title: "<img src=x onerror=alert(1)>", summary: "Result", next_action: "Next", unknowns: "Runtime not verified", created: "2026-10-28", updated: "2026-10-28 17:00", tickets: ["CR0000000"], topic: "Analysis", sources: ["evidence.md"], verification: "verified" };
const recordFile = add("Team/Wiki/Records/Example.md", `---\n${JSON.stringify(fields)}\n---\n# Human note\n\n- First bullet\n- Second bullet\n`);
const ticketFile = add("Team/Tickets/CR0000000.md", "# Ticket\n\n## 📝 작업 일지\n\n## To-Do\nKeep manual task\n");
const plainFile = add("Team/Wiki/Knowledge/Plain.md", "# Plain\n\nHuman knowledge without frontmatter\n");
plugin.aiWikiRecords = () => [ctx.aiWikiRecord(recordFile, fields), ctx.aiWikiRecord(plainFile, {})];
const Wiki = vm.runInContext("AiWikiModal", ctx), Preview = vm.runInContext("AiWikiRecordModal", ctx);
const find = (modal, label) => modal.contentEl.all().find(el => el.textContent === label);
(async () => {
  const records = plugin.aiWikiRecords(), ordered = ctx.sortAiWikiRecords([...records, { ...records[0], file: new TFile("last.md"), title: "Older", date: "2026-10-27T10:00" }]);
  assert.equal(ordered[0].date, "2026-10-28 17:00"); assert.equal(ordered.at(-1).date, ""); assert.equal(records[0].title, fields.title, "sorting must not mutate records");
  const wiki = new Wiki(plugin.app, plugin); wiki.onOpen(); assert.equal(reads, 0, "cards use metadata only");
  await find(wiki, fields.title).events.click(); const detail = opened.at(-1); await detail.render();
  assert(detail instanceof Preview); assert(!wiki.closed); assert.equal(navigated.length, 0); assert.equal(writes, 0);
  assert(rendered.at(-1)[0].includes("- First bullet\n- Second bullet")); assert.equal(rendered.at(-1)[1], recordFile.path);
  assert(find(detail, "CR0000000 · 아직 연결 안 됨")); assert(find(detail, "티켓 일지에 요약 추가"));
  await find(detail, "티켓 일지에 요약 추가").events.click(); const confirmation = opened.at(-1);
  assert(confirmation instanceof ConfirmActionModal); assert(confirmation.message.includes("자동 반영되지 않습니다")); assert.equal(writes, 0, "opening confirmation is not approval");
  await confirmation.confirm(); assert.equal(writes, 1); assert(find(detail, "CR0000000 · 요약 연결됨")); assert(texts.get(ticketFile.path).includes("Keep manual task"));
  const linked = texts.get(ticketFile.path); await find(detail, "티켓 일지에 요약 추가").events.click(); await opened.at(-1).confirm();
  assert.equal(writes, 1); assert.equal(texts.get(ticketFile.path), linked, "duplicate confirmation must not append again");
  await find(detail, "일지 위치 열기").events.click(); assert(navigated.at(-1).includes("#📝 작업 일지")); assert(wiki.closed && detail.closed);
  assert.equal(loads, unloads); assert.equal(refs.size, 0);
  const second = new Wiki(plugin.app, plugin); second.onOpen(); second.query = "Result";
  const layout = second.contentEl.all().find(el => el.attrs["aria-label"] === "AI Wiki 표시 방식"); reads = 0; layout.value = "table"; await layout.events.change();
  assert.equal(plugin.settings.aiWikiLayout, "table"); assert.equal(second.query, "Result"); assert.equal(reads, 0, "table preference/filter/sort must not read note bodies");
  assert(second.contentEl.all().some(el => el.tag === "table")); assert.equal(second.contentEl.all().filter(el => el.tag === "tbody")[0].children.length, 1);
  const sort = second.contentEl.all().find(el => el.attrs["aria-label"] === "기록명 정렬"); sort.events.click(); assert.equal(second.sortKey, "title"); assert.equal(reads, 0);
  failSave = true; await assert.rejects(() => plugin.setAiWikiLayout("cards"), /되돌렸습니다/); assert.equal(plugin.settings.aiWikiLayout, "table"); assert.equal(plugin.settings.untouched, "preserve"); failSave = false;
  await assert.rejects(() => plugin.setAiWikiLayout("invalid"));
  second.close(); const reopened = new Wiki(plugin.app, plugin); reopened.onOpen(); assert(reopened.contentEl.all().some(el => el.tag === "table")); reopened.close();
  const plain = new Preview(plugin.app, plugin, ctx.aiWikiRecord(plainFile, {})); await plain.onOpen(); assert(find(plain, "티켓 일지에 요약 추가").disabled); assert(rendered.at(-1)[0].includes("Human knowledge")); plain.close();
  const recordsBefore = plugin.aiWikiRecords; plugin.aiWikiRecords = () => [...recordsBefore(), { ...records[0], file: new TFile("Team/Wiki/Duplicate.md") }];
  const duplicate = new Preview(plugin.app, plugin, records[0]); duplicate.showReview = true; await duplicate.onOpen();
  assert(find(duplicate, "중복 식별자 확인")); assert(duplicate.contentEl.all().some(el => el.cls.includes("snm-ai-review-details") && Object.hasOwn(el.attrs, "open"))); duplicate.close(); plugin.aiWikiRecords = recordsBefore;
  const renderBefore = ctx.MarkdownRenderer.render; ctx.MarkdownRenderer.render = async () => { throw Error("renderer unavailable"); };
  const broken = new Preview(plugin.app, plugin, records[0]); await broken.onOpen(); assert(find(broken, "renderer unavailable")); assert(!find(broken, "원본 노트 열기").disabled); assert.equal(loads, unloads); broken.close(); ctx.MarkdownRenderer.render = renderBefore;
  const missing = new Preview(plugin.app, plugin, records[0]); files.delete(recordFile.path); await missing.onOpen(); assert(find(missing, "원본 노트 열기").disabled); missing.close(); files.set(recordFile.path, recordFile);
  const outside = new Preview(plugin.app, plugin, { ...records[0], file: new TFile("Other/Private.md") }); const before = reads; await outside.onOpen(); assert.equal(reads, before); outside.close();
  const originalRead = plugin.app.vault.read; let release;
  plugin.app.vault.read = () => new Promise(resolve => { release = resolve; });
  const cancelled = new Preview(plugin.app, plugin, records[0]); const opening = cancelled.onOpen(); cancelled.close(); release(texts.get(recordFile.path)); await opening; plugin.app.vault.read = originalRead;
  assert.equal(refs.size, 0); assert.equal(loads, unloads); assert.equal(texts.get(recordFile.path).includes("First bullet"), true);
  assert.equal((await ctx.aiWikiTicketSummaryStates(plugin, { ...records[0], tickets: ["SR0000000"] }))[0].state, "missing");
  const rootLookup = plugin.rootTicketFile; plugin.rootTicketFile = () => { throw Error("lookup unavailable"); }; assert.equal((await ctx.aiWikiTicketSummaryStates(plugin, records[0]))[0].state, "error"); plugin.rootTicketFile = rootLookup;
  console.log("AI Wiki view checks passed: card/table persistence and rollback; metadata-only listing/sorting; popup-first navigation; full Markdown contract; exact work-log link status; explicit idempotent summary approval; raw-note preservation; missing/unstructured notes; scope, cancellation and renderer/event cleanup.");
})().catch(error => { console.error(error); process.exitCode = 1; });
