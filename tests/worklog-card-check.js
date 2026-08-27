const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");

if (!main.includes("function extractTicketWorkLogs(markdown)")) throw new Error("Work-log parser is missing");
const formatterSource = main.match(/function formatMarkdownListEntry\(prefix, content\) \{[\s\S]*?\n\}/)?.[0];
if (!formatterSource) throw new Error("Work-log Markdown formatter is missing");
const formatMarkdownListEntry = Function(`${formatterSource}; return formatMarkdownListEntry;`)();
const bulletEntry = formatMarkdownListEntry("- 2026-08-26 16:54 : ", "- 테스트3\n- 테스트4");
if (bulletEntry !== "- 2026-08-26 16:54 :\n    - 테스트3\n    - 테스트4") {
  throw new Error(`Work-log bullet list is flattened: ${JSON.stringify(bulletEntry)}`);
}
const plainEntry = formatMarkdownListEntry("- 2026-08-26 16:54 : ", "일반 문장");
if (plainEntry !== "- 2026-08-26 16:54 : 일반 문장") throw new Error("Plain work-log entry formatting regressed");
const prefixStripperSource = main.match(/function stripWorkLogEntryPrefix\(raw, dateTime\) \{[\s\S]*?\n\}/)?.[0];
if (!prefixStripperSource) throw new Error("Work-log prefix parser is missing");
const stripWorkLogEntryPrefix = Function(`${prefixStripperSource}; return stripWorkLogEntryPrefix;`)();
if (stripWorkLogEntryPrefix("2026-08-26 16:54 : - 테스트3\n- 테스트4", "2026-08-26 16:54") !== "- 테스트3\n- 테스트4") {
  throw new Error("Existing work-log first bullet is not preserved");
}
if (!main.includes("renderTicketWorkLogCards(sourceList, ticketId, workLogs")) throw new Error("Ticket work-log card renderer is missing");
if (!main.includes("await mountWorkLogCards()")) throw new Error("Ticket work-log cards are not mounted");
if (!main.includes('sourceList.dataset.cltWorklogView || "latest"')) throw new Error("Recent work-log view is not the default");
if (!main.includes('latestButton.textContent = "최근 작업"')) throw new Error("Recent work-log button is missing");
if (!main.includes('allButton.textContent = "전체 작업"')) throw new Error("All work-log button is missing");
if (!main.includes('sortDirection === "desc" ? "최신순" : "오래된순"')) throw new Error("Work-log sorting control is missing");
if (!main.includes("async deleteTicketWorkLog(sourcePath, entry)")) throw new Error("Work-log deletion API is missing");
if (!main.includes('cls: "clt-ticket-worklog-delete"')) throw new Error("Ticket work-log delete control is missing");
if (!styles.includes(".clt-ticket-worklog-toolbar")) throw new Error("Work-log toolbar styles are missing");
if (!main.includes("new ConfirmDeleteModal(this.app")) throw new Error("Custom To-Do delete confirmation is missing");
if (main.includes("window.confirm(`${this.task.ticketId}의 이 To-Do를 삭제하시겠습니까?")) throw new Error("Native delete confirmation is still used");
if (!styles.includes(".clt-ticket-worklog-cards")) throw new Error("Work-log card styles are missing");
if (!styles.includes(".clt-confirm-modal")) throw new Error("Delete confirmation styles are missing");
if (!main.includes('if (/^https?:\\/\\//i.test(href)) void shell.openExternal(href);')) throw new Error("Rich editor links do not open on a normal click");
if (!main.includes("function isVideoAttachment(fileName, contentType")) throw new Error("Video attachment detection is missing");
if (!main.includes("async ensureAttachmentVideoFile(ticketId, entry)")) throw new Error("Video attachment persistence is missing");
if (!main.includes('preview.createEl("video"')) throw new Error("Video attachment player is missing");
if (!styles.includes(".clt-sn-video-preview video")) throw new Error("Video player styles are missing");

console.log("Ticket work-log card and delete confirmation checks passed");
