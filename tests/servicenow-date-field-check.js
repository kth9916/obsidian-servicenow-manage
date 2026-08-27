const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

assert.match(source, /estimatedQaCompletionDate:[\s\S]*?"u_est_qa_comp_date"/,
  "ONE ServiceNow Estimated QA Completion Date field must be mapped");
assert.match(source, /targetQaCompletionDate:[\s\S]*?"u_qa_comp_date"/,
  "ONE ServiceNow Target QA Completion Date field must be mapped");
assert.match(source, /actualReleaseDate:[\s\S]*?"u_release_date"/,
  "ONE ServiceNow Actual Release Date field must be mapped");
assert.match(source, /deploymentFinish:[\s\S]*?"end_date"/,
  "ONE ServiceNow Deployment Finish field must be mapped");
assert.match(source, /uiInterfaceIds:[\s\S]*?"u_ui_i_f_id"/,
  "ONE ServiceNow UI & I/F ID field must be mapped");

assert.match(source, /"배포일":\s*metadata\.deploymentFinish/,
  "Deployment Finish must overwrite the existing Deploy Date field");
assert.doesNotMatch(source, /^\s*deployment_finish:\s*metadata\.deploymentFinish/m,
  "Deployment Finish must not be duplicated in ticket frontmatter");
assert.match(source, /function mergeDeploymentFinishField[\s\S]*?delete frontmatter\.deployment_finish/,
  "Legacy deployment_finish must be migrated to Deploy Date");

const migrationSource = source.match(/function mergeDeploymentFinishField\(frontmatter\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(migrationSource, "Deployment Finish migration helper must exist");
const mergeDeploymentFinishField = Function(`${migrationSource}; return mergeDeploymentFinishField;`)();
const legacy = { deployment_finish: "2026-08-25 10:00:00", "배포일": "2026-08-24" };
assert.equal(mergeDeploymentFinishField(legacy), true);
assert.equal(legacy["배포일"], "2026-08-25 10:00:00");
assert.equal(Object.prototype.hasOwnProperty.call(legacy, "deployment_finish"), false);
const manualOnly = { deployment_finish: "", "배포일": "2026-08-24" };
mergeDeploymentFinishField(manualOnly);
assert.equal(manualOnly["배포일"], "2026-08-24", "An empty legacy field must not erase Deploy Date");
assert.match(source, /ui_interface_id:\s*metadata\.uiInterfaceIds/,
  "UI & I/F IDs must be written to ticket frontmatter");

console.log("ServiceNow date field mapping check passed.");
