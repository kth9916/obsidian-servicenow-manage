const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert"), zlib = require("zlib"), crypto = require("crypto");
const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
function method(name) {
  const start = main.search(new RegExp(`^  (?:async )?${name}\\(`, "m")); assert(start >= 0, name);
  const rest = main.slice(start), end = rest.slice(1).search(/\n  (?:async )?\w+\(/);
  return rest.slice(0, end + 1).trim();
}
const helpers = main.slice(main.indexOf("// DS schedule import reads only"), main.indexOf("class DsScheduleModal extends Modal"));
class TFile { constructor(value) { this.path = value; } }
const context = vm.createContext({ Buffer, zlib, crypto, TFile, console, normalizeTicketId: value => value.toUpperCase(), parseYaml: JSON.parse,
  localIsoDateTime: () => "2026-10-19T15:30:00", googleDriveFileId: value => String(value).match(/\/d\/([^/]+)/)?.[1] || "",
  encodeTodoDetail: encodeURIComponent, decodeTodoDetail: decodeURIComponent, stripCltTodoMetadata: value => value.trim(),
  appendEntryToMarkdownSection: (markdown, heading, entry) => `${markdown}\n${entry}\n`,
  DocumentCandidateModal: class { constructor(_app, _id, _groups, _current, resolve) { this.resolve = resolve; } open() { this.resolve(context.choice || {}); } }
});
vm.runInContext(helpers, context);
const api = vm.runInContext("({readDsScheduleWorkbook,dsScheduleDate,dsScheduleActivityDetails,dsScheduleZipReader,dsScheduleSourceLine})", context);
const plugin = vm.runInContext(`({${["loadLatestDsSchedule", "dsScheduleExistingSources", "createDsScheduleTodos"].map(method).join(",")}})`, context);
function crc32(bytes) { let result = -1; for (const byte of bytes) { result ^= byte; for (let bit = 0; bit < 8; bit++) result = (result >>> 1) ^ (result & 1 ? 0xedb88320 : 0); } return (result ^ -1) >>> 0; }
function zip(entries) {
  const body = [], directory = []; let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const content = Buffer.from(text), encoded = Buffer.from(name), compressed = zlib.deflateRawSync(content), crc = crc32(content);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(encoded.length, 26);
    body.push(local, encoded, compressed);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(encoded.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, encoded); offset += local.length + encoded.length + compressed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, central, end]);
}
const inline = (cell, text) => `<c r="${cell}" t="inlineStr"><is><t>${text}</t></is></c>`;
const number = (cell, value) => `<c r="${cell}"><v>${value}</v></c>`;
const header = '<row r="16">'+inline("C16", "Activity")+inline("D16", "PIC")+inline("E16", "Jira Account ID")+inline("F16", "Start")+inline("G16", "End")+'</row>';
const entries = {
  "xl/workbook.xml": '<workbook xmlns:r="relationships"><workbookPr date1904="0"/><sheets><sheet name="Cover" r:id="r0"/><sheet name="Schedule" r:id="r1"/><sheet name="PROD Schedule" r:id="r2"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
  "xl/sharedStrings.xml": '<sst><si><r><t>Develop</t></r><r><t>ment</t></r></si><si><t>Owner &amp; Reviewer</t></si></sst>',
  "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="4">'+inline("B4", "Guideline")+'</row>'+header+'<row r="17"><c r="C17" t="s"><v>0</v></c><c r="D17" t="s"><v>1</v></c>'+number("F17", "46321")+number("G17", "46325.5")+'</row><row r="18">'+inline("C18", "Development")+inline("D18", "Second owner")+inline("F18", "2026/10/19")+inline("G18", "2026-10-20")+'</row><row r="19">'+inline("C19", "QA")+number("F19", "46326")+'<c r="G19"><f>G17+3</f></c></row></sheetData></worksheet>',
  "xl/worksheets/sheet2.xml": '<worksheet><sheetData>'+header+'<row r="17">'+inline("C17", "Deployment (Stage)")+inline("D17", "Release owner")+inline("F17", "2026-11-03 12:30")+inline("G17", "2026-11-04 14:00")+'</row><row r="18">'+inline("C18", "READY FOR PROD")+inline("D18", "Release owner")+'</row></sheetData></worksheet>'
};
const workbook = zip(entries), result = api.readDsScheduleWorkbook(workbook);
assert.deepEqual(Array.from(result.sheets, sheet => sheet.name), ["Schedule", "PROD Schedule"]);
const schedule = result.sheets[0].items, prod = result.sheets[1].items;
assert.equal(schedule.length, 3); assert.equal(schedule[0].activity, "Development"); assert.equal(schedule[0].pic, "Owner & Reviewer"); assert.equal(schedule[0].end, "2026-10-30 12:00");
assert.equal(schedule[0].dueDate, "2026-10-30T12:00"); assert.equal(schedule[1].start, "2026-10-19");
assert.equal(schedule[2].end, "계산 결과 없음"); assert.equal(schedule[2].dueDate, ""); assert.equal(schedule[2].dateWarning, true);
assert.equal(prod.length, 2); assert.equal(prod[0].dueDate, "2026-11-04T14:00"); assert.equal(prod[1].dueDate, "");
for (const [value, expected] of [["2026.1.2", "2026-01-02"], ["10/19/2026", "2026-10-19"], ["2026-02-29", ""], ["2026-10-19T25:00", ""], ["TBD", ""], ["10/19", ""], ["0", ""]]) assert.equal(api.dsScheduleDate(value).due, expected, value);
assert.equal(api.dsScheduleDate(1).due, "1900-01-01"); assert.equal(api.dsScheduleDate(1, true).due, "1904-01-02");
for (const activity of ["Development", "Pair Test", "DS", "TAS", "Code Review", "Testing", "IT", "QA", "Approved For Production", "Deployment (Stage)", "Final Verification", "READY FOR PROD", "Implemented"]) assert(!api.dsScheduleActivityDetails(activity).startsWith("DS 일정에 따라"), activity);
assert(api.dsScheduleActivityDetails("QA").includes("CTASK")); assert(api.dsScheduleActivityDetails("TAS (Stage)").includes("Automation"));
assert(api.dsScheduleActivityDetails("Test Case").includes("Test Case"));
assert.throws(() => api.readDsScheduleWorkbook(Buffer.from("not an xlsx")), /손상/);
assert.throws(() => api.readDsScheduleWorkbook(zip({ "xl/workbook.xml": "<!DOCTYPE unsafe><workbook/>" })), /손상/);
assert.throws(() => api.readDsScheduleWorkbook(zip({ "xl/workbook.xml": '<workbook><sheets><sheet name="Cover"/></sheets></workbook>' })), /탭이 없습니다/);
assert.throws(() => api.readDsScheduleWorkbook(zip({ ...entries, "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="r1" Target="../../outside.xml"/></Relationships>' })), /경로/);
const missingHeader = api.readDsScheduleWorkbook(zip({ ...entries, "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1">'+inline("A1", "Activity")+'</row></sheetData></worksheet>' }));
assert(missingHeader.sheets[0].error.includes("열을 찾지")); assert.equal(missingHeader.sheets[1].items.length, 2);
const root = new TFile("ServiceNow/티켓/CR0000000/CR0000000.md"), asset = new TFile("ServiceNow/티켓/CR0000000/assets/CR0000000 DS.xlsx");
let markdown = '---\n'+JSON.stringify({ DS: "https://docs.google.com/spreadsheets/d/example-ds/edit" })+'\n---\n## ✅ To-Do\n\nManual task stays.\n', binaryReads = 0, downloads = 0, touches = 0, refreshes = 0;
plugin.settings = { googleDriveContentAccess: true }; plugin.rootTicketFile = () => root;
plugin.app = { vault: { read: async () => markdown, getAbstractFileByPath: value => value === asset.path ? asset : null,
  readBinary: async () => { binaryReads++; return workbook; }, process: async (_file, callback) => { markdown = callback(markdown); } },
  fileManager: { processFrontMatter: async (_file, callback) => { callback({ DS: "" }); } } };
plugin.downloadGoogleDriveDocument = async () => { downloads++; return asset.path; };
plugin.touchTodoLastChecked = async () => { touches++; }; plugin.refreshViews = () => { refreshes++; };
plugin.assertTodoStatusEnabled = status => { if (!["pending", "in-progress", "waiting", "done"].includes(status)) throw new Error("disabled status"); };
(async () => {
  const source = await plugin.loadLatestDsSchedule("CR0000000"); await plugin.loadLatestDsSchedule("CR0000000");
  assert.equal(downloads, 2, "each open downloads DS again"); assert.equal(binaryReads, 2);
  assert.equal(source.fileId, "example-ds"); assert.equal(source.loadedAt, "2026-10-19T15:30");
  const review = { activity: "리뷰 준비", sheet: "추가 업무", pic: "", occurrence: 1, details: "리뷰 준비", dueDate: "" };
  let counts = await plugin.createDsScheduleTodos("CR0000000", source, [schedule[0], prod[0], review], "pending");
  assert.equal(counts.created, 3); assert(markdown.includes("Manual task stays."));
  const lines = markdown.split("\n").filter(line => line.startsWith("- ["));
  assert.equal(lines.length, 3); assert(lines[0].includes("clt-todo-due:2026-10-30T12:00")); assert(!lines[2].includes("clt-todo-due:"));
  const details = decodeURIComponent(lines[0].match(/clt-todo-detail:([^>]*)/)[1].trim());
  assert(details.includes("개발") && details.includes("PIC: Owner & Reviewer") && details.includes("Start:") && details.includes("End:") && details.includes(asset.path));
  assert.equal((await plugin.dsScheduleExistingSources("CR0000000")).size, 3);
  const original = markdown;
  counts = await plugin.createDsScheduleTodos("CR0000000", source, [{ ...schedule[0], dueDate: "2027-01-01" }, prod[0], review], "pending");
  assert.equal(counts.created, 0); assert.equal(counts.skipped, 3); assert.equal(markdown, original, "DS changes must not overwrite manual To-Dos");
  assert.equal(touches, 1); assert.equal(refreshes, 1);
  await assert.rejects(plugin.createDsScheduleTodos("CR0000000", source, [schedule[1]], "disabled"), /disabled/);
  await assert.rejects(plugin.createDsScheduleTodos("CR0000000", source, [schedule[1], { ...schedule[2], dueDate: "invalid" }], "pending"), /완료 예정일/);
  assert.equal(markdown, original, "invalid bulk creation is atomic");
  counts = await plugin.createDsScheduleTodos("CR0000000", source, [schedule[1]], "in-progress");
  assert.equal(counts.created, 1); assert(markdown.includes("clt-todo:in-progress"));
  counts = await plugin.createDsScheduleTodos("CR0000000", source, [prod[1]], "done");
  assert.equal(counts.created, 1); assert(markdown.includes("- [x]") && markdown.includes("clt-todo-completed:"));
  plugin.downloadGoogleDriveDocument = async () => { throw new Error("network failed"); };
  await assert.rejects(plugin.loadLatestDsSchedule("CR0000000"), /network failed/); assert.equal(binaryReads, 2, "never read a stale DS when download fails");
  plugin.settings.googleDriveContentAccess = false; await assert.rejects(plugin.loadLatestDsSchedule("CR0000000"), /권한/);
  plugin.settings.googleDriveContentAccess = true;
  markdown = '---\n{}\n---\n'; plugin.searchGoogleDriveDocuments = async () => ({ DS: [] });
  await assert.rejects(plugin.loadLatestDsSchedule("CR0000000"), /찾지 못했습니다/);
  plugin.searchGoogleDriveDocuments = async () => ({ DS: [{ url: "a" }, { url: "b" }] });
  await assert.rejects(plugin.loadLatestDsSchedule("CR0000000"), /취소/);
  assert(main.includes('text: "일정 생성"') && main.includes("new DsScheduleModal(this.app, this, ticketId).open()"));
  assert(!method("loadLatestDsSchedule").includes("syncTicket("), "schedule generation does not depend on or mutate ServiceNow");
  console.log("DS schedule checks passed: XLSX tabs/cached cells/dates, activity mapping, fresh-only downloads, atomic To-Dos, state settings, review without dates, deduplication, and failure recovery.");
})().catch(error => { console.error(error); process.exitCode = 1; });
