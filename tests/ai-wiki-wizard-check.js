const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
class Element {
  constructor(tag = "div", opts = {}) { this.tag = tag; this.textContent = opts.text || ""; this.children = []; this.events = {}; this.attrs = opts.attr || {}; this.disabled = false; this.value = opts.value || ""; }
  createEl(tag, opts = {}) { const el = new Element(tag, opts); this.children.push(el); return el; }
  createDiv(opts) { return this.createEl("div", opts); } createSpan(opts) { return this.createEl("span", opts); }
  empty() { this.children = []; } setText(value) { this.textContent = value; } setAttr(key, value) { this.attrs[key] = value; } addClass(value) { this.cls = value; }
  addEventListener(name, handler) { this.events[name] = handler; }
  all() { return this.children.flatMap(child => [child, ...child.all()]); }
}
class Modal { constructor(app) { this.app = app; this.contentEl = new Element(); this.modalEl = new Element(); this.titleEl = new Element(); } }
class Setting {
  constructor(host) { this.control = host.createDiv(); }
  setName() { return this; } setDesc() { return this; }
  addText(callback) { return this.add("input", callback); } addToggle(callback) { return this.add("toggle", callback); } addButton(callback) { return this.add("button", callback); }
  add(tag, callback) { const el = this.control.createEl(tag), control = { el,
    setValue(value) { el.value = value; return control; }, setDisabled(value) { el.disabled = value; return control; }, setPlaceholder() { return control; },
    setButtonText(value) { el.textContent = value; return control; }, onChange(fn) { el.change = fn; return control; }, onClick(fn) { el.click = fn; return control; }
  }; callback(control); return this; }
}
const ctx = vm.createContext({ Modal, Setting, Notice: class {}, process: { platform: "win32" } });
vm.runInContext(source.slice(source.indexOf("// BEGIN AI WIKI"), source.indexOf("// END AI WIKI")), ctx);
vm.runInContext(source.match(/function renderAiWikiSettings\([^]*?\n\}/)[0], ctx);
const Wizard = vm.runInContext("AiWikiConnectModal", ctx);
(async () => {
  let release, fail = false, prepared = 0, verified = 0, launched;
  const plugin = {
    settings: { aiWikiEnabled: false, aiWikiSubfolder: "LLM WIKI", aiWikiProvider: "codex", aiWikiAllowWrites: false }, rootFolder: () => "Project A",
    aiWikiFolder: () => "Project A/" + plugin.settings.aiWikiSubfolder, absoluteVaultPath: value => "D:/Notes/" + value,
    configureAiWiki: async changes => { if (release) await new Promise(resolve => { release.resolve = resolve; }); if (fail) throw Error("disk unavailable"); Object.assign(plugin.settings, changes); if (changes.aiWikiEnabled || changes.aiWikiSubfolder) plugin.settings.aiWikiFolderApplied = true; },
    launchAiWikiApp: async (provider, path) => { launched = [provider, path]; },
    prepareAiWikiChallenge: async () => { prepared++; }, getAiWikiConnectionStatus: async () => ({ state: verified ? "verified" : "pending" }),
    verifyAiWikiChallenge: async (answer, options) => { if (answer !== "correct") throw Error("wrong code"); assert.equal(options.provider, "codex"); verified++; }
  };
  const host = new Element(); ctx.renderAiWikiSettings(host, plugin, () => { throw Error("must not discard draft inputs by rebuilding the settings tab"); });
  const controls = host.all(), toggle = controls.find(el => el.tag === "toggle"), writer = controls.filter(el => el.tag === "toggle")[1];
  const input = controls.find(el => el.tag === "input"), apply = controls.find(el => el.textContent === "적용");
  const state = controls.find(el => el.attrs["aria-label"] === "저장 폴더 적용 상태");
  const appProvider = controls.find(el => el.attrs["aria-label"] === "앱 경로를 설정할 AI");
  const appPath = controls.find(el => el.attrs["aria-label"] === "고급 AI 앱 실행 경로");
  const saveApp = controls.find(el => el.textContent === "앱 경로 저장"), launchApp = controls.find(el => el.textContent === "등록한 앱 열기");
  assert(appProvider.disabled && appPath.disabled && saveApp.disabled && launchApp.disabled);
  assert(state.textContent.startsWith("미적용")); assert(writer.disabled);
  release = {}; const enabling = toggle.change(true);
  assert(toggle.disabled && writer.disabled); assert(controls.find(el => el.attrs["aria-label"] === "AI Wiki 설정 저장 상태").textContent.includes("저장 중"));
  release.resolve(); release = null; await enabling;
  assert(!writer.disabled, "enabling must unlock recording settings without applying the folder again"); assert(state.textContent.startsWith("적용됨")); assert(apply.disabled);
  assert(!appPath.disabled && !saveApp.disabled && !launchApp.disabled);
  appProvider.value = "claude"; appProvider.events.change(); appPath.value = "C:/Apps/Claude.exe";
  await saveApp.events.click(); assert.equal(plugin.settings.aiWikiAppPaths.claude, appPath.value);
  assert.equal(plugin.settings.aiWikiProvider, "codex", "advanced launcher must not change the selected connection provider");
  await launchApp.events.click(); assert.deepEqual(launched, ["claude", appPath.value]);
  input.value = "Changed Wiki"; input.change(input.value); assert(state.textContent.includes("아직 미적용")); assert(!apply.disabled);
  await writer.change(true); assert.equal(input.value, "Changed Wiki");
  assert(state.textContent.includes("아직 미적용"), "unrelated autosave must preserve the folder draft");
  fail = true; await apply.click(); assert(state.textContent.includes("아직 미적용")); assert.equal(plugin.settings.aiWikiSubfolder, "LLM WIKI");
  fail = false; await apply.click(); assert.equal(plugin.settings.aiWikiSubfolder, "Changed Wiki"); assert(state.textContent.startsWith("적용됨"));
  const wizard = new Wizard({}, plugin); wizard.render = () => {};
  await wizard.next(); assert.equal(wizard.step, 1);
  await assert.rejects(() => wizard.next(), /준비/); assert.equal(wizard.step, 1);
  wizard.folderConfirmed = true; await wizard.next(); assert.equal(wizard.step, 2);
  await assert.rejects(() => wizard.next(), /프롬프트/); assert.equal(prepared, 0);
  wizard.promptConfirmed = true; await wizard.next(); assert.equal(wizard.step, 3); assert.equal(prepared, 1);
  wizard.answer = "kept"; wizard.step = 2; await wizard.next(); assert.equal(prepared, 1); assert.equal(wizard.answer, "kept", "Back/Next must not silently rotate the proof or erase input");
  await assert.rejects(() => wizard.next(), /wrong code/); assert.equal(wizard.step, 3); assert.equal(verified, 0);
  wizard.answer = "correct"; await wizard.next(); assert.equal(wizard.step, 4); assert.equal(verified, 1);
  const cancelled = new Wizard({}, plugin); cancelled.render = () => {}; cancelled.onClose(); await cancelled.act(async () => { throw Error("closed wizard ran"); }); assert.equal(verified, 1);
  const changed = new Wizard({}, plugin); changed.render = () => {}; changed.step = 3; changed.preparedFolder = "old folder"; changed.answer = "correct";
  await assert.rejects(() => changed.next(), /폴더/); assert.equal(verified, 1);
  console.log("AI Wiki wizard/settings checks passed: explicit pending/applying/applied states; immediate autosave progress; dependent controls; retained folder draft; errors/retry; ordered gated steps; Back/Next preservation; cancellation and changed-root rejection.");
})().catch(error => { console.error(error); process.exitCode = 1; });
