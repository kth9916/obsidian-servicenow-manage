const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const dashboard = fs.readFileSync(path.join(__dirname, "..", "resources", "업무현황.md"), "utf8");
const functionSource = name => main.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
function method(name) {
  const start = main.search(new RegExp(`^  (?:async )?${name}\\(`, "m"));
  assert(start >= 0, name);
  const rest = main.slice(start), end = rest.slice(1).search(/\n  (?:async )?\w+\(/);
  return rest.slice(0, end + 1).trim();
}
class TFile {
  constructor(filePath) { this.path = filePath; this.basename = filePath.split("/").pop().replace(/\.md$/, ""); this.stat = { ctime: 1 }; }
}
const context = vm.createContext({ Date, Set, Map, TextDecoder, console, TFile,
  normalizeTicketId: value => String(value || "").trim().toUpperCase(), normalizePath: value => String(value),
  parseWikiLink: value => String(value || "").replace(/^\[\[/, "").replace(/\]\]$/, ""),
  safeFileName: value => String(value), localIsoDateTime: value => value ? value.toISOString().slice(0, 16).replace("T", " ") : "2026-10-19 12:00" });
for (const name of ["normalizeMeetingTicketIds", "escapeRegExp", "parseMeetingDate", "cleanMeetingTitle", "meetingSection", "buildMeetingNoteMarkdown"]) {
  assert(functionSource(name), name); vm.runInContext(functionSource(name), context);
}
const plugin = vm.runInContext(`({${["importMeetingFiles", "importGoogleDriveMeeting", "listTicketMeetings", "meetingTicketIdsForFile", "isManagedMeetingFile", "searchGoogleDriveMeetingDocuments", "uniqueVaultPath"].map(method).join(",")}})`, context);
const files = new Map(), metadata = new Map(), created = [], pdfs = [], touched = [], lookedUp = [], queries = [];
plugin.app = { vault: {
  getMarkdownFiles: () => [...files.values()],
  getAbstractFileByPath: filePath => files.get(filePath) || null,
  create: async (filePath, markdown) => {
    const file = new TFile(filePath); files.set(filePath, file); created.push({ file, markdown });
    metadata.set(filePath, { ticket: markdown.match(/^ticket: "(.*)"/m)?.[1] || "", tickets: [],
      meeting_date: markdown.match(/^meeting_date: "(.*)"/m)?.[1], meeting_kind: "gemini",
      source_drive_id: markdown.match(/^source_drive_id: "(.*)"/m)?.[1] || "" });
    return file;
  }, createBinary: async filePath => { pdfs.push(filePath); }
}, metadataCache: { getFileCache: file => ({ frontmatter: metadata.get(file.path) || {} }) } };
plugin.rootTicketFile = id => { lookedUp.push(id); return null; };
plugin.generalMeetingsFolder = () => "ServiceNow/회의록";
plugin.ticketMeetingsFolder = id => `ServiceNow/티켓/${id}/회의록`;
plugin.ensureFolder = async () => {};
plugin.ensureMeetingSection = async (_file, id) => touched.push(id);
plugin.refreshViews = id => touched.push(id);
plugin.saveDownloadedDocument = async filePath => pdfs.push(filePath);
const candidate = { id: "weekly-doc", name: "Weekly Report", meetingDate: "2026-10-19T12:00" };
let downloadCount = 0;
plugin.googleDriveBinaryGet = async (_url, query) => { downloadCount++; return new TextEncoder().encode(query.mimeType === "text/markdown" ? "# Weekly\n\nGeneral discussion" : "PDF fixture"); };
(async () => {
  const note = await plugin.importMeetingFiles([], [{ name: "Weekly.md", text: async () => "# Weekly\n\nGeneral discussion" }, { name: "Weekly.pdf", arrayBuffer: async () => new ArrayBuffer(1) }], { title: "Weekly Report", meetingDate: "2026-10-19T12:00" });
  assert(note.path.startsWith("ServiceNow/회의록/"));
  assert(created[0].markdown.includes('ticket: ""\ntickets: []'));
  assert(!/^Parent:/m.test(created[0].markdown), "a general meeting must not invent a parent ticket");
  assert(created[0].markdown.includes("Weekly Report") && created[0].markdown.includes("General discussion"));
  assert(pdfs[0].startsWith("ServiceNow/회의록/"));
  assert.deepEqual(lookedUp, []); assert.deepEqual(touched, [], "unlinked imports must not modify any ticket note");
  const imported = await plugin.importGoogleDriveMeeting([], candidate);
  assert(imported.note.path.startsWith("ServiceNow/회의록/"));
  assert.equal(plugin.listTicketMeetings("").length, 2);
  const before = downloadCount, duplicate = await plugin.importGoogleDriveMeeting([], candidate);
  assert.equal(duplicate.note, null); assert(duplicate.warnings[0].includes("이미 추가"));
  assert.equal(downloadCount, before, "re-import must be blocked before a download");
  const shared = new TFile("ServiceNow/회의록/Shared.md"); files.set(shared.path, shared);
  metadata.set(shared.path, { tickets: ["CR0000000", "SR0000000"], meeting_kind: "gemini" });
  assert(!plugin.listTicketMeetings("").some(meeting => meeting.file === shared));
  assert(plugin.listTicketMeetings("CR0000000").some(meeting => meeting.file === shared));
  assert.deepEqual(lookedUp, []); assert.deepEqual(touched, []);
  const driveFiles = [
    { id: "weekly", name: "Weekly - Gemini가 작성한 회의록", createdTime: "2026-10-19T00:00:00Z" },
    { id: "ticket", name: "CR0000000 - Gemini가 작성한 회의록", createdTime: "2026-10-18T00:00:00Z" },
    { id: "custom", name: "Weekly Report", createdTime: "2026-10-17T00:00:00Z" }
  ];
  plugin.googleDriveApiGet = async (_url, query) => { queries.push(query); return { files: driveFiles }; };
  const general = await plugin.searchGoogleDriveMeetingDocuments("");
  assert.equal(general.length, 2); assert(!queries[0].q.includes("name contains ''"));
  assert(queries[0].q.startsWith("name contains 'Gemini가 작성한 회의록' and mimeType"));
  const direct = await plugin.searchGoogleDriveMeetingDocuments("", "Weekly Report");
  assert.equal(direct.length, 1); assert.equal(direct[0].id, "custom");
  const scoped = await plugin.searchGoogleDriveMeetingDocuments("CR0000000");
  assert.equal(scoped.length, 1); assert.equal(scoped[0].id, "ticket");
  assert(main.includes('text: "티켓 없음 (주간·공통 회의)"'));
  assert(dashboard.includes("주간·공통 회의 (티켓 없음)"));
  console.log("No-ticket meeting checks passed: general-folder Markdown/PDF/Drive storage, empty ticket metadata, no ticket writes, duplicate blocking, general/direct/ticket search and dashboard group.");
})().catch(error => { console.error(error); process.exitCode = 1; });
