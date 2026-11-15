import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  SANDBOX_HOST_FAILURE_CODES,
  type SandboxHostBinding,
  type SandboxJobControlBinding,
  type SandboxRuntimeQualification,
} from "@himawari-agent/execution-contracts";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createProductionSandboxControl } from "../../apps/agent-service/src/production-sandbox-control.ts";
import { expectTestRuntimeFile, installTestNodeRuntime } from "../fixtures/node-runtime.ts";
import { sandboxV2Admission, sandboxV2Call } from "../fixtures/sandbox-execution-v2-fixture.ts";
import { openSandboxJournal } from "../fixtures/sqlite-capability-invocation-fixture.ts";

const launch = vi.hoisted(() => ({
  hook: "",
  entry: "",
  stalePrepareMs: 0,
  runtimeFork: 0,
  stderr: "",
  events: [] as Record<string, unknown>[],
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    fork: (_file: string, args: string[], options: import("node:child_process").ForkOptions) => {
      const forkAt = Date.now();
      const child = actual.fork(launch.entry, args, {
        ...options,
        execArgv: ["--import", launch.hook],
      });
      launch.events.push({
        stage: "fork",
        at: forkAt,
        returnedAt: Date.now(),
        processId: child.pid,
        runtimeFork: ++launch.runtimeFork,
        entry: launch.entry,
      });
      child.on("message", (message: Record<string, unknown>) => {
        launch.events.push({
          stage: "host-message",
          at: Date.now(),
          processId: child.pid,
          type: message["type"],
          sequence: message["sequence"],
          observedAt: message["observedAt"],
          detail: message["detail"],
        });
      });
      const originalSend = child.send.bind(child);
      child.send = ((message: Record<string, unknown>, ...args: unknown[]) => {
        launch.events.push({
          stage: "worker-message",
          at: Date.now(),
          processId: child.pid,
          type: message["type"],
          sequence: message["sequence"],
          observedAt: message["observedAt"],
        });
        return Reflect.apply(originalSend, child, [message, ...args]);
      }) as typeof child.send;
      child.stderr?.on("data", (chunk: Buffer) => {
        launch.stderr += chunk.toString();
      });
      if (launch.stalePrepareMs) {
        const send = child.send.bind(child);
        child.send = ((message: Record<string, unknown>, ...args: unknown[]) =>
          Reflect.apply(send, child, [
            message["type"] === "prepare"
              ? {
                  ...message,
                  observedAt: new Date(Date.now() - launch.stalePrepareMs).toISOString(),
                }
              : message,
            ...args,
          ])) as typeof child.send;
      }
      return child;
    },
  };
});

import { resolveReadOnlyToolchainPaths } from "@himawari-agent/testing/read-only-toolchain";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";
import { prepareSandboxJobHost } from "../../packages/runtime-sandbox/src/job-host.ts";
import { readJobHostFinalEvidence } from "../../packages/runtime-sandbox/src/job-host-control.ts";
import {
  gatewayJobHostControlAccess,
  type JobHostControlAccess,
  localJobHostControlAccess,
} from "../../packages/runtime-sandbox/src/job-host-control-access.ts";
import { serveJobHostGateway } from "../../packages/runtime-sandbox/src/job-host-gateway.ts";
import {
  gatewayJobHostLauncher,
  type JobHostLauncher,
} from "../../packages/runtime-sandbox/src/job-host-transport.ts";
import { prepareJobPolicy } from "../../packages/runtime-sandbox/src/job-policy.ts";

const cleanups: Array<() => Promise<unknown>> = [];
let runtimeRoot = path.resolve("dist/node-runtime");
let installation: Awaited<ReturnType<typeof installTestNodeRuntime>> | undefined;
beforeAll(async () => {
  installation = await installTestNodeRuntime();
  runtimeRoot = installation.runtimeRoot;
}, 240_000);
afterAll(async () => {
  await installation?.close();
});
const jobHostEntry = () =>
  path.join(runtimeRoot, "node_modules/@himawari-agent/runtime-sandbox/dist/job-host-main.js");
afterEach(async (context) => {
  for (const close of cleanups.splice(0).reverse()) await close();
  const timeline = {
    testName: context.task.name,
    state: context.task.result?.state,
    capturedAt: Date.now(),
    runtimeRoot: launch.entry ? path.resolve(path.dirname(launch.entry), "../../../..") : null,
    artifactRequested: Boolean(process.env["HIMAWARI_TEST_ARTIFACT"]),
    stderr: launch.stderr,
    events: [...launch.events],
  };
  Object.assign(context.task.meta, { jobHostStartup: timeline });
  const output = process.env["HIMAWARI_TEST_DIAGNOSTIC_OUTPUT"];
  if (output) {
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(output, `host-startup-${context.task.id}.json`),
      JSON.stringify(timeline),
      {
        mode: 0o600,
        flag: "wx",
      },
    );
  }
  launch.stalePrepareMs = 0;
  launch.stderr = "";
  launch.events.length = 0;
});

