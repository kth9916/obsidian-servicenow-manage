const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const start = source.indexOf("  async searchGoogleDriveDocuments(ticketId)");
const end = source.indexOf("\n  async searchGoogleDriveMeetingDocuments", start);
const createPlugin = () => vm.runInNewContext(`({${source.slice(start, end).trim()}})`, {
  normalizeTicketId: value => /^CR\d+$/.test(String(value).trim().toUpperCase()) ? String(value).trim().toUpperCase() : "",
  localIsoDateTime: value => value.toISOString(), console: { warn() {} }
});
(async () => {
  const plugin = createPlugin();
  const titles = ["CR0000000_FS", "CR0000000 _FS_20261008_TEAM", "CR0000000_ FS.xlsx",
    "CR0000000  _  DS_v2", "CR0000000\u00a0_UT.pdf", "cr0000000 _fs_20261008",
    "CR00000000_FS", "CR0000000_FSOther", "CR0000000_meeting", "CR9_FS"];
  const files = titles.map((name, index) => ({ id: `file-${index}`, name, modifiedTime: "2026-10-08T00:00:00Z" }));
  const calls = [];
  plugin.googleDriveApiGet = async (_path, query) => {
    calls.push(query);
    assert.equal(query.q, "name contains 'CR0000000' and trashed = false");
    assert(query.fields.includes("nextPageToken"));
    if (query.corpora === "allDrives") return { files: [files[1]] };
    return query.pageToken ? { files: files.slice(3) } : { files: files.slice(0, 3), nextPageToken: "second-page" };
  };
  const groups = await plugin.searchGoogleDriveDocuments("cr0000000");
  assert.equal(groups.FS.length, 4);
  assert.equal(groups.DS.length, 1);
  assert.equal(groups.UT.length, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].pageToken, "second-page");
  assert(groups.FS.some(file => file.name === titles[1]));
  assert(!Object.values(groups).flat().some(file => /file-(?:6|7|8|9)$/.test(file.url)));
  const before = calls.length;
  await assert.rejects(plugin.searchGoogleDriveDocuments(""), /티켓 번호/);
  assert.equal(calls.length, before);
  const repeated = createPlugin();
  repeated.googleDriveApiGet = async () => ({ files: [], nextPageToken: "repeat" });
  await assert.rejects(repeated.searchGoogleDriveDocuments("CR0000000"), /페이지가 반복/);
  console.log("Drive document spacing checks passed: original title, whitespace around separator, legacy names, case, other-ticket rejection, pagination, deduplication and invalid input.");
})().catch(error => { console.error(error); process.exitCode = 1; });
