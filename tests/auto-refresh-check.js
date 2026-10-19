const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

assert.match(source, /scheduleViewRefresh\(this\.ticketId, "work-notes"\)/,
  "Opening the Work Notes view should schedule a full ticket refresh.");
assert.match(source, /scheduleViewRefresh\(this\.ticketId, "root"\)/,
  "Opening the root ticket view should schedule a status/basic-info refresh.");
assert.match(source, /if \(kind === "work-notes"\) void this\.syncTicket\(normalized\);\s+else void this\.syncTicketStatus\(normalized\);/,
  "View refresh must keep document downloads manual and use the correct refresh scope.");
assert.match(source, /if \(selectedLanguage !== "original"\) \{\s+void this\.plugin\.translateTicket\(this\.ticketId, selectedLanguage, \{ notify: true \}\);/,
  "Selecting a translated language should start translation automatically.");
assert(source.includes('const result = await this.syncAllTickets({ activeOnly: true });'),
  "Daily automation must refresh active tickets only, including Work Notes.");
assert(source.includes('for (const file of this.activeRootTicketFiles()) await this.syncTicket(this.rootTicketIdFromFile(file));'),
  "Hourly automation must refresh active root tickets only.");
assert.match(source, /async runCatchUpSync\(\)[\s\S]*?for \(const id of ids\) await this\.syncTicket\(id\);/,
  "Launch catch-up should continue to run the combined ticket refresh.");

console.log("auto refresh checks passed");