function jobHostDiagnostics() {
  if (!process.env["HIMAWARI_TEST_DIAGNOSTIC_OUTPUT"]) return "";
  return `import childProcess from "node:child_process";
import { syncBuiltinESMExports as synchronizeBuiltins } from "node:module";
const trace = (stage, details = {}) => process.stderr.write(JSON.stringify({ stage, at: Date.now(), processId: process.pid, ...details }) + "\\n");
trace("preload.entered");
const on = process.on;
process.on = function (event, listener) {
  if (event !== "message") return Reflect.apply(on, this, [event, listener]);
  let firstMessage = true;
  const result = Reflect.apply(on, this, [event, function (message, ...args) {
    trace(firstMessage ? "ipc.first_message" : "ipc.message", {
      type: message?.type,
      sequence: message?.sequence,
      observedAt: message?.observedAt,
    });
    firstMessage = false;
    return Reflect.apply(listener, this, [message, ...args]);
  }]);
  trace("ipc.handler_registered");
  return result;
};
let nextCallId = 0;
for (const method of ["spawnSync", "execSync"]) {
  const execute = childProcess[method];
  childProcess[method] = function (...args) {
    const callId = ++nextCallId;
    const startedAt = Date.now();
    const started = performance.now();
    const command = args[0];
    const commandArguments = Array.isArray(args[1]) ? args[1] : [];
    trace("sync_command.started", { callId, method, command, commandArguments, startedAt });
    try {
      return Reflect.apply(execute, this, args);
    } finally {
      trace("sync_command.finished", { callId, method, command, commandArguments, startedAt, finishedAt: Date.now(), elapsedMs: performance.now() - started });
    }
  };
}
synchronizeBuiltins();
let previousTick = performance.now();
let previousTickAt = Date.now();
let maximumGap = { elapsedMs: 0, startedAt: previousTickAt, finishedAt: previousTickAt };
setInterval(() => {
  const tick = performance.now();
  const at = Date.now();
  const elapsedMs = tick - previousTick;
  if (elapsedMs > maximumGap.elapsedMs) {
    maximumGap = { elapsedMs, startedAt: previousTickAt, finishedAt: at };
    trace("event_loop.max_gap", maximumGap);
  }
  previousTick = tick;
  previousTickAt = at;
}, 10).unref();
process.once("exit", () => trace("event_loop.summary", maximumGap));
const send = process.send;
if (send) process.send = function (message, ...args) {
  if (message && typeof message === "object" && message.type === "heartbeat")
    trace("host_heartbeat_sent", { sequence: message.sequence, observedAt: message.observedAt });
  return Reflect.apply(send, this, [message, ...args]);
};
`;
}

function jobHostEntryLoadDiagnostics() {
  if (!process.env["HIMAWARI_TEST_DIAGNOSTIC_OUTPUT"]) return { before: "", after: "" };
  const entry = JSON.stringify(pathToFileURL(launch.entry).href);
  const firstStatement = `process.stderr.write(JSON.stringify({ stage: "job_host_main.entered", at: Date.now(), processId: process.pid, entry: ${entry} }) + "\\n");\n`;
  return {
    before: `const entryLoadStartedAt = Date.now();
  if (url === ${entry}) process.stderr.write(JSON.stringify({ stage: "job_host_main.load_started", at: entryLoadStartedAt, processId: process.pid, url }) + "\\n");`,
    after: `if (url === ${entry}) {
    process.stderr.write(JSON.stringify({ stage: "job_host_main.load_finished", at: Date.now(), processId: process.pid, url, startedAt: entryLoadStartedAt }) + "\\n");
    return { ...loaded, source: ${JSON.stringify(firstStatement)} + loaded.source.toString() };
  }`,
  };
}

function launchReplacement(options: { launchCommand?: string; gateDelaySeconds?: number }) {
  if (options.launchCommand)
    return `command = ${JSON.stringify(options.launchCommand)}; process.stderr.write(JSON.stringify({ stage: "r2t10_launch_command", command }) + "\\n"); `;
  if (options.gateDelaySeconds)
    return `command = "/usr/bin/sleep ${options.gateDelaySeconds}; " + command; `;
  return null;
}

