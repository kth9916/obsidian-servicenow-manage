const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const dashboard = fs.readFileSync(path.join(root, "resources", "업무현황.md"), "utf8");

for (const expected of [
  "class MeetingImportModal extends Modal",
  "class MeetingListModal extends Modal",
  "function buildMeetingNoteMarkdown(",
  "async importMeetingFiles(ticketId, files, options = {})",
  "listTicketMeetings(ticketId, sortDirection = \"desc\")",
  "openMeetingListModal(ticketId)",
  "clt-ticket-meeting-actions",
  "ticketMeetingsFolder(ticketId)",
  "마크다운(.md)으로 내려받아 등록하는 방식을 권장"
]) {
  if (!main.includes(expected)) throw new Error(`Meeting-minutes implementation is missing: ${expected}`);
}

if (!main.includes("`${this.ticketFolder(ticketId)}/회의록`")) {
  throw new Error("Meeting notes are not stored beside the ticket assets folder");
}
if (!main.includes('sortDirection === "asc" ? compared : -compared')) {
  throw new Error("Meeting list chronological sorting is missing");
}
if (!main.includes("await this.app.vault.createBinary(pdfPath")) {
  throw new Error("Optional PDF source preservation is missing");
}
if (!main.includes('cssclasses:\\n  - clt-meeting-note')) {
  throw new Error("Generated meeting notes do not opt into the visual meeting-note design");
}
if (!styles.includes(".clt-meeting-card") || !styles.includes(".clt-meeting-note h1")) {
  throw new Error("Meeting list or note visual styles are missing");
}
if (!dashboard.includes("data-meeting-index") || !dashboard.includes("openMeetingListModal(ticketId)")) {
  throw new Error("Dashboard meeting icon integration is missing");
}

const functionSource = name => {
  const source = main.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
  if (!source) throw new Error(`${name} source could not be extracted`);
  return source;
};
const parser = Function(`
  const normalizeTicketId = value => String(value || "").toUpperCase();
  const localIsoDateTime = () => "2026-09-14 12:00";
  const safeFileName = value => String(value || "");
  ${functionSource("escapeRegExp")}
  ${functionSource("parseMeetingDate")}
  ${functionSource("cleanMeetingTitle")}
  ${functionSource("meetingSection")}
  ${functionSource("buildMeetingNoteMarkdown")}
  return { parseMeetingDate, buildMeetingNoteMarkdown };
`)();
if (parser.parseMeetingDate("CR0022122 회의 - 2026_09_11 09_30 KST.md") !== "2026-09-11T09:30") {
  throw new Error("Gemini filename date/time parsing regressed");
}
const sample = `# **📝 회의록**\n\n9월 11, 2026\n\n## **CR0022122 회의**\n\n초대됨 Amy 김미선\n\n### **요약**\n\n핵심 요약\n\n### **결정**\n\n## 의견 일치\n\n* API 전송 합의\n\n### **다음 단계**\n\n- [ ] 담당자 확인\n\n### **상세정보**\n\n* 상세 논의\n\n# **📖 스크립트**\n\n### **00:00:31**\n\n**Amy：** 테스트`;
const generated = parser.buildMeetingNoteMarkdown({
  ticketId: "CR0022122",
  sourceName: "CR0022122 회의 - 2026_09_11 09_30 KST.md",
  sourceText: sample
});
for (const expected of ["meeting_date: \"2026-09-11T09:30\"", "회의 핵심", "API 전송 합의", "담당자 확인", "상세 논의", "스크립트 펼치기"]) {
  if (!generated.includes(expected)) throw new Error(`Generated meeting note lost content: ${expected}`);
}

console.log("Meeting-minutes import, list, sorting, and dashboard checks passed");
