const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

assert.match(source, /function isClientAuthCertificateError\(error\)/,
  "ServiceNow transport should recognize the Obsidian client-certificate failure.");
assert.match(source, /async serviceNowRequest\(options\)[\s\S]*?return await requestUrl\(options\);[\s\S]*?return nodeHttpsRequest\(options\);/,
  "ServiceNow transport should use requestUrl first and retry through Node HTTPS only for the certificate error.");
assert.match(source, /async apiGet\(path, query = \{\}\)[\s\S]*?this\.serviceNowRequest\(/,
  "ServiceNow API reads should use the resilient transport.");
assert.match(source, /async attachmentImageDataUrl\(entry\)[\s\S]*?this\.serviceNowRequest\(/,
  "ServiceNow attachment previews should use the resilient transport.");

console.log("ServiceNow transport fallback checks passed");
