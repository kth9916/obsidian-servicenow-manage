import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${args.join(" ")} exited with ${code}`)));
  });
}

await run(["--check", "main.js"]);
const tests = (await readdir(path.join(root, "tests")))
  .filter(name => name.endsWith(".js") && name !== "dashboard-check.js")
  .sort();
for (const test of tests) await run([path.join("tests", test)]);
console.log(`Completed ${tests.length} plugin checks.`);
