import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { chmod, lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateR2l6Installed } from "./validate-r2l6-installed.mjs";

const runtime = "/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__/lib/himawari-agent";
const qualification = "/var/lib/himawari/qualification/__PKT_LABEL__-__PKT_DATE_COMPACT__";
const destination = "/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__/runtime-protection.json";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(hostname(), "__PKT_HOSTNAME__");
assert.equal(process.platform, "linux");
assert.equal(process.getuid(), 0);
assert.equal(process.argv.length, 2);
process.umask(0o077);

async function trustedBytes(name) {
  const file = path.join(qualification, name);
  const info = await lstat(file);
  assert(info.isFile() && !info.isSymbolicLink() && info.uid === 0 && !(info.mode & 0o022));
  assert.equal(await realpath(file), file);
  return readFile(file);
}

async function protectedTree(entry) {
  const info = await lstat(entry);
  assert((info.isFile() || info.isDirectory()) && !info.isSymbolicLink());
  assert.equal(info.uid, 0);
  assert.equal(info.mode & 0o022, 0);
  assert.equal(await realpath(entry), entry);
  if (info.isFile()) assert.equal(info.nlink, 1);
  if (info.isDirectory())
    for (const name of await readdir(entry)) await protectedTree(path.join(entry, name));
}

const receiptBytes = await trustedBytes("installation-receipt.json");
const publicKey = createPublicKey(await trustedBytes("host-qualification-public-key.pem"));
assert(verify(null, receiptBytes, publicKey, await trustedBytes("installation-receipt.sig")));
const receipt = JSON.parse(receiptBytes);
assert.equal(receipt.host, hostname());
assert.equal(receipt.runtime, runtime);
assert(Number.isSafeInteger(receipt.bindingInputs.acceptanceUid) && receipt.bindingInputs.acceptanceUid > 0);
for (const [name, digest] of Object.entries(receipt.artifacts))
  assert.equal(hash(await trustedBytes(`${name}.json`)), digest);
await protectedTree(runtime);
for (let directory = path.dirname(destination); ; directory = path.dirname(directory)) {
  const info = await lstat(directory);
  assert(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0 && !(info.mode & 0o022));
  assert.equal(await realpath(directory), directory);
  if (directory === "/") break;
}
const platform = await import(
  pathToFileURL(path.join(runtime, "node_modules/@himawari-agent/platform-node/dist/index.js")).href
);
assert.equal(await platform.digestSandboxRuntime(runtime), receipt.runtimeDigest);
const r2l6 = await validateR2l6Installed({ runtime, reportPath: qualification + "/r2l6-installed.json" });
assert.equal(r2l6.runtimeDigest, receipt.runtimeDigest);
const bytes = Buffer.from(`${JSON.stringify({
  schemaVersion: "protected-runtime.v1",
  runtimeRoot: runtime,
  runtimeDigest: receipt.runtimeDigest,
  runtimeUid: receipt.bindingInputs.acceptanceUid,
  deploymentUid: 0,
})}\n`);
await writeFile(destination, bytes, { mode: 0o644, flag: "wx" });
await chmod(destination, 0o644);
process.stdout.write(`${JSON.stringify({ passed: true, path: destination, sha256: hash(bytes), runtimeDigest: receipt.runtimeDigest })}\n`);
