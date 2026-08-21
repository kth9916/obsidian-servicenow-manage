const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const dashboard = fs.readFileSync(path.join(root, "resources", "업무현황.md"), "utf8");

if (!main.includes("async touchTodoLastChecked(file)")) throw new Error("Plugin To-Do last-checked helper is missing");
if ((main.match(/await this\.touchTodoLastChecked\(file\)/g) || []).length < 3) {
  throw new Error("Plugin To-Do add/edit/delete paths do not all update last checked");
}
if (!dashboard.includes("async function touchTodoLastChecked(file)")) throw new Error("Dashboard To-Do last-checked helper is missing");
if ((dashboard.match(/await touchTodoLastChecked\(file\)/g) || []).length < 3) {
  throw new Error("Dashboard To-Do add/edit/delete paths do not all update last checked");
}
if (!dashboard.includes('frontmatter["마지막확인"] = today')) throw new Error("Last checked frontmatter update is missing");
if (!dashboard.includes("background: transparent !important") || !dashboard.includes("background-image: none !important")) {
  throw new Error("To-Do collapse button theme reset is missing");
}

console.log("To-Do last-checked and collapse-button checks passed");
