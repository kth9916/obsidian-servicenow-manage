const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const functionSource = name => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
function method(name) {
  const start = source.search(new RegExp(`^  (?:async )?${name}\\(`, "m")); assert(start >= 0, name);
  const rest = source.slice(start), end = rest.slice(1).search(/\n  (?:async )?\w+\(/);
  return rest.slice(0, end + 1).trim();
}
class TFile { constructor(value) { this.path = value; this.basename = value.split("/").pop().replace(/\.md$/i, ""); this.extension = "md"; this.stat = { mtime: 1 }; } }
const context = vm.createContext({ TFile, console, Set, Map, Date,
  normalizeTicketId: value => String(value || "").trim().toUpperCase(), normalizePath: value => String(value).replace(/\\/g, "/"),
  parseYaml: value => JSON.parse(value), stringifyYaml: value => JSON.stringify(value), localIsoDateTime: () => "2026-10-19T16:30:00" });
for (const name of ["parseWikiLink", "safeFileName", "relatedNoteTitle", "relatedDocumentValues", "relatedNoteFrontmatter", "updateRelatedNotesIndexMarkdown"]) vm.runInContext(functionSource(name), context);
const helpers = vm.runInContext("({relatedNoteTitle, relatedNoteFrontmatter, updateRelatedNotesIndexMarkdown})", context);
const plugin = vm.runInContext(`({${["ticketRelatedNotesFolder", "resolveRelatedDocumentFile", "isTicketRelatedIndex", "createTicketRelatedNote", "linkRelatedNoteToIndex", "uniqueVaultPath"].map(method).join(",")}})`, context);
const files = new Map(), text = new Map(), roots = new Map(), folders = [], created = [], refreshed = [];
let failIndexWrite = false, failRootWrite = false, changeRootDuringWrite = false;
const pack = (metadata, body = "") => `---\n${JSON.stringify(metadata)}\n---\n${body}`;
const store = (filePath, metadata = {}, body = "") => { const file = new TFile(filePath); files.set(filePath, file); text.set(filePath, pack(metadata, body)); return file; };
const metadata = file => helpers.relatedNoteFrontmatter(text.get(file.path));
const root = store("ServiceNow/티켓/CR0000000/CR0000000.md", { id: "CR0000000", "관련 문서": null, custom: "keep" }, "Manual root content\n"); roots.set("CR0000000", root);
plugin.ticketFolder = id => `ServiceNow/티켓/${id}`; plugin.rootTicketFile = id => roots.get(id) || null;
plugin.ensureFolder = async folder => folders.push(folder); plugin.refreshViews = id => refreshed.push(id);
plugin.app = { vault: { read: async file => text.get(file.path), getAbstractFileByPath: filePath => files.get(filePath) || null,
  create: async (filePath, markdown) => { assert(!files.has(filePath), "existing notes must never be overwritten"); const file = new TFile(filePath); files.set(filePath, file); text.set(filePath, markdown); created.push(filePath); return file; },
  process: async (file, callback) => { if (failIndexWrite) throw new Error("simulated index write failure"); text.set(file.path, callback(text.get(file.path))); file.stat.mtime++; } },
  metadataCache: { getFirstLinkpathDest: target => files.get(target) || files.get(`${target}.md`) || [...files.values()].find(file => file.basename === target) || null },
  fileManager: { processFrontMatter: async (file, callback) => {
    if (failRootWrite) throw new Error("simulated root write failure");
    const current = metadata(file);
    if (changeRootDuringWrite) { changeRootDuringWrite = false; current["관련 문서"] = "https://example.com/concurrent-reference"; text.set(file.path, pack(current, "Manual root content\n")); }
    callback(current); const body = text.get(file.path).replace(/^---\n[^]*?\n---\n/, ""); text.set(file.path, pack(current, body));
  } } };
(async () => {
  const first = await plugin.createTicketRelatedNote("CR0000000", "배포 점검 자료");
  assert.equal(files.size, 3); assert.equal(first.note.basename, "배포 점검 자료"); assert(first.note.path.startsWith("ServiceNow/티켓/CR0000000/관련 문서/"));
  assert.equal(metadata(root)["관련 문서"], `[[${first.index.path}]]`); assert.equal(metadata(root).custom, "keep"); assert(text.get(root.path).endsWith("Manual root content\n"));
  assert.equal(metadata(first.index).Parent, `[[${root.path}]]`);
  assert.equal(metadata(first.note).Parent, `[[${first.index.path}]]`); assert.equal(metadata(first.note)["원본 노트"], `[[${root.path}]]`); assert.equal(metadata(first.note).title, "배포 점검 자료");
  assert(text.get(first.note.path).endsWith("# 배포 점검 자료\n\n")); assert(text.get(first.index.path).includes("```clt-related-note-actions\nticket: CR0000000"));
  text.set(first.note.path, text.get(first.note.path) + "Manually authored document body stays.\n"); const firstContents = text.get(first.note.path);
  const second = await plugin.createTicketRelatedNote("CR0000000", "추가 분석", first.index.path);
  assert.equal(second.index.path, first.index.path); assert.equal(metadata(second.note).Parent, `[[${first.index.path}]]`); assert.equal(text.get(first.note.path), firstContents);
  const duplicate = await plugin.createTicketRelatedNote("CR0000000", "배포 점검 자료");
  assert.equal(duplicate.note.basename, "배포 점검 자료 (2)"); assert.equal(text.get(first.note.path), firstContents);
  for (const note of [first.note, second.note, duplicate.note]) assert(text.get(first.index.path).includes(`[[${note.path}|${note.basename}]]`));
  assert.equal((text.get(first.index.path).match(/```clt-related-note-actions/g) || []).length, 1);
  const countBeforeInvalid = files.size;
  await assert.rejects(plugin.createTicketRelatedNote("CR0000000", "   "), /제목/);
  await assert.rejects(plugin.createTicketRelatedNote("CR0000000", ".."), /제목/);
  await assert.rejects(plugin.createTicketRelatedNote("CR0000000", "new", root.path), /목록/);
  await assert.rejects(plugin.createTicketRelatedNote("CR0000000", "new", first.note.path), /목록/);
  assert.equal(files.size, countBeforeInvalid);
  assert.equal(helpers.relatedNoteTitle("CON").stem, "_CON"); assert(!helpers.relatedNoteTitle("../../note[#]").stem.includes("/")); assert.equal(helpers.relatedNoteTitle("Report.md").stem, "Report");
  assert.equal(Array.from(helpers.relatedNoteTitle("가".repeat(120)).stem).length, 100);
  const manualRoot = store("ServiceNow/티켓/SR0000000/SR0000000.md", { id: "SR0000000", "관련 문서": "[[SR0000000_관련문서]]" }, "Manual root two"); roots.set("SR0000000", manualRoot);
  const manual = store("ServiceNow/티켓/SR0000000/assets/SR0000000_관련문서.md", { created: "2026-01-01", custom: [1, 2] }, "1. Shared sheet: https://example.com/spec\n2. Review slide: [[Review.pptx]]\n");
  const manualPrefix = text.get(manual.path), manualFmPrefix = manualPrefix.match(/^---\n[^]*?\n---\n/)[0];
  const reused = await plugin.createTicketRelatedNote("SR0000000", "테스트 기록");
  assert.equal(reused.index.path, manual.path); assert.equal(reused.note.path, "ServiceNow/티켓/SR0000000/assets/테스트 기록.md");
  assert(text.get(manual.path).startsWith(manualFmPrefix)); assert(text.get(manual.path).includes("1. Shared sheet: https://example.com/spec\n2. Review slide: [[Review.pptx]]\n"));
  assert.equal(metadata(reused.note)["원본 노트"], `[[${manualRoot.path}]]`);
  const externalRef = "https://example.com/design";
  text.set(root.path, pack({ id: "CR0000000", "관련 문서": [externalRef, `[[${reused.index.path}]]`, `[[${first.note.path}]]`] }, "Manual root content\n"));
  const preserved = await plugin.createTicketRelatedNote("CR0000000", "링크 보존 확인");
  assert.equal(preserved.index.path, first.index.path, "an index linked from another ticket cannot be modified/reused");
  assert(text.get(preserved.index.path).includes(externalRef)); assert(text.get(preserved.index.path).includes(`[[${reused.index.path}]]`));
  const manualAfterReuse = text.get(manual.path);
  await assert.rejects(plugin.createTicketRelatedNote("CR0000000", "wrong", manual.path), /목록/); assert.equal(text.get(manual.path), manualAfterReuse);
  const beforeBadField = files.size; text.set(root.path, pack({ id: "CR0000000", "관련 문서": { custom: true } }, "Manual root content\n"));
  await assert.rejects(plugin.createTicketRelatedNote("CR0000000", "invalid field"), /속성/); assert.equal(files.size, beforeBadField);
  text.set(root.path, pack({ id: "CR0000000", "관련 문서": `[[${first.index.path}]]` }, "Manual root content\n"));
  failIndexWrite = true; let partial;
  try { await plugin.createTicketRelatedNote("CR0000000", "연결 복구"); } catch (error) { partial = error.relatedNote; assert.match(error.message, /index write failure/); }
  assert(partial?.note && files.has(partial.note.path), "a saved document is preserved if a later linking step fails");
  const countWithPartial = files.size; failIndexWrite = false;
  await plugin.linkRelatedNoteToIndex("CR0000000", partial.index, partial.note); await plugin.linkRelatedNoteToIndex("CR0000000", partial.index, partial.note);
  assert.equal(files.size, countWithPartial); assert.equal(text.get(partial.index.path).split(`[[${partial.note.path}|${partial.note.basename}]]`).length - 1, 1);
  failRootWrite = true; text.set(root.path, pack({ "관련 문서": externalRef }, "Manual root content\n"));
  let rootFailure; try { await plugin.createTicketRelatedNote("CR0000000", "원본 연결 복구"); } catch (error) { rootFailure = error.relatedNote; }
  assert(rootFailure?.note); assert.equal(metadata(root)["관련 문서"], externalRef); failRootWrite = false;
  await plugin.linkRelatedNoteToIndex("CR0000000", rootFailure.index, rootFailure.note); assert.equal(metadata(root)["관련 문서"], `[[${rootFailure.index.path}]]`);
  text.set(root.path, pack({ "관련 문서": externalRef }, "Manual root content\n")); changeRootDuringWrite = true;
  let conflict; try { await plugin.createTicketRelatedNote("CR0000000", "동시 수정"); } catch (error) { conflict = error.relatedNote; assert.match(error.message, /변경되었습니다/); }
  assert(conflict?.note); assert.equal(metadata(root)["관련 문서"], "https://example.com/concurrent-reference");
  await plugin.linkRelatedNoteToIndex("CR0000000", conflict.index, conflict.note); assert(text.get(conflict.index.path).includes("https://example.com/concurrent-reference"));
  const pending = plugin.createTicketRelatedNote("CR0000000", "동시 생성 A");
  await assert.rejects(plugin.createTicketRelatedNote("CR0000000", "동시 생성 B"), /생성 중/); await pending;
  assert.throws(() => helpers.relatedNoteFrontmatter("---\ninvalid boundary"), /구분자/);
  assert.throws(() => helpers.updateRelatedNotesIndexMarkdown("<!-- servicenow-manage:related-notes:start -->", "CR0000000", []), /손상/);
  assert.throws(() => helpers.updateRelatedNotesIndexMarkdown("```clt-related-note-actions\nticket: SR0000000\n```", "CR0000000", []), /티켓 설정/);
  const body = "---\r\n{}\r\n---\r\nKeep this manual body.\r\n";
  const updated = helpers.updateRelatedNotesIndexMarkdown(body, "CR0000000", ["[[Example.md]]"]);
  assert(updated.startsWith("---\r\n{}\r\n---\r\n")); assert(updated.includes("Keep this manual body.\r\n")); assert.equal(helpers.updateRelatedNotesIndexMarkdown(updated, "CR0000000", ["[[Example.md]]"]), updated);
  assert(source.includes('registerMarkdownCodeBlockProcessor("clt-related-note-actions"')); assert(source.includes('text: "관련 문서 노트 생성"')); assert(source.includes('text: "관련 노트 추가"'));
  assert(refreshed.length > 5); assert(folders.every(folder => folder.startsWith("ServiceNow/티켓/")));
  console.log("Related-note checks passed: automatic index/child creation, existing manual lists, root/Parent navigation, preserved old references and content, unique titles, path guards, concurrency, partial-write repair, and idempotent index updates.");
})().catch(error => { console.error(error); process.exitCode = 1; });
