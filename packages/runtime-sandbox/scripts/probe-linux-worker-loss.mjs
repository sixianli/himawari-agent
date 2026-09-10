// Owned fake-data Worker-loss probe. The child is a harness, not production registration.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.equal(process.platform, "linux");
assert.equal(process.env.HIMAWARI_LIVE_SANDBOX_PROBE, "1");
const runtime = await realpath(process.env.HIMAWARI_PROBE_RUNTIME);
const moduleRoot = path.join(runtime, "node_modules/@himawari-agent/runtime-sandbox/dist");
const {
  compileSandboxPolicy,
  prepareSandboxJobHost,
  queryJobHostControl,
  readJobHostFinalEvidence,
} = await import(pathToFileURL(path.join(moduleRoot, "index.js")));
const { readLinuxNamespaceState } = await import(
  pathToFileURL(path.join(moduleRoot, "linux-namespace.js"))
);
if (process.argv[2] === "worker") {
  process.once("message", async ({ root }) => {
    const policy = {
      workspace: path.join(root, "workspace"),
      privateDirectory: path.join(root, "private"),
      writable: true,
      allowedDomains: [],
      protectedPaths: [],
      readOnlyToolchainPaths: await Promise.all(
        [
          "/usr/bin",
          "/usr/lib",
          "/lib",
          "/lib64",
          "/dev",
          "/proc",
          path.dirname(process.execPath),
          path.join(moduleRoot, "../../../@anthropic-ai/sandbox-runtime/vendor/seccomp"),
        ].map((p) => realpath(p)),
      ),
    };
    const compiled = await compileSandboxPolicy(policy);
    const host = prepareSandboxJobHost(
      {
        jobId: "worker-loss",
        attemptId: "attempt",
        policy,
        policyDigest: compiled.policyDigest,
        executable: "/bin/bash",
        args: [
          "-c",
          "setsid /bin/bash -c 'sleep 4; printf escaped > escaped' >/dev/null 2>&1 & printf spawned; sleep 15",
        ],
        deadlineAt: new Date(Date.now() + 20000).toISOString(),
        maxOutputBytes: 1024,
        cleanupTimeoutMs: 2000,
      },
      path.join(root, "control"),
    );
    await host.ready;
    host.start();
    await host.started;
    while (!Buffer.from(host.readOutput(0, 1024).bytes).toString().includes("spawned"))
      await delay(20);
    process.send({ binding: host.controlBinding });
    await host.result;
  });
} else {
  const parent = await realpath(process.env.HIMAWARI_PROBE_SCRATCH);
  assert.ok(parent.startsWith("/data/himawari-r8-"));
  assert.equal((await lstat(parent)).uid, process.getuid());
  const root = await mkdtemp(path.join(parent, "loss-"));
  for (const name of ["workspace", "private", "control"])
    await mkdir(path.join(root, name), { mode: 0o700 });
  const worker = fork(fileURLToPath(import.meta.url), ["worker"], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    execArgv: [],
  });
  let exited = false;
  worker.once("exit", () => {
    exited = true;
  });
  let binding;
  try {
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WORKER_PROBE_READY_TIMEOUT")), 10000);
      worker.once("message", (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      worker.once("error", reject);
    });
    worker.send({ root });
    ({ binding } = await ready);
    const before = await queryJobHostControl(binding, "inspect");
    assert.ok(before.linuxNamespace);
    assert.equal(await readLinuxNamespaceState(before.linuxNamespace), "alive");
    worker.kill("SIGKILL");
    await delay(5500);
    const final = await readJobHostFinalEvidence(binding);
    const namespaceState = await readLinuxNamespaceState(before.linuxNamespace);
    const markerAbsent = await readFile(path.join(root, "workspace/escaped")).then(
      () => false,
      (error) => {
        if (error.code === "ENOENT") return true;
        throw error;
      },
    );
    const passed =
      namespaceState === "released" && markerAbsent && final.srtReset && final.taskProcessExited;
    console.log(
      JSON.stringify(
        {
          runtime,
          platform: process.platform,
          node: process.version,
          scenario: "worker-sigkill-with-setsid-descendant",
          linuxNamespace: before.linuxNamespace,
          namespaceState,
          markerAbsent,
          srtReset: final.srtReset,
          taskProcessExited: final.taskProcessExited,
          passed,
          productionSuitable: false,
        },
        null,
        2,
      ),
    );
    if (!passed) process.exitCode = 1;
  } finally {
    if (binding) await queryJobHostControl(binding, "stop").catch(() => {});
    if (!exited) worker.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}
