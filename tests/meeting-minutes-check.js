const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const dashboard = fs.readFileSync(path.join(root, "resources", "업무현황.md"), "utf8");

for (const expected of [
  "class MeetingImportModal extends Modal",
  "class MeetingListModal extends Modal",
  "class DriveMeetingCandidateModal extends Modal",
  "class MeetingAnalysisPromptModal extends Modal",
  "function buildMeetingNoteMarkdown(",
  "function buildMeetingAnalysisPrompt(",
  "async importMeetingFiles(ticketId, files, options = {})",
  "async searchGoogleDriveMeetingDocuments(ticketId)",
  "async importGoogleDriveMeeting(ticketId, candidate)",
  "async deleteTicketMeeting(meeting)",
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
if (!main.includes("name contains '${normalized}' and name contains 'Gemini가 작성한 회의록'")) {
  throw new Error("Google Drive meeting search does not enforce the required AND condition");
}
if (!main.includes('mimeType: "text/markdown"') || !main.includes('mimeType: "application/pdf"')) {
  throw new Error("Google Docs Markdown import or optional PDF preservation is missing");
}
if (!main.includes("source_drive_id") || !main.includes("meeting_kind: analysis")) {
  throw new Error("Drive duplicate tracking or AI analysis classification is missing");
}
if (!main.includes("await this.app.vault.trash(meeting.file, true)")) {
  throw new Error("Meeting-note deletion does not use the Obsidian trash");
}
const guideIndex = main.indexOf('text: "현재 상태 업무 가이드"');
const ticketAiIndex = main.indexOf('text: "AI 티켓 분석 프롬프트 생성"', guideIndex);
const analysisIndex = main.indexOf('text: "AI 회의록 분석"', ticketAiIndex);
const statusIndex = main.indexOf('text: "상태·기본정보 갱신"', analysisIndex);
const importIndex = main.indexOf('text: "회의록 가져오기"', statusIndex);
if (!(guideIndex < ticketAiIndex && ticketAiIndex < analysisIndex && analysisIndex < statusIndex && statusIndex < importIndex)) {
  throw new Error("Root-note action button order is incorrect");
}
if (!styles.includes(".clt-meeting-card") || !styles.includes(".clt-meeting-note h1")) {
  throw new Error("Meeting list or note visual styles are missing");
}
if (!styles.includes(".clt-meeting-analysis-note h1") || !styles.includes(".clt-meeting-type-badge.is-analysis")) {
  throw new Error("AI meeting-analysis visual distinction is missing");
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
  ${functionSource("buildMeetingAnalysisPrompt")}
  return { parseMeetingDate, buildMeetingNoteMarkdown, buildMeetingAnalysisPrompt };
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
for (const expected of ["meeting_date: \"2026-09-11T09:30\"", "meeting_kind: gemini", "회의 핵심", "API 전송 합의", "담당자 확인", "상세 논의", "스크립트 펼치기"]) {
  if (!generated.includes(expected)) throw new Error(`Generated meeting note lost content: ${expected}`);
}

const analysisPrompt = parser.buildMeetingAnalysisPrompt({
  ticketId: "CR0022122",
  ticketPath: "EBKG/티켓/CR0022122/CR0022122.md",
  outputFolder: "EBKG/티켓/CR0022122/회의록",
  meetings: [
    { meetingDate: "2026-09-11T09:30", title: "두 번째", file: { path: "second.md" }, content: "두 번째 회의 원문" },
    { meetingDate: "2026-09-01T10:00", title: "첫 번째", file: { path: "first.md" }, content: "첫 번째 회의 원문" }
  ]
});
for (const expected of ["2026-09-01 ~ 2026-09-11 회의록 분석.md", "meeting_kind: analysis", "첫 번째 회의 원문", "두 번째 회의 원문", "Action Items"]) {
  if (!analysisPrompt.includes(expected)) throw new Error(`Meeting analysis prompt is incomplete: ${expected}`);
}
if (analysisPrompt.indexOf("첫 번째 회의 원문") > analysisPrompt.indexOf("두 번째 회의 원문")) {
  throw new Error("Meeting analysis prompt is not chronological");
}

console.log("Meeting-minutes Drive import, analysis, deletion, sorting, and dashboard checks passed");
