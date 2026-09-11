const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");

const protectStart = main.indexOf("function protectUrls(");
const restoreEnd = main.indexOf("\nfunction localIsoDateTime", protectStart);
if (protectStart < 0 || restoreEnd < 0) throw new Error("URL translation helpers were not found");

const helpers = Function(`${main.slice(protectStart, restoreEnd)}; return { protectUrls, restoreUrls };`)();
const sourceUrl = "https://docs.google.com/spreadsheets/d/example/edit?gid=1510928642#gid=1510928642";
const { masked, urls } = helpers.protectUrls(`Please review:\n${sourceUrl}`);

if (masked.includes(sourceUrl) || urls[0] !== sourceUrl) {
  throw new Error("Source URL was not protected before translation");
}
if (!helpers.restoreUrls("번역문\n__SNM_URL_0__", urls).includes(sourceUrl)) {
  throw new Error("Unchanged URL placeholder was not restored");
}
const repaired = helpers.restoreUrls("번역 공급자가 링크 토큰을 제거한 번역문", urls);
if (!repaired.endsWith(sourceUrl)) {
  throw new Error("Missing source URL was not appended to the translation");
}
if ((helpers.restoreUrls(repaired, urls).match(/https:\/\//g) || []).length !== 1) {
  throw new Error("Existing source URL was duplicated during cache repair");
}

if (!main.includes("const repaired = restoreUrls(existing, protectUrls(entry.content).urls)")) {
  throw new Error("Existing work-note translation caches are not repaired");
}

console.log("Translation URL preservation checks passed");
