const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "main.js"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
class Element {
  constructor(tag = "div", options = {}) { this.tag = tag; this.className = options.cls || ""; this.textContent = options.text || ""; this.children = []; this.listeners = {}; this.value = ""; }
  createEl(tag, options) { const child = new Element(tag, options); child.parentElement = this; this.children.push(child); return child; }
  createDiv(options) { return this.createEl("div", options); }
  createSpan(options) { return this.createEl("span", options); }
  addClass(name) { this.className += " " + name; }
  removeClass(name) { this.className = this.className.replace(name, ""); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  empty() { for (const child of [...this.children]) child.remove(); }
}
class Modal {
  constructor(app) { this.app = app; this.modalEl = new Element(); this.titleEl = this.modalEl.createDiv({ cls: "modal-title" }); this.contentEl = this.modalEl.createDiv({ cls: "modal-content" }); }
  close() { this.onClose(); this.closed = true; }
}
let confirmedDelete, copied = "", saves = [], deletes = 0, opened = 0, callbacks = 0;
const context = vm.createContext({
  Modal, Notice: class {}, ConfirmDeleteModal: class { constructor(app, options) { confirmedDelete = options; } open() {} },
  fillTodoStatusSelect: (select, plugin, status) => { select.value = status; },
  createRichMarkdownEditor: (app, owner, parent, value) => { const field = parent.createDiv({ cls: "clt-rich-markdown-editor" }); field.value = value; return field; },
  splitTodoDueValue: value => ({ date: String(value || "").slice(0, 10), time: String(value || "").slice(11, 16) }),
  composeTodoDueValue: (date, time) => date + (time ? "T" + time : ""),
  createTodoWaitingEditor: () => ({ values: () => ({}) }), renderTodoWaitingInfo: () => {},
  navigator: { clipboard: { writeText: async value => { copied = value; } } }
});
vm.runInContext(source.slice(source.indexOf("class TodoDetailEntryModal extends Modal"), source.indexOf("class WorkNotesRenderChild extends")) + "\nthis.DetailModal = TodoDetailEntryModal;", context);
const plugin = { data: { tickets: {} }, rootTicketFile: () => ({ path: "ticket.md" }), updateTodoTaskDetails: async (task, values) => { saves.push(values); return { ...task, ...values }; }, deleteTodoTask: async () => { deletes++; } };
const app = { workspace: { on: () => ({}), offref: () => {}, getLeaf: () => ({ openFile: async () => { opened++; } }) } };
const task = { ticketId: "CR0000000", text: "Example task", details: "Long details\n".repeat(100), result: "Result", status: "in-progress", dueDate: "2026-10-20T10:14" };
function open(ticketId = task.ticketId) { const modal = new context.DetailModal(app, plugin, { ...task, ticketId }, async () => { callbacks++; }); modal.onOpen(); return modal; }
function buttons(modal) { return Object.fromEntries(modal.footerEl.children.map(button => [button.textContent, button])); }
(async () => {
  const modal = open();
  assert.equal(modal.footerEl.parentElement, modal.modalEl, "footer must be outside the scrollable modal content");
  assert(!modal.contentEl.children.includes(modal.footerEl));
  assert.deepEqual(Object.keys(buttons(modal)), ["삭제", "내용 복사", "원본 티켓 열기", "저장"]);
  modal.render();
  assert.equal(modal.modalEl.children.filter(child => child.className.includes("clt-todo-detail-actions")).length, 1, "rerender must not duplicate the pinned footer");
  await buttons(modal)["내용 복사"].listeners.click();
  assert.equal(copied, [task.text, task.details, task.result].join("\n\n"));
  await buttons(modal)["저장"].listeners.click();
  assert.equal(saves.length, 1); assert.equal(saves[0].details, task.details); assert.equal(saves[0].result, task.result); assert.equal(saves[0].dueDate, task.dueDate);
  assert(modal.closed); assert.equal(modal.footerEl, null);
  const navigate = open(); await buttons(navigate)["원본 티켓 열기"].listeners.click(); assert(navigate.closed); assert.equal(opened, 1);
  const general = open(""); assert(buttons(general)["원본 티켓 열기"].disabled); general.close();
  const deletion = open(); buttons(deletion)["삭제"].listeners.click(); assert.equal(deletes, 0, "moving delete must retain the confirmation guard");
  await confirmedDelete.onConfirm(); assert.equal(deletes, 1); assert(deletion.closed); assert.equal(callbacks, 2);
  for (const marker of [".clt-todo-detail-modal > .modal-content { flex: 1 1 auto; min-height: 0; overflow-y: auto; }", ".clt-todo-detail-modal > .clt-todo-detail-actions", "flex: 0 0 auto;", "@container snm-todo-dialog (max-width: 520px)"]) assert(css.includes(marker), marker);
  console.log("To-Do pinned-footer checks passed: separate scroll region, all four actions, rerender/close cleanup, copy/save/navigation, ticketless state and delete confirmation.");
})().catch(error => { console.error(error); process.exitCode = 1; });