async function configureSdkLoad(
  root: string,
  options: {
    delayMs: number;
    failImport?: boolean;
    failContractsImport?: boolean;
    failInitialize?: boolean;
    blockInitializeMs?: number;
    blockDependenciesMs?: number;
    blockModuleMs?: number;
    blockContractsImportMs?: number;
    blockEntryMs?: number;
    changePolicyText?: boolean;
    launchCommand?: string;
    gateDelaySeconds?: number;
  },
) {
  if (options.launchCommand && options.gateDelaySeconds)
    throw new Error("FIXTURE_LAUNCH_COMMAND_AND_GATE_DELAY_EXCLUSIVE");
  launch.entry = jobHostEntry();
  launch.hook = path.join(root, "preload.mjs");
  const loader = path.join(root, "loader.mjs");
  const entryDiagnostics = jobHostEntryLoadDiagnostics();
  const injectionDetails = process.env["HIMAWARI_TEST_DIAGNOSTIC_OUTPUT"]
    ? {
        expectedRuntimeRoot: path.resolve(path.dirname(launch.entry), "../../../.."),
        failImport: Boolean(options.failImport),
      }
    : {};
  await writeFile(
    launch.hook,
    `${jobHostDiagnostics()}
import { register } from "node:module";
import threads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
const SdkWorker = threads.Worker;
threads.Worker = class extends SdkWorker {
  constructor(filename, options) {
    super(filename, String(filename).endsWith("/sandbox-sdk-worker.js")
      ? { ...options, execArgv: [...(options?.execArgv ?? []), "--import", import.meta.url] }
      : options);
  }
};
syncBuiltinESMExports();
register(${JSON.stringify(pathToFileURL(loader).href)});
`,
  );
  await writeFile(
    loader,
    `export async function load(url, context, nextLoad) {
  ${entryDiagnostics.before}
  if (${Boolean(options.failContractsImport)} && url.endsWith("/@himawari-agent/execution-contracts/dist/index.js")) {
    ${process.env["HIMAWARI_TEST_DIAGNOSTIC_OUTPUT"] ? 'process.stderr.write(JSON.stringify({ stage: "contracts_import_failure.injected", at: Date.now(), processId: process.pid, url }) + "\\n");' : ""}
    throw Object.assign(new Error("JOB_HOST_TEST_CONTRACTS_IMPORT_FAILURE"), { code: "EIO" });
  }
  const loaded = await nextLoad(url, context);
  if (${JSON.stringify(launchReplacement(options))} !== null && url.endsWith("/runtime-sandbox/dist/job-host-main.js")) {
    const original = loaded.source.toString();
    const declaration = "    const command = namespaceGate\\n";
    const wrap = 'const wrapping = launch.manager.wrapWithSandboxArgv(command, "/bin/bash");';
    if (original.split(declaration).length !== 2 || original.split(wrap).length !== 2)
      throw new Error("LAUNCH_COMMAND_INJECTION_MISSED");
    return {
      ...loaded,
      source: original
        .replace(declaration, "    let command = namespaceGate\\n")
        .replace(wrap, ${JSON.stringify(launchReplacement(options))} + wrap),
    };
  }
  if (${Boolean(options.blockEntryMs)} && url === ${JSON.stringify(pathToFileURL(launch.entry).href)})
    return { ...loaded, source: ${JSON.stringify(
      `process.stderr.write(JSON.stringify({ stage: "ENTRY_STALL_STARTED", at: Date.now() }) + "\\n");
const himawariFixtureEntryUntil = performance.now() + ${options.blockEntryMs ?? 0};
while (performance.now() < himawariFixtureEntryUntil) {}
process.stderr.write(JSON.stringify({ stage: "ENTRY_STALL_FINISHED", at: Date.now() }) + "\\n");
`,
    )} + loaded.source.toString() };
  ${entryDiagnostics.after}
  if (${Boolean(options.blockContractsImportMs)} && url.endsWith("/@himawari-agent/execution-contracts/dist/index.js"))
    return { ...loaded, source: ${JSON.stringify(
      `const himawariFixtureContractsUntil = performance.now() + ${options.blockContractsImportMs ?? 0};
while (performance.now() < himawariFixtureContractsUntil) {}
`,
    )} + loaded.source.toString() };
  if (${Boolean(options.changePolicyText)} && url.endsWith("/runtime-sandbox/dist/policy.js")) {
    const original = loaded.source.toString();
    const changed = original.replace("const policyJson = JSON.stringify(policy);", 'const policyJson = JSON.stringify(policy) + " "; process.stderr.write(JSON.stringify({ stage: "POLICY_TEXT_CHANGED" }) + "\\\\n");');
    if (changed === original) throw new Error("POLICY_TEXT_INJECTION_MISSED");
    return { ...loaded, source: changed };
  }
  if (!url.endsWith("/sandbox/sandbox-manager.js")) return loaded;
  return { ...loaded, source: ${JSON.stringify(
    `import { threadId as himawariSdkThreadId } from "node:worker_threads";
const himawariFixtureTrace = (stage) => { if (${Boolean(process.env["HIMAWARI_TEST_DIAGNOSTIC_OUTPUT"])}) process.stderr.write(JSON.stringify({ stage, at: Date.now(), processId: process.pid, threadId: himawariSdkThreadId, ...${JSON.stringify(injectionDetails)}, moduleUrl: import.meta.url }) + "\\n"); };
himawariFixtureTrace("sdk_module_entered");
${
  options.blockModuleMs
    ? `process.stderr.write(JSON.stringify({ stage: "SDK_MODULE_STALL_STARTED", threadId: himawariSdkThreadId }) + "\\n");
const himawariFixtureModuleUntil = performance.now() + ${options.blockModuleMs};
while (performance.now() < himawariFixtureModuleUntil) {}
process.stderr.write(JSON.stringify({ stage: "SDK_MODULE_STALL_FINISHED", threadId: himawariSdkThreadId }) + "\\n");
`
    : ""
}await new Promise((resolve) => setTimeout(resolve, ${options.delayMs}));
himawariFixtureTrace("sdk_module_delay_finished");
` +
      (options.failImport
        ? 'himawariFixtureTrace("sdk_import_failure.injected");\nthrow Object.assign(new Error("JOB_HOST_TEST_IMPORT_FAILURE"), { code: "EIO" });\n'
        : ""),
  )} + loaded.source.toString() + ${JSON.stringify(
    (options.blockDependenciesMs
      ? `\nconst himawariFixtureDependencies = SandboxManager.checkDependenciesAsync;
SandboxManager.checkDependenciesAsync = async (...args) => {
  process.stderr.write(JSON.stringify({ stage: "SDK_SYNCHRONOUS_STALL_STARTED", threadId: himawariSdkThreadId }) + "\\n");
  const until = performance.now() + ${options.blockDependenciesMs};
  while (performance.now() < until) {}
  process.stderr.write(JSON.stringify({ stage: "SDK_SYNCHRONOUS_STALL_FINISHED", threadId: himawariSdkThreadId }) + "\\n");
  return himawariFixtureDependencies(...args);
};\n`
      : "") +
      (options.failInitialize
        ? '\nSandboxManager.initialize = async () => { throw Object.assign(new Error("JOB_HOST_TEST_PREPARATION_FAILURE"), { code: "EIO" }); };\n'
        : options.blockInitializeMs
          ? `\nconst himawariFixtureInitialize = SandboxManager.initialize;
SandboxManager.initialize = async (...args) => {
  himawariFixtureTrace("sdk_initialize_entered");
  process.stderr.write(JSON.stringify({ stage: "SDK_SYNCHRONOUS_STALL_STARTED", threadId: himawariSdkThreadId }) + "\\n");
  const until = performance.now() + ${options.blockInitializeMs};
  while (performance.now() < until) {}
  himawariFixtureTrace("sdk_synchronous_delay_finished");
  process.stderr.write(JSON.stringify({ stage: "SDK_SYNCHRONOUS_STALL_FINISHED", threadId: himawariSdkThreadId }) + "\\n");
  const result = await himawariFixtureInitialize(...args);
  himawariFixtureTrace("sdk_initialize_finished");
  return result;
};\n`
          : "") +
      "",
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

it.for(["local", "gateway"] as const)(
  "[R2-L8] proves release when preparation fails before the control step after launch was claimed (%s)",
  async (route, context) => {
    const f = await openSandboxJournal();
    cleanups.push(f.close);
    const root = await realpath(await mkdtemp(`${testTemporaryRoot()}/hma-prep-`));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await configureSdkLoad(root, { delayMs: 0, changePolicyText: true });
    const { access, launcher } = await controlRoute(route, root);
    const prepared = await access.prepareDirectory(`control-${"0".repeat(20)}`);
    const directory = prepared.directory;
    const plan = {
      ...sandboxV2Call(f, "admit", sandboxV2Admission(f)).record.plan,
      backendRef: "srt",
      preparationProtocol: "launch-or-block.v2" as const,
    };
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
      jobHostControl: access,
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
    expect(
      await access.claimLaunch({
        plan,
        control,
        policyDigest: compiled.policyDigest,
        directoryDevice: prepared.device,
        directoryInode: prepared.inode,
      }),
    ).toBe(true);
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
      launcher,
    );
    cleanups.push(async () => {
      host.cancel();
      await host.result;
    });
    await expect(host.ready).rejects.toThrow();
    const observed = await host.result;
    expect(launch.stderr).toContain("POLICY_TEXT_CHANGED");
    expect(observed, JSON.stringify({ observed, stderr: launch.stderr })).toMatchObject({
      reason: "host_failure",
      diagnostic: { stage: "policy", detail: { code: "JOB_HOST_POLICY_CHANGED" } },
      taskStarted: false,
      srtReset: true,
    });
    const stopRequestedAt = options.now();
    const restarted = createProductionSandboxControl(options);
    await restarted.stopPreparation(plan, undefined, stopRequestedAt);
    const release = await restarted.verifyReservationRelease(plan, stopRequestedAt);
    expect(release, JSON.stringify([...stored.keys()])).toMatchObject({
      basis: "host_never_started",
      identity: plan.identity,
      controlSessionId: control.sessionId,
    });
    expect(await access.readFinalEvidence(control)).toMatchObject({
      phase: "finished",
      taskStarted: false,
      srtReset: true,
    });
    Object.assign(context.task.meta, { cleanupReadback: { observed, release } });
  },
);

async function controlRoute(
  route: "local" | "gateway",
  root: string,
): Promise<{ access: JobHostControlAccess; launcher: JobHostLauncher | undefined }> {
  if (route === "local") return { access: localJobHostControlAccess(root), launcher: undefined };
  const gatewayServer = createServer();
  serveJobHostGateway(gatewayServer, {
    idleExitMs: 60000,
    onIdle: () => {},
    controlRoot: root,
  });
  const socketPath = path.join(root, "gateway.sock");
  await new Promise<void>((resolve) => gatewayServer.listen(socketPath, resolve));
  cleanups.push(() => new Promise<void>((resolve) => gatewayServer.close(() => resolve())));
  return {
    access: gatewayJobHostControlAccess(socketPath),
    launcher: gatewayJobHostLauncher(socketPath),
  };
}

it.for(["local", "gateway"] as const)(
  "blocks an unclaimed launch and proves release from the signed block decision (%s)",
  async (route) => {
    const f = await openSandboxJournal();
    cleanups.push(f.close);
    const root = await realpath(await mkdtemp(`${testTemporaryRoot()}/hma-prep-`));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const { access } = await controlRoute(route, root);
    const prepared = await access.prepareDirectory(`control-${"0".repeat(20)}`);
    const plan = {
      ...sandboxV2Call(f, "admit", sandboxV2Admission(f)).record.plan,
      backendRef: "srt",
      preparationProtocol: "launch-or-block.v2" as const,
    };
    const control: SandboxJobControlBinding = {
      directory: prepared.directory,
      token: randomBytes(32).toString("hex"),
      sessionId: randomUUID(),
      jobId: plan.identity.jobId,
      attemptId: plan.identity.attemptId,
    };
    const policyDigest = "e".repeat(64);
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
      jobHostControl: access,
      now: () => new Date().toISOString(),
      machineBootId: async () => "machine-boot",
      host: hostInfo,
      admit: hostInfo,
      read: async (_plan: unknown, key: string) => stored.get(key),
      write: async (_plan: unknown, key: string, value: unknown) => {
        if (stored.has(key)) throw new Error("duplicate artifact");
        const artifact = {
          ref: key,
          digest: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
          value: structuredClone(value),
        };
        stored.set(key, artifact);
        return artifact;
      },
    };
    const launchContext = {
      plan,
      control,
      policyDigest,
      directoryDevice: prepared.device,
      directoryInode: prepared.inode,
    };
    await createProductionSandboxControl(options).registerPreparation(plan, control, policyDigest);
    expect(await access.readLaunchDecision(launchContext)).toBeUndefined();
    const stopRequestedAt = options.now();
    const restarted = createProductionSandboxControl(options);
    await restarted.stopPreparation(plan, undefined, stopRequestedAt);
    expect(await access.readLaunchDecision(launchContext)).toMatchObject({
      decision: { kind: "blocked", stopRequestedAt },
    });
    expect(await access.claimLaunch(launchContext)).toBe(false);
    expect(await restarted.verifyReservationRelease(plan, stopRequestedAt)).toMatchObject({
      basis: "preparation_launch_blocked",
      identity: plan.identity,
    });
  },
);

async function r2t10Host(input: {
  readonly jobId: string;
  readonly launchCommand?: string;
  readonly gateDelaySeconds?: number;
}) {
  const root = await realpath(await mkdtemp(`${testTemporaryRoot()}/hma-r2t10-`));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await configureSdkLoad(root, {
    delayMs: 0,
    ...(input.launchCommand ? { launchCommand: input.launchCommand } : {}),
    ...(input.gateDelaySeconds ? { gateDelaySeconds: input.gateDelaySeconds } : {}),
  });
  const toolchain = await resolveReadOnlyToolchainPaths([
    "/bin",
    "/usr/bin",
    "/usr/lib",
    "/lib",
    "/lib64",
    "/proc",
    "/dev",
    path.dirname(process.execPath),
    path.join(runtimeRoot, "node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp"),
  ]);
  const { policy, compiled } = await prepareJobPolicy({
    workspace: null,
    privateRoot: root,
    jobId: input.jobId,
    writable: false,
    readOnlyToolchainPaths: toolchain,
    protectedPaths: [],
    allowedDomains: [],
  });
  const directory = path.join(root, "control");
  await mkdir(directory, { mode: 0o700 });
  const host = prepareSandboxJobHost(
    {
      jobId: input.jobId,
      attemptId: "original-attempt",
      policy,
      policyDigest: compiled.policyDigest,
      executable: process.execPath,
      args: ["-e", "process.exit(99)"],
      deadlineAt: new Date(Date.now() + 30000).toISOString(),
      maxOutputBytes: 4096,
      cleanupTimeoutMs: 5000,
    },
    directory,
  );
  cleanups.push(async () => {
    host.cancel();
    await host.result;
  });
  await host.ready;
  host.start();
  return { host, directory, observed: await host.result };
}

it("[R2-T10] reproduces a sandbox that never releases the user command", async (context) => {
  const { host, directory, observed } = await r2t10Host({
    jobId: "r2t10-never-started",
    launchCommand: "printf 'r2t10-gate-marker\\n' >&2; /usr/bin/sleep 3600",
  });
  Object.assign(context.task.meta, {
    r2t10Reproduction: {
      reason: observed.reason,
      exitCode: observed.exitCode,
      taskStarted: observed.taskStarted,
      taskProcessExited: observed.taskProcessExited,
      stdioClosed: observed.stdioClosed,
      srtReset: observed.srtReset,
      taskTreeCleanup: observed.taskTreeCleanup,
      diagnostic: observed.diagnostic ?? null,
    },
  });
  expect(observed, `${JSON.stringify(observed)}\nSTDERR:\n${launch.stderr}`).toMatchObject({
    reason: "host_failure",
    exitCode: null,
    taskStarted: false,
  });
  console.info(
    JSON.stringify({ event: "r2t10-host-diagnostic", diagnostic: observed.diagnostic ?? null }),
  );
  expect(observed.diagnostic, JSON.stringify(observed.diagnostic)).toMatchObject({
    stage: "launch",
    detail: { code: "JOB_HOST_NAMESPACE_GATE_TIMEOUT" },
  });
  expect(observed.diagnostic?.systemCode).toBe("UNKNOWN");
  const text = observed.diagnostic?.detail?.text ?? "";
  expect(text).toContain("r2t10-gate-marker");
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(512);
  expect(text).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  if (!host.controlBinding) throw new Error("Original control binding missing");
  const final = await readJobHostFinalEvidence(host.controlBinding);
  Object.assign(context.task.meta, {
    r2t10FinalEvidence: {
      phase: final.phase,
      taskStarted: final.taskStarted,
      srtReset: final.srtReset,
    },
  });
  expect(final).toMatchObject({ phase: "finished", taskStarted: false, srtReset: true });
  await expect(readFile(path.join(directory, "started.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("[R2-D27] starts the user command when the namespace gate answers after 2.5 seconds", async () => {
  const { host, observed } = await r2t10Host({
    jobId: "r2d27-slow-gate",
    gateDelaySeconds: 2.5,
  });
  expect(observed, `${JSON.stringify(observed)}\nSTDERR:\n${launch.stderr}`).toMatchObject({
    reason: "exited",
    exitCode: 99,
    taskStarted: true,
    srtReset: true,
  });
  expect(observed.diagnostic ?? null).toBeNull();
  if (!host.controlBinding) throw new Error("Original control binding missing");
  const final = await readJobHostFinalEvidence(host.controlBinding);
  expect(final.linuxNamespace?.namespaceId).toMatch(/^pid:\[\d+\]$/);
});

it("[R2-T10] classifies an oversized namespace gate as JOB_HOST_NAMESPACE_GATE_INVALID", async () => {
  const { observed } = await r2t10Host({
    jobId: "r2t10-gate-invalid",
    launchCommand: "for i in {1..300}; do echo xxxxxxxxxxxxxxxxxxxx >&2; done; /usr/bin/sleep 3600",
  });
  expect(observed, `${JSON.stringify(observed)}\nSTDERR:\n${launch.stderr}`).toMatchObject({
    reason: "host_failure",
    exitCode: null,
    taskStarted: false,
    diagnostic: { stage: "launch", detail: { code: "JOB_HOST_NAMESPACE_GATE_INVALID" } },
  });
});

it("[R2-T10] declares the three launch failure codes", () => {
  expect([...SANDBOX_HOST_FAILURE_CODES]).toEqual(
    expect.arrayContaining([
      "JOB_HOST_NAMESPACE_GATE_TIMEOUT",
      "JOB_HOST_LAUNCH_SPAWN_FAILED",
      "JOB_HOST_NAMESPACE_GATE_INVALID",
    ]),
  );
});

it("[R2-T10] records whether a normal launch also prints the .bashrc permission line", async () => {
  const { observed } = await r2t10Host({ jobId: "r2t10-normal" });
  console.info(
    JSON.stringify({
      event: "r2t10-normal-launch",
      reason: observed.reason,
      exitCode: observed.exitCode,
      taskStarted: observed.taskStarted,
      hasBashrc: launch.stderr.includes(".bashrc"),
      jobHostStderr: launch.stderr.slice(0, 800),
      taskStderr: Buffer.from(observed.stderr).toString("utf8").slice(0, 1500),
    }),
  );
  expect(observed.taskStarted).toBe(true);
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

it.each(["dependencies", "initialize"] as const)(
  "[R2-D13] keeps the original lease during a synchronous SDK %s stall",
  async (stage) => {
    const root = await realpath(await mkdtemp(`${testTemporaryRoot()}/hma-prep-`));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await configureSdkLoad(root, {
      delayMs: 0,
      ...(stage === "dependencies" ? { blockDependenciesMs: 2200 } : { blockInitializeMs: 2200 }),
    });
    const marker = path.join(root, "user-task-started");
    const { policy, compiled } = await prepareJobPolicy({
      workspace: null,
      privateRoot: root,
      jobId: `synchronous-${stage}`,
      writable: false,
      readOnlyToolchainPaths: [],
      protectedPaths: [],
      allowedDomains: [],
    });
    const host = prepareSandboxJobHost({
      jobId: `synchronous-${stage}`,
      attemptId: "original-attempt",
      policy,
      policyDigest: compiled.policyDigest,
      executable: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`],
      deadlineAt: new Date(Date.now() + 30000).toISOString(),
      maxOutputBytes: 4096,
      cleanupTimeoutMs: 5000,
    });
    cleanups.push(async () => {
      host.cancel();
      await host.result;
    });
    let preparationError: unknown;
    await host.ready.catch((error: unknown) => {
      preparationError = error;
    });
    const preparedState = host.inspect()?.state;
    host.cancel();
    const observed = await host.result;
    launch.events.push({ stage: "preparation-readback", observed });
    expect(launch.stderr).toContain("SDK_SYNCHRONOUS_STALL_STARTED");
    expect(launch.stderr).toContain("SDK_SYNCHRONOUS_STALL_FINISHED");
    const stalls = launch.stderr
      .split("\n")
      .filter((line) => line.startsWith("{") && line.includes("SDK_SYNCHRONOUS_STALL_"))
      .map((line) => JSON.parse(line) as { threadId: number });
    expect(stalls).toHaveLength(2);
    expect(stalls.every((entry) => entry.threadId > 0)).toBe(true);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(observed, JSON.stringify(observed)).toMatchObject({
      taskStarted: false,
      srtReset: true,
    });
    expect(observed.diagnostic?.detail?.code).not.toBe("JOB_HOST_HEARTBEAT_EXPIRED");
    expect(preparationError).toBeUndefined();
    expect(preparedState).toBe("alive");
  },
);

