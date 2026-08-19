const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

for (const marker of [
  "const FIRST_RUN_SETUP_VERSION = 1",
  "setupWizardVersion: 0",
  "class FirstRunSetupModal extends Modal",
  'id: "open-setup-wizard"',
  "openSetupWizard()",
  "applyGoogleOAuthJson(value)",
  "applyOrganizationPack(value)",
  "ServiceNow Manage 초기 설정",
  "업무가이드팩이 있나요?"
]) {
  if (!main.includes(marker)) throw new Error(`Missing setup wizard marker: ${marker}`);
}

if (/업무자료 팩|조직 업무자료/.test(main)) throw new Error("Legacy work-guide-pack labels remain in the UI");

for (const marker of [".snm-setup-modal", ".snm-setup-footer", ".snm-setup-summary"]) {
  if (!styles.includes(marker)) throw new Error(`Missing setup wizard style: ${marker}`);
}

if (manifest.author !== "thkim9916") throw new Error("Public author is not configured");
console.log("First-run setup wizard checks passed");
