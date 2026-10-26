import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateScratchRoot } from "./scratch-root.mjs";

const scratch = await validateScratchRoot(process.env.HIMAWARI_TEST_TEMP_ROOT);
const runtime = await realpath(process.argv[2]);
assert.equal(runtime, process.env.HIMAWARI_PROBE_RUNTIME);
assert.equal(await realpath(runtime), runtime);
assert.notEqual(runtime, scratch);
const { digestSandboxRuntime } = await import(
  pathToFileURL(path.join(runtime, "node_modules/@himawari-agent/platform-node/dist/index.js"))
);
const runtimeDigest = await digestSandboxRuntime(runtime);
assert.match(runtimeDigest, /^[0-9a-f]{64}$/);
process.stdout.write(JSON.stringify({ runtimeDigest, productionQualificationIssued: false }) + "\n");
