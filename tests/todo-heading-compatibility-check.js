const fs = require("fs");
const path = require("path");

const main = fs.readFileSync(path.resolve(__dirname, "..", "main.js"), "utf8");

function loadFunction(name) {
  const start = main.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const next = main.indexOf("\nfunction ", start + 1);
  return main.slice(start, next < 0 ? main.length : next);
}

eval(loadFunction("normalizedHeadingText"));
eval(loadFunction("matchTodoHeading"));

for (const heading of ["## To-Do", "## To-Do]", "## ✅ To-Do", "### To Do"]) {
  const match = matchTodoHeading(heading);
  if (!match) throw new Error(`Compatible To-Do heading was rejected: ${heading}`);
}
if (matchTodoHeading("## 작업 일지")) throw new Error("Non-To-Do heading was accepted");
if (!main.includes('replace(/\\s*[\\]\\)}]+\\s*$/, "")')) {
  throw new Error("Malformed trailing bracket migration is missing");
}
if (!main.includes("todoMetadataVersion || 0) >= 2")) {
  throw new Error("To-Do heading migration version was not advanced");
}

console.log("To-Do heading compatibility checks passed");
