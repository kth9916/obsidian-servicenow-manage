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

assert.match(source, /deployment_finish:\s*metadata\.deploymentFinish/,
  "Deployment Finish must be written to ticket frontmatter");
assert.match(source, /"배포일":\s*metadata\.deploymentFinish/,
  "Deployment Finish must overwrite the existing Deploy Date field");
assert.match(source, /ui_interface_id:\s*metadata\.uiInterfaceIds/,
  "UI & I/F IDs must be written to ticket frontmatter");

console.log("ServiceNow date field mapping check passed.");
