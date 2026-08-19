const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");

const removedMarkers = [
  "class TicketStateHistoryModal extends Modal",
  'text: "상태 History"',
  "fetchTicketHistory(",
  "/api/now/table/sys_history_line",
  "stateHistory:",
  "historyDiagnostics:",
  "History 복사",
  "현재 Bearer Token에는 브라우저에서 보이는 Field Changes가 반환되지 않습니다."
];
for (const marker of removedMarkers) {
  if (main.includes(marker)) throw new Error(`Removed state History marker remains: ${marker}`);
}
if (styles.includes(".clt-state-history-")) {
  throw new Error("Removed state History styling remains");
}
if (!main.includes('this.apiGet("/api/now/table/sys_journal_field"')) {
  throw new Error("Work Notes journal fallback was removed accidentally");
}
if (!main.includes("workNotes = buildJournalWorkNotes(journalResponse.result || [])")) {
  throw new Error("Work Notes journal conversion was removed accidentally");
}
if (!main.includes("entries: mergeEntries(workNotes, attachments)")) {
  throw new Error("Work Notes and attachment merge is not using the simplified path");
}
if (!main.includes('(stored.entries || []).filter((entry) => entry.type !== "Field Change")')) {
  throw new Error("Legacy Field Change entries are not cleaned during status refresh");
}
for (const property of ["stateHistory", "historyDiagnostics", "lastHistorySyncedAt"]) {
  if (!main.includes(`delete stored.${property}`)) {
    throw new Error(`Legacy ${property} data is not cleaned during status refresh`);
  }
}

console.log("Removed ServiceNow state History checks passed");
