import assert from "node:assert/strict";
import childProcess, { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createProductionSandboxControl } from "../../../dist/node-build/apps/agent-service/src/production-sandbox-control.js";
import {
  compileSandboxPolicy,
  prepareSandboxJobHost,
  queryJobHostControl,
  readJobHostFinalEvidence,
} from "../../../dist/node-build/packages/runtime-sandbox/src/index.js";

// Temporary Linux helpers are a probe-only override, never product configuration.
if (process.platform === "linux" && process.env.HIMAWARI_R4_HELPERS) {
  const originalFork = childProcess.fork;
  childProcess.fork = (module, args, options) =>
    !options?.env
      ? originalFork(module, args, options)
      : originalFork(module, args, {
          ...options,
          env: { ...options.env, PATH: `${process.env.HIMAWARI_R4_HELPERS}:${options.env.PATH}` },
        });
  syncBuiltinESMExports();
}
const self = fileURLToPath(import.meta.url);
if (process.argv.includes("--worker")) {
  process.once("message", async ({ request, directory, scenario }) => {
    const host = prepareSandboxJobHost(request, directory);
    await host.ready;
    process.send?.({ binding: host.controlBinding, supervisor: host.inspect() });
    if (scenario !== "never-started") {
      await new Promise((resolve) => process.once("message", resolve));
      host.start();
    }
    const result = await host.result;
    process.send?.({
      result: {
        reason: result.reason,
        taskTreeCleanup: result.taskTreeCleanup,
        stdout: Buffer.from(result.stdout).toString(),
        stderr: Buffer.from(result.stderr).toString(),
        exitCode: result.exitCode,
      },
    });
    process.disconnect();
  });
} else {
  const root = await realpath(
    await mkdtemp(
      process.env.HIMAWARI_R4_ROOT
        ? path.join(process.env.HIMAWARI_R4_ROOT, "c-")
        : "/tmp/r4-control-",
    ),
  );
  const results = [];
  try {
    for (const scenario of ["stop", "worker-crash", "never-started", "observed-escape", "stdin"]) {
      const directory = path.join(root, String(results.length));
      await mkdir(directory, { mode: 0o700 });
      for (const child of ["workspace", "private", "control"])
        await mkdir(path.join(directory, child), { mode: 0o700 });
      const controlDirectory = path.join(directory, "control");
      await writeFile(path.join(controlDirectory, "sentinel"), "synthetic-only", { mode: 0o600 });
      const policy = {
        workspace: path.join(directory, "workspace"),
        privateDirectory: path.join(directory, "private"),
        writable: true,
        protectedPaths: [],
        allowedDomains: [],
        readOnlyToolchainPaths: await Promise.all(
          (process.platform === "linux"
            ? [
                "/bin",
                "/usr",
                "/lib",
                "/lib64",
                "/dev",
                process.env.HIMAWARI_R4_HELPERS,
                fileURLToPath(
                  new URL(
                    "../../../node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp",
                    import.meta.url,
                  ),
                ),
              ]
            : ["/bin", "/usr/bin", "/usr/lib", "/System", "/dev"]
          ).map((p) => realpath(p)),
        ),
      };
      const compiled = await compileSandboxPolicy(policy);
      const request = {
        jobId: scenario,
        attemptId: "attempt",
        policy,
        policyDigest: compiled.policyDigest,
        executable: "/usr/bin/perl",
        args: [
          "-e",
          scenario === "stdin"
            ? "binmode STDIN; local $/; my $input=<STDIN>; print $input; $|=1; sleep(4);"
            : scenario === "observed-escape"
              ? "use POSIX qw(setsid); my $p=fork(); if (!$p) { setsid(); sleep(4); exit(0); } sleep(3);"
              : `open(my $f, '<', '${controlDirectory}/sentinel') and die 'control visible'; print qq(denied\\n); $|=1; sleep(4);`,
        ],
        ...(scenario === "stdin"
          ? { stdinBase64: Buffer.from("synthetic\u0000first\nsecond").toString("base64") }
          : {}),
        deadlineAt: new Date(Date.now() + 10000).toISOString(),
        maxOutputBytes: 4096,
        cleanupTimeoutMs: 1000,
        resourceLimits: { maxCpuTimeMs: 5000, maxMemoryBytes: 536870912 },
      };
      const worker = fork(self, ["--worker"], {
        execArgv: [],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let workerError = "";
      worker.stderr.on("data", (chunk) => {
        workerError = (workerError + chunk.toString()).slice(-8192);
      });
      let workerResult;
      let stage = "prepare";
      const exited = new Promise((resolve) => worker.once("exit", resolve));
      const timeout = setTimeout(() => worker.kill("SIGKILL"), 12000);
      try {
        const bound = new Promise((resolve, reject) => {
          worker.on("message", (message) => {
            if (message.binding) resolve(message);
            if (message.result) workerResult = message.result;
          });
          worker.once("exit", () =>
            reject(new Error(`worker exited before binding: ${workerError}`)),
          );
        });
        worker.send({ request, directory: controlDirectory, scenario });
        const { binding, supervisor } = await bound;
        stage = "first-inspect";
        const inspected = await queryJobHostControl(binding, "inspect");
        assert.equal(inspected.bootId, supervisor.bootId);
        assert.equal(inspected.phase, "ready");
        // In-memory artifact storage and qualification are fixtures; the process,
        // control protocol and product evidence verifier are real.
        const artifacts = new Map();
        const product = createProductionSandboxControl({
          now: () => new Date().toISOString(),
          read: async (_plan, key) => artifacts.get(key),
          write: async (_plan, key, value) => {
            const artifact = {
              ref: `probe-evidence-${artifacts.size}`,
              digest: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
              value,
            };
            artifacts.set(key, artifact);
            return artifact;
          },
          host: async () => ({
            binding: {
              privateRoot: directory,
              runtimeRoot: "/unused-runtime",
              readOnlyToolchainPaths: [],
              roots: [],
            },
            qualification: {
              platform: process.platform,
              terminationMode: process.platform === "linux" ? "verified_tree" : "best_effort",
            },
          }),
        });
        const identity = {
          jobId: scenario,
          attemptId: "attempt",
          invocationId: "probe",
          receiptRef: "probe",
          hostId: "probe",
          ownerId: "probe",
          agentId: "probe",
          threadId: null,
          runId: "probe",
          toolCallId: "probe",
        };
        const plan = {
          identity,
          mode: "foreground",
          operationContract: { ref: "probe", version: "1", kind: "fixed_read" },
          semanticFingerprint: `sha256:${"a".repeat(64)}`,
          environmentId: "probe",
          effectiveDeadlineAt: request.deadlineAt,
          binding: { profileRef: "probe", qualificationRef: "probe" },
        };
        const supervisorIdentity = {
          supervisorId: binding.sessionId,
          bootId: inspected.bootId,
          epoch: 1,
        };
        const environment = {
          kind: "local",
          privateDirectoryOwnerRef: "probe",
          privateDirectoryRef: inspected.privateDirectoryRef,
          supervisor: supervisorIdentity,
          policyDigest: compiled.policyDigest,
        };
        const resource = {
          schemaVersion: "sandbox-execution.v2",
          environmentId: "probe",
          creator: identity,
          policyDigest: compiled.policyDigest,
          scopeDigest: "a".repeat(64),
          sequence: 1,
          occurredAt: new Date().toISOString(),
          supervisor: supervisorIdentity,
          resourceRef: null,
          status: { kind: "foreground" },
          metrics: null,
          supervision: "initializing",
          cleanup: "pending",
        };
        const record = {
          plan,
          facts: {
            environment,
            resource,
            result: null,
            effect: { kind: "unknown", reasonCode: "probe" },
          },
          operationRevision: 0,
        };
        await product.register(plan, binding);
        await product.verifyPreparation(plan, record.facts);
        if (scenario !== "never-started") {
          worker.send({ start: true });
          await delay(300);
        }
        if (scenario !== "observed-escape") {
          stage = "wrong-token";
          await assert.rejects(queryJobHostControl({ ...binding, token: "0".repeat(64) }, "stop"));
          stage = "inspect-after-rejection";
          assert.equal(
            (await queryJobHostControl(binding, "inspect")).phase,
            scenario === "never-started" ? "ready" : "running",
          );
          if (scenario === "worker-crash") worker.kill("SIGKILL");
          else await queryJobHostControl(binding, "stop");
        }
        await exited;
        let final;
        for (let i = 0; i < 30 && !final; i++) {
          try {
            final = await readJobHostFinalEvidence(binding);
          } catch {
            await delay(100);
          }
        }
        assert.ok(final);
        assert.equal(final.bootId, inspected.bootId);
        assert.equal(final.taskStarted, scenario !== "never-started");
        assert.equal(final.phase, "finished");
        assert.ok(final.sequence > inspected.sequence);
        if (scenario === "stop") {
          assert.equal(workerResult.stdout, "denied\n");
          assert.equal(workerResult.reason, "cancelled");
          assert.equal(workerResult.taskTreeCleanup, "unknown");
        }
        let observed;
        for (let i = 0; i < 20; i++) {
          observed = await product.observe(record);
          if (
            (scenario !== "never-started" && process.platform !== "linux") ||
            observed.supervision === "released"
          )
            break;
          await delay(100);
        }
        assert.equal(
          observed.supervision,
          scenario === "never-started" || process.platform === "linux" ? "released" : "lost",
        );
        if (observed.supervision === "released")
          assert.equal(
            (await product.evidence(plan, { ...record.facts, resource: observed })).length,
            1,
          );
        if (scenario === "stdin") assert.equal(workerResult.stdout, "synthetic\u0000first\nsecond");
        if (scenario === "observed-escape")
          assert.equal(
            workerResult.reason,
            process.platform === "linux" ? "exited" : "host_failure",
          );
        const filename = path.join(controlDirectory, "final.json");
        const envelope = JSON.parse(await readFile(filename, "utf8"));
        envelope.body = envelope.body.replace('"srtReset":true', '"srtReset":false');
        await writeFile(filename, JSON.stringify(envelope), { mode: 0o600 });
        await assert.rejects(readJobHostFinalEvidence(binding));
        results.push({ scenario, passed: true, cleanup: observed.cleanup });
      } catch (error) {
        console.error(JSON.stringify({ scenario, stage, workerResult }));
        throw error;
      } finally {
        clearTimeout(timeout);
        if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
        await exited;
        await delay(4500);
      }
    }
    console.log(JSON.stringify({ passed: true, productionQualified: false, results }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
