import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  SandboxHostBinding,
  SandboxJobControlBinding,
  SandboxRuntimeQualification,
} from "@himawari-agent/execution-contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createProductionSandboxControl } from "../../apps/agent-service/src/production-sandbox-control.ts";
import { sandboxV2Admission, sandboxV2Call } from "../fixtures/sandbox-execution-v2-fixture.ts";
import { openSandboxJournal } from "../fixtures/sqlite-capability-invocation-fixture.ts";

const launch = vi.hoisted(() => ({ hook: "", entry: "" }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    fork: (_file: string, args: string[], options: import("node:child_process").ForkOptions) =>
      actual.fork(launch.entry, args, { ...options, execArgv: ["--import", launch.hook] }),
  };
});
import { prepareSandboxJobHost } from "../../packages/runtime-sandbox/src/job-host.ts";
import { prepareJobPolicy } from "../../packages/runtime-sandbox/src/job-policy.ts";
import { readJobHostFinalEvidence } from "../../packages/runtime-sandbox/src/job-host-control.ts";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

it("recovers authenticated never-started cleanup when SDK preparation fails before ready", async () => {
  const f = await openSandboxJournal();
  cleanups.push(f.close);
  const root = await realpath(await mkdtemp(`${testTemporaryRoot()}/hma-prep-`));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const runtime = path.resolve("dist/node-runtime/node_modules");
  launch.entry = path.join(runtime, "@himawari-agent/runtime-sandbox/dist/job-host-main.js");
  launch.hook = path.join(root, "failure.mjs");
  await writeFile(
    launch.hook,
    `import { SandboxManager } from ${JSON.stringify(pathToFileURL(path.join(runtime, "@anthropic-ai/sandbox-runtime/dist/index.js")).href)};\nSandboxManager.initialize = async () => { throw Object.assign(new Error("JOB_HOST_TEST_PREPARATION_FAILURE"), { code: "EIO" }); };\n`,
  );
  const directory = path.join(root, "control");
  await mkdir(directory, { mode: 0o700 });
  const plan = sandboxV2Call(f, "admit", sandboxV2Admission(f)).record.plan;
  const control: SandboxJobControlBinding = {
    directory,
    token: randomBytes(32).toString("hex"),
    sessionId: randomUUID(),
    jobId: plan.identity.jobId,
    attemptId: plan.identity.attemptId,
  };
  const { policy, compiled } = await prepareJobPolicy({
    workspace: null,
    privateRoot: root,
    jobId: plan.identity.jobId,
    writable: false,
    readOnlyToolchainPaths: [],
    protectedPaths: [],
    allowedDomains: [],
  });
  const stored = new Map<string, { ref: string; digest: string; value: unknown }>();
  const hostInfo = async () => ({
    binding: {
      privateRoot: root,
      runtimeRoot: "/runtime",
      readOnlyToolchainPaths: [],
      roots: [],
    } as unknown as SandboxHostBinding,
    qualification: { platform: process.platform } as SandboxRuntimeQualification,
  });
  const options = {
    now: () => new Date().toISOString(),
    machineBootId: async () => "machine-boot",
    host: hostInfo,
    admit: hostInfo,
    read: async (_plan: unknown, key: string) => stored.get(key),
    write: async (_plan: unknown, key: string, value: unknown) => {
      if (stored.has(key)) throw new Error("duplicate artifact");
      const artifact = { ref: key, digest: "a".repeat(64), value: structuredClone(value) };
      stored.set(key, artifact);
      return artifact;
    },
  };
  const controller = createProductionSandboxControl(options);
  await controller.registerPreparation(plan, control, compiled.policyDigest);
  const host = prepareSandboxJobHost(
    {
      jobId: plan.identity.jobId,
      attemptId: plan.identity.attemptId,
      policy,
      policyDigest: compiled.policyDigest,
      executable: process.execPath,
      args: ["-e", "process.exit(99)"],
      deadlineAt: new Date(Date.now() + 30000).toISOString(),
      maxOutputBytes: 4096,
      cleanupTimeoutMs: 5000,
    },
    directory,
    undefined,
    control,
  );
  cleanups.push(async () => {
    host.cancel();
    await host.result;
  });
  await expect(host.ready).rejects.toThrow("JOB_HOST_NOT_READY");
  const observed = await host.result;
  process.stderr.write(`${JSON.stringify({ event: "sandbox.preparation.cleanup", observed })}\n`);
  expect(observed).toMatchObject({
    reason: "host_failure",
    taskStarted: false,
    srtReset: true,
  });
  if (!host.controlBinding) throw new Error("Original control binding missing");
  expect(await readJobHostFinalEvidence(host.controlBinding)).toMatchObject({
    phase: "finished",
    taskStarted: false,
    srtReset: true,
  });
  const restarted = createProductionSandboxControl(options);
  await expect(restarted.verifyReservationRelease(plan, options.now())).resolves.toMatchObject({
    basis: "host_never_started",
    identity: plan.identity,
    controlSessionId: control.sessionId,
  });
  expect(host.controlBinding).toEqual(control);
});

