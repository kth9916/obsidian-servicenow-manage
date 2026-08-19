const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const example = JSON.parse(fs.readFileSync(path.join(root, "examples", "organization-pack.example.json"), "utf8"));

const required = [
  'const PLUGIN_ID = "servicenow-manage"',
  'const LEGACY_PLUGIN_ID = "clt-servicenow-worknotes"',
  "loadOrganizationPack()",
  "validateOrganizationPack(pack)",
  "importOrganizationPack(onDone)",
  "removeOrganizationPack(onDone)",
  "ensureOrganizationTemplates()",
  "ensureOrganizationTemplates(options = {})",
  "options.previousPack",
  "사용자 수정 템플릿 보존",
  'guideButton.hidden = !this.organizationFeatureEnabled("statusGuides")',
  'aiPrompt.hidden = !this.organizationFeatureEnabled("aiPrompt")',
  "this.organizationPack?.slaRules?.[category]?.[status]",
  "this.organizationPack?.states?.[category]",
  "this.settings.changeRequestTable",
  "this.settings.serviceRequestTable",
  "migrateLegacySecrets()"
];

for (const marker of required) {
  if (!main.includes(marker)) throw new Error(`Missing organization-pack or generic-instance marker: ${marker}`);
}

if (/const EMBEDDED_ANALYSIS_TEMPLATE_GZIP_BASE64/.test(main)) {
  throw new Error("Private analysis templates remain embedded in the public plugin");
}
if (example.schemaVersion !== 1 || !example.packId || !example.name || !example.statusGuides || !example.analysisTemplates) {
  throw new Error("The public organization-pack example does not match schema version 1");
}
if (JSON.stringify(example).match(/token|client_secret|refresh_token|password/i)) {
  throw new Error("The public organization-pack example contains a credential-like field");
}
console.log("Organization-pack isolation checks passed");
