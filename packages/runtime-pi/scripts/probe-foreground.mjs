// Opt-in installed-runner verification with disposable fake data. This does not
// issue a deployment qualification or grant access to a user's project.
import assert from "node:assert/strict";
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
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

if (
  process.env.HIMAWARI_LIVE_SANDBOX_PROBE !== "1" ||
  !["darwin", "linux"].includes(process.platform)
)
  throw new Error("SANDBOX_PROBE_OPT_IN_REQUIRED");
const useInstallation = process.env.HIMAWARI_PROBE_RUNTIME !== undefined;
const fd = process.env.HIMAWARI_PROBE_FD;
const rg = process.env.HIMAWARI_PROBE_RG;
const bash = process.env.HIMAWARI_PROBE_BASH;
if (!useInstallation && (!fd || !rg || !bash)) throw new Error("PREINSTALLED_TOOLS_REQUIRED");
const installed = await realpath(
  process.env.HIMAWARI_PROBE_RUNTIME ??
    fileURLToPath(new URL("../../../dist/node-runtime", import.meta.url)),
);
const { prepareJobPolicy, prepareSandboxJobHost } = await import(
  path.join(installed, "node_modules/@himawari-agent/runtime-sandbox/dist/index.js")
);
const runner = path.join(
  installed,
  "node_modules/@himawari-agent/agent-service/dist/capability-programs/pi-coding-main.js",
);
const scratch = process.env.HIMAWARI_PROBE_SCRATCH ?? os.tmpdir();
if (process.platform === "linux" && !scratch.startsWith("/data/"))
  throw new Error("LINUX_PROBE_REQUIRES_DATA_DISK");
const root = await realpath(await mkdtemp(path.join(scratch, "himawari-pi-")));
const workspace = path.join(root, "workspace");
const runtimeRoot = useInstallation ? installed : path.join(root, "installation");
const privateRoot = path.join(root, "jobs");
const binaries = path.join(runtimeRoot, "pi-tools/bin");
await Promise.all([mkdir(workspace, { mode: 0o700 }), mkdir(privateRoot, { mode: 0o700 })]);
if (!useInstallation) {
  await mkdir(binaries, { recursive: true, mode: 0o700 });
  await Promise.all([
    copyFile(fd, path.join(binaries, "fd")),
    copyFile(rg, path.join(binaries, "rg")),
    copyFile(bash, path.join(binaries, "bash")),
  ]);
}
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
async function run(tool, parameters, writable = false, executionMode = "foreground") {
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
        "/dev",
        ...(process.platform === "darwin"
          ? ["/System", "/opt/homebrew"]
          : ["/lib", "/lib64", "/proc", "/etc/ssl", "/etc/hosts"]),
      ].map((p) => realpath(p)),
    ),
    allowedDomains: [],
  });
  const expiresAt = new Date(Date.now() + 30000).toISOString();
  const input = {
    schemaVersion: "pi-runner.v1",
    executionMode,
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
  const controlDirectory = path.join(root, `${jobId}-control`);
  await mkdir(controlDirectory, { mode: 0o700 });
  const host = prepareSandboxJobHost(
    {
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
    },
    controlDirectory,
  );
  await host.ready;
  host.start();
  let liveObserved = false;
  if (executionMode !== "foreground") {
    let completed = false;
    void host.result.then(() => {
      completed = true;
    });
    while (!completed && Date.now() < Date.parse(expiresAt)) {
      if (host.readOutput(0, 4096).bytes.length) {
        liveObserved = !completed;
        break;
      }
      await delay(50);
    }
  }
  const result = await host.result;
  let namespaceState = null;
  if (process.platform === "linux") {
    const { readJobHostFinalEvidence, readLinuxNamespaceState } = await import(
      path.join(
        installed,
        "node_modules/@himawari-agent/runtime-sandbox/dist/job-host-control-client.js",
      )
    );
    const final = await readJobHostFinalEvidence(host.controlBinding);
    assert.ok(final.linuxNamespace, "Linux runner requires an authenticated namespace identity");
    namespaceState = await readLinuxNamespaceState(final.linuxNamespace);
    assert.equal(namespaceState, "released");
  }
  if (!result.stdout.length)
    process.stderr.write(
      `${JSON.stringify({
        tool,
        exitCode: result.exitCode,
        stderr: Buffer.from(result.stderr).toString("utf8"),
        supervision: result.supervision,
      })}\n`,
    );
  assert.equal(result.taskStarted, true, "runner must actually start");
  const output = result.stdout.length
    ? executionMode === "foreground"
      ? JSON.parse(Buffer.from(result.stdout).toString("utf8"))
      : Buffer.from(result.stdout).toString("utf8")
    : null;
  reports.push({
    tool,
    executionMode,
    liveObserved,
    exitCode: result.exitCode,
    cleanup: result.taskTreeCleanup,
    namespaceState,
    policyDigest: compiled.policyDigest,
  });
  return { result, output, liveObserved };
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
  const background = await run(
    "bash",
    { command: "printf 'before\\n'; /bin/sleep 1; printf 'after\\n'; exit 7" },
    false,
    "background",
  );
  assert.equal(background.liveObserved, true);
  assert.equal(background.result.exitCode, 7);
  assert.equal(background.output, "before\nafter\n");
  const secret = await run(
    "bash",
    { command: "printf '%s' 'sk-'; /bin/sleep 0.1; printf '%s\\n' 'abcdefghijklmnopqrstuv'" },
    false,
    "background",
  );
  assert.notEqual(secret.result.exitCode, 0);
  assert.equal(secret.result.stdout.length, 0);
  const writeTask = await run(
    "bash",
    { command: "printf changed > note.txt; /bin/sleep 0.2; printf 'saved\\n'" },
    true,
    "background",
  );
  assert.equal(writeTask.result.exitCode, 0);
  assert.equal(await readFile(path.join(workspace, "note.txt"), "utf8"), "changed");
  if (!useInstallation) {
    await rename(path.join(binaries, "fd"), path.join(binaries, "fd.unavailable"));
    assert.equal((await run("find", { pattern: "*.txt" })).result.exitCode, 1);
    await rename(path.join(binaries, "rg"), path.join(binaries, "rg.unavailable"));
    assert.equal((await run("grep", { pattern: "second", path: "note.txt" })).result.exitCode, 1);
  }
  process.stdout.write(
    `${JSON.stringify({ passed: reports.length, platform: process.platform, qualification: false, toolDigests, nodeVersion: process.version, reports })}\n`,
  );
} finally {
  // Only this probe's own disposable fake data and copied binaries.
  await rm(root, { recursive: true, force: true });
}
