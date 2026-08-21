const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const start = main.indexOf("const CR_STATES = [");
const end = main.indexOf("\nconst CR_SLA =", start);
if (start < 0 || end < 0) throw new Error("Status guide data block was not found");
const data = Function(`${main.slice(start, end)}; return { CR_STATES, SR_STATES, STATUS_GUIDES };`)();

if (Object.keys(data.STATUS_GUIDES.CR).length || Object.keys(data.STATUS_GUIDES.SR).length) {
  throw new Error("Organization status guides are still bundled in the public plugin");
}
if (!main.includes("class StatusGuideModal extends Modal")) throw new Error("Status guide modal is missing");
if (!main.includes('text: "현재 상태 업무 가이드"')) throw new Error("Ticket status guide button is missing");
if (!main.includes("openCurrentStatusGuide(ticketId)")) throw new Error("Current-state guide lookup is missing");
if (!main.includes('guideButton.hidden = !this.organizationFeatureEnabled("statusGuides")')) throw new Error("Status guide UI gate is missing");
if (!main.includes("this.organizationPack?.statusGuides?.[category]")) throw new Error("Organization-pack status guide lookup is missing");
if (!main.includes("체크리스트 복사")) throw new Error("Guide checklist copy action is missing");
if (!main.includes("this.guide.workNoteTemplates")) throw new Error("Guide Working Note template lookup is missing");
if (!main.includes('text: "문구 복사"')) throw new Error("Guide Working Note copy action is missing");
if (!styles.includes(".clt-status-guide-modal") || !styles.includes(".clt-status-guide-checklist")) {
  throw new Error("Status guide modal styling is missing");
}
if (!styles.includes(".clt-status-guide-template")) throw new Error("Guide Working Note template styling is missing");

console.log("CR/SR current status guide checks passed");
