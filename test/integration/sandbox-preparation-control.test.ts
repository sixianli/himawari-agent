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

const launch = vi.hoisted(() => ({
  hook: "",
  entry: "",
  stalePrepare: false,
  stderr: "",
  events: [] as Record<string, unknown>[],
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    fork: (_file: string, args: string[], options: import("node:child_process").ForkOptions) => {
      const child = actual.fork(launch.entry, args, {
        ...options,
        execArgv: ["--import", launch.hook],
      });
      launch.events.push({ stage: "fork", at: Date.now() });
      child.on("message", (message: Record<string, unknown>) => {
        launch.events.push({
          stage: "host-message",
          at: Date.now(),
          type: message["type"],
          detail: message["detail"],
        });
      });
      const originalSend = child.send.bind(child);
      child.send = ((message: Record<string, unknown>, ...args: unknown[]) => {
        launch.events.push({
          stage: "worker-message",
          at: Date.now(),
          type: message["type"],
          observedAt: message["observedAt"],
        });
        return Reflect.apply(originalSend, child, [message, ...args]);
      }) as typeof child.send;
      child.stderr?.on("data", (chunk: Buffer) => {
        launch.stderr += chunk.toString();
      });
      if (launch.stalePrepare) {
        const send = child.send.bind(child);
        child.send = ((message: Record<string, unknown>, ...args: unknown[]) =>
          Reflect.apply(send, child, [
            message["type"] === "prepare"
              ? { ...message, observedAt: new Date(Date.now() - 2000).toISOString() }
              : message,
            ...args,
          ])) as typeof child.send;
      }
      return child;
    },
  };
});
import { prepareSandboxJobHost } from "../../packages/runtime-sandbox/src/job-host.ts";
import { prepareJobPolicy } from "../../packages/runtime-sandbox/src/job-policy.ts";
import { readJobHostFinalEvidence } from "../../packages/runtime-sandbox/src/job-host-control.ts";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  launch.stalePrepare = false;
  launch.stderr = "";
  launch.events.length = 0;
});

async function configureSdkLoad(
  root: string,
  options: {
    delayMs: number;
    failImport?: boolean;
    failContractsImport?: boolean;
    failInitialize?: boolean;
    blockInitializeMs?: number;
  },
) {
  const runtime = path.resolve("dist/node-runtime/node_modules");
  launch.entry = path.join(runtime, "@himawari-agent/runtime-sandbox/dist/job-host-main.js");
  launch.hook = path.join(root, "preload.mjs");
  const loader = path.join(root, "loader.mjs");
  await writeFile(
    launch.hook,
    `import { register } from "node:module";
register(${JSON.stringify(pathToFileURL(loader).href)});
`,
  );
  await writeFile(
    loader,
    `export async function load(url, context, nextLoad) {
  if (${Boolean(options.failContractsImport)} && url.endsWith("/@himawari-agent/execution-contracts/dist/index.js"))
    throw Object.assign(new Error("JOB_HOST_TEST_CONTRACTS_IMPORT_FAILURE"), { code: "EIO" });
  const loaded = await nextLoad(url, context);
  if (!url.endsWith("/sandbox/sandbox-manager.js")) return loaded;
  return { ...loaded, source: ${JSON.stringify(
    `const himawariFixtureTrace = (stage) => process.stderr.write(JSON.stringify({ stage, at: Date.now() }) + "\\n");
himawariFixtureTrace("sdk_module_entered");
await new Promise((resolve) => setTimeout(resolve, ${options.delayMs}));
himawariFixtureTrace("sdk_module_delay_finished");
` +
      (options.failImport
        ? 'throw Object.assign(new Error("JOB_HOST_TEST_IMPORT_FAILURE"), { code: "EIO" });\n'
        : ""),
  )} + loaded.source.toString() + ${JSON.stringify(
    options.failInitialize
      ? '\nSandboxManager.initialize = async () => { throw Object.assign(new Error("JOB_HOST_TEST_PREPARATION_FAILURE"), { code: "EIO" }); };\n'
      : options.blockInitializeMs
        ? `\nconst himawariFixtureInitialize = SandboxManager.initialize;
SandboxManager.initialize = async (...args) => {
  himawariFixtureTrace("sdk_initialize_entered");
  const until = performance.now() + ${options.blockInitializeMs};
  while (performance.now() < until) {}
  himawariFixtureTrace("sdk_synchronous_delay_finished");
  const result = await himawariFixtureInitialize(...args);
  himawariFixtureTrace("sdk_initialize_finished");
  return result;
};\n`
        : "",
  )} };
}
`,
  );
}

