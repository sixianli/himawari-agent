import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, chown, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gatewayJobHostLauncher } from "../src/job-host-transport.ts";

const execUid = Number(process.argv[2] ?? "4999");
assert.equal(process.getuid?.(), 0, "QUALIFY_REQUIRES_ROOT");
assert.ok(Number.isSafeInteger(execUid) && execUid > 0, "QUALIFY_EXEC_UID_INVALID");
const repository = fileURLToPath(new URL("../../..", import.meta.url));
const hostFixture = path.join(repository, "test/fixtures/job-host-gateway-host.mjs");
const gatewaySource = path.join(repository, "packages/runtime-sandbox/src/job-host-gateway.ts");
const root = await mkdtemp(path.join(tmpdir(), "hjg-"));
let host;
let jobHostPid;
const giveUp = setTimeout(() => {
  for (const group of [jobHostPid, host?.pid])
    if (group)
      try {
        process.kill(-group, "SIGKILL");
      } catch {}
  host?.kill("SIGKILL");
  process.stderr.write("QUALIFY_TIMEOUT\n");
  process.exit(1);
}, 30000);
try {
  await chown(root, execUid, execUid);
  await chmod(root, 0o700);
  const socketPath = path.join(root, "gateway.sock");
  host = spawn(
    "setpriv",
    [
      `--reuid=${execUid}`,
      `--regid=${execUid}`,
      "--clear-groups",
      process.execPath,
      hostFixture,
      gatewaySource,
      socketPath,
      "60000",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise((resolve, reject) => {
    host.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("listening")) resolve();
    });
    host.once("exit", () => reject(new Error("GATEWAY_HOST_EXITED")));
    host.once("error", reject);
  });
  const transport = gatewayJobHostLauncher(socketPath)({
    jobId: "job",
    attemptId: "attempt",
    policy: {
      workspace: "/workspace",
      privateDirectory: "/private-job",
      writable: true,
      readOnlyToolchainPaths: [],
      protectedPaths: [],
      allowedDomains: [],
    },
    policyDigest: "a".repeat(64),
    executable: "/bin/echo",
    args: ["value"],
    deadlineAt: new Date(Date.now() + 10000).toISOString(),
    maxOutputBytes: 16,
    cleanupTimeoutMs: 10,
  });
  const messages = [];
  transport.onMessage((value) => messages.push(value));
  const closed = new Promise((resolve) =>
    transport.onceClose((exitCode, signal) => resolve({ exitCode, signal })),
  );
  const pid = await transport.spawned;
  jobHostPid = pid;
  transport.send({ type: "ping" }, () => {});
  const deadline = Date.now() + 5000;
  while (messages.length === 0 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(messages[0]?.pid, pid, "QUALIFY_JOB_HOST_PID_MISMATCH");
  assert.strictEqual(messages[0]?.uid, execUid, "QUALIFY_JOB_HOST_UID_MISMATCH");
  transport.killGroup();
  assert.deepEqual(await closed, { exitCode: null, signal: "SIGKILL" }, "QUALIFY_KILL_FAILED");
  process.stdout.write(`${JSON.stringify({ status: "passed", execUid, jobHostPid: pid })}\n`);
} finally {
  clearTimeout(giveUp);
  if (host && host.exitCode === null) host.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
}