async function prepareStalledHost(root: string, jobId: string) {
  const { policy, compiled } = await prepareJobPolicy({
    workspace: null,
    privateRoot: root,
    jobId,
    writable: false,
    readOnlyToolchainPaths: [],
    protectedPaths: [],
    allowedDomains: [],
  });
  const host = prepareSandboxJobHost({
    jobId,
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
  let preparationError: unknown;
  await host.ready.catch((error: unknown) => {
    preparationError = error;
  });
  const preparedState = host.inspect()?.state;
  host.cancel();
  const observed = await host.result;
  launch.events.push({ stage: "preparation-readback", observed });
  return { observed, preparationError, preparedState };
}

it("[R2-L7] keeps the original lease while the sandbox library loads slowly", async () => {
  const root = await realpath(await mkdtemp(`${testTemporaryRoot()}/hma-prep-`));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await configureSdkLoad(root, { delayMs: 0, blockModuleMs: 2200 });
  const { observed, preparationError, preparedState } = await prepareStalledHost(
    root,
    "slow-library-load",
  );
  expect(observed.diagnostic?.detail?.code, JSON.stringify(observed)).not.toBe(
    "JOB_HOST_HEARTBEAT_EXPIRED",
  );
  const stalls = launch.stderr
    .split("\n")
    .filter((line) => line.startsWith("{") && line.includes("SDK_MODULE_STALL_"))
    .map((line) => JSON.parse(line) as { stage: string; threadId: number });
  expect(stalls.map((entry) => entry.stage)).toEqual([
    "SDK_MODULE_STALL_STARTED",
    "SDK_MODULE_STALL_FINISHED",
  ]);
  expect(
    stalls.every((entry) => entry.threadId > 0),
    JSON.stringify(stalls),
  ).toBe(true);
  expect(preparationError).toBeUndefined();
  expect(preparedState).toBe("alive");
  expect(observed).toMatchObject({ taskStarted: false, srtReset: true });
});

it("[R2-D23] waits for a Job Host whose own startup takes longer than the lease window", async () => {
  const root = await realpath(await mkdtemp(`${testTemporaryRoot()}/hma-prep-`));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await configureSdkLoad(root, { delayMs: 0, blockEntryMs: 2200 });
  const { observed, preparationError, preparedState } = await prepareStalledHost(
    root,
    "slow-host-startup",
  );
  const stalls = launch.stderr
    .split("\n")
    .filter((line) => line.startsWith("{") && line.includes("ENTRY_STALL_"))
    .map((line) => JSON.parse(line) as { stage: string });
  expect(stalls.map((entry) => entry.stage)).toEqual([
    "ENTRY_STALL_STARTED",
    "ENTRY_STALL_FINISHED",
  ]);
  expect(preparationError, JSON.stringify(observed)).toBeUndefined();
  expect(preparedState).toBe("alive");
  expect(observed).toMatchObject({ taskStarted: false, srtReset: true });
  const first = launch.events.find((event) => event["stage"] === "host-message");
  const queuedHeartbeats = launch.events.filter(
    (event) =>
      event["stage"] === "worker-message" &&
      event["type"] === "heartbeat" &&
      Number(event["at"]) < Number(first?.["at"]),
  );
  expect(queuedHeartbeats, JSON.stringify(launch.events)).toEqual([]);
});

it("[R2-D23] accepts the first prepare after it waited two seconds for the Job Host", async () => {
  const root = await realpath(await mkdtemp(`${testTemporaryRoot()}/hma-prep-`));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await configureSdkLoad(root, { delayMs: 0 });
  launch.stalePrepareMs = 2000;
  const { observed, preparationError, preparedState } = await prepareStalledHost(
    root,
    "waited-prepare",
  );
  expect(preparationError, JSON.stringify({ observed, stderr: launch.stderr })).toBeUndefined();
  expect(preparedState).toBe("alive");
  expect(observed).toMatchObject({ taskStarted: false, srtReset: true });
  expect(launch.stderr).not.toContain("JOB_HOST_WORKER_LEASE_INVALID");
});

it("[R2-L7] records the preparation step that was running when the Job Host went silent", async () => {
  const root = await realpath(await mkdtemp(`${testTemporaryRoot()}/hma-prep-`));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await configureSdkLoad(root, { delayMs: 0, blockContractsImportMs: 2200 });
  const { observed, preparationError } = await prepareStalledHost(root, "silent-step");
  expect(preparationError).toBeInstanceOf(Error);
  expect(observed.taskStarted).toBe(false);
  expect(observed.diagnostic, JSON.stringify(observed)).toMatchObject({
    stage: "dependencies",
    detail: { code: "JOB_HOST_HEARTBEAT_EXPIRED", phase: "preparing" },
  });
  const steps = observed.diagnostic?.detail?.steps;
  expect(steps, JSON.stringify(observed)).toEqual([
    { stage: "dependencies", startedMs: expect.any(Number), elapsedMs: null },
  ]);
  expect(steps?.[0]?.startedMs).toBeGreaterThanOrEqual(0);
});

it("[R2-D16] reads the configured Job Host entry from the selected runtime", async () => {
  const root = await realpath(await mkdtemp(`${testTemporaryRoot()}/hma-prep-`));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await configureSdkLoad(root, { delayMs: 0 });
  await expectTestRuntimeFile(launch.entry);
});

it("prepares with the packaged Java agent when global npm discovery would block heartbeats", async () => {
  const root = await realpath(await mkdtemp(`${testTemporaryRoot()}/hma-prep-`));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  launch.entry = jobHostEntry();
  launch.hook = path.join(root, "slow-global-npm.mjs");
  const discovery = path.join(root, "discovery.txt");
  const entryDiagnostics = jobHostEntryLoadDiagnostics();
  const entryLoader = path.join(root, "entry-diagnostics.mjs");
  if (entryDiagnostics.before)
    await writeFile(
      entryLoader,
      `export async function load(url, context, nextLoad) {
  ${entryDiagnostics.before}
  const loaded = await nextLoad(url, context);
  ${entryDiagnostics.after}
  return loaded;
}\n`,
    );
  await writeFile(
    launch.hook,
    `${jobHostDiagnostics()}
${entryDiagnostics.before ? `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(entryLoader).href)});` : ""}
import cp from "node:child_process";
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
  { name: "preparation deadline", delayMs: 31000, failImport: false, stalePrepareMs: 0 },
  { name: "import failure", delayMs: 0, failImport: true, stalePrepareMs: 0 },
  {
    name: "contracts import failure",
    delayMs: 0,
    failImport: false,
    failContractsImport: true,
    stalePrepareMs: 0,
  },
  {
    name: "task deadline during import",
    delayMs: 2500,
    failImport: false,
    stalePrepareMs: 0,
    taskDeadlineMs: 1000,
  },
  { name: "already stale prepare", delayMs: 0, failImport: false, stalePrepareMs: 11000 },
])(
  "rejects $name without starting the user task",
  async (scenario) => {
    const root = await realpath(await mkdtemp(`${testTemporaryRoot()}/hma-prep-`));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await configureSdkLoad(root, scenario);
    launch.stalePrepareMs = scenario.stalePrepareMs;
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
