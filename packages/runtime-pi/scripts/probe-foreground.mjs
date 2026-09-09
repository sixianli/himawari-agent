// Opt-in installed-runner verification with disposable fake data. This does not
// issue a deployment qualification or grant access to a user's project.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.HIMAWARI_LIVE_SANDBOX_PROBE !== "1" || process.platform !== "darwin")
  throw new Error("MAC_SANDBOX_PROBE_OPT_IN_REQUIRED");
const fd = process.env.HIMAWARI_PROBE_FD;
const rg = process.env.HIMAWARI_PROBE_RG;
const bash = process.env.HIMAWARI_PROBE_BASH;
if (!fd || !rg || !bash) throw new Error("PREINSTALLED_TOOLS_REQUIRED");
const installed = await realpath(
  fileURLToPath(new URL("../../../dist/node-runtime", import.meta.url)),
);
const originalFork = childProcess.fork;
childProcess.fork = (...args) => {
  const child = originalFork(...args);
  const began = performance.now();
  child.once("message", () =>
    process.stderr.write(`host-first-message-ms=${Math.round(performance.now() - began)}\n`),
  );
  child.once("exit", (code, signal) => {
    if (code !== 0) process.stderr.write(`host-exit=${code}:${signal}\n`);
  });
  let remaining = 4096;
  child.stderr?.on("data", (chunk) => {
    if (remaining > 0) {
      process.stderr.write(chunk.subarray(0, remaining));
      remaining -= chunk.length;
    }
  });
  return child;
};
syncBuiltinESMExports();
const { prepareJobPolicy, prepareSandboxJobHost } = await import(
  path.join(installed, "node_modules/@himawari-agent/runtime-sandbox/dist/index.js")
);
const runner = path.join(
  installed,
  "node_modules/@himawari-agent/agent-service/dist/capability-programs/pi-coding-main.js",
);
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "himawari-r5-")));
const workspace = path.join(root, "workspace");
const runtimeRoot = path.join(root, "installation");
const privateRoot = path.join(root, "jobs");
const binaries = path.join(runtimeRoot, "pi-tools/bin");
await Promise.all([mkdir(workspace), mkdir(privateRoot), mkdir(binaries, { recursive: true })]);
await Promise.all([
  copyFile(fd, path.join(binaries, "fd")),
  copyFile(rg, path.join(binaries, "rg")),
  copyFile(bash, path.join(binaries, "bash")),
]);
await writeFile(path.join(workspace, "note.txt"), "first\nsecond\nthird\n");
await writeFile(path.join(workspace, "empty.txt"), "");
await writeFile(path.join(workspace, ".env"), "synthetic-secret-marker");
await writeFile(path.join(root, "outside.txt"), "synthetic-outside-marker");
await symlink(path.join(root, "outside.txt"), path.join(workspace, "link.txt"));
const metadata = await stat(workspace);
const operations = ["read", "create", "update", "move", "trash", "restore", "permanent_delete"];
const reports = [];
const toolDigests = Object.fromEntries(
  await Promise.all(
    ["bash", "rg", "fd"].map(async (name) => [
      name,
      createHash("sha256")
        .update(await readFile(path.join(binaries, name)))
        .digest("hex"),
    ]),
  ),
);
let sequence = 0;
async function run(tool, parameters, writable = false) {
  const jobId = `pi-probe-${++sequence}`;
  process.stderr.write(`${jobId} ${tool}\n`);
  const { policy, compiled } = await prepareJobPolicy({
    workspace,
    privateRoot,
    jobId,
    writable,
    protectedPaths: [
      path.join(workspace, ".env"),
      path.join(workspace, ".git"),
      ...(["write", "edit"].includes(tool) ? [] : [path.join(workspace, ".himawari-recovery")]),
    ],
    readOnlyToolchainPaths: await Promise.all(
      [
        installed,
        runtimeRoot,
        "/bin",
        "/usr/bin",
        "/usr/lib",
        "/System",
        "/dev",
        "/opt/homebrew",
      ].map((p) => realpath(p)),
    ),
    allowedDomains: [],
  });
  const expiresAt = new Date(Date.now() + 15000).toISOString();
  const input = {
    schemaVersion: "pi-runner.v1",
    tool,
    workerInstanceId: "worker-1",
    workspace,
    runtimeRoot,
    privateDirectory: policy.privateDirectory,
    maxOutputBytes: 512 * 1024,
    parametersJson: JSON.stringify(parameters),
    scope: {
      schemaVersion: "sandbox-scope.v1",
      ownerId: "owner",
      agentId: "agent",
      threadId: "thread",
      runId: "run",
      toolCallId: `call-${sequence}`,
      parentToolCallId: null,
      parentRequestId: "request",
      hostId: "host-1",
      handleRef: "handle",
      inputRef: "input",
      operation: tool,
      authorizationRef: "authorization",
      modelRef: "model",
      profileRef: "authorized-project.v1",
      directoryGrant: {
        ref: "directory",
        revision: 1,
        canonicalRootId: `${metadata.dev}:${metadata.ino}`,
        authorizationRef: "authorization",
        operations: writable ? operations : ["read"],
      },
      networkAuthorizationRef: null,
      expiresAt,
    },
  };
  const host = prepareSandboxJobHost({
    jobId,
    attemptId: "attempt-1",
    policy,
    policyDigest: compiled.policyDigest,
    executable: await realpath(process.execPath),
    args: [runner, "host-1", "worker-1"],
    stdinBase64: Buffer.from(JSON.stringify(input)).toString("base64"),
    deadlineAt: expiresAt,
    maxOutputBytes: 512 * 1024,
    cleanupTimeoutMs: 1000,
  });
  await host.ready;
  host.start();
  const result = await host.result;
  if (!result.stdout.length)
    process.stderr.write(
      JSON.stringify({
        tool,
        exitCode: result.exitCode,
        stderr: Buffer.from(result.stderr).toString("utf8"),
        supervision: result.supervision,
      }) + "\n",
    );
  assert.equal(result.taskStarted, true, "runner must actually start");
  const output = result.stdout.length
    ? JSON.parse(Buffer.from(result.stdout).toString("utf8"))
    : null;
  reports.push({ tool, exitCode: result.exitCode, cleanup: result.taskTreeCleanup });
  return { result, output };
}
const text = (output) =>
  output.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
