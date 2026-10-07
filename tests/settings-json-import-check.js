const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
class Element {
  constructor(tag = "div", options = {}) { this.tag = tag; this.textContent = options.text || ""; this.value = ""; this.children = []; this.events = {}; this.attrs = {}; this.disabled = false; Object.assign(this, options); }
  createEl(tag, options) { const el = new Element(tag, options); this.children.push(el); return el; }
  createDiv(options) { return this.createEl("div", options); }
  createSpan(options) { return this.createEl("span", options); }
  addClass(value) { this.cls = value; }
  setText(value) { this.textContent = value; }
  setAttr(key, value) { this.attrs[key] = value; }
  addEventListener(key, handler) { this.events[key] = handler; }
  async fire(key) { await this.events[key]?.({ target: this }); }
  focus() { this.focused = true; }
  empty() { this.children = []; }
  all(tag) { return this.children.flatMap(child => [ ...(child.tag === tag ? [child] : []), ...child.all(tag) ]); }
}
class Modal {
  constructor(app) { this.app = app; this.modalEl = new Element(); this.titleEl = new Element(); this.contentEl = new Element(); }
  open() { this.opened = true; this.onOpen(); }
  close() { this.opened = false; this.onClose(); }
}
const notices = [];
const ctx = vm.createContext({ Modal, Notice: class { constructor(message) { notices.push(message); } } });
vm.runInContext(main.slice(main.indexOf("class SettingsJsonImportModal extends Modal"), main.indexOf("class BearerTokenModal extends Modal")), ctx);
function method(name, next) {
  return main.slice(main.indexOf(`  ${name}(`), main.indexOf(`\n  ${next}(`, main.indexOf(`  ${name}(`)));
}
const imports = vm.runInContext("({" + method("importOrganizationPack", "async applyOrganizationPack") + "," + method("importGoogleOAuthJson", "async applyGoogleOAuthJson") + "})", ctx);
let appliedPack = null, appliedGoogle = null, callbacks = 0;
const plugin = {
  ...imports, app: {}, hasOrganizationPack: () => Boolean(appliedPack),
  applyOrganizationPack: async pack => {
    assert.equal(pack.schemaVersion, 1); if (!pack.packId) throw new Error("packId 또는 name이 없습니다.");
    appliedPack = pack; return pack;
  },
  applyGoogleOAuthJson: async value => {
    if (!value.installed?.client_id || !value.installed?.client_secret) throw new Error("client_id 또는 client_secret을 찾을 수 없습니다.");
    appliedGoogle = value;
  }
};
function controls(modal) {
  return { json: modal.jsonInput, file: modal.fileInput,
    submit: modal.contentEl.all("button").find(b => b.textContent === "등록"),
    cancel: modal.contentEl.all("button").find(b => b.textContent === "취소"),
    status: modal.contentEl.all("div").find(el => el.attrs.role === "status") };
}
(async () => {
  let modal = plugin.importOrganizationPack(() => callbacks++);
  assert(modal.opened); assert(modal.titleEl.textContent.includes("가져오기"));
  let c = controls(modal);
  assert(modal.contentEl.all("input").includes(c.file), "Native file control must be attached to the modal");
  await c.submit.fire("click"); assert(modal.opened); assert(c.json.focused); assert.equal(appliedPack, null);
  c.json.value = '{ "client_secret": "sensitive-invalid-json",';
  await c.submit.fire("click"); assert(c.status.textContent.includes("JSON 문법")); assert(!c.status.textContent.includes("sensitive-invalid-json")); assert(!c.submit.disabled);
  c.json.value = '{"schemaVersion":1,"name":"Incomplete"}';
  await c.submit.fire("click"); assert(c.status.textContent.includes("packId")); assert.equal(appliedPack, null);
  const firstPack = { schemaVersion: 1, packId: "example", name: "Example guide", analysisTemplates: { CR: "Example" } };
  c.json.value = JSON.stringify(firstPack); await c.submit.fire("click");
  assert(!modal.opened); assert.equal(callbacks, 1); assert.equal(appliedPack.packId, "example"); assert.equal(c.json.value, "");
  modal = plugin.importOrganizationPack(() => callbacks++); c = controls(modal);
  assert(modal.titleEl.textContent.includes("교체"));
  c.file.files = [{ name: "guide.json", text: async () => "\uFEFF" + JSON.stringify({ ...firstPack, name: "Replacement" }) }];
  await c.file.fire("change"); assert(c.status.textContent.includes("guide.json")); assert.equal(appliedPack.name, "Example guide");
  await c.submit.fire("click"); assert.equal(appliedPack.name, "Replacement"); assert.equal(callbacks, 2);
  modal = plugin.importGoogleOAuthJson(() => callbacks++); c = controls(modal);
  assert(modal.opened); assert(modal.titleEl.textContent.includes("Google OAuth"));
  c.json.value = "{}"; await c.submit.fire("click"); assert(modal.opened); assert(c.status.textContent.includes("client_id")); assert.equal(appliedGoogle, null);
  c.file.files = [{ name: "unreadable.json", text: async () => { throw new Error("read failed"); } }];
  await c.file.fire("change"); assert(c.status.textContent.includes("직접 붙여넣을")); assert(!c.submit.disabled);
  c.json.value = JSON.stringify({ installed: { client_id: "example-client", client_secret: "example-secret" } });
  await c.submit.fire("click"); assert.equal(appliedGoogle.installed.client_id, "example-client"); assert.equal(callbacks, 3); assert(!modal.opened); assert.equal(c.json.value, "");
  modal = plugin.importGoogleOAuthJson(() => callbacks++); c = controls(modal); c.json.value = "temporary"; await c.cancel.fire("click"); assert(!modal.opened); assert.equal(c.json.value, ""); assert.equal(callbacks, 3);
  assert(!method("importOrganizationPack", "async applyOrganizationPack").includes("input.click()"));
  assert(!method("importGoogleOAuthJson", "async applyGoogleOAuthJson").includes("input.click()"));
  const settingsStart = main.search(/^class \w+ extends PluginSettingTab/m);
  assert(settingsStart >= 0, "Settings UI class must exist");
  const settings = main.slice(settingsStart, main.indexOf("class CltServiceNowWorkNotes", settingsStart));
  let handlers = 0;
  for (const call of settings.matchAll(/\.onClick\([^\n]*this\.plugin\.(\w+)\(/g)) {
    assert(new RegExp(`^  (?:async )?${call[1]}\\(`, "m").test(main), `Missing settings button handler: ${call[1]}`);
    handlers++;
  }
  assert(handlers >= 8, "Settings button audit must cover actual handlers");
  assert(notices.every(message => !message.includes("example-secret")));
  console.log("Settings JSON import/replace checks passed: pack and Google, file and paste, retry, cancel, safe errors, attached controls.");
})().catch(error => { console.error(error); process.exitCode = 1; });
