const fs = require("fs");
const path = require("path");

const dashboard = fs.readFileSync(path.resolve(__dirname, "..", "resources", "업무현황.md"), "utf8");
const start = dashboard.indexOf("function todoDueInfo(");
const end = dashboard.indexOf("// ================================================================\n// 8.", start);
if (start < 0 || end < 0) throw new Error("To-Do due label function is missing");
const todoDueInfo = Function(`${dashboard.slice(start, end)}; return todoDueInfo;`)();
const now = new Date(2026, 7, 20, 16, 51);

const timedTomorrow = todoDueInfo({ dueDate: "2026-08-21T16:51", status: "in-progress" }, now);
if (!timedTomorrow.label.includes("내일 16:51까지") || !timedTomorrow.label.includes("24시간 남음")) {
  throw new Error(`Timed tomorrow label is unclear: ${timedTomorrow.label}`);
}

const dateOnlyTomorrow = todoDueInfo({ dueDate: "2026-08-21", status: "pending" }, now);
if (dateOnlyTomorrow.label !== "⌛ 내일") throw new Error(`Date-only tomorrow label is unclear: ${dateOnlyTomorrow.label}`);

const overdueToday = todoDueInfo({ dueDate: "2026-08-20T13:00", status: "in-progress" }, now);
if (!overdueToday.label.includes("오늘 13:00 마감") || !overdueToday.label.includes("시간 지남")) {
  throw new Error(`Timed overdue label is unclear: ${overdueToday.label}`);
}

console.log("To-Do due label checks passed");
