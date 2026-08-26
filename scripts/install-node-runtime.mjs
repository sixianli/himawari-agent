import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prefixIndex = process.argv.indexOf("--prefix");
const prefixValue = prefixIndex < 0 ? undefined : process.argv[prefixIndex + 1];
if (!prefixValue || !path.isAbsolute(prefixValue)) {
  throw new Error("--prefix requires an absolute installation target");
}
const source = path.join(repositoryRoot, "dist/node-runtime");
await readFile(path.join(source, "runtime-manifest.json"));
const libDirectory = path.join(prefixValue, "lib/himawari-agent");
const binDirectory = path.join(prefixValue, "bin");
await rm(libDirectory, { recursive: true, force: true });
await mkdir(path.dirname(libDirectory), { recursive: true });
await cp(source, libDirectory, { recursive: true });
await mkdir(binDirectory, { recursive: true });
const entries = {
  himawari: "@himawari-agent/admin-cli",
  "himawari-agent-service": "@himawari-agent/agent-service",
  "himawari-execution-worker": "@himawari-agent/execution-worker",
};
for (const [command, packageName] of Object.entries(entries)) {
  const target = path.join(binDirectory, command);
  const modulePath = path.join(
    libDirectory,
    "node_modules",
    ...packageName.split("/"),
    "dist/main.js",
  );
  await writeFile(target, `#!/bin/sh\nexec node ${JSON.stringify(modulePath)} "$@"\n`, {
    mode: 0o755,
  });
  await chmod(target, 0o755);
}
console.log(`Himawari Node runtime installed under ${prefixValue}`);
