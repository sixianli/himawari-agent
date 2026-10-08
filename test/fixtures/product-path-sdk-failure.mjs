import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const gate = process.env.HIMAWARI_TEST_PREPARATION_FINAL_GATE;
if (gate) {
  const rename = fs.rename;
  let held = false;
  fs.rename = async (source, target) => {
    const result = await rename(source, target);
    if (!held && String(target).endsWith("/final.json")) {
      held = true;
      const directory = path.dirname(String(target));
      const heldPath = path.join(directory, "final-held.json");
      await rename(target, heldPath);
      const bytes = await fs.readFile(heldPath);
      const observation = JSON.parse(JSON.parse(bytes.toString("utf8")).body);
      const signal = `${gate}.entered`;
      await fs.writeFile(
        `${signal}.pending`,
        JSON.stringify({
          pid: process.pid,
          at: new Date().toISOString(),
          jobId: observation.jobId,
          attemptId: observation.attemptId,
          directory,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byteLength: bytes.byteLength,
        }),
        { mode: 0o600 },
      );
      await rename(`${signal}.pending`, signal);
    }
    return result;
  };
  syncBuiltinESMExports();
}

const require = createRequire(process.argv[1]);
const { SandboxManager } = await import(
  pathToFileURL(require.resolve("@anthropic-ai/sandbox-runtime")).href
);
SandboxManager.initialize = async () => {
  throw Object.assign(new Error("private fixture preparation input"), { code: "EIO" });
};
