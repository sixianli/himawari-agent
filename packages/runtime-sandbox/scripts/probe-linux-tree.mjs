// Finite fake-data probe of the pinned SRT Linux namespace mechanism.
// Helper paths and qualification are fixture-owned, not installed product configuration.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

const root = await realpath(process.argv[2]);
assert.equal(process.platform, "linux");
assert.ok(root.startsWith("/data/himawari-r4-"));
assert.equal((await lstat(root)).uid, process.getuid());
const owned = await mkdtemp(path.join(root, "tree-"));
const workspace = path.join(owned, "workspace");
const scratch = path.join(owned, "scratch");
await mkdir(workspace, { mode: 0o700 });
await mkdir(scratch, { mode: 0o700 });
process.env.TMPDIR = scratch;
process.env.CLAUDE_CODE_TMPDIR = scratch;
const watchdog = setTimeout(() => process.exit(124), 15000);
const results = [];
try {
  await SandboxManager.initialize(
    {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: {
        denyRead: ["/"],
        allowRead: [
          workspace,
          scratch,
          "/usr",
          "/lib",
          "/lib64",
          "/bin",
          "/dev",
          "/proc",
          path.join(root, "sysroot"),
          path.join(root, "node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp"),
        ],
        denyWrite: ["/"],
        allowWrite: [workspace, scratch],
      },
      bwrapPath: path.join(root, "sysroot/usr/bin/bwrap"),
      socatPath: path.join(root, "sysroot/usr/bin/socat"),
      enableWeakerNestedSandbox: false,
    },
    undefined,
    false,
  );
  for (const scenario of ["normal", "setsid"]) {
    const marker = path.join(workspace, "escaped");
    const command =
      scenario === "normal"
        ? "sleep 0.2; printf done"
        : `setsid /bin/sh -c 'sleep 2; printf escaped > ${marker}' >/dev/null 2>&1 & sleep 0.2; printf done`;
    const launch = await SandboxManager.wrapWithSandboxArgv(command, "/bin/bash");
    const started = Date.now();
    const child = spawn(launch.argv[0], launch.argv.slice(1), {
      cwd: workspace,
      env: launch.env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 4096) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 4096) child.kill("SIGKILL");
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timeout);
    assert.equal(exit.code, 0, stderr);
    assert.equal(stdout, "done");
    assert.ok(Date.now() - started < 1900, "namespace completion did not promptly close pipes");
    await delay(2300);
    assert.equal(
      await access(marker).then(
        () => true,
        () => false,
      ),
      false,
    );
    results.push({ scenario, exit, passed: true, descendantMarkerAbsent: true });
    SandboxManager.cleanupAfterCommand();
  }
  console.log(
    JSON.stringify({
      passed: true,
      productionQualified: false,
      srtVersion: "0.0.75",
      helperConfiguration: "temporary-fixture",
      owned,
      results,
    }),
  );
} finally {
  await SandboxManager.reset();
  clearTimeout(watchdog);
}