it("survives slow startup followed by bounded synchronous preparation without renewing the lease", async () => {
  const root = await realpath(await mkdtemp(`${testTemporaryRoot()}/hma-prep-`));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const runtime = path.resolve("dist/node-runtime/node_modules");
  launch.entry = path.join(runtime, "@himawari-agent/runtime-sandbox/dist/job-host-main.js");
  launch.hook = path.join(root, "slow-prepare.mjs");
  await writeFile(
    launch.hook,
    `import { SandboxManager } from ${JSON.stringify(pathToFileURL(path.join(runtime, "@anthropic-ai/sandbox-runtime/dist/index.js")).href)};
const startup = performance.now() + 500;
while (performance.now() < startup) {}
const initialize = SandboxManager.initialize;
SandboxManager.initialize = async (...args) => {
  const until = performance.now() + 1150;
  while (performance.now() < until) {}
  return initialize(...args);
};
`,
  );
  const { policy, compiled } = await prepareJobPolicy({
    workspace: null,
    privateRoot: root,
    jobId: "bounded-preparation",
    writable: false,
    readOnlyToolchainPaths: [],
    protectedPaths: [],
    allowedDomains: [],
  });
  const host = prepareSandboxJobHost({
    jobId: "bounded-preparation",
    attemptId: "original-attempt",
    policy,
    policyDigest: compiled.policyDigest,
    executable: process.execPath,
    args: ["-e", "process.exit(99)"],
    deadlineAt: new Date(Date.now() + 30000).toISOString(),
    maxOutputBytes: 4096,
    cleanupTimeoutMs: 5000,
  });
  cleanups.push(async () => {
    host.cancel();
    await host.result;
  });
  await expect(host.ready).resolves.toBeUndefined();
  expect(host.inspect()?.state).toBe("alive");
  host.cancel();
  expect(await host.result).toMatchObject({ taskStarted: false, srtReset: true });
});

it("prepares with the packaged Java agent when global npm discovery would block heartbeats", async () => {
  const root = await realpath(await mkdtemp(`${testTemporaryRoot()}/hma-prep-`));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const runtime = path.resolve("dist/node-runtime/node_modules");
  launch.entry = path.join(runtime, "@himawari-agent/runtime-sandbox/dist/job-host-main.js");
  launch.hook = path.join(root, "slow-global-npm.mjs");
  const discovery = path.join(root, "discovery.txt");
  await writeFile(
    launch.hook,
    `import cp from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const execute = cp.execSync;
cp.execSync = (command, ...args) => {
  if (command === "npm root -g") {
    appendFileSync(${JSON.stringify(discovery)}, "global npm discovery\\n");
    const until = performance.now() + 1600;
    while (performance.now() < until) {}
  }
  return execute(command, ...args);
};
syncBuiltinESMExports();
`,
  );
  const { policy, compiled } = await prepareJobPolicy({
    workspace: null,
    privateRoot: root,
    jobId: "packaged-java-agent",
    writable: false,
    readOnlyToolchainPaths: [],
    protectedPaths: [],
    allowedDomains: [],
  });
  const host = prepareSandboxJobHost({
    jobId: "packaged-java-agent",
    attemptId: "original-attempt",
    policy,
    policyDigest: compiled.policyDigest,
    executable: process.execPath,
    args: ["-e", "process.exit(99)"],
    deadlineAt: new Date(Date.now() + 30000).toISOString(),
    maxOutputBytes: 4096,
    cleanupTimeoutMs: 5000,
  });
  cleanups.push(async () => {
    host.cancel();
    await host.result;
  });
  await expect(host.ready).resolves.toBeUndefined();
  await expect(readFile(discovery, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  host.cancel();
  expect(await host.result).toMatchObject({ taskStarted: false, srtReset: true });
});
