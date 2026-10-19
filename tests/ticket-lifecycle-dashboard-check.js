const fs = require("fs"), path = require("path"), assert = require("assert");
const source = fs.readFileSync(path.join(__dirname, "..", "resources", "업무현황.md"), "utf8");
const start = source.indexOf("function dashboardActivityPlugin()"), end = source.indexOf("\nawait dashboardActivityPlugin()", start);
assert(start > 0 && end > start);
const settings = { ticketScope: "active" }, reads = [];
const pages = Array.from({ length: 120 }, (_, index) => ({ page: { id: `CR${index}`, status: "Open", file: { path: `CR${index}.md`, name: `CR${index}` } }, detailsLoaded: false }));
const files = new Map(pages.map(item => [item.page.file.path, { path: item.page.file.path, stat: { mtime: 1 } }]));
const plugin = { getTicketActivity: id => ({ kind: Number(id.slice(2)) < 20 ? "active" : Number(id.slice(2)) < 100 ? "archived" : "dormant" }), readTicketNoteSnapshot: async file => { reads.push(file.path); return file.path; } };
const app = { plugins: { getPlugin: () => plugin }, vault: { getAbstractFileByPath: file => files.get(file) } };
const makeHelpers = Function("app", "settings", "pages", "extractWorkLogs", "extractTodos", "getLatestWorkLog", source.slice(start, end) + ";return {matchesTicketActivityScope, ensureVisibleTicketDetails, ensureTicketItemDetails};");
const helpers = makeHelpers(
  app, settings, pages, value => [value], value => [{ text: value }], value => value[0]);
(async () => {
  await Promise.all([helpers.ensureVisibleTicketDetails(), helpers.ensureVisibleTicketDetails()]);
  assert.equal(reads.length, 20, "only active root details are read, including concurrent calls");
  await helpers.ensureVisibleTicketDetails(); assert.equal(reads.length, 20, "unchanged rerender does not reread all notes");
  await helpers.ensureVisibleTicketDetails("CR25"); assert.equal(reads.length, 21, "exact historical lookup reads only one extra note");
  assert(helpers.matchesTicketActivityScope(pages[25], "cr25"));
  assert(!helpers.matchesTicketActivityScope(pages[25], "CR2"));
  plugin.getTicketActivitySearchText = id => id === "CR30" ? "related CR25 and CR250" : "";
  assert(helpers.matchesTicketActivityScope(pages[30], "CR25"), "indexed related historical tickets can be found by ticket number");
  assert(!helpers.matchesTicketActivityScope(pages[30], "CR2"), "related lookup must respect ticket boundaries");
  files.get("CR1.md").stat.mtime = 2; await helpers.ensureVisibleTicketDetails(); assert.equal(reads.length, 22, "one changed active note is reread");
  settings.ticketScope = "dormant"; await helpers.ensureVisibleTicketDetails(); assert.equal(reads.length, 42);
  settings.ticketScope = "all"; await helpers.ensureVisibleTicketDetails(); assert.equal(reads.length, 121);
  const recreated = pages.map(item => ({ page: item.page, detailsLoaded: false }));
  const nextDashboard = makeHelpers(app, settings, recreated, value => [value], value => [{ text: value }], value => value[0]);
  await nextDashboard.ensureVisibleTicketDetails(); assert.equal(reads.length, 121, "parsed details survive dashboard recreation without another read");
  const missing = { page: { id: "SR0", file: { path: "missing.md", name: "SR0" } }, detailsLoaded: false };
  await helpers.ensureTicketItemDetails(missing); assert(missing.detailsLoaded, "deleted files cannot create an endless pending-details loop");
  const retryItem = { page: { id: "SR1", file: { path: "retry.md", name: "SR1" } }, detailsLoaded: false };
  files.set("retry.md", { path: "retry.md", stat: { mtime: 1 } });
  const readSnapshot = plugin.readTicketNoteSnapshot, warn = console.warn;
  plugin.readTicketNoteSnapshot = async () => { throw new Error("simulated read failure"); };
  try { console.warn = () => {}; await helpers.ensureTicketItemDetails(retryItem); }
  finally { console.warn = warn; plugin.readTicketNoteSnapshot = readSnapshot; }
  assert(retryItem.detailsLoaded && retryItem.detailsError, "one read failure must not blank the entire dashboard or loop the To-Do renderer");
  await helpers.ensureTicketItemDetails(retryItem);
  assert.equal(retryItem.detailsError, null, "another explicit detail request retries a transient read failure");
  assert(source.includes('ticketActivityToolbar.classList.add("opus-ticket-activity-toolbar")'));
  assert(source.includes('workspace.on("servicenow-manage:ticket-activity-changed"'));
  assert(source.includes('if (rootItem && !matchesTicketActivityScope(rootItem, meetingSearchKeyword)) return;'));
  console.log("Lifecycle dashboard checks passed: 20/120 initial detail reads, deduplication, zero-read unchanged render, exact archived lookup, one-note invalidation, on-demand history and deleted-note handling.");
})().catch(error => { console.error(error); process.exitCode = 1; });
