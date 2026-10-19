const fs = require("fs"), path = require("path"), assert = require("assert");
const source = fs.readFileSync(path.join(__dirname, "..", "resources", "업무현황.md"), "utf8");
const start = source.indexOf("function buildJiraCellTextPayload(");
const end = source.indexOf("\nfunction buildJiraJsonPayload", start);
assert(start > 0 && end > start);
const build = Function("jiraExportValue", "normalizeJiraDetailLines", source.slice(start, end) + "; return buildJiraCellTextPayload;")(
  (field, task) => task[field.key] || "", value => String(value).split(/\r?\n/).filter(Boolean));
const fields = ["ticket", "description", "phase", "memo", "target"].map(key => ({ key, label: { phase: "Phase", memo: "Memo", target: "Target QA Completion Date" }[key] || key }));
const memo = "첫 문단입니다.\r\n\r\n둘째 문단입니다.\r\n\r\n- 확인 항목\r\n  - 하위 항목";
const tasks = [{ ticket: "CR1", description: "Example", phase: "Ready for UAT", memo, target: "2026-10-19" }, { ticket: "CR2", memo: "한 줄 메모" }];
const result = build(tasks, fields);
assert(result.text.includes("   - Phase: Ready for UAT\n\n   - Memo:\n     첫 문단입니다.\n\n     둘째 문단입니다.\n\n     - 확인 항목\n       - 하위 항목\n\n   - Target QA Completion Date: 2026-10-19"));
assert(result.text.includes("2026-10-19\n\n2. CR2\n   - Memo: 한 줄 메모"));
assert.equal(result.rows[0][3], memo);
assert(!result.text.includes("\r"));
assert(!result.text.split("\n").some(line => /\s+$/.test(line)));
assert(!build([{ ticket: "CR1", memo: "" }], fields).text.includes("Memo:"));
console.log("Jira memo cell-text spacing checks passed: paragraph blanks, aligned multiline block, nested bullets, field/ticket gaps, CRLF, single-line memo and unchanged raw values.");
