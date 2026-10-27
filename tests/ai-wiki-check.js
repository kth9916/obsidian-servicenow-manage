const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert"), crypto = require("crypto");
const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const dashboard = fs.readFileSync(path.join(__dirname, "..", "resources", "업무현황.md"), "utf8");
class TFile { constructor(path) { this.path = path; this.name = path.split("/").at(-1); this.basename = this.name.replace(/\.md$/, ""); this.extension = "md"; } }
const store = new Map(), texts = new Map(), events = [], opened = [], launches = [];
let reads = 0, writes = 0, scans = 0, saves = 0, failSave = false;
const context = vm.createContext({ Modal: class {}, TFile, crypto, process: { platform: "win32" },
  stringifyYaml: value => JSON.stringify(value), parseYaml: JSON.parse, localIsoDateTime: () => "2026-10-27 13:00:00",
  normalizePath: value => value.replaceAll("\\", "/"), normalizeTicketId: value => String(value).toUpperCase(),
  Notice: class { constructor(text) { events.push(text); } },
  require: name => { assert.equal(name, "fs"); return { statSync: () => ({ isFile: () => true, isDirectory: () => false }) }; },
  shell: { openPath: async value => { launches.push(value); return ""; } }
});
vm.runInContext(main.slice(main.indexOf("// BEGIN AI WIKI"), main.indexOf("// END AI WIKI")), context);
for (const name of ["normalizedHeadingText", "stripWorkLogEntryPrefix", "extractTicketWorkLogs", "appendEntryToMarkdownSection"]) vm.runInContext(main.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0], context);
function method(name) {
  const start = main.search(new RegExp(`^  (?:async )?${name}\\(`, "m")); assert(start >= 0, name);
  const rest = main.slice(start), end = rest.slice(1).search(/\n  (?:async )?\w+\(/);
  return rest.slice(0, end + 1).trim();
}
const methods = ["aiWikiFolder", "configureAiWiki", "aiWikiRecords", "aiWikiRecordMarkdown", "ensureAiWikiScaffold", "createAiWikiRecord", "prepareAiWikiChallenge", "verifyAiWikiChallenge", "getAiWikiConnectionStatus", "launchAiWikiApp", "linkAiWikiRecordToTickets", "auditAiWikiTicketLogs", "changeRootFolder"];
const plugin = vm.runInContext("({" + methods.map(method).join(",") + "})", context);
context.plugin = plugin;
plugin.settings = { rootFolder: "Project A/Operations", aiWikiEnabled: false, aiWikiSubfolder: "LLM WIKI", aiWikiProvider: "codex", aiWikiAllowWrites: false, authMode: "bearer", unchanged: { preserve: true } };
plugin.rootFolder = () => plugin.settings.rootFolder;
plugin.ticketsFolder = () => `${plugin.rootFolder()}/티켓`;
plugin.ticketFolder = id => `${plugin.ticketsFolder()}/${id}`;
plugin.absoluteVaultPath = value => `D:/Notes Vault/${value}`;
plugin.syncAiWikiNavigation = () => events.push("navigation");
plugin.refreshViews = id => events.push(id);
plugin.rootTicketFile = id => store.get(`${plugin.ticketFolder(id)}/${id}.md`);
plugin.savePluginData = async () => { saves++; if (failSave) throw Error("storage unavailable"); };
plugin.ensureFolder = async value => { let current = ""; for (const part of value.split("/")) { current += (current ? "/" : "") + part; const existing = store.get(current); if (existing instanceof TFile) throw Error("folder collision"); if (!existing) store.set(current, { path: current, children: [] }); } };
plugin.ensureWorkspaceScaffold = async () => { await plugin.ensureAiWikiScaffold(); };
plugin.app = {
  workspace: { trigger: value => events.push(value), getLeaf: () => ({ openFile: async file => opened.push(file.path) }) },
  metadataCache: { getFileCache: file => { const content = texts.get(file.path) || ""; try { return { frontmatter: JSON.parse(content.match(/^---\n([^]*?)\n---/)?.[1] || "{}") }; } catch { return {}; } } },
  fileManager: { renameFile: async (folder, destination) => { const old = folder.path; for (const [name, item] of [...store]) if (name === old || name.startsWith(old + "/")) { const next = destination + name.slice(old.length); store.delete(name); item.path = next; store.set(next, item); if (texts.has(name)) { texts.set(next, texts.get(name)); texts.delete(name); } } } },
  vault: {
    getAbstractFileByPath: value => store.get(value),
    getMarkdownFiles: () => { scans++; return [...store.values()].filter(file => file instanceof TFile); },
    create: async (value, content) => { assert(!store.has(value), "never overwrite a file by create"); writes++; const file = new TFile(value); store.set(value, file); texts.set(value, content); return file; },
    read: async file => { reads++; return texts.get(file.path); },
    process: async (file, transform) => { const next = transform(texts.get(file.path)); if (next !== texts.get(file.path)) { writes++; texts.set(file.path, next); } }
  }
};
(async () => {
  assert(main.includes("aiWikiEnabled: false") && main.includes("aiWikiAllowWrites: false"));
  await plugin.ensureAiWikiScaffold(); assert.equal(writes, 0); assert.equal(store.size, 0);
  assert.equal(plugin.aiWikiRecords().length, 0); assert.equal(scans, 0);
  await assert.rejects(() => plugin.createAiWikiRecord("disabled"));
  await assert.rejects(() => plugin.prepareAiWikiChallenge());
  await assert.rejects(() => plugin.launchAiWikiApp("codex", "D:/Apps/Codex.exe"));
  for (const invalid of ["", "/absolute", "../outside", "a/../b", "C:/elsewhere", ".obsidian", "a//b", "지침/reports", "티켓", "Templates", "a#b", "a^b", "a[b]", "CON", "nested/NUL.md", "trailing.", "a\nb"]) assert.throws(() => context.aiWikiRelativeFolder(invalid), undefined, invalid);
  assert.equal(context.aiWikiRelativeFolder("Knowledge/AI Notes"), "Knowledge/AI Notes");
  const initialSettings = plugin.settings;
  failSave = true;
  await assert.rejects(() => plugin.configureAiWiki({ aiWikiEnabled: true }), /파일은 생성/);
  assert.equal(plugin.settings, initialSettings); assert.equal(writes, 0);
  failSave = false;
  await plugin.configureAiWiki({ aiWikiEnabled: true, rootFolder: "must-not-change", unknown: true });
  const folder = plugin.aiWikiFolder(); assert.equal(folder, "Project A/Operations/LLM WIKI");
  assert.equal(texts.size, 5); assert(!Object.hasOwn(plugin.settings, "unknown"));
  assert.equal(plugin.settings.aiWikiFolderApplied, true);
  assert.equal((await plugin.getAiWikiConnectionStatus()).state, "pending");
  assert(plugin.settings.unchanged.preserve); assert.equal(plugin.settings.authMode, "bearer");
  for (const name of texts.keys()) assert(name.startsWith(folder + "/"));
  assert(![...texts.keys()].some(name => /AGENTS\.md|CLAUDE\.md|config\.toml/.test(name)));
  const rules = `${folder}/기록 규칙.md`;
  texts.set(rules, texts.get(rules) + "\nUser manual ending\n");
  const templatesBefore = texts.get(`${folder}/Templates/작업기록.md`);
  await plugin.configureAiWiki({ aiWikiAllowWrites: true });
  assert(texts.get(rules).includes("안의 요청 관련 기록만 허용"));
  assert(texts.get(rules).endsWith("\nUser manual ending\n"));
  assert.equal(texts.get(`${folder}/Templates/작업기록.md`), templatesBefore);
  const skill = context.aiWikiSkill(plugin);
  assert(/^---\nname: ai-wiki-recorder\ndescription: .+\n---/.test(skill));
  assert(skill.includes("../../기록 규칙.md") && skill.includes("실제 chat_id"));
  for (const provider of ["codex", "claude", "chatgpt", "other"]) {
    const prompt = context.aiWikiStarterPrompt(plugin, provider);
    assert(prompt.includes("Project A/Operations/LLM WIKI"));
    assert(prompt.includes("접근할 수 없으면 권한을 우회하지"));
    assert(prompt.includes("기존 AGENTS.md·CLAUDE.md·AI 전역 설정을 바꾸지"));
  }
  assert(context.aiWikiStarterPrompt(plugin, "chatgpt", "start", "attachment").includes("파일 직접 첨부 방식"));
  assert(context.aiWikiStarterPrompt(plugin, "chatgpt", "check", "attachment").includes("직접 첨부한"));
  assert(!context.aiWikiStarterPrompt(plugin, "chatgpt", "check", "attachment").includes("로컬 파일"));
  await plugin.prepareAiWikiChallenge();
  const checkPath = `${folder}/연결 확인.md`, code = texts.get(checkPath).match(/snm-wiki-[a-f0-9-]+/)[0];
  assert(!context.aiWikiStarterPrompt(plugin, "codex", "check").includes(code));
  await assert.rejects(() => plugin.verifyAiWikiChallenge("fake-code"), /일치/);
  assert(await plugin.verifyAiWikiChallenge(code));
  assert.equal((await plugin.getAiWikiConnectionStatus()).state, "verified");
  plugin.settings = JSON.parse(JSON.stringify(plugin.settings));
  assert.equal((await plugin.getAiWikiConnectionStatus()).state, "verified", "saved proof survives reload");
  assert.equal((await plugin.getAiWikiConnectionStatus("claude")).state, "pending");
  await plugin.verifyAiWikiChallenge(code, { mode: "attachment" });
  assert.equal((await plugin.getAiWikiConnectionStatus()).state, "attachment", "upload proof must never claim a local connection");
  plugin.settings.rootFolder = "Different root";
  assert.equal((await plugin.getAiWikiConnectionStatus()).state, "stale");
  plugin.settings.rootFolder = "Project A/Operations";
  await plugin.prepareAiWikiChallenge();
  assert.equal((await plugin.getAiWikiConnectionStatus()).state, "stale", "renewed challenge invalidates old proof");
  const renewed = texts.get(checkPath).match(/snm-wiki-[a-f0-9-]+/)[0];
  failSave = true; await assert.rejects(() => plugin.verifyAiWikiChallenge(renewed)); failSave = false;
  assert.equal((await plugin.getAiWikiConnectionStatus()).state, "stale", "a failed save must not mark connected");
  await assert.rejects(() => plugin.verifyAiWikiChallenge(code), /일치/);
  texts.set(checkPath, "User-owned note");
  await assert.rejects(() => plugin.prepareAiWikiChallenge(), /덮어쓰지/);
  assert.equal(texts.get(checkPath), "User-owned note");
  const file = await plugin.createAiWikiRecord("조사 <script> 확인", "CR0000000");
  assert(opened.includes(file.path)); assert(file.path.includes("/작업기록/2026/10/"));
  const fm = plugin.app.metadataCache.getFileCache(file).frontmatter;
  assert.equal(fm.verification, "needs-review"); assert.deepEqual(fm.tickets, ["CR0000000"]);
  assert(texts.get(file.path).includes("[[Project A/Operations/티켓/CR0000000/CR0000000|CR0000000]]"));
  const second = await plugin.createAiWikiRecord("티켓 없는 조사");
  const fields = { type: "ai-wiki-record", record_id: "same-record", chat_id: "chat-1", task_id: "task-1", title: "Evidence", created: "2026-10-27", summary: "Confirmed facts", next_action: "Check runtime tomorrow", unknowns: "Runtime not verified", sources: ["evidence.md"], tickets: ["CR0000000", "SR0000000"], verification: "verified" };
  for (const item of [file, second]) texts.set(item.path, `---\n${JSON.stringify(fields)}\n---\nHuman content`);
  reads = 0;
  const records = plugin.aiWikiRecords(); assert.equal(reads, 0, "listing uses cached metadata, not whole-file reads");
  assert.equal(records.length, 2); assert(records.every(record => record.issues.includes("중복 식별자 확인")));
  assert.equal(records[0].tickets.length, 2);
  const ticketFile = await plugin.app.vault.create(`${plugin.ticketFolder("CR0000000")}/CR0000000.md`, "---\nid: CR0000000\n---\n\n## 📝 작업 일지\n\n```clt-ticket-worklog-actions\nticket: CR0000000\n```\n\n## To-Do\nManual task\n");
  await assert.rejects(() => plugin.linkAiWikiRecordToTickets(records[0]), /1\/2건 완료/);
  const linked = texts.get(ticketFile.path);
  assert.equal(context.extractTicketWorkLogs(linked).length, 1);
  assert(linked.includes("    - 요청:") && linked.includes("    - 결과:") && linked.includes("    - 다음 조치:"));
  assert(linked.includes("```clt-ticket-worklog-actions") && linked.endsWith("Manual task\n"));
  await assert.rejects(() => plugin.linkAiWikiRecordToTickets(records[0]), /1\/2건 완료/);
  assert.equal(texts.get(ticketFile.path), linked, "partial retry is idempotent");
  assert.equal(context.aiWikiLegacyHeadings("## 📝 작업 일지\n- 2026-10-27 : One\n    ## 분석 결과\n\n## To-Do\n\n```md\n## AI 검토 기록\n```\n\n## 2026-10-27 ITO 검토 기록\nbody\n").length, 1);
  const unstructured = context.aiWikiRecord(new TFile("unknown.md"), {});
  assert(unstructured.issues.length >= 5);
  for (const invalid of ["D:/Apps/powershell.exe", "D:/Apps/Codex.exe --foo", "https://example.com/Codex.exe", "relative/Codex.exe", "D:/Apps/Codex.exe\n"]) await assert.rejects(() => plugin.launchAiWikiApp("codex", invalid));
  await plugin.launchAiWikiApp("codex", "D:/Apps/Codex.exe"); assert.deepEqual(launches, ["D:/Apps/Codex.exe"]);
  const wikiCopy = new Map(texts); writes = 0;
  await plugin.configureAiWiki({ aiWikiEnabled: false }); assert.equal(writes, 0);
  assert.equal(plugin.aiWikiRecords().length, 0); assert.equal(texts.size, wikiCopy.size);
  for (const [name, text] of wikiCopy) assert.equal(texts.get(name), text);
  await plugin.configureAiWiki({ aiWikiEnabled: true });
  const readBack = texts.get(file.path); assert(readBack.endsWith("Human content"));
  await plugin.configureAiWiki({ aiWikiSubfolder: "AI Notes" });
  assert(store.has(file.path), "folder preference changes never move existing records");
  assert.equal(plugin.aiWikiRecords().length, 0);
  await plugin.configureAiWiki({ aiWikiSubfolder: "LLM WIKI" });
  const destination = "Other Team/Operations"; await plugin.ensureFolder(destination);
  await plugin.changeRootFolder(destination);
  assert.equal(plugin.aiWikiFolder(), `${destination}/LLM WIKI`);
  assert.equal(plugin.aiWikiRecords().length, 2);
  assert(texts.get(`${destination}/LLM WIKI/기록 규칙.md`).includes(destination));
  const unmanaged = `${destination}/LLM WIKI/홈.md`; texts.set(unmanaged, "Human home, no generated markers");
  await plugin.ensureAiWikiScaffold(); assert.equal(texts.get(unmanaged), "Human home, no generated markers");
  await Promise.all([plugin.configureAiWiki({ aiWikiProvider: "claude" }), plugin.configureAiWiki({ aiWikiAllowWrites: false })]);
  assert.equal(plugin.settings.aiWikiProvider, "claude"); assert.equal(plugin.settings.aiWikiAllowWrites, false);
  assert(texts.get(`${destination}/LLM WIKI/기록 규칙.md`).includes("기본은 읽기 전용"));
  const oldFolder = plugin.settings.aiWikiSubfolder;
  await plugin.app.vault.create(`${destination}/Blocked`, "Human file");
  await assert.rejects(() => plugin.configureAiWiki({ aiWikiSubfolder: "Blocked/AI" }), /설정을 복구/);
  assert.equal(plugin.settings.aiWikiSubfolder, oldFolder);
  assert.equal(texts.get(`${destination}/Blocked`), "Human file");
  assert(dashboard.includes('dashboardActivityPlugin()?.settings?.aiWikiEnabled !== true'));
  assert(main.includes('this.step === 6 && !this.aiWikiEnabledValue ? "AI Wiki 건너뛰기"'));
  const section = main.slice(main.indexOf("// BEGIN AI WIKI"), main.indexOf("// END AI WIKI"));
  assert(!/child_process|execFile|spawn\(|requestUrl|https\.request|loadData\(|\.codex|\.claude/.test(section), "no auto-install, credential reads or AI process requests");
  console.log("AI Wiki checks passed: opt-in/no disabled I/O; root-relative paths; traversal guards; preserved notes/templates/settings; save rollback; duplicate metadata; cached listing; scoped prompts/skill; user-mediated access challenge; explicit safe app launch; root migration and optional setup.");
})().catch(error => { console.error(error); process.exitCode = 1; });