try {
  assert.equal(
    text((await run("read", { path: "note.txt", offset: 2, limit: 1 })).output).includes("second"),
    true,
  );
  assert.equal((await run("read", { path: "empty.txt" })).output.isError, false);
  assert.equal((await run("read", { path: "missing.txt" })).result.exitCode, 1);
  assert.equal(
    (await run("write", { path: "created.txt", content: "alpha\n" }, true)).result.exitCode,
    0,
  );
  assert.equal(await readFile(path.join(workspace, "created.txt"), "utf8"), "alpha\n");
  assert.equal(
    (
      await run(
        "edit",
        { path: "created.txt", edits: [{ oldText: "alpha", newText: "beta" }] },
        true,
      )
    ).result.exitCode,
    0,
  );
  assert.equal(await readFile(path.join(workspace, "created.txt"), "utf8"), "beta\n");
  assert.match(text((await run("ls", { path: "." })).output), /note.txt/);
  assert.match(text((await run("find", { pattern: "*.txt" })).output), /note.txt/);
  assert.match(text((await run("grep", { pattern: "second", path: "note.txt" })).output), /second/);
  assert.match(
    text((await run("bash", { command: "printf synthetic-output" })).output),
    /synthetic-output/,
  );
  const failed = await run("bash", { command: "printf expected-failure; exit 7" });
  assert.equal(failed.result.exitCode, 7);
  assert.equal(failed.output.commandExitCode, 7);
  assert.match(text(failed.output), /expected-failure/);
  const long = await run("bash", {
    command: "for ((i=0;i<3000;i++)); do printf 'synthetic-line-%s\\n' \"$i\"; done",
  });
  assert.equal(long.output.details.truncation.truncated, true);
  assert.ok(long.output.fullOutput.byteLength > 30000);
  assert.equal(JSON.stringify(long.output).includes("pi-bash-"), false);
  for (const target of ["../outside.txt", ".env", "link.txt"]) {
    const read = await run("read", { path: target });
    assert.notEqual(read.result.exitCode, 0);
  }
  const denied = await run("grep", { pattern: "synthetic-secret-marker", path: "." });
  assert.equal(text(denied.output).includes("synthetic-secret-marker"), false);
  const timeout = await run("bash", { command: "while :; do :; done", timeout: 0.1 });
  assert.notEqual(timeout.result.exitCode, 0);
  for (const command of ["/bin/cat ../outside.txt", "/bin/cat .env", "printf changed > note.txt"]) {
    const denied = await run("bash", { command });
    assert.notEqual(denied.result.exitCode, 0);
    assert.equal(JSON.stringify(denied.output).includes("synthetic-secret-marker"), false);
    assert.equal(JSON.stringify(denied.output).includes("synthetic-outside-marker"), false);
  }
  assert.equal(await readFile(path.join(workspace, "note.txt"), "utf8"), "first\nsecond\nthird\n");
  await rename(path.join(binaries, "fd"), path.join(binaries, "fd.unavailable"));
  assert.equal((await run("find", { pattern: "*.txt" })).result.exitCode, 1);
  await rename(path.join(binaries, "rg"), path.join(binaries, "rg.unavailable"));
  assert.equal((await run("grep", { pattern: "second", path: "note.txt" })).result.exitCode, 1);
  process.stdout.write(
    `${JSON.stringify({ passed: reports.length, platform: process.platform, qualification: false, toolDigests, nodeVersion: process.version, reports })}\n`,
  );
} finally {
  // Only this probe's own disposable fake data and copied binaries.
  await rm(root, { recursive: true, force: true });
}
