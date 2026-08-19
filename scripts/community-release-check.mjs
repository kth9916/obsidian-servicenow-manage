import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

for (const required of ["README.md", "LICENSE", "PRIVACY.md", "SECURITY.md", "ORGANIZATION_PACK.md", "manifest.json", "versions.json", "main.js"]) {
  try { await access(path.join(root, required), constants.R_OK); }
  catch (_) { failures.push(`Missing required repository file: ${required}`); }
}

const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const versions = JSON.parse(await readFile(path.join(root, "versions.json"), "utf8"));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const license = await readFile(path.join(root, "LICENSE"), "utf8");
if (manifest.version !== packageJson.version) failures.push("manifest.json and package.json versions differ");
if (versions[manifest.version] !== manifest.minAppVersion) failures.push("versions.json does not map the current version to minAppVersion");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) failures.push("Manifest version is not x.y.z");
if (!/^[a-z0-9-]+$/.test(manifest.id) || manifest.id.includes("obsidian")) failures.push("Plugin ID is invalid for the community directory");
if (String(manifest.description || "").length > 250 || !String(manifest.description || "").endsWith(".")) {
  failures.push("Manifest description must be at most 250 characters and end with a period");
}
if (manifest.isDesktopOnly !== true) failures.push("Desktop-only declaration is required by Node.js/Electron usage");
const author = String(manifest.author || "").trim();
if (!author || /contributors|todo|replace me/i.test(author)) {
  failures.push("Replace the placeholder manifest author with the exact public author name or GitHub handle");
}
if (author && !license.includes(author)) {
  failures.push("LICENSE copyright holder must match the public manifest author");
}

if (failures.length) {
  console.error("Community release gate failed:");
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log(`Community release metadata passed for ${manifest.id} ${manifest.version}.`);
}
