import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "main.js", "manifest.json", "versions.json", "package.json", "styles.css",
  "README.md", "PRIVACY.md", "SECURITY.md", "COMMUNITY_RELEASE_CHECKLIST.md",
  "ORGANIZATION_PACK.md", "LICENSE"
];

async function markdownResources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await markdownResources(full));
    else if (entry.name.endsWith(".md")) result.push(path.relative(root, full));
  }
  return result;
}

async function filesWithExtension(directory, extension) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesWithExtension(full, extension));
    else if (entry.name.endsWith(extension)) result.push(path.relative(root, full));
  }
  return result;
}

files.push(...await markdownResources(path.join(root, "resources")));
files.push(...await filesWithExtension(path.join(root, "examples"), ".json"));
files.push(...await filesWithExtension(path.join(root, "tests"), ".js"));
files.push(...await filesWithExtension(path.join(root, "scripts"), ".mjs"));

const checks = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
  ["Google OAuth client ID", /\b\d{6,}-[a-z0-9]{16,}\.apps\.googleusercontent\.com\b/i],
  ["JWT-like credential", /\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\b/],
  ["ServiceNow session cookie", /\b(?:JSESSIONID|glide_user|glide_user_session|UX-Token)\s*=/i],
  ["personal Windows user path", /\bC:\\Users\\(?!example\b)[^\\\r\n]+\\/i],
  ["email address", /\b[A-Z0-9._%+-]+@(?!example\.(?:com|org)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ["customer-specific default instance", /https:\/\/one\.service-now\.com/i],
  ["organization workflow content", /(?:OPUS\s+CLT\s+ITO|eBooking\s+담당\s+CLT\s+ITO|ONE이\s+CR을\s+생성)/i]
];

const findings = [];
for (const relative of files) {
  const content = (await readFile(path.join(root, relative), "utf8"))
    .replaceAll("thkim9916@cyberlogitec.com", "PUBLIC_MAINTAINER_CONTACT");
  for (const [name, pattern] of checks) {
    if (pattern.test(content)) findings.push(`${relative}: ${name}`);
  }
  for (const match of content.matchAll(/\b(?:CR|SR|INC)(\d{7,})\b/g)) {
    if (!/^0+$/.test(match[1])) findings.push(`${relative}: real-looking ticket identifier`);
  }
}

if (findings.length) {
  console.error("Community security audit failed. Potential public-release data found:");
  for (const finding of [...new Set(findings)]) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Community security audit passed for ${files.length} public files.`);
}