it("recovers authenticated never-started cleanup when SDK preparation fails before ready", async (context) => {
  const f = await openSandboxJournal();
  cleanups.push(f.close);
  const root = await realpath(await mkdtemp(`${testTemporaryRoot()}/hma-prep-`));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await configureSdkLoad(root, { delayMs: 2500, failInitialize: true });
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
  expect(observed, JSON.stringify({ observed, stderr: launch.stderr })).toMatchObject({
    reason: "host_failure",
    diagnostic: { stage: "sdk_initialize", systemCode: "EIO" },
    taskStarted: false,
    srtReset: true,
  });
  if (!host.controlBinding) throw new Error("Original control binding missing");
  const final = await readJobHostFinalEvidence(host.controlBinding);
  expect(final).toMatchObject({
    phase: "finished",
    taskStarted: false,
    srtReset: true,
  });
  const restarted = createProductionSandboxControl(options);
  const release = await restarted.verifyReservationRelease(plan, options.now());
  expect(release).toMatchObject({
    basis: "host_never_started",
    identity: plan.identity,
    controlSessionId: control.sessionId,
  });
  expect(host.controlBinding).toEqual(control);
  Object.assign(context.task.meta, { cleanupReadback: { observed, final, release } });
});

it("survives slow startup followed by bounded synchronous preparation without renewing the lease", async () => {
  const root = await realpath(await mkdtemp(`${testTemporaryRoot()}/hma-prep-`));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await configureSdkLoad(root, { delayMs: 500, blockInitializeMs: 1150 });
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
  await expect(
    host.ready.catch(async (error: unknown) => {
      const observed = await host.result;
      throw new Error(JSON.stringify({ observed, stderr: launch.stderr, events: launch.events }), {
        cause: error,
      });
    }),
  ).resolves.toBeUndefined();
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

it.each([
  { name: "preparation deadline", delayMs: 31000, failImport: false, stalePrepare: false },
  { name: "import failure", delayMs: 0, failImport: true, stalePrepare: false },
  {
    name: "contracts import failure",
    delayMs: 0,
    failImport: false,
    failContractsImport: true,
    stalePrepare: false,
  },
  {
    name: "task deadline during import",
    delayMs: 2500,
    failImport: false,
    stalePrepare: false,
    taskDeadlineMs: 1000,
  },
  { name: "already stale prepare", delayMs: 0, failImport: false, stalePrepare: true },
])(
  "rejects $name without starting the user task",
  async (scenario) => {
    const root = await realpath(await mkdtemp(`${testTemporaryRoot()}/hma-prep-`));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await configureSdkLoad(root, scenario);
    launch.stalePrepare = scenario.stalePrepare;
    const marker = path.join(root, "user-task-started");
    const { policy, compiled } = await prepareJobPolicy({
      workspace: null,
      privateRoot: root,
      jobId: "load-rejection",
      writable: false,
      readOnlyToolchainPaths: [],
      protectedPaths: [],
      allowedDomains: [],
    });
    const startedAt = performance.now();
    const host = prepareSandboxJobHost({
      jobId: "load-rejection",
      attemptId: "original-attempt",
      policy,
      policyDigest: compiled.policyDigest,
      executable: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`],
      deadlineAt: new Date(Date.now() + (scenario.taskDeadlineMs ?? 60000)).toISOString(),
      maxOutputBytes: 4096,
      cleanupTimeoutMs: 5000,
    });
    cleanups.push(async () => {
      host.cancel();
      await host.result;
    });
    await expect(host.ready).rejects.toThrow("JOB_HOST_NOT_READY");
    const observed = await host.result;
    expect(observed, JSON.stringify({ observed, stderr: launch.stderr })).toMatchObject({
      reason: scenario.taskDeadlineMs ? "deadline" : "host_failure",
      taskStarted: false,
    });
    expect(() => host.start()).toThrow("JOB_HOST_START_NOT_ALLOWED");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    if (scenario.delayMs > 30000) {
      expect(observed.diagnostic?.detail?.code).toBe("JOB_HOST_PREPARATION_TIMEOUT");
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(30000);
      expect(performance.now() - startedAt).toBeLessThan(36000);
    } else if (scenario.failImport || scenario.failContractsImport) {
      expect(observed).toMatchObject({
        diagnostic: { stage: "dependencies", systemCode: "EIO" },
        srtReset: false,
      });
    } else if (scenario.taskDeadlineMs) {
      expect(observed.diagnostic?.detail?.code).toBe("JOB_HOST_EXECUTION_DEADLINE");
    } else {
      expect(launch.stderr).toContain("JOB_HOST_WORKER_LEASE_INVALID");
    }
  },
  45000,
);
