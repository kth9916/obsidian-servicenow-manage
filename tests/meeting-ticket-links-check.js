const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const dashboard = fs.readFileSync(path.join(__dirname, "..", "resources", "업무현황.md"), "utf8");
function method(name) {
  const start = source.search(new RegExp(`^  (?:async )?${name}\\(`, "m")); assert(start >= 0, name);
  const rest = source.slice(start), end = rest.slice(1).search(/\n  (?:async )?\w+\(/);
  return rest.slice(0, end + 1).trim();
}
const functionSource = name => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
class TFile { constructor(filePath) { this.path = filePath; this.basename = filePath.split("/").pop().replace(/\.md$/, ""); this.stat = { ctime: 1, mtime: 1 }; } }
const context = vm.createContext({ TFile, console, Date, Set, Map, Notice: class {},
  normalizeTicketId: value => String(value || "").trim().toUpperCase(), normalizePath: value => String(value), parseWikiLink: value => String(value || "").replace(/^\[\[/, "").replace(/\]\]$/, ""),
  parseYaml: text => text.trim() ? JSON.parse(text) : null, stringifyYaml: metadata => JSON.stringify(metadata), window: { setTimeout: () => 1, clearTimeout() {} } });
for (const name of ["normalizeMeetingTicketIds", "updateMeetingTicketLinksMarkdown"]) vm.runInContext(functionSource(name), context);
const rewrite = vm.runInContext("updateMeetingTicketLinksMarkdown", context);
const plugin = vm.runInContext(`({${["meetingTicketIdsForFile", "isManagedMeetingFile", "listTicketMeetings", "isMeetingFileRelevantToTicket", "updateMeetingTicketLinks", "deleteTicketMeeting", "migrateMeetingParentLinks"].map(method).join(",")}})`, context);
const files = new Map(), text = new Map(), cache = new Map(), events = [], refreshed = [], ensured = [], trashed = [];
const clone = value => JSON.parse(JSON.stringify(value));
const metadata = file => JSON.parse(text.get(file.path).match(/^---\n([^]*?)\n---/)?.[1] || "{}");
const store = (filePath, fm, body) => { const file = new TFile(filePath); files.set(filePath, file); text.set(filePath, `---\n${JSON.stringify(fm)}\n---\n${body}`); cache.set(filePath, clone(fm)); return file; };
const roots = new Map(["CR0000000", "SR0000000"].map(id => [id, store(`ServiceNow/티켓/${id}/${id}.md`, { id }, `Manual root content for ${id}`)]));
const body = '# Weekly\n\n> [!info] 회의 정보\n> | 관련 티켓 | 티켓 없음 |\n\nManual discussion mentions CR0000000 without changing its text.\n\n- [ ] A manually added action\n';
const note = store("ServiceNow/회의록/Weekly.md", { type: "meeting-minutes", meeting_kind: "gemini", ticket: "", tickets: [], source_pdf: "[[ServiceNow/회의록/Weekly.pdf]]", source_drive_id: "weekly-source", created: "2026-01-01", custom: { keep: [1, 2] } }, body);
const pdf = new TFile("ServiceNow/회의록/Weekly.pdf"); files.set(pdf.path, pdf); text.set(pdf.path, "PDF bytes stay untouched");
plugin.generalMeetingsFolder = () => "ServiceNow/회의록";
plugin.ticketsFolder = () => "ServiceNow/티켓";
plugin.ticketMeetingsFolder = id => `ServiceNow/티켓/${id}/회의록`;
plugin.rootTicketFile = id => roots.get(id) || null;
plugin.refreshViews = id => refreshed.push(id);
plugin.ensureMeetingSection = async (_file, id) => ensured.push(id);
plugin.app = { workspace: { trigger: (...args) => events.push(args) }, metadataCache: { getFileCache: file => ({ frontmatter: cache.get(file.path) || {} }) },
  vault: { getMarkdownFiles: () => [...files.values()].filter(file => file.path.endsWith(".md")), getAbstractFileByPath: filePath => files.get(filePath) || null,
    process: async (file, callback) => { const updated = callback(text.get(file.path)); text.set(file.path, updated); file.stat.mtime++; },
    trash: async file => { trashed.push(file.path); files.delete(file.path); } }, fileManager: { processFrontMatter: async () => { throw new Error("An unlinked note must not gain a Parent during migration"); } } };
(async () => {
  assert.equal(plugin.listTicketMeetings("").length, 1);
  const rootContents = [...roots.values()].map(file => text.get(file.path));
  await plugin.updateMeetingTicketLinks(note, ["CR0000000", "SR0000000"], { expectedTicketIds: [] });
  assert.deepEqual(metadata(note).tickets, ["CR0000000", "SR0000000"]);
  assert.equal(metadata(note).Parent, "[[CR0000000]]"); assert.deepEqual(metadata(note).Parents, ["[[CR0000000]]", "[[SR0000000]]"]);
  assert.deepEqual(metadata(note).custom, { keep: [1, 2] }); assert.equal(metadata(note).created, "2026-01-01"); assert.equal(metadata(note).source_drive_id, "weekly-source");
  assert(text.get(note.path).includes("Manual discussion mentions CR0000000 without changing its text.")); assert(text.get(note.path).endsWith("- [ ] A manually added action\n"));
  assert(text.get(note.path).includes("> | 관련 티켓 | [[CR0000000]] · [[SR0000000]] |"));
  assert.equal(plugin.listTicketMeetings("CR0000000").length, 1); assert.equal(plugin.listTicketMeetings("SR0000000").length, 1);
  assert.equal(plugin.listTicketMeetings("").length, 0); assert.deepEqual([...roots.values()].map(file => text.get(file.path)), rootContents);
  assert.deepEqual(ensured, ["CR0000000", "SR0000000"]); assert(refreshed.includes("CR0000000") && refreshed.includes("SR0000000"));
  cache.set(note.path, metadata(note)); plugin.meetingTicketIdsForFile(note);
  assert(!plugin.pendingMeetingTicketLinks.has(note.path), "the temporary override is released after metadata catches up");
  await plugin.updateMeetingTicketLinks(note, ["SR0000000"], { expectedTicketIds: ["CR0000000", "SR0000000"] });
  assert.equal(plugin.listTicketMeetings("CR0000000").length, 0); assert.equal(plugin.listTicketMeetings("SR0000000").length, 1);
  await plugin.updateMeetingTicketLinks(note, [], { expectedTicketIds: ["SR0000000"] });
  assert.deepEqual(clone(plugin.meetingTicketIdsForFile(note)), [], "empty pending links override stale metadata rather than unioning old links");
  assert.equal(plugin.listTicketMeetings("").length, 1); assert.equal(plugin.listTicketMeetings("CR0000000").length, 0);
  assert(!Object.hasOwn(metadata(note), "Parent") && !Object.hasOwn(metadata(note), "Parents"));
  assert.equal(text.get(pdf.path), "PDF bytes stay untouched"); assert.equal(note.path, "ServiceNow/회의록/Weekly.md");
  const unchanged = text.get(note.path);
  await assert.rejects(plugin.updateMeetingTicketLinks(note, ["CR000000000"], { expectedTicketIds: [] }), /원본 티켓/);
  await assert.rejects(plugin.updateMeetingTicketLinks(note, ["CR0000000"], { expectedTicketIds: ["SR0000000"] }), /다른 화면/);
  assert.equal(text.get(note.path), unchanged);
  const originalProcess = plugin.app.vault.process;
  plugin.app.vault.process = async () => { throw new Error("simulated disk failure"); };
  await assert.rejects(plugin.updateMeetingTicketLinks(note, ["CR0000000"], { expectedTicketIds: [] }), /disk failure/);
  assert.deepEqual(clone(plugin.meetingTicketIdsForFile(note)), []); assert.equal(text.get(note.path), unchanged);
  plugin.app.vault.process = originalProcess;
  plugin.ensureMeetingSection = async () => { throw new Error("simulated section failure"); };
  const partial = await plugin.updateMeetingTicketLinks(note, ["CR0000000"], { expectedTicketIds: [] });
  assert.equal(partial.warnings.length, 1); assert.deepEqual(metadata(note).tickets, ["CR0000000"]);
  assert(events.some(event => event[0] === "servicenow-manage:meeting-links-changed"));
  const other = store("Unrelated/Weekly.md", { type: "meeting-minutes" }, "Do not touch");
  await assert.rejects(plugin.updateMeetingTicketLinks(other, []), /회의록 폴더 밖/);
  assert.throws(() => rewrite('---\n{"meeting_kind":"analysis"}\n---\nAnalysis stays unchanged', []), /원본 회의록/);
  assert.throws(() => rewrite('---\nnot valid JSON YAML fixture\n---\nOriginal', []));
  const oldNote = store("ServiceNow/티켓/CR0000000/회의록/CR0000000.md", { type: "meeting-minutes", meeting_kind: "gemini", ticket: "CR0000000", tickets: ["CR0000000"] }, body);
  await plugin.updateMeetingTicketLinks(oldNote, [], { expectedTicketIds: ["CR0000000"] });
  cache.set(oldNote.path, metadata(oldNote)); plugin.meetingTicketIdsForFile(oldNote);
  assert(!plugin.listTicketMeetings("CR0000000").some(item => item.file === oldNote), "the old folder must not reattach an explicitly unlinked note");
  assert(plugin.listTicketMeetings("").some(item => item.file === oldNote));
  cache.set(note.path, metadata(note));
  await plugin.migrateMeetingParentLinks();
  await plugin.deleteTicketMeeting({ file: oldNote, ticketIds: [] });
  assert(trashed.includes(oldNote.path), "deletion remains available after unlinking without moving the note");
  assert(dashboard.includes('plugin.openMeetingTicketLinksModal(meeting.file.path, renderMeetingOverview)'));
  assert(source.includes('this.decorateMeetingTicketLinks(el, file, ctx)'));
  console.log("Meeting link editing checks passed: late multi-ticket linking, relinking/unlinking, atomic metadata/body updates, preserved content/PDF/path, stale-cache removal, conflict/disk guards, partial warnings, reload migration and deletion.");
})().catch(error => { console.error(error); process.exitCode = 1; });
