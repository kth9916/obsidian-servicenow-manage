const fs = require("fs");
const path = require("path");

const main = fs.readFileSync(path.resolve(__dirname, "..", "main.js"), "utf8");
const start = main.indexOf("function summarizeTicketNotices(");
const end = main.indexOf("\nfunction ", start + 1);
if (start < 0 || end < 0) throw new Error("Ticket notice summarizer was not found");
const summarize = Function(`${main.slice(start, end)}; return summarizeTicketNotices;`)();
const summary = summarize([
  { ticketId: "CR001", kind: "worknotes", failed: false },
  { ticketId: "CR002", kind: "worknotes", failed: false },
  { ticketId: "CR002", kind: "documents", failed: true }
]);
if (!summary.includes("티켓 2건이 자동 변경되었습니다")) throw new Error("Unique ticket total is incorrect");
if (!summary.includes("워킹노트 생성·갱신 2건")) throw new Error("Work-notes count is missing");
if (!summary.includes("문서 연결 1건")) throw new Error("Document count is missing");
if (!summary.includes("실패 1건")) throw new Error("Failure count is missing");
if (!main.includes("if (entries.length < 3)")) throw new Error("One-to-two notice threshold is missing");
console.log("Notification batching checks passed");
