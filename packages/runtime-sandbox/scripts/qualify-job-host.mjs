// Fixed synthetic commands only. This probes Job Host, not production authority.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const runtime = process.argv.includes("--installed")
  ? await import(
      "../../../dist/node-runtime/node_modules/@himawari-agent/runtime-sandbox/dist/index.js"
    )
  : { ...(await import("../src/policy.ts")), ...(await import("../src/job-host.ts")) };
const { compileSandboxPolicy, prepareSandboxJobHost } = runtime;

const root = await realpath(await mkdtemp(path.join(tmpdir(), "himawari-job-host-")));
const observations = [];
try {
  for (const name of ["workspace", "private"]) await mkdir(path.join(root, name));
  const policy = {
    workspace: path.join(root, "workspace"),
    privateDirectory: path.join(root, "private"),
    writable: true,
    protectedPaths: [path.join(root, "workspace", ".env")],
    readOnlyToolchainPaths: await Promise.all(
      ["/bin", "/usr/bin", "/usr/lib", "/System", "/dev"].map((p) => realpath(p)),
    ),
    allowedDomains: [],
  };
  await writeFile(path.join(policy.workspace, ".env"), "synthetic-secret");
  const compiled = await compileSandboxPolicy(policy);
  let sequence = 0;
  async function run(
    command,
    {
      cancel = false,
      maxOutputBytes = 8192,
      deadlineMs = 10000,
      digest = compiled.policyDigest,
      stdinBase64,
      resourceLimits,
    } = {},
  ) {
    const host = prepareSandboxJobHost({
      jobId: `probe-${++sequence}`,
      attemptId: "attempt-1",
      policy,
      policyDigest: digest,
      executable: "/bin/bash",
      args: ["-c", command],
      ...(stdinBase64 === undefined ? {} : { stdinBase64 }),
      ...(resourceLimits === undefined ? {} : { resourceLimits }),
      deadlineAt: new Date(Date.now() + deadlineMs).toISOString(),
      maxOutputBytes,
      cleanupTimeoutMs: 2000,
    });
    try {
      await host.ready;
    } catch {
      return await host.result;
    }
    host.start();
    if (cancel) {
      await delay(100);
      host.cancel();
    }
    const result = await host.result;
    observations.push({
      reason: result.reason,
      resources: result.resources,
      taskProcessExited: result.taskProcessExited,
      stdioClosed: result.stdioClosed,
      srtReset: result.srtReset,
      taskTreeCleanup: result.taskTreeCleanup,
    });
    return result;
  }
  const inputBytes = Buffer.from([0, 255, 10, 39, 36, 65]);
  const inputResult = await run("/bin/cat", { stdinBase64: inputBytes.toString("base64") });
  assert.equal(
    inputResult.exitCode,
    0,
    `stdin probe failed: ${Buffer.from(inputResult.stderr).toString("utf8")}`,
  );
  assert.deepEqual(Buffer.from(inputResult.stdout), inputBytes);
  assert.equal(inputResult.stderr.byteLength, 0);
  assert.equal(inputResult.taskTreeCleanup, "unknown");
  // Readiness never executes the command, and argv contents keep their literal meaning.
  const marker = path.join(policy.workspace, "marker");
  const host = prepareSandboxJobHost({
    jobId: "prepare-probe",
    attemptId: "attempt-1",
    policy,
    policyDigest: compiled.policyDigest,
    executable: "/usr/bin/touch",
    args: [marker],
    deadlineAt: new Date(Date.now() + 10000).toISOString(),
    maxOutputBytes: 8192,
    cleanupTimeoutMs: 2000,
  });
  await host.ready;
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  host.start();
  const prepared = await host.result;
  assert.equal(prepared.exitCode, 0);
  assert.equal(prepared.srtReset, true);
  assert.throws(() => host.start(), /START_NOT_ALLOWED/);
  await readFile(marker);
  const literal = "literal'$(printf injected);*";
  const argvHost = prepareSandboxJobHost({
    jobId: "argv-probe",
    attemptId: "attempt-1",
    policy,
    policyDigest: compiled.policyDigest,
    executable: "/usr/bin/printf",
    args: ["%s", literal],
    deadlineAt: new Date(Date.now() + 10000).toISOString(),
    maxOutputBytes: 8192,
    cleanupTimeoutMs: 2000,
  });
  await argvHost.ready;
  argvHost.start();
  assert.equal(Buffer.from((await argvHost.result).stdout).toString(), literal);
  const result = await run(
    'test -z "$HIMAWARI_SYNTHETIC_PARENT_SECRET" && ! cat .env >/dev/null 2>&1 && printf safe',
  );
  assert.equal(result.exitCode, 0);
  assert.equal(Buffer.from(result.stdout).toString(), "safe");
  assert.equal(result.taskTreeCleanup, "unknown");
  const rejected = await run("printf unexpected", { digest: "0".repeat(64) });
  assert.equal(rejected.taskStarted, false);
  assert.equal(rejected.reason, "host_failure");
  const flood = await run("while :; do printf 0123456789; done", { maxOutputBytes: 256 });
  assert.equal(flood.reason, "output_limit");
  assert.equal(flood.stdout.byteLength + flood.stderr.byteLength, 256);
  const cpuLimited = await run("while :; do :; done", {
    resourceLimits: { maxCpuTimeMs: 50, maxMemoryBytes: 268435456 },
  });
  assert.equal(cpuLimited.reason, "resource_limit");
  assert.ok(cpuLimited.resources?.observedCpuTimeMs > 50);
  assert.equal(cpuLimited.taskTreeCleanup, "unknown");
  const memoryLimited = await run("/bin/sleep 10", {
    resourceLimits: { maxCpuTimeMs: 10000, maxMemoryBytes: 1 },
  });
  assert.equal(memoryLimited.reason, "resource_limit");
  assert.ok(memoryLimited.resources?.peakObservedMemoryBytes > 1);
  assert.equal(memoryLimited.taskTreeCleanup, "unknown");
  const cancelled = await run("/bin/sleep 10", { cancel: true });
  assert.equal(cancelled.reason, "cancelled");
  const deadline = await run("/bin/sleep 10", { deadlineMs: 2000 });
  assert.equal(deadline.reason, "deadline");
  // A bounded detached descendant demonstrates why group exit is not tree cleanup.
  // Both branches self-terminate; the child only writes this synthetic marker.
  await writeFile(
    path.join(policy.workspace, "detached.pl"),
    `use POSIX qw(setsid);
pipe(my $r, my $w) or die "pipe";
my $pid = fork(); defined($pid) or die "fork";
if ($pid) { close($w); my $b; read($r, $b, 1); close($r); exit($b eq "r" ? 0 : 2); }
close($r); setsid() >= 0 or die "setsid";
close(STDIN); close(STDOUT); close(STDERR);
syswrite($w, "r"); close($w); sleep(1);
open(my $f, ">", "detached-finished") or exit(3); print $f "synthetic"; close($f); exit(0);
`,
  );
  const detached = await run("/usr/bin/perl detached.pl");
  assert.equal(detached.exitCode, 0);
  assert.equal(detached.taskTreeCleanup, "unknown");
  await delay(1500);
  assert.equal(
    await readFile(path.join(policy.workspace, "detached-finished"), "utf8"),
    "synthetic",
  );
  process.stdout.write(
    `${JSON.stringify({ jobHostProbePassed: true, productionSuitable: false, observations })}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
