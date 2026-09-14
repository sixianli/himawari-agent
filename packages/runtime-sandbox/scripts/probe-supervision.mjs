// Real, bounded fake-data process probes. No result certifies a production profile.
import assert from "node:assert/strict";
import childProcess, { fork } from "node:child_process";
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const runtimeURL = new URL(
  "../../../dist/node-build/packages/runtime-sandbox/src/index.js",
  import.meta.url,
);
// Capture bounded infrastructure diagnostics in the synthetic harness only.
if (process.argv.includes("--worker")) {
  const originalFork = childProcess.fork;
  childProcess.fork = (...args) => {
    const child = originalFork(...args);
    let remaining = 8192;
    child.stderr?.on("data", (chunk) => {
      if (remaining > 0) {
        const bytes = chunk.subarray(0, remaining);
        remaining -= bytes.length;
        process.stderr.write(bytes);
      }
    });
    return child;
  };
  syncBuiltinESMExports();
}
const runtime = await import(runtimeURL.href);
const self = fileURLToPath(import.meta.url);
if (process.argv.includes("--worker")) {
  process.once("message", async ({ request, scenario }) => {
    const host = runtime.prepareSandboxJobHost(request);
    try {
      await host.ready;
      const before = host.inspect();
      assert.equal(before?.state, "alive");
      if (scenario === "identity") {
        assert.throws(() =>
          host.stop({ ...before, bootId: "22222222-2222-2222-2222-222222222222" }),
        );
        assert.equal(host.inspect()?.state, "alive");
      }
      host.start();
      const until = Date.now() + 2000;
      while (!host.inspect()?.task && Date.now() < until) await delay(10);
      const observed = host.inspect();
      if (scenario !== "init-failure") assert.ok(observed?.task);
      if (scenario === "worker-stall") await delay(300);
      if (["worker-crash", "worker-stall"].includes(scenario))
        process.send?.({ type: "started", observed });
      if (scenario === "host-crash") process.kill(observed.processId, "SIGKILL");
      if (scenario === "stop-failure") {
        process.kill(observed.processId, "SIGSTOP");
        host.stop(observed);
      }
      if (scenario === "ack-loss") {
        // Lose the caller's start acknowledgement: do not create a second host.
        assert.throws(() => host.start());
        host.stop(observed);
      }
    } catch (error) {
      if (scenario !== "init-failure") {
        host.cancel();
        throw error;
      }
    }
    const result = await host.result;
    process.send?.({
      type: "result",
      result: {
        reason: result.reason,
        taskStarted: result.taskStarted,
        taskProcessExited: result.taskProcessExited,
        stdioClosed: result.stdioClosed,
        srtReset: result.srtReset,
        taskTreeCleanup: result.taskTreeCleanup,
        supervision: result.supervision,
        outputBytes: result.stdout.byteLength + result.stderr.byteLength,
      },
    });
    process.disconnect();
  });
} else {
  const root = await realpath(await mkdtemp("/tmp/himawari-supervision-"));
  const evidence = [];
  try {
    for (const scenario of [
      "normal",
      "identity",
      "ack-loss",
      "pipes",
      "init-failure",
      "host-crash",
      "stop-failure",
      "worker-crash",
      "worker-stall",
    ].filter(
      (value) =>
        !process.argv.includes("--case") ||
        value === process.argv[process.argv.indexOf("--case") + 1],
    )) {
      const directory = path.join(root, scenario);
      await mkdir(directory, { mode: 0o700 });
      const workspace = path.join(directory, "workspace"),
        scratch = path.join(directory, "scratch");
      await mkdir(workspace, { mode: 0o700 });
      await mkdir(scratch, { mode: 0o700 });
      // Every task also has its own finite lifetime if its supervisor is killed.
      const command =
        scenario === "worker-stall"
          ? "/usr/bin/perl -e 'for(1..40){open(my $f, q(>), q(ticks)) or die; print $f $_; close($f); select(undef,undef,undef,0.1)}'"
          : scenario === "pipes"
            ? "(/bin/sleep 0.5; /usr/bin/printf held) & /usr/bin/printf parent"
            : ["host-crash", "stop-failure", "worker-crash", "worker-stall"].includes(scenario)
              ? "/usr/bin/perl -e 'for(1..40){print qq(synthetic\\n); select(undef,undef,undef,0.1)}'"
              : "/bin/sleep 0.2; /usr/bin/printf synthetic";
      const policy = {
        workspace,
        privateDirectory: scratch,
        writable: true,
        protectedPaths: [],
        readOnlyToolchainPaths: await Promise.all(
          ["/bin", "/usr/bin", "/usr/lib", "/System", "/dev"].map((p) => realpath(p)),
        ),
        allowedDomains: [],
      };
      const compiled = await runtime.compileSandboxPolicy(policy);
      const request = {
        jobId: `probe-${scenario}`,
        attemptId: "attempt-1",
        policy,
        policyDigest: scenario === "init-failure" ? "0".repeat(64) : compiled.policyDigest,
        executable: "/bin/bash",
        args: ["-c", command],
        deadlineAt: new Date(Date.now() + 12000).toISOString(),
        maxOutputBytes: 8192,
        cleanupTimeoutMs: 1000,
      };
      const worker = fork(self, ["--worker"], {
        execArgv: [],
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
          HOME: scratch,
          TMPDIR: scratch,
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let diagnostics = "";
      worker.stderr.on("data", (chunk) => {
        diagnostics = (diagnostics + chunk.toString("utf8")).slice(0, 16384);
      });
      let observation;
      let killed = false;
      let resumeTimer;
      let stallCheck;
      const timeout = setTimeout(() => worker.kill("SIGKILL"), 15000);
      try {
        await new Promise((resolve, reject) => {
          worker.on("message", (message) => {
            if (message.type === "started" && scenario === "worker-crash") {
              observation = message.observed;
              killed = true;
              worker.kill("SIGKILL");
            }
            if (message.type === "started" && scenario === "worker-stall") {
              worker.kill("SIGSTOP");
              stallCheck = (async () => {
                await delay(1900);
                const first = await readFile(path.join(workspace, "ticks"), "utf8");
                await delay(400);
                const second = await readFile(path.join(workspace, "ticks"), "utf8");
                return { first, second };
              })();
              // Handle read failure even if the Worker exits before the final check.
              void stallCheck.catch(() => {});
              resumeTimer = setTimeout(() => {
                if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGCONT");
              }, 2500);
            }
            if (message.type === "result") observation = message.result;
          });
          worker.once("error", reject);
          worker.once("exit", (code) =>
            code === 0 || killed
              ? resolve()
              : reject(new Error(`fixture Worker failed: ${scenario}, diagnostics ${diagnostics}`)),
          );
          worker.send({ request, scenario });
        });
        assert.ok(observation);
        if (scenario === "worker-crash") {
          // Absence of a final authenticated observation is loss, not cleanup.
          evidence.push({
            scenario,
            supervision: "lost",
            cleanup: "unknown",
            lastBootId: observation.bootId,
          });
        } else {
          assert.equal(observation.supervision?.taskTreeGuarantee, "unverified");
          if (scenario === "worker-stall") {
            assert.equal(observation.reason, "host_failure");
            const ticks = await stallCheck;
            assert.equal(ticks.first, ticks.second);
            assert.ok(Number(ticks.second) > 0 && Number(ticks.second) < 30);
            assert.ok(observation.outputBytes < 35 * "synthetic\n".length);
          }
          assert.equal(
            observation.taskTreeCleanup,
            scenario === "init-failure" ? "not_started" : "unknown",
          );
          evidence.push({ scenario, ...observation });
        }
      } finally {
        clearTimeout(timeout);
        clearTimeout(resumeTimer);
        if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
        // Also wait on assertion failure, before removing the owned fixture directory.
        await delay(4500);
      }
      await writeFile(path.join(directory, "evidence.json"), JSON.stringify(evidence.at(-1)), {
        mode: 0o600,
      });
    }
    process.stdout.write(
      `${JSON.stringify({ probePassed: true, productionSuitable: false, taskTreeGuarantee: "unverified", evidence })}\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
