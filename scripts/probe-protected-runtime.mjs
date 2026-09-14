// Real Linux permission and latency probe. Use only an administrator-created
// disposable sentinel, never attempt writes to a program or a real user file.
import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const [manifestPath, sentinel, scratch] = process.argv.slice(2);
assert.equal(process.argv.length, 5);
assert.equal(process.platform, "linux");
assert(scratch.startsWith("/data/"));
const protection = JSON.parse(await readFile(manifestPath, "utf8"));
const { runtimeRoot, runtimeDigest, runtimeUid } = protection;
assert.equal(process.getuid(), runtimeUid);
const prefix = path.dirname(path.dirname(runtimeRoot));
assert.equal(sentinel, path.join(prefix, "protection-probe"));
assert.equal((await lstat(sentinel)).uid, 0);
assert.equal((await lstat(scratch)).uid, runtimeUid);
const marker = path.join(sentinel, "sentinel.txt");
assert.equal(await readFile(marker, "utf8"), "himawari-protection-probe\n");
const denied = [];
async function mustDeny(name, action) {
  let blocked = false;
  try {
    await action();
  } catch (error) {
    if (!["EACCES", "EPERM", "EROFS"].includes(error.code)) throw error;
    blocked = true;
  }
  assert(blocked, `PROTECTION_FAILED:${name}`);
  denied.push(name);
}
await mustDeny("overwrite sentinel", () => writeFile(marker, "unexpected-write\n"));
await mustDeny("restore file write permission", () => chmod(marker, 0o666));
await mustDeny("restore directory write permission", () => chmod(sentinel, 0o777));
await mustDeny("delete sentinel", () => rm(marker));
await mustDeny("replace installation child", () => rename(sentinel, `${sentinel}-replaced`));
await mustDeny("create installation child", () =>
  writeFile(path.join(prefix, "unexpected-probe-file"), "probe", { flag: "wx" }),
);
await mustDeny("open deployment record for writing", async () => {
  const handle = await open(manifestPath, constants.O_WRONLY);
  await handle.close();
});
await mustDeny("change deployment record permissions", () => chmod(manifestPath, 0o666));
// access() observes real filesystem permission without trying to move the
// active installation. The disposable sibling above tests the same parent.
await mustDeny("write runtime root", () => access(runtimeRoot, constants.W_OK));
await mustDeny("replace release directory", () => access(path.dirname(prefix), constants.W_OK));
try {
  await lstat("/var/run/docker.sock");
  await mustDeny("access Docker control socket", () =>
    access("/var/run/docker.sock", constants.W_OK),
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  denied.push("Docker control socket absent");
}
const temp = await mkdtemp(path.join(scratch, "protected-runtime-"));
try {
  const file = path.join(temp, "note.txt");
  await writeFile(file, "真实权限验收\n", { mode: 0o600 });
  assert.equal(await readFile(file, "utf8"), "真实权限验收\n");
} finally {
  await rm(temp, { recursive: true });
}
const moduleRoot = path.join(
  runtimeRoot,
  "node_modules/@himawari-agent/platform-node/dist/capabilities",
);
const { ProtectedRuntimeVerifier } = await import(
  pathToFileURL(path.join(moduleRoot, "protected-runtime.js"))
);
const { digestSandboxRuntime } = await import(
  pathToFileURL(path.join(moduleRoot, "sandbox-host-verifier.js"))
);
const verifier = new ProtectedRuntimeVerifier(manifestPath);
let fullAudits = 0;
const digest = async (root) => {
  fullAudits++;
  return digestSandboxRuntime(root);
};
const started = performance.now();
await verifier.verify(runtimeRoot, runtimeDigest, digest);
const initialAuditMs = performance.now() - started;
const subsequentVerifyMs = [];
for (let count = 0; count < 10; count++) {
  const start = performance.now();
  await verifier.verify(runtimeRoot, runtimeDigest, digest);
  subsequentVerifyMs.push(performance.now() - start);
}
assert.equal(fullAudits, 1);
console.log(
  JSON.stringify({
    schemaVersion: "protected-runtime-probe.v1",
    passed: true,
    runtimeRoot,
    runtimeDigest,
    runtimeUid,
    denied,
    workspaceWriteRead: true,
    fullAudits,
    initialAuditMs,
    subsequentVerifyMs,
    scope:
      "real Linux permissions and installation verification; not a model or complete tool latency measurement",
  }),
);
