import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "resources/jira-workspace.js"), "utf8").replace(/\r\n/g, "\n").trimEnd();
const file = path.join(root, "main.js"), main = fs.readFileSync(file, "utf8");
const pattern = /\/\/ BEGIN GENERATED JIRA WORKSPACE[\s\S]*?\/\/ END GENERATED JIRA WORKSPACE/;
if (!pattern.test(main)) throw Error("Jira workspace marker missing");
const next = main.replace(pattern, () => `// BEGIN GENERATED JIRA WORKSPACE\n${source}\n// END GENERATED JIRA WORKSPACE`);
if (process.argv.includes("--check")) { if (next.replace(/\r\n/g,"\n") !== main.replace(/\r\n/g,"\n")) throw Error("Jira workspace embed is stale"); }
else fs.writeFileSync(file, next);
console.log("Jira workspace embed " + (process.argv.includes("--check") ? "verified" : "updated"));
