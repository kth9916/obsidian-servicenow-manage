const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const dashboard = fs.readFileSync(path.join(root, "resources", "업무현황.md"), "utf8");

const requiredSelectors = [
  ".markdown-preview-sizer:has(.clt-sn-root)",
  ".markdown-preview-section:has(.clt-sn-root)",
  ".markdown-preview-sizer:has(.clt-sn-ticket-status)",
  ".markdown-preview-section:has(.clt-sn-ticket-status)",
  ".markdown-source-view.mod-cm6 .cm-sizer:has(.clt-sn-root)",
  ".markdown-source-view.mod-cm6 .cm-sizer:has(.clt-sn-ticket-status)",
];

for (const selector of requiredSelectors) {
  if (!styles.includes(selector)) throw new Error(`Readable-line-length override is missing: ${selector}`);
}

if (!dashboard.includes(".markdown-preview-sizer:has(.opus-dashboard)")) {
  throw new Error("Dashboard readable-line-length override is missing");
}
if (!styles.includes("@media (max-width: 900px)")) throw new Error("Work-note responsive layout is missing");
if (!styles.includes("@media (max-width: 560px)")) throw new Error("Ticket To-Do responsive layout is missing");
if (!dashboard.includes("@media (max-width: 900px)")) throw new Error("Dashboard modal responsive layout is missing");
if (!dashboard.includes("@media (max-width: 650px)")) throw new Error("Dashboard toolbar responsive layout is missing");

console.log("Readable-width coverage checks passed");
