import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Replay the pre-fix experiment through the existing runner. Never overwrite an existing test.
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../../../../..");
const relative = "test/integration/workspace-authorization-release-reproduction.test.ts";
const target = path.join(root, relative);
writeFileSync(target, readFileSync(path.join(directory, "release-reproduction.test.ts.txt")), {
  flag: "wx",
});
try {
  const result = spawnSync(
    process.execPath,
    [".ci-output/tools/npm/package/bin/npm-cli.js", "run", "test:integration", "--", relative],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  unlinkSync(target);
}
