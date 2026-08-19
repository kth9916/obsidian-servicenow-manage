import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const target = process.argv[2];
if (!target) throw new Error("Target dashboard path is required");

const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const start = main.indexOf("function upgradeDashboardFieldOrdering(");
const end = main.indexOf("\nfunction ", start + 1);
if (start < 0 || end < 0) throw new Error("Field ordering migration was not found");
const upgrade = Function(`${main.slice(start, end)}; return upgradeDashboardFieldOrdering;`)();
const bundled = fs.readFileSync(path.join(root, "resources", "업무현황.md"), "utf8");
const current = fs.readFileSync(target, "utf8");
const next = upgrade(current, bundled);
if (next !== current) fs.writeFileSync(target, next, "utf8");
console.log(next === current ? "Dashboard already current" : "Dashboard upgraded");
