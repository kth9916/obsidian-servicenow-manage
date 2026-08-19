import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, "..");
const bundledPath = path.join(pluginRoot, "resources", "업무현황.md");
const targetPath = process.argv[2];
if (!targetPath) throw new Error("Target dashboard path is required");

const bundled = fs.readFileSync(bundledPath, "utf8");
let current = fs.readFileSync(targetPath, "utf8");
const slice = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = start >= 0 ? source.indexOf(endMarker, start + startMarker.length) : -1;
  return start >= 0 && end > start ? source.slice(start, end) : "";
};

if (!current.includes("const TODO_PAGE_SIZE = 10;")) {
  const existingBoard = slice(current, "const TODO_STATUSES = [", "function renderAll()");
  const bundledBoard = slice(bundled, "const TODO_STATUSES = [", "function renderAll()");
  if (!existingBoard || !bundledBoard) throw new Error("To-Do board section was not found");
  current = current.replace(existingBoard, bundledBoard);
}

if (!current.includes(".opus-todo-load-more {") && current.includes(".opus-todo-ticket-group +")) {
  const paginationCss = slice(bundled, ".opus-todo-load-more {", ".opus-todo-ticket-group +");
  if (!paginationCss) throw new Error("To-Do pagination styles were not found");
  current = current.replace(".opus-todo-ticket-group +", `${paginationCss}.opus-todo-ticket-group +`);
}

fs.writeFileSync(targetPath, current, "utf8");
console.log(`Updated To-Do pagination in ${targetPath}`);
