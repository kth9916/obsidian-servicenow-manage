const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.resolve(__dirname, "../main.js"), "utf8");

assert.match(source, /"시작", "화면 설정", "필수 플러그인"/, "setup wizard should include display settings");
assert.match(source, /setName\("새 탭을 읽기 화면으로 열기"\)/, "setup wizard should explicitly offer reading view");
assert.match(source, /setName\("새 탭 기본 화면"\)/, "general settings should expose the default view");
assert.match(source, /getConfig\?\.\("defaultViewMode"\) === "preview"/, "current Obsidian view preference should be read");
assert.match(source, /setConfig\("defaultViewMode", enabled \? "preview" : "source"\)/, "Obsidian view preference should be updated");
assert.match(source, /이미 열려 있는 탭의 화면은 바뀌지 않습니다/, "setup should explain the scope of the setting");

console.log("Default view mode checks passed.");
