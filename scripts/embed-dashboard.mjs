import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, "..");
const dashboardPath = path.join(pluginRoot, "resources", "업무현황.md");
const mainPath = path.join(pluginRoot, "main.js");
const dashboardCheckPath = path.join(pluginRoot, "tests", "dashboard-check.js");
const dashboard = fs.readFileSync(dashboardPath, "utf8");
const encoded = zlib.gzipSync(Buffer.from(dashboard, "utf8"), { level: 9 }).toString("base64");
const main = fs.readFileSync(mainPath, "utf8");
const marker = /\/\/ BEGIN GENERATED DASHBOARD ASSET[\s\S]*?\/\/ END GENERATED DASHBOARD ASSET/;

if (!marker.test(main)) throw new Error("Generated dashboard marker was not found in main.js");

const next = main.replace(
  marker,
  `// BEGIN GENERATED DASHBOARD ASSET\nconst EMBEDDED_DASHBOARD_GZIP_BASE64 = ${JSON.stringify(encoded)};\n// END GENERATED DASHBOARD ASSET`
);
fs.writeFileSync(mainPath, next, "utf8");
const dataviewSource = dashboard.match(/```dataviewjs\r?\n([\s\S]*?)\r?\n```/)?.[1];
if (!dataviewSource) throw new Error("DataviewJS block was not found in the dashboard resource");
fs.writeFileSync(dashboardCheckPath, `(async () => {\n${dataviewSource}\n})();\n`, "utf8");
console.log(`Embedded ${dashboard.length} dashboard characters into main.js (${encoded.length} base64 characters).`);
