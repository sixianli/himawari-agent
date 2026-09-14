// Current-artifact Linux preparation probe; never starts a user command or issues a qualification.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { release } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(process.env.HIMAWARI_LIVE_SANDBOX_PROBE, "1");
assert.equal(process.platform, "linux");
const parent = await realpath(process.env.HIMAWARI_PROBE_SCRATCH);
assert.ok(parent.startsWith("/data/himawari-r8-"));
assert.equal((await lstat(parent)).uid, process.getuid());
const runtime = await realpath(process.env.HIMAWARI_PROBE_RUNTIME);
const moduleRoot = path.join(runtime, "node_modules/@himawari-agent/runtime-sandbox/dist");
const { inspectSrtDependencies, compileSandboxPolicy, prepareSandboxJobHost } = await import(
  pathToFileURL(path.join(moduleRoot, "index.js"))
);
const root = await mkdtemp(path.join(parent, "ready-"));
try {
  for (const name of ["workspace", "private", "control"])
    await mkdir(path.join(root, name), { mode: 0o700 });
  const policy = {
    workspace: path.join(root, "workspace"),
    privateDirectory: path.join(root, "private"),
    writable: false,
    readOnlyToolchainPaths: [await realpath("/usr/bin")],
    protectedPaths: [],
    allowedDomains: [],
  };
  const dependencies = await inspectSrtDependencies();
  const compiled = await compileSandboxPolicy(policy);
  const host = prepareSandboxJobHost(
    {
      jobId: "linux-readiness",
      attemptId: "attempt",
      policy,
      policyDigest: compiled.policyDigest,
      executable: "/bin/echo",
      args: ["must-not-start"],
      deadlineAt: new Date(Date.now() + 10000).toISOString(),
      maxOutputBytes: 1024,
      cleanupTimeoutMs: 2000,
    },
    path.join(root, "control"),
  );
  let preparation;
  try {
    await host.ready;
    preparation = "ready-not-started";
  } catch (error) {
    preparation = error.message;
  } finally {
    host.cancel();
  }
  const result = await host.result;
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        architecture: process.arch,
        osRelease: release(),
        node: process.version,
        runtime,
        dependencies,
        preparation,
        taskStarted: host.inspect()?.task != null,
        result,
        runnerDigest: createHash("sha256")
          .update(await readFile(path.join(moduleRoot, "job-host-main.js")))
          .digest("hex"),
        productionSuitable: false,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
