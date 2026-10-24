import "../fixtures/r2p2-entry-live-sandbox-probe.ts";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type ExecutionEnvironmentLifecyclePort,
  type ExecutionEnvironmentLocator,
  type ExecutionEnvironmentStopProof,
  type HostFileOperationKind,
  hostDirectoryGrantStateKey,
  type HostDirectoryGrant,
  RemoteExecutionBackend,
  type RuntimeToolInvocation,
} from "@himawari-agent/application";
import { createIdempotencyKey } from "@himawari-agent/domain";
import {
  type ExecutionV2Event,
  type ExecutionV2Request,
  PI_PREPARED_FILE_CONTRACT,
  PI_RUNNER_CONTRACT,
  PI_WRITE_VERIFIER,
  sandboxScopeSchema,
  SRT_TASK_ENVIRONMENT_BACKEND_REF,
  SRT_TASK_ENVIRONMENT_GUARANTEES,
  type SandboxHostBinding,
  type SandboxOperationBinding,
} from "@himawari-agent/execution-contracts";
import { resolveSandboxWorkspaceClaim } from "@himawari-agent/platform-node";
import {
  type JobHostRequest,
  JobHostPreparationError,
  type SandboxJobSession,
  prepareSandboxJobSession,
} from "@himawari-agent/runtime-sandbox";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";
import Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductionPayloadBrokerClient } from "../../apps/execution-worker/src/production-payload-broker-client.ts";
import {
  SrtTaskEnvironmentBackend,
  srtTaskEnvironmentJobId,
} from "../../apps/execution-worker/src/production-srt-task-environment-backend.ts";
import { ProductionRuntimeTools } from "../../apps/agent-service/src/production-runtime-tools.ts";
import { createProductionWorkerParentBindingRegistry } from "../../apps/agent-service/src/production-worker-parent-binding-registry.ts";
import { productionSandboxScope } from "../fixtures/production-sandbox-scope.ts";
import { queuedLiveWorker } from "../fixtures/queued-live-worker.ts";
import {
  AGENT_ID,
  OWNER_ID,
  RUN_ID,
  SERVICE_AUTHORITY,
  T1,
  T2,
  serviceRequest,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

vi.setConfig({ testTimeout: 180000, hookTimeout: 60000 });

const forkState = vi.hoisted(() => ({ children: [] as ChildProcess[], stderr: "" }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    fork: (...args: Parameters<typeof actual.fork>) => {
      const child = actual.fork(...args);
      forkState.stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        forkState.stderr += chunk.toString();
      });
      forkState.children.push(child);
      return child;
    },
  };
});

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const bashBinding: SandboxOperationBinding = {
  operation: "bash",
  mode: "foreground",
  contract: { ...PI_RUNNER_CONTRACT, kind: "command" },
  backendRef: "srt",
  scopeSource: "grant_targets",
  directoryOperations: ["read"],
  network: "disabled",
};

const bashWriteBinding: SandboxOperationBinding = {
  ...bashBinding,
  directoryOperations: ["read", "create", "update", "move", "trash", "restore", "permanent_delete"],
};

const fullDirectoryOperations = [
  "read",
  "create",
  "update",
  "move",
  "trash",
  "restore",
  "permanent_delete",
] as const;

const writeBinding: SandboxOperationBinding = {
  operation: "write",
  mode: "foreground",
  contract: {
    ...PI_RUNNER_CONTRACT,
    kind: "verified_effect",
    verifierRef: PI_WRITE_VERIFIER.ref,
    verifierVersion: PI_WRITE_VERIFIER.version,
    targetRef: PI_WRITE_VERIFIER.targetRef,
  },
  backendRef: "srt",
  scopeSource: "grant_targets",
  directoryOperations: ["read", "create", "update"],
  network: "disabled",
};

const preparedWriteBinding: SandboxOperationBinding = {
  ...writeBinding,
  contract: {
    ...PI_PREPARED_FILE_CONTRACT,
    kind: "verified_effect",
    verifierRef: PI_WRITE_VERIFIER.ref,
    verifierVersion: PI_WRITE_VERIFIER.version,
    targetRef: PI_WRITE_VERIFIER.targetRef,
  },
};

const backgroundBashBinding: SandboxOperationBinding = {
  ...bashBinding,
  mode: "background",
  contract: { ...PI_RUNNER_CONTRACT, kind: "task_start" },
};

const networkBashBinding: SandboxOperationBinding = {
  ...bashBinding,
  network: "grant_targets",
};

const editBinding: SandboxOperationBinding = {
  operation: "edit",
  mode: "foreground",
  contract: {
    ...PI_RUNNER_CONTRACT,
    kind: "verified_effect",
    verifierRef: PI_WRITE_VERIFIER.ref,
    verifierVersion: PI_WRITE_VERIFIER.version,
    targetRef: PI_WRITE_VERIFIER.targetRef,
  },
  backendRef: "srt",
  scopeSource: "grant_targets",
  directoryOperations: ["read", "create", "update"],
  network: "disabled",
};

const resourceCeiling = {
  maxWallTimeMs: 60000,
  maxCpuTimeMs: 10000,
  maxMemoryBytes: 268435456,
  maxOutputBytes: 65536,
  maxProgressEvents: 10,
};

const cleanups: Array<() => Promise<unknown>> = [];

const linux = process.platform === "linux";

const installedRuntime = process.env["HIMAWARI_QUALIFY_INSTALLED_RUNTIME"] !== undefined;

const runtimeRoot = path.resolve(
  process.env["HIMAWARI_QUALIFY_INSTALLED_RUNTIME"] ?? "dist/node-runtime",
);

interface BindingSpec {
  readonly binding: SandboxOperationBinding;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly deadlineMs?: number;
}

interface Harness {
  readonly f: Awaited<ReturnType<typeof productionSandboxScope>>;
  readonly live: Awaited<ReturnType<typeof queuedLiveWorker>>;
  readonly srt: SrtTaskEnvironmentBackend;
  readonly prepareCalls: JobHostRequest[];
  readonly sessions: SandboxJobSession[];
  readonly commandOutcomes: ReturnType<SandboxJobSession["run"]>["result"][];
  readonly stateDirectory: string;
  readonly bindings: readonly BindingSpec[];
  readonly runs: () => number;
}

async function srtHarness(options: {
  readonly bindings: readonly BindingSpec[];
  readonly forceFirstUnsettled?: boolean;
  readonly failFirstWriteOutput?: boolean;
  readonly runtimeInstanceId?: string;
  readonly directoryOperations?: readonly HostFileOperationKind[];
  readonly failCommandSessionPreparation?: boolean;
  readonly failCommandSessionReadiness?: boolean;
  readonly closeSessionWhenFirstCommandStarts?: boolean;
}): Promise<Harness> {
  const stateDirectory = await mkdtemp(`${testTemporaryRoot()}/srt-env-`);
  cleanups.push(() => rm(stateDirectory, { recursive: true, force: true }));
  const prepareCalls: JobHostRequest[] = [];
  const sessions: SandboxJobSession[] = [];
  const commandOutcomes: ReturnType<SandboxJobSession["run"]>["result"][] = [];
  let failedCommandSessionPreparation = false;
  let failedCommandSessionReadiness = false;
  if (options.failFirstWriteOutput) {
    const delivery = vi
      .spyOn(ProductionPayloadBrokerClient.prototype, "writeOutput")
      .mockRejectedValueOnce(new Error("SANDBOX_RESULT_DELIVERY_FAILED"));
    cleanups.push(async () => {
      delivery.mockRestore();
    });
  }
  let totalRuns = 0;
  let forced = false;
  const srt = new SrtTaskEnvironmentBackend({
    stateDirectory,
    runtimeInstanceId: options.runtimeInstanceId ?? "worker-boot-srt-entry",
    proofValidityMs: 60_000,
    now: () => new Date(),
    prepareSession: (request) => {
      prepareCalls.push(request);
      if (
        options.failCommandSessionPreparation &&
        !failedCommandSessionPreparation &&
        prepareCalls.length === 2
      ) {
        failedCommandSessionPreparation = true;
        throw new Error("SRT_TASK_ENVIRONMENT_SESSION_PREPARATION_FAILED");
      }
      const session = prepareSandboxJobSession(request);
      sessions.push(session);
      if (
        options.failCommandSessionReadiness &&
        !failedCommandSessionReadiness &&
        prepareCalls.length === 2
      ) {
        failedCommandSessionReadiness = true;
        const ready = Promise.reject(
          new JobHostPreparationError({ stage: "sdk_initialize", systemCode: "EIO" }),
        );
        ready.catch(() => {});
        return { ...session, ready };
      }
      let runs = 0;
      const run = session.run.bind(session);
      const wrapped: SandboxJobSession = {
        ...session,
        run: (input, authorize) => {
          const active = run(input, authorize);
          runs += 1;
          totalRuns += 1;
          commandOutcomes.push(active.result);
          if (options.closeSessionWhenFirstCommandStarts && totalRuns === 1)
            void active.started.then(
              () => setTimeout(() => session.close(), 2000),
              () => undefined,
            );
          if (!options.forceFirstUnsettled || forced || runs !== 1) return active;
          forced = true;
          return {
            ...active,
            result: active.result.then((outcome) => ({ ...outcome, settled: false })),
          };
        },
      };
      return wrapped;
    },
  });
  const remote = {
    worker: undefined as undefined | Awaited<ReturnType<typeof queuedLiveWorker>>["worker"],
  };
  let sequence = 0;
  const lifecycle = new RemoteExecutionBackend({
    backendRef: SRT_TASK_ENVIRONMENT_BACKEND_REF,
    transport: {
      request: (message) => {
        if (!remote.worker) throw new Error("worker not connected");
        return remote.worker.request(message);
      },
      events: (cursor) => {
        if (!remote.worker) throw new Error("worker not connected");
        return remote.worker.events(cursor);
      },
    },
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    authority: () => SERVICE_AUTHORITY.product,
    nextId: (scope) => `srt-${scope}-${++sequence}`,
    now: () => new Date().toISOString(),
    requestTimeoutMs: 60_000,
    resultTimeoutMs: 60_000,
    pollIntervalMs: 25,
  });
  const primary = options.bindings[0];
  if (!primary) throw new Error("binding required");
  const rest = options.bindings.slice(1);
  const f = await productionSandboxScope(primary.binding, undefined, {
    realFileIdentity: true,
    piRuntimeRoot: runtimeRoot,
    directoryOperations: options.directoryOperations ?? ["read", "create", "update"],
    resourceCeiling,
    profileRef: "authorized-project.v1",
    callParameters: options.bindings.map((spec) => spec.parameters),
    additionalBindings: rest.map((spec) => spec.binding),
    handleUses: 10,
    srtTaskEnvironments: {
      backendRef: SRT_TASK_ENVIRONMENT_BACKEND_REF,
      session: "srt",
      guarantees: SRT_TASK_ENVIRONMENT_GUARANTEES,
      inspectBeforeReuse: true,
      lifecycle,
    },
  });
  cleanups.push(f.close);
  const live = await queuedLiveWorker(f, SERVICE_AUTHORITY, undefined, undefined, srt);
  cleanups.push(live.close);
  cleanups.push(() => srt.close());
  remote.worker = live.worker;
  return {
    f,
    live,
    srt,
    prepareCalls,
    sessions,
    commandOutcomes,
    stateDirectory,
    bindings: options.bindings,
    runs: () => totalRuns,
  };
}

function makeCalls(ctx: Harness) {
  let index = 0;
  return async () => {
    index += 1;
    const spec = ctx.bindings[index - 1];
    if (!spec) throw new Error("call out of range");
    const deadlineAt = spec.deadlineMs
      ? new Date(Date.now() + spec.deadlineMs).toISOString()
      : ctx.f.input.deadlineAt;
    const operation = spec.binding.operation;
    const toolCallId = `srt-entry-call-${index}`;
    const invocationId = `runtime-tool:${hash([RUN_ID, toolCallId])}`;
    const inputRef = `payload-pi-parameters-${index}`;
    const handleRef =
      operation === ctx.bindings[0]?.binding.operation
        ? ctx.f.input.handleRef
        : (() => {
            const handle = ctx.f.additionalHandles.get(operation);
            if (!handle) throw new Error(`missing handle for ${operation}`);
            return handle.ref;
          })();
    const authorizationRef =
      operation === ctx.bindings[0]?.binding.operation
        ? ctx.f.input.authorizationRef
        : (ctx.f.additionalHandles.get(operation)?.authorizationRef ??
          ctx.f.input.authorizationRef);
    await ctx.f.persist(`runtime-tool-intent:${hash([RUN_ID, toolCallId])}`, {
      request: {
        schemaVersion: "execution.v2",
        kind: "request",
        type: "work.execute",
        messageId: invocationId,
        correlationId: `run:${RUN_ID}`,
        causationId: RUN_ID,
        dataClassification: ctx.f.input.dataClassification,
        risk: "high",
        authorizationRef,
        scope: ctx.f.input.requestScope,
        idempotencyKey: invocationId,
        payload: {
          inputRef,
          capabilityHandleRef: handleRef,
          capabilityId: ctx.f.input.capabilityRef,
          capabilityVersion: ctx.f.input.capabilityVersion,
          operation,
          delegatedContextRefs: ctx.f.input.delegatedContextRefs,
          secretRefs: ctx.f.input.secretRefs,
          resourceCeiling: ctx.f.input.resourceCeiling,
          requestedAt: ctx.f.input.requestedAt,
          deadlineAt,
        },
      },
    });
    const input = {
      ...ctx.f.input,
      deadlineAt,
      invocationId,
      idempotencyKey: invocationId,
      inputRef,
      receiptRef: `${ctx.f.input.receiptRef}-${index}`,
      operation,
      handleRef,
      authorizationRef,
    };
    const call = {
      ...ctx.f.call,
      toolCallId,
      capabilityHandleRef: handleRef,
      arguments: { inputRef },
    };
    const prepared = await ctx.f.services.runtime.prepare(input, call);
    if (!("reservation" in prepared)) throw new Error("expected sandbox-execution.v2 admission");
    await ctx.f.services.runtime.acquireEnvironment?.(prepared);
    await ctx.f.services.brokerV2.preparations.reserve({ ...prepared, invocation: input });
    return { prepared, input, call };
  };
}

type Prepared = Awaited<ReturnType<ReturnType<typeof makeCalls>>>;

async function dispatch(ctx: Harness, prepared: Prepared) {
  const plan = prepared.prepared.plan;
  const base = serviceRequest();
  return ctx.live.sandbox.execute({
    ...base,
    messageId: plan.identity.invocationId,
    authorizationRef: plan.authorizationRef,
    scope: ctx.f.input.requestScope,
    payload: {
      ...base.payload,
      capabilityId: plan.capabilityRef,
      capabilityVersion: plan.capabilityVersion,
      capabilityHandleRef: plan.handleRef,
      inputRef: plan.inputRef,
      operation: plan.operation,
      requestedAt: ctx.f.input.requestedAt,
      deadlineAt: plan.effectiveDeadlineAt,
      resourceCeiling: plan.resourceCeiling,
      delegatedContextRefs: ctx.f.input.delegatedContextRefs,
      secretRefs: ctx.f.input.secretRefs,
      sandboxExecution: {
        schemaVersion: "sandbox-execution.v2",
        mode: plan.mode,
        environmentId: plan.environmentId,
        identity: plan.identity,
      },
    },
  });
}

async function readRecord(ctx: Harness, prepared: Prepared) {
  return ctx.f.repository
    .sandboxExecutionJournal(OWNER_ID, AGENT_ID)
    .read(prepared.prepared.plan.identity);
}

async function waitForBoundRecord(ctx: Harness, prepared: Prepared) {
  return waitFor(async () => {
    try {
      const record = await readRecord(ctx, prepared);
      return record?.startedAt ? record : undefined;
    } catch {
      return undefined;
    }
  });
}

async function preparationDiagnostic(ctx: Harness, prepared: Prepared) {
  const database = new Database(path.join(ctx.f.f.resource.stateRoot, "product.sqlite"), {
    readonly: true,
  });
  let payloadRefs: string[] = [];
  try {
    payloadRefs = (
      database
        .prepare(
          "SELECT payload_ref AS payloadRef FROM run_payload_artifacts WHERE purpose='trace' AND operation_key LIKE '%:diagnostic:preparation-failure' ORDER BY rowid DESC",
        )
        .all() as Array<{ payloadRef: string }>
    ).map((row) => row.payloadRef);
  } finally {
    database.close();
  }
  for (const payloadRef of payloadRefs) {
    const payload = await ctx.f.repository.payloadStore(OWNER_ID, AGENT_ID).get(payloadRef);
    if (!payload) continue;
    const bytes = await ctx.f.f.protector.unprotect({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      payload,
    });
    const diagnostic = JSON.parse(new TextDecoder().decode(bytes)) as {
      readonly identity?: { readonly jobId?: string };
      readonly stage?: string;
      readonly reasonCode?: string;
      readonly systemCode?: string;
    };
    if (diagnostic.identity?.jobId === prepared.prepared.plan.identity.jobId) return diagnostic;
  }
  return undefined;
}

async function readPiResult(ctx: Harness, prepared: Prepared) {
  const record = await readRecord(ctx, prepared);
  const result = record?.facts.result;
  if (!result || !("output" in result) || !result.output) return undefined;
  const payload = await ctx.f.repository.payloadStore(OWNER_ID, AGENT_ID).get(result.output.ref);
  if (!payload) return undefined;
  const bytes = await ctx.f.f.protector.unprotect({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    payload,
  });
  const text = Buffer.from(bytes).toString("utf8");
  if (text.length === 0)
    throw new Error(
      `empty command output: result=${JSON.stringify(record?.facts.result)} resource=${JSON.stringify(
        record?.facts.resource,
      )} stderr=${forkState.stderr.slice(0, 2000)}`,
    );
  let parsed: {
    isError?: boolean;
    commandExitCode?: number | null;
    content?: readonly { readonly type: string; readonly text?: string }[];
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`unreadable command output: ${text.slice(0, 500)}`);
  }
  return {
    record,
    parsed,
    text: (parsed.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n"),
  };
}

async function releaseEnvironment(ctx: Harness, prepared: Prepared) {
  const record = await readRecord(ctx, prepared);
  if (!record) throw new Error("missing execution record");
  await ctx.f.services.brokerV2.refreshVerification(record);
  return record;
}

async function environmentRecord(ctx: Harness, environmentId: string) {
  return ctx.f.repository.executionEnvironmentStore(OWNER_ID, AGENT_ID).read(environmentId);
}

async function primaryEnvironment(ctx: Harness) {
  const run = await ctx.f.repository.executionEnvironmentStore(OWNER_ID, AGENT_ID).readRun(RUN_ID);
  const primaries = (run?.environments ?? []).filter(
    (environment) => environment.identity.role === "primary",
  );
  return primaries;
}

async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function processesWith(needle: string): Promise<string[]> {
  return (async () => {
    const leftovers: string[] = [];
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
      if (cmdline.includes(needle)) leftovers.push(entry);
    }
    return leftovers;
  })();
}

async function residentIdentity(session: SandboxJobSession) {
  const { residentProcessId } = await session.ready;
  const stat = await readFile(`/proc/${residentProcessId}/stat`, "utf8");
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  if (!start || !/^\d+$/.test(start)) throw new Error("resident start token unavailable");
  return { pid: residentProcessId, start };
}

function residentSession(ctx: Harness): SandboxJobSession {
  const session = ctx.sessions[0];
  if (!session) throw new Error("missing session");
  return session;
}

function storedStreamKeys(ctx: Harness): string[] {
  const database = new Database(path.join(ctx.f.f.resource.stateRoot, "product.sqlite"), {
    readonly: true,
  });
  try {
    return database
      .prepare(
        "SELECT operation_key AS operationKey FROM run_payload_artifacts WHERE purpose='trace' AND operation_key LIKE 'sandbox-stream-%' ORDER BY operation_key",
      )
      .all()
      .map((row) => (row as { operationKey: string }).operationKey);
  } finally {
    database.close();
  }
}

describe("[R2-P2] SRT resident task environment through the real Agent entry", () => {
  if (!linux || !installedRuntime) {
    it("[R2-P2] reports that the resident SRT environment requires Linux and an installed runtime", () => {
      expect(linux && installedRuntime).toBe(false);
    });
    return;
  }

  beforeAll(async () => {
    const shell = await stat(path.join(runtimeRoot, "pi-tools/bin/bash")).catch(() => null);
    if (!shell?.isFile() || shell.isSymbolicLink() || !(shell.mode & 0o111))
      throw new Error("LIVE_SRT_BASH_TOOLCHAIN_REQUIRED");
  });
  beforeEach(() => {
    forkState.children = [];
    forkState.stderr = "";
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    for (const child of forkState.children) {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) continue;
      try {
        process.kill(child.pid, "SIGCONT");
      } catch {}
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {}
    }
    forkState.children = [];
  });

  it("[R2-P2] reuses one resident runner across three foreground bash calls in one Run", async () => {
    const ctx = await srtHarness({
      bindings: [
        { binding: bashBinding, parameters: { command: "echo one" } },
        { binding: bashBinding, parameters: { command: "echo two; exit 3" } },
        { binding: bashBinding, parameters: { command: "pwd" } },
      ],
    });
    const call = makeCalls(ctx);
    const durations: number[] = [];
    const identities: string[] = [];
    const results: Array<Awaited<ReturnType<typeof readPiResult>>> = [];
    for (let index = 0; index < 3; index++) {
      const prepared = await call();
      const began = Date.now();
      await dispatch(ctx, prepared);
      durations.push(Date.now() - began);
      const identity = await residentIdentity(residentSession(ctx));
      identities.push(`${identity.pid}:${identity.start}`);
      results.push(await readPiResult(ctx, prepared));
    }

    expect(ctx.prepareCalls).toHaveLength(1);
    expect(new Set(identities).size).toBe(1);
    expect(results[0]?.parsed.isError).not.toBe(true);
    expect(results[0]?.text).toContain("one");
    expect(results[1]?.parsed.commandExitCode).toBe(3);
    expect(results[1]?.text).toContain("two");
    expect(results[2]?.parsed.isError).not.toBe(true);
    expect(results[2]?.text).toContain("live-workspace");
    console.log(
      `[R2-P2] resident runner reuse durations(ms)=${durations.join(",")} identities=${identities.join(",")}`,
    );

    const primaries = await primaryEnvironment(ctx);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.backendRef).toBe(SRT_TASK_ENVIRONMENT_BACKEND_REF);
  });

  it("[R2-P2] reports a bash that reaches its own deadline as deadline exceeded and holds the workspace", async () => {
    const ctx = await srtHarness({
      bindings: [
        { binding: bashBinding, parameters: { command: "sleep 30" }, deadlineMs: 25000 },
        { binding: bashBinding, parameters: { command: "echo after-deadline" } },
      ],
    });
    const call = makeCalls(ctx);
    const first = await call();
    await dispatch(ctx, first);
    const firstRecord = await readRecord(ctx, first);
    expect(firstRecord?.facts.result).toMatchObject({
      kind: "error",
      reasonCode: "SANDBOX_TOOL_DEADLINE_EXCEEDED",
    });

    const secondOutcome = await call().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (secondOutcome.ok)
      throw new Error(
        `second call after a deadline result resolved instead of being refused: ${JSON.stringify(secondOutcome.value)}`,
      );
    expect(String(secondOutcome.error)).toContain("Workspace remains occupied");
    expect(ctx.prepareCalls).toHaveLength(1);
  });

  it("[R2-P2] settles a running command before stopping the resident runner when the session stops", async () => {
    const ctx = await srtHarness({
      bindings: [{ binding: bashBinding, parameters: { command: "sleep 90" } }],
      closeSessionWhenFirstCommandStarts: true,
    });
    const call = makeCalls(ctx);
    const first = await call();
    const dispatched = dispatch(ctx, first).catch((error: unknown) => error);
    const pending = await waitFor(() => ctx.commandOutcomes[0], 60_000);
    expect(await pending).toMatchObject({
      settled: true,
      reason: "cancelled",
      namespace: "resident_intact",
    });
    await dispatched;
  });

  it("[R2-P2] keeps the file_write session policy separate from the command session", async () => {
    const ctx = await srtHarness({
      directoryOperations: fullDirectoryOperations,
      bindings: [
        { binding: writeBinding, parameters: { path: "notes.txt", content: "resident-write" } },
        {
          binding: bashWriteBinding,
          parameters: { command: "printf probe > .himawari-recovery/probe" },
        },
      ],
    });
    const call = makeCalls(ctx);
    await mkdir(path.join(ctx.f.host.workspace, ".himawari-recovery"), { mode: 0o700 });
    const first = await call();
    await dispatch(ctx, first);
    const second = await call();
    const secondDispatch = await dispatch(ctx, second);
    expect(secondDispatch.outcome).toBe("result_unknown");
    expect(secondDispatch.errorCode).toBeNull();
    expect(typeof secondDispatch.externalActionId).toBe("string");
    expect((await readRecord(ctx, second))?.startedAt).toBeTruthy();

    expect(await readFile(path.join(ctx.f.host.workspace, "notes.txt"), "utf8")).toBe(
      "resident-write",
    );
    await expect(
      stat(path.join(ctx.f.host.workspace, ".himawari-recovery/probe")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const secondResult = await readPiResult(ctx, second);
    expect(secondResult?.parsed.isError).toBe(true);
    expect(secondResult?.parsed.commandExitCode ?? 1).not.toBe(0);

    expect(ctx.prepareCalls).toHaveLength(2);
    const [environment] = await primaryEnvironment(ctx);
    const environmentId = environment?.identity.environmentId ?? "";
    const started = new Set(ctx.prepareCalls.map((request) => request.jobId));
    expect(started).toEqual(
      new Set([
        srtTaskEnvironmentJobId(environmentId, "file_write"),
        srtTaskEnvironmentJobId(environmentId, "command"),
      ]),
    );

    const stored = await environmentRecord(ctx, environmentId);
    const writeCall = stored?.calls.find(
      (entry) => entry.invocationId === first.prepared.plan.identity.invocationId,
    );
    expect(writeCall?.claims.length).toBeGreaterThan(0);
    expect(writeCall?.claims.every((claim) => claim.file === undefined)).toBe(true);
  });

  it("[R2-P2] releases a resident reservation that failed before bind and runs the next call", async () => {
    const ctx = await srtHarness({
      bindings: [
        { binding: writeBinding, parameters: { path: "notes.txt", content: "resident-write" } },
        { binding: bashBinding, parameters: { command: "echo two" } },
        { binding: bashBinding, parameters: { command: "echo three" } },
      ],
      failCommandSessionPreparation: true,
    });
    const call = makeCalls(ctx);
    const first = await call();
    await dispatch(ctx, first);
    const second = await call();
    const failed = await dispatch(ctx, second);
    expect(failed.outcome).toBe("result_unknown");

    const invocation = { runId: RUN_ID, invocationId: second.prepared.plan.identity.invocationId };
    const delivery = { assertDisclosure: async () => {}, saveReceipt: async () => {} };
    expect(await ctx.f.services.completeToolResult(invocation, delivery)).toMatchObject({
      outcome: "failed",
      outputRef: null,
      errorCode: "SANDBOX_TOOL_NOT_STARTED",
    });

    const preparations = ctx.f.services.brokerV2.preparations;
    expect(await preparations.readAdmission(second.prepared.plan.identity)).toMatchObject({
      phase: "reserved",
      workspaceBlocked: false,
      recovery: { status: "resolved", reasonCode: "SANDBOX_RESERVATION_RELEASE_CONFIRMED" },
      releaseReceipt: { verification: { basis: "task_environment_bind_fenced" } },
    });

    const [environment] = await primaryEnvironment(ctx);
    const environmentId = environment?.identity.environmentId ?? "";
    expect(await environmentRecord(ctx, environmentId)).toMatchObject({ state: "running" });

    const third = await call();
    await dispatch(ctx, third);
    expect((await readPiResult(ctx, third))?.text).toContain("three");
  });

  it("[R2-P2] reports the Job Host's preparation diagnostic when a resident session never becomes ready", async () => {
    const ctx = await srtHarness({
      bindings: [
        { binding: writeBinding, parameters: { path: "notes.txt", content: "resident-write" } },
        { binding: bashBinding, parameters: { command: "echo two" } },
        { binding: bashBinding, parameters: { command: "echo three" } },
      ],
      failCommandSessionReadiness: true,
    });
    const call = makeCalls(ctx);
    const first = await call();
    await dispatch(ctx, first);
    const second = await call();
    const failed = await dispatch(ctx, second);
    expect(failed.outcome).toBe("result_unknown");
    expect(await preparationDiagnostic(ctx, second)).toMatchObject({
      stage: "prepare",
      reasonCode: "SANDBOX_PREPARATION_FAILED",
      hostStage: "sdk_initialize",
      systemCode: "EIO",
    });

    const invocation = { runId: RUN_ID, invocationId: second.prepared.plan.identity.invocationId };
    const delivery = { assertDisclosure: async () => {}, saveReceipt: async () => {} };
    expect(await ctx.f.services.completeToolResult(invocation, delivery)).toMatchObject({
      outcome: "failed",
      outputRef: null,
      errorCode: "SANDBOX_TOOL_NOT_STARTED",
    });

    const third = await call();
    await dispatch(ctx, third);
    expect((await readPiResult(ctx, third))?.text).toContain("three");
  });

  it("[R2-P2] leaves no background process behind after its command namespace releases", async () => {
    const ctx = await srtHarness({
      bindings: [
        {
          binding: bashBinding,
          parameters: { command: "setsid nohup sleep 600 >/dev/null 2>&1 &" },
        },
        { binding: bashBinding, parameters: { command: "ps -eo pid,args" } },
      ],
    });
    const call = makeCalls(ctx);
    const first = await call();
    await dispatch(ctx, first);
    const second = await call();
    await dispatch(ctx, second);

    const secondResult = await readPiResult(ctx, second);
    expect(secondResult?.text).not.toContain("sleep 600");
    expect((await readRecord(ctx, first))?.facts.resource).toMatchObject({
      supervision: "released",
      cleanup: "process_group_gone",
      cleanupScope: "pid_namespace",
    });
    const leftovers = await waitFor(async () => {
      const found = await processesWith("sleep 600");
      return found.length === 0 ? [] : undefined;
    }, 10000).catch(async () => processesWith("sleep 600"));
    expect(leftovers).toEqual([]);
  });

  it("[R2-P2] stops the environment after an unknown command result and refuses the next call", async () => {
    const ctx = await srtHarness({
      forceFirstUnsettled: true,
      bindings: [
        { binding: bashBinding, parameters: { command: "echo one" } },
        { binding: bashBinding, parameters: { command: "echo two" } },
      ],
    });
    const call = makeCalls(ctx);
    const first = await call();
    await dispatch(ctx, first);
    const firstRecord = await readRecord(ctx, first);
    expect(firstRecord?.facts.result?.kind).toBe("unknown");
    if (!firstRecord) throw new Error("missing execution record");
    await ctx.f.services.brokerV2.refreshVerification(firstRecord);
    const [firstEnvironment] = await primaryEnvironment(ctx);
    const firstId = firstEnvironment?.identity.environmentId ?? "";
    expect(await environmentRecord(ctx, firstId)).toMatchObject({
      state: "released",
      releaseReceipt: { basis: "process_group_gone" },
    });

    const secondOutcome = await call().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (secondOutcome.ok)
      throw new Error(
        `second call after an unknown result resolved instead of being refused: ${JSON.stringify(secondOutcome.value)}`,
      );
    expect(String(secondOutcome.error)).toContain("Workspace remains occupied");
    expect(ctx.prepareCalls).toHaveLength(1);
  });

  it("[R2-P2] reassembles a settled command's output from stored stream fragments after the Worker fails to deliver the result", async () => {
    const marker = "r2p2-recovered-delivery-marker";
    const ctx = await srtHarness({
      failFirstWriteOutput: true,
      bindings: [{ binding: bashBinding, parameters: { command: `printf '%s' '${marker}'` } }],
    });
    const call = makeCalls(ctx);
    const first = await call();
    await dispatch(ctx, first);

    const failed = await readRecord(ctx, first);
    expect(failed?.facts.result).toMatchObject({ kind: "unknown" });
    expect(ctx.runs()).toBe(1);
    const stored = storedStreamKeys(ctx);
    expect(stored.some((key) => key.startsWith("sandbox-stream-end:"))).toBe(true);
    expect(stored.some((key) => key.startsWith("sandbox-stream-chunk:"))).toBe(true);

    expect(await ctx.f.services.resources.stopRun(RUN_ID, "run_cancelled")).toEqual({
      released: true,
    });
    const released = await readRecord(ctx, first);
    expect(released?.facts.resource.supervision).toBe("released");
    expect(released?.releaseReceipt).toEqual(
      expect.objectContaining({ acceptedAt: expect.any(String) }),
    );
    expect(released?.facts.result).toMatchObject({ kind: "unknown" });
    if (!released) throw new Error("missing released record");

    const recovered = await ctx.f.services.recoverMissingToolResult(released);
    expect(recovered.facts.result).toMatchObject({
      kind: "result",
      completion: { type: "exit", exitCode: 0 },
    });
    const delivered = await readPiResult(ctx, first);
    expect(delivered?.parsed.isError).not.toBe(true);
    expect(delivered?.text.trim()).toBe(marker);
    expect(ctx.runs()).toBe(1);
  });

  it("[R2-P2] retries one stop intent as a new request and releases after the first refusal", async () => {
    const ctx = await srtHarness({
      forceFirstUnsettled: true,
      bindings: [{ binding: bashBinding, parameters: { command: "echo one" } }],
    });
    const call = makeCalls(ctx);
    const first = await call();
    await dispatch(ctx, first);
    const record = await readRecord(ctx, first);
    expect(record?.facts.result?.kind).toBe("unknown");
    if (!record) throw new Error("missing execution record");

    let stops = 0;
    const originalStop = ctx.srt.stop.bind(ctx.srt);
    ctx.srt.stop = async (input) => {
      stops += 1;
      return originalStop(input);
    };
    let verifications = 0;
    const originalVerify = ctx.srt.verifyStopped.bind(ctx.srt);
    ctx.srt.verifyStopped = async (input) => {
      verifications += 1;
      if (verifications === 1)
        throw Object.assign(new Error("SRT_ENVIRONMENT_NOT_STOPPED"), {
          code: "SRT_ENVIRONMENT_NOT_STOPPED",
        });
      return originalVerify(input);
    };

    const refused = await ctx.f.services.brokerV2.refreshVerification(record).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(Error);
    const refusalChain: string[] = [];
    for (let current: unknown = refused; current instanceof Error; current = current.cause)
      refusalChain.push(`${current.name}: ${current.message}`);
    const refusalText = refusalChain.join(" | ");
    expect(refusalText).toContain("SRT_ENVIRONMENT_NOT_STOPPED");
    expect(refusalText).not.toContain("WORKER_DUPLICATE_CONFLICT");

    await ctx.f.services.brokerV2.refreshVerification(record);
    const [environment] = await primaryEnvironment(ctx);
    expect(await environmentRecord(ctx, environment?.identity.environmentId ?? "")).toMatchObject({
      state: "released",
      releaseReceipt: { basis: "process_group_gone" },
    });
    expect(stops).toBeGreaterThanOrEqual(2);
  });

  it("[R2-P2] stops the resident environment once and keeps one release proof across an Agent restart", async () => {
    const ctx = await srtHarness({
      bindings: [
        { binding: bashBinding, parameters: { command: "echo one" } },
        { binding: bashBinding, parameters: { command: "echo two" } },
      ],
    });
    const call = makeCalls(ctx);
    const first = await call();
    await dispatch(ctx, first);
    const second = await call();
    await dispatch(ctx, second);

    await ctx.f.reopen();

    let stops = 0;
    const originalStop = ctx.srt.stop.bind(ctx.srt);
    ctx.srt.stop = async (input) => {
      stops += 1;
      return originalStop(input);
    };
    expect(await ctx.f.services.resources.stopRun(RUN_ID, "run_finished")).toEqual({
      released: true,
    });
    expect(stops).toBe(1);

    const [environment] = await primaryEnvironment(ctx);
    const environmentId = environment?.identity.environmentId ?? "";
    expect(await environmentRecord(ctx, environmentId)).toMatchObject({
      state: "released",
      releaseReceipt: { basis: "process_group_gone" },
    });
    const firstRecord = await readRecord(ctx, first);
    const secondRecord = await readRecord(ctx, second);
    expect(firstRecord?.releaseReceipt).toBeDefined();
    expect(secondRecord?.releaseReceipt).toBeDefined();
    expect(firstRecord?.releaseReceipt?.verification.facts.environment).toMatchObject({
      taskEnvironmentId: environmentId,
    });
    expect(secondRecord?.releaseReceipt?.verification.facts.environment).toMatchObject({
      taskEnvironmentId: environmentId,
    });
  });

  it("[R2-P2] ends a fenced resident call as not started once and runs the next call in the same resident runner", async () => {
    const ctx = await srtHarness({
      bindings: [
        { binding: bashBinding, parameters: { command: "echo one" } },
        { binding: bashBinding, parameters: { command: "echo never" } },
        { binding: bashBinding, parameters: { command: "echo three" } },
      ],
    });
    const call = makeCalls(ctx);
    const first = await call();
    await dispatch(ctx, first);
    const runner = await residentIdentity(residentSession(ctx));
    const fenced = await call();
    const preparations = ctx.f.services.brokerV2.preparations;
    await preparations.interruptReservation({
      identity: fenced.prepared.plan.identity,
      authority: SERVICE_AUTHORITY,
      now: new Date().toISOString(),
      reasonCode: "SANDBOX_PREVIOUS_BOOT_UNKNOWN",
    });
    await ctx.f.services.resources.recoverPending(new AbortController().signal, 10);
    expect(await preparations.readAdmission(fenced.prepared.plan.identity)).toMatchObject({
      phase: "reserved",
      recovery: { status: "resolved", reasonCode: "SANDBOX_RESERVATION_RELEASE_CONFIRMED" },
      workspaceBlocked: false,
      releaseReceipt: { verification: { basis: "task_environment_bind_fenced" } },
    });
    const environments = await primaryEnvironment(ctx);
    expect(environments.map((environment) => environment.state)).toEqual(["running"]);
    expect(environments[0]?.calls.map((entry) => entry.invocationId)).toEqual([
      first.prepared.plan.identity.invocationId,
    ]);
    const invocation = { runId: RUN_ID, invocationId: fenced.prepared.plan.identity.invocationId };
    const delivery = { assertDisclosure: async () => {}, saveReceipt: async () => {} };
    const notStarted = {
      outcome: "failed",
      outputRef: null,
      errorCode: "SANDBOX_TOOL_NOT_STARTED",
    };
    expect(await ctx.f.services.completeToolResult(invocation, delivery)).toMatchObject(notStarted);
    expect(await ctx.f.services.completeToolResult(invocation, delivery)).toMatchObject(notStarted);

    const third = await call();
    await dispatch(ctx, third);
    expect((await readPiResult(ctx, third))?.text).toContain("three");
    expect(await residentIdentity(residentSession(ctx))).toEqual(runner);
    expect(ctx.runs()).toBe(2);
    expect((await primaryEnvironment(ctx)).map((environment) => environment.state)).toEqual([
      "running",
    ]);
  });

  it("[R2-P2] ends the call as unknown and stops the environment when the Job Host stops responding", async () => {
    const ctx = await srtHarness({
      bindings: [{ binding: bashBinding, parameters: { command: "sleep 30" } }],
    });
    const call = makeCalls(ctx);
    const first = await call();
    const pending = dispatch(ctx, first);
    const child = await waitFor(() => forkState.children.at(-1));
    const closed = new Promise<boolean>((resolve) => child.once("close", () => resolve(true)));
    await waitFor(() => (ctx.sessions[0]?.inspect()?.task ? true : undefined));
    process.kill(child.pid as number, "SIGSTOP");
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`dispatch did not settle within 30s: ${forkState.stderr.slice(0, 2000)}`),
            ),
          30000,
        ),
      ),
    ]);
    expect(result.outcome).toBe("result_unknown");
    expect(
      await Promise.race([
        closed,
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 30000)),
      ]),
      "the Job Host process must close after it stops responding",
    ).toBe(true);
    const record = await readRecord(ctx, first);
    expect(record?.facts.result?.kind).toBe("unknown");
    if (!record) throw new Error("missing execution record");
    await releaseEnvironment(ctx, first);
    const [environment] = await primaryEnvironment(ctx);
    expect(await environmentRecord(ctx, environment?.identity.environmentId ?? "")).toMatchObject({
      state: "released",
      releaseReceipt: { basis: "process_group_gone" },
    });
    const leftovers = await waitFor(async () => {
      const found = await processesWith("sleep 30");
      return found.length === 0 ? [] : undefined;
    }, 10000).catch(async () => processesWith("sleep 30"));
    expect(leftovers).toEqual([]);
  });

  it("[R2-P2] ends the call as unknown when the Job Host is killed while a command runs", async () => {
    const ctx = await srtHarness({
      bindings: [{ binding: bashBinding, parameters: { command: "sleep 30" } }],
    });
    const call = makeCalls(ctx);
    const first = await call();
    const pending = dispatch(ctx, first);
    const child = await waitFor(() => forkState.children.at(-1));
    const closed = new Promise<boolean>((resolve) => child.once("close", () => resolve(true)));
    await waitFor(() => (ctx.sessions[0]?.inspect()?.task ? true : undefined));
    process.kill(child.pid as number, "SIGKILL");
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`dispatch did not settle within 30s: ${forkState.stderr.slice(0, 2000)}`),
            ),
          30000,
        ),
      ),
    ]);
    expect(result.outcome).toBe("result_unknown");
    expect(
      await Promise.race([
        closed,
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 30000)),
      ]),
      "the Job Host process must close after the session ends",
    ).toBe(true);
    const record = await readRecord(ctx, first);
    expect(record?.facts.result?.kind).toBe("unknown");
    if (!record) throw new Error("missing execution record");
    await releaseEnvironment(ctx, first);
    const [environment] = await primaryEnvironment(ctx);
    expect(await environmentRecord(ctx, environment?.identity.environmentId ?? "")).toMatchObject({
      state: "released",
      releaseReceipt: { basis: "process_group_gone" },
    });
  });

  it("[R2-P2] keeps background bash and contract v2-v5 operations on the per-call sandbox path", async () => {
    const ctx = await srtHarness({
      bindings: [
        { binding: preparedWriteBinding, parameters: { path: "queued.txt", content: "queued" } },
        { binding: backgroundBashBinding, parameters: { command: "printf background" } },
      ],
    });
    const call = makeCalls(ctx);
    await writeFile(path.join(ctx.f.host.workspace, "queued.txt"), "before");
    const first = await call();
    await dispatch(ctx, first);
    const second = await call();
    await dispatch(ctx, second);

    expect(first.prepared.plan.backendRef).toBe("srt");
    expect(first.prepared.plan.preparationProtocol).toBeDefined();
    expect(second.prepared.plan.backendRef).toBe("srt");
    expect(second.prepared.plan.preparationProtocol).toBeDefined();
    expect(ctx.prepareCalls).toHaveLength(0);
  });

  it("[R2-P2] keeps the sandbox base processes when a networked command leaves a background process", async () => {
    const ctx = await srtHarness({
      bindings: [
        {
          binding: networkBashBinding,
          parameters: { command: "setsid nohup sleep 600 >/dev/null 2>&1 &" },
        },
        { binding: networkBashBinding, parameters: { command: "ps -eo pid,args" } },
      ],
    });
    const call = makeCalls(ctx);
    const first = await call();
    await dispatch(ctx, first);
    const second = await call();
    await dispatch(ctx, second);

    const secondResult = await readPiResult(ctx, second);
    expect(secondResult?.parsed.isError).not.toBe(true);
    expect(secondResult?.text).not.toContain("sleep 600");
    expect(ctx.prepareCalls).toHaveLength(1);
    const leftovers = await waitFor(async () => {
      const found = await processesWith("sleep 600");
      return found.length === 0 ? [] : undefined;
    }, 10000).catch(async () => processesWith("sleep 600"));
    expect(leftovers).toEqual([]);
  });

  it("[R2-P2] ends the call as unknown and stops the environment when the resident runner is killed", async () => {
    const ctx = await srtHarness({
      bindings: [{ binding: bashBinding, parameters: { command: "sleep 30" } }],
    });
    const call = makeCalls(ctx);
    const first = await call();
    const pending = dispatch(ctx, first);
    await waitFor(() => (ctx.sessions[0]?.inspect()?.task ? true : undefined));
    const { pid } = await residentIdentity(residentSession(ctx));
    process.kill(pid, "SIGKILL");
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`dispatch did not settle within 30s: ${forkState.stderr.slice(0, 2000)}`),
            ),
          30000,
        ),
      ),
    ]);
    expect(result.outcome).toBe("result_unknown");
    const record = await readRecord(ctx, first);
    expect(record?.facts.result?.kind).toBe("unknown");
    if (!record) throw new Error("missing execution record");
    await releaseEnvironment(ctx, first);
    const [environment] = await primaryEnvironment(ctx);
    expect(await environmentRecord(ctx, environment?.identity.environmentId ?? "")).toMatchObject({
      state: "released",
      releaseReceipt: { basis: "process_group_gone" },
    });
  });

  it("[R2-P2] alternates write, bash, edit, and bash with one session each", async () => {
    const ctx = await srtHarness({
      directoryOperations: fullDirectoryOperations,
      bindings: [
        { binding: writeBinding, parameters: { path: "alt.txt", content: "one" } },
        { binding: bashWriteBinding, parameters: { command: "cat alt.txt" } },
        {
          binding: editBinding,
          parameters: { path: "alt.txt", edits: [{ oldText: "one", newText: "two" }] },
        },
        { binding: bashWriteBinding, parameters: { command: "cat alt.txt" } },
      ],
    });
    const call = makeCalls(ctx);
    const results: Array<Awaited<ReturnType<typeof readPiResult>>> = [];
    for (let index = 0; index < 4; index++) {
      const prepared = await call();
      await dispatch(ctx, prepared);
      results.push(await readPiResult(ctx, prepared));
    }

    expect(await readFile(path.join(ctx.f.host.workspace, "alt.txt"), "utf8")).toBe("two");
    expect(results[1]?.parsed.isError).not.toBe(true);
    expect(results[1]?.text).toContain("one");
    expect(results[2]?.parsed.isError).not.toBe(true);
    expect(results[3]?.parsed.isError).not.toBe(true);
    expect(results[3]?.text).toContain("two");

    expect(ctx.prepareCalls).toHaveLength(2);
    const [environment] = await primaryEnvironment(ctx);
    const environmentId = environment?.identity.environmentId ?? "";
    expect(new Set(ctx.prepareCalls.map((request) => request.jobId))).toEqual(
      new Set([
        srtTaskEnvironmentJobId(environmentId, "file_write"),
        srtTaskEnvironmentJobId(environmentId, "command"),
      ]),
    );
  });

  it("[R2-P2] recovers a resident deadline failure once its release evidence is confirmed", async () => {
    const ctx = await srtHarness({
      failFirstWriteOutput: true,
      bindings: [{ binding: bashBinding, parameters: { command: "sleep 30" }, deadlineMs: 20000 }],
    });
    const call = makeCalls(ctx);
    const first = await call();
    await dispatch(ctx, first);
    const failed = await readRecord(ctx, first);
    expect(failed?.facts.result).toMatchObject({ kind: "unknown" });
    expect(failed?.facts.resource.supervision).toBe("lost");
    expect(storedStreamKeys(ctx).some((key) => key.startsWith("sandbox-stream-end:"))).toBe(true);

    expect(await ctx.f.services.resources.stopRun(RUN_ID, "run_cancelled")).toEqual({
      released: true,
    });
    const released = await readRecord(ctx, first);
    expect(released?.facts.resource.supervision).toBe("released");
    if (!released) throw new Error("missing released record");

    const recovered = await ctx.f.services.recoverMissingToolResult(released);
    expect(recovered.facts.result).toMatchObject({
      kind: "error",
      reasonCode: "SANDBOX_TOOL_DEADLINE_EXCEEDED",
    });
  });

  it("[R2-P2] does not report a resident call stopped after binding as a bind failure or as never started", async () => {
    const ctx = await srtHarness({
      bindings: [{ binding: bashBinding, parameters: { command: "sleep 30" } }],
    });
    const call = makeCalls(ctx);
    const first = await call();
    const running = dispatch(ctx, first).catch(() => undefined);
    await waitForBoundRecord(ctx, first);
    const bound = await readRecord(ctx, first);
    expect(bound?.startedAt).toBeDefined();
    expect(bound?.facts.result).toBeNull();

    expect(await ctx.f.services.resources.stopRun(RUN_ID, "run_cancelled")).toEqual({
      released: true,
    });
    await running;

    const diagnostic = await preparationDiagnostic(ctx, first);
    expect(["bind", "prepare"]).not.toContain(diagnostic?.stage);
    const settled = await readRecord(ctx, first);
    expect(settled?.facts.result).not.toMatchObject({
      kind: "error",
      reasonCode: "SANDBOX_TOOL_NOT_STARTED",
    });
  });

  it("[R2-P2] writes an unknown result when the environment is released while a command runs", async () => {
    const ctx = await srtHarness({
      bindings: [{ binding: bashBinding, parameters: { command: "sleep 30" } }],
    });
    const call = makeCalls(ctx);
    const first = await call();
    const running = dispatch(ctx, first).catch(() => undefined);
    await waitForBoundRecord(ctx, first);

    expect(await ctx.f.services.resources.stopRun(RUN_ID, "run_cancelled")).toEqual({
      released: true,
    });
    await running;

    const released = await readRecord(ctx, first);
    expect(released?.facts.resource.supervision).toBe("released");
    expect(released?.facts.result).toMatchObject({
      kind: "unknown",
      reasonCode: "SANDBOX_EXIT_UNKNOWN",
    });
  });

  it("[R2-P2] writes an unknown result when the recovery scan releases a running environment", async () => {
    const ctx = await srtHarness({
      bindings: [{ binding: bashBinding, parameters: { command: "sleep 30" } }],
    });
    const call = makeCalls(ctx);
    const first = await call();
    const running = dispatch(ctx, first).catch(() => undefined);
    await waitForBoundRecord(ctx, first);
    const database = new Database(path.join(ctx.f.f.resource.stateRoot, "product.sqlite"));
    try {
      database.prepare("UPDATE runs SET status='cancelled' WHERE id=?").run(RUN_ID);
    } finally {
      database.close();
    }

    await ctx.f.services.resources.recoverPending(new AbortController().signal, 4);
    await running;

    const released = await readRecord(ctx, first);
    expect(released?.facts.resource.supervision).toBe("released");
    expect(released?.facts.result).toMatchObject({
      kind: "unknown",
      reasonCode: "SANDBOX_EXIT_UNKNOWN",
    });
  });
});

function residentQueueFingerprint(call: RuntimeToolInvocation) {
  if (!call.context) throw new Error("context missing");
  const { executionLease, continuationRef: _continuation, ...context } = call.context;
  return createHash("sha256")
    .update(
      JSON.stringify(
        {
          ...call,
          context: {
            ...context,
            authority: {
              deploymentId: executionLease.deploymentId,
              authorityEpoch: executionLease.authorityEpoch,
              fencingToken: executionLease.fencingToken,
            },
          },
        },
        (_key, value) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
            : value,
      ),
    )
    .digest("hex");
}

class ResidentQueueLifecycle implements ExecutionEnvironmentLifecyclePort {
  readonly calls: string[] = [];
  readonly created = new Map<string, ExecutionEnvironmentLocator>();
  readonly stopped = new Set<string>();
  runtimeInstanceId = "resident-queue-daemon";
  async capabilities() {
    this.calls.push("capabilities");
    return {
      protocolVersion: "execution-backend.v1" as const,
      backendRef: SRT_TASK_ENVIRONMENT_BACKEND_REF,
      runtimeInstanceId: this.runtimeInstanceId,
      guarantees: SRT_TASK_ENVIRONMENT_GUARANTEES,
      checkedAt: T1,
    };
  }
  async create(input: Parameters<ExecutionEnvironmentLifecyclePort["create"]>[0]) {
    this.calls.push("create");
    const locator: ExecutionEnvironmentLocator = {
      backendRef: SRT_TASK_ENVIRONMENT_BACKEND_REF,
      runtimeInstanceId: this.runtimeInstanceId,
      runtimeEnvironmentId: `runtime-${createHash("sha256")
        .update(input.identity.environmentId)
        .digest("hex")}`,
      createIntentId: input.createIntentId,
      effectivePolicyDigest: input.policyDigest,
    };
    this.created.set(input.createIntentId, locator);
    return locator;
  }
  async inspect(input: Parameters<ExecutionEnvironmentLifecyclePort["inspect"]>[0]) {
    this.calls.push("inspect");
    const locator = this.created.get(input.createIntentId) ?? null;
    return {
      state:
        locator === null
          ? ("not_found" as const)
          : this.stopped.has(input.createIntentId)
            ? ("stopped" as const)
            : ("running" as const),
      locator,
      observedAt: T1,
    };
  }
  async stop(input: Parameters<ExecutionEnvironmentLifecyclePort["stop"]>[0]) {
    this.calls.push("stop");
    this.stopped.add(input.createIntentId);
    return { accepted: true as const };
  }
  async verifyStopped(
    input: Parameters<ExecutionEnvironmentLifecyclePort["verifyStopped"]>[0],
  ): Promise<ExecutionEnvironmentStopProof> {
    this.calls.push("verifyStopped");
    const locator = this.created.get(input.createIntentId);
    if (!locator || !this.stopped.has(input.createIntentId))
      throw new Error("resident queue environment is still running");
    return {
      basis: "process_group_gone",
      identity: input.identity,
      createIntentId: input.createIntentId,
      stopIntentId: input.stopIntentId,
      stopFence: input.stopFence,
      verifierRef: "resident-queue-lifecycle",
      checkedAt: T1,
      validUntil: new Date(Date.parse(T1) + 300_000).toISOString(),
      evidence: [{ ref: `resident-queue-stop-${input.stopIntentId}`, digest: "d".repeat(64) }],
      locator,
    };
  }
  async destroy() {}
}

describe("[R2-P2] resident workspace admission queues behind unresolved occupancy", () => {
  if (!linux) {
    it("[R2-P2] reports that resident workspace queuing requires Linux", () => {
      expect(linux).toBe(false);
    });
    return;
  }

  const foreignRun = "run-resident-queue-foreign";
  const foreignEnvironment = "environment-resident-queue-foreign";
  const foreignJob = "execution-job-resident-queue-foreign";

  interface QueueFixture {
    readonly f: Awaited<ReturnType<typeof productionSandboxScope>>;
    readonly lifecycle: ResidentQueueLifecycle;
    readonly sent: Extract<ExecutionV2Request, { type: "work.execute" }>[];
    readonly database: Database.Database;
    readonly tool: () => ProductionRuntimeTools;
    readonly setNow: (value: string) => void;
  }

  async function queueFixture(options: { readonly seedIntent?: boolean } = {}) {
    const lifecycle = new ResidentQueueLifecycle();
    const f = await productionSandboxScope(bashBinding, (intent) => intent, {
      realRun: true,
      realFileIdentity: true,
      ...(options.seedIntent
        ? { runtimeFingerprint: residentQueueFingerprint }
        : { seedRuntimeIntent: false }),
      profileRef: "authorized-project.v1",
      callParameters: [{ command: "echo resident-queue" }],
      handleUses: 10,
      srtTaskEnvironments: {
        backendRef: SRT_TASK_ENVIRONMENT_BACKEND_REF,
        session: "srt",
        guarantees: SRT_TASK_ENVIRONMENT_GUARANTEES,
        inspectBeforeReuse: true,
        lifecycle,
      },
    });
    cleanups.push(f.close);
    const database = new Database(path.join(f.f.resource.stateRoot, "product.sqlite"));
    cleanups.push(async () => {
      database.close();
    });
    const peer = {
      ...SERVICE_AUTHORITY.product,
      agentServiceInstanceId: SERVICE_AUTHORITY.agentServiceInstanceId,
      agentServiceBootId: SERVICE_AUTHORITY.agentServiceBootId,
      workerInstanceId: SERVICE_AUTHORITY.workerInstanceId,
      workerBootId: SERVICE_AUTHORITY.workerBootId,
    };
    const registry = createProductionWorkerParentBindingRegistry({
      trustedPeerBinding: () => peer,
    });
    const sent: Extract<ExecutionV2Request, { type: "work.execute" }>[] = [];
    let counter = 0;
    let now = T1;
    const request = vi.fn(async (message: ExecutionV2Request) => {
      if (message.type === "work.delegate")
        return {
          ...message,
          kind: "response" as const,
          type: "work.delegate.accepted" as const,
          messageId: "resident-queue-accepted",
          causationId: message.messageId,
          payload: {
            handleRef: message.payload.handle.ref,
            workerBootId: peer.workerBootId,
            acceptedAt: T1,
          },
        };
      if (message.type === "work.execute") sent.push(message);
      return null;
    });
    const tool = () =>
      new ProductionRuntimeTools({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        capabilities: f.repository.capabilityStore(OWNER_ID, AGENT_ID),
        invocations: f.repository.capabilityInvocationReceiptPort(OWNER_ID, AGENT_ID),
        results: { lookupOutput: async () => undefined },
        artifacts: f.artifacts(),
        payloads: f.repository.payloadStore(OWNER_ID, AGENT_ID),
        protector: f.f.protector,
        sandbox: f.services.runtime,
        authority: () => SERVICE_AUTHORITY,
        peer: () => peer,
        parents: registry.writer,
        assertRunActive: async (runId) => {
          const current = await f.repository
            .runLifecycle(OWNER_ID, AGENT_ID, SERVICE_AUTHORITY.product)
            .readRun(runId);
          if (!current || !["accepted", "building_context", "running"].includes(current.run.status))
            throw new Error("RUN_NOT_ACTIVE");
        },
        ceiling: { ...f.input.resourceCeiling },
        clock: { now: () => now },
        ids: { next: (scope) => `${scope}:resident-queue:${++counter}` },
        transport: {
          request,
          async *events() {
            const first = sent[0];
            if (!first) return;
            yield {
              ...first,
              kind: "event" as const,
              type: "work.cancelled" as const,
              messageId: "resident-queue-cancelled",
              causationId: first.messageId,
              payload: {
                requestId: first.messageId,
                cursor: "1",
                sequence: 1,
                cancelledAt: T1,
                reasonCode: "TEST_WORKER_CANCELLED",
              },
            } satisfies ExecutionV2Event;
          },
        },
      });
    return {
      f,
      lifecycle,
      sent,
      database,
      tool,
      setNow: (value: string) => {
        now = value;
        f.setNow(value);
      },
    } satisfies QueueFixture;
  }

  function queueStatus(fixture: QueueFixture, invocationId: string) {
    return fixture.database
      .prepare(
        "SELECT status FROM sandbox_admission_queue WHERE json_extract(request_json,'$.plan.identity.invocationId')=?",
      )
      .get(invocationId) as { status: string } | undefined;
  }

  function executionCount(fixture: QueueFixture) {
    return fixture.database
      .prepare("SELECT count(*) FROM sandbox_execution_records WHERE run_id=?")
      .pluck()
      .get(RUN_ID) as number;
  }

  function environmentCount(fixture: QueueFixture) {
    return fixture.database
      .prepare(
        "SELECT count(*) FROM execution_environments e JOIN execution_jobs j ON j.execution_job_id=e.execution_job_id WHERE j.run_id=? AND e.role='primary'",
      )
      .pluck()
      .get(RUN_ID) as number;
  }

  async function seedForeignLease(fixture: QueueFixture) {
    const database = fixture.database;
    const owner = database
      .prepare("SELECT thread_id AS threadId FROM runs WHERE id=?")
      .get(RUN_ID) as { threadId: string };
    database
      .prepare(`INSERT INTO triggers (id, owner_id, agent_id, thread_id, idempotency_key,
        source_type, source_id, payload_ref, source_proof_ref, occurred_at)
        VALUES (?, ?, ?, ?, ?, 'user_message', 'fixture-source', 'restart-prompt', 'fixture-proof', ?)`)
      .run(
        `${foreignRun}-trigger`,
        OWNER_ID,
        AGENT_ID,
        owner.threadId,
        `${foreignRun}-message`,
        T1,
      );
    database
      .prepare(`INSERT INTO runs (id, owner_id, agent_id, thread_id, session_id, trigger_id,
        revision, status, created_at, updated_at)
        VALUES (?,?,?,?,?,?,1,'running',?,?)`)
      .run(
        foreignRun,
        OWNER_ID,
        AGENT_ID,
        owner.threadId,
        `${foreignRun}-session`,
        `${foreignRun}-trigger`,
        T1,
        T1,
      );
    const snapshot = JSON.parse(
      await readFile(fixture.f.capabilityDeployment.snapshotPath, "utf8"),
    ) as {
      capabilities: Array<{
        manifest: { ref: string; version: string };
        binding: { value: SandboxHostBinding };
      }>;
    };
    const entry = snapshot.capabilities.find(
      (item) =>
        item.manifest.ref === fixture.f.input.capabilityRef &&
        item.manifest.version === fixture.f.input.capabilityVersion,
    );
    if (!entry) throw new Error("capability binding missing");
    const binding = entry.binding.value;
    const grant = (
      await fixture.f.repository.readScopedState(
        OWNER_ID,
        AGENT_ID,
        hostDirectoryGrantStateKey(fixture.f.f.directoryGrant.id),
      )
    )?.value as HostDirectoryGrant | undefined;
    if (!grant) throw new Error("workspace grant missing");
    const scope = sandboxScopeSchema.parse({
      schemaVersion: "sandbox-scope.v1",
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threadId: fixture.f.call.context?.threadId ?? null,
      runId: RUN_ID,
      toolCallId: `${fixture.f.call.toolCallId}:occupancy`,
      parentToolCallId: null,
      parentRequestId: RUN_ID,
      hostId: binding.hostId,
      handleRef: fixture.f.input.handleRef,
      inputRef: fixture.f.input.inputRef,
      operation: "bash",
      authorizationRef: fixture.f.input.authorizationRef,
      modelRef: fixture.f.call.context?.modelRef ?? "model-fixture",
      profileRef: binding.profileRef,
      directoryGrant: {
        ref: grant.id,
        revision: grant.revision,
        canonicalRootId: grant.canonicalRootId,
        authorizationRef: grant.authorizationRef,
        operations: ["read"],
      },
      networkAuthorizationRef: null,
      expiresAt: grant.expiresAt,
    });
    console.log(
      `[R2-P2] resident queue claim roots=${binding.roots.some(
        (root) => root.canonicalRootId === grant.canonicalRootId,
      )} host=${scope.hostId === binding.hostId} profile=${
        scope.profileRef === binding.profileRef
      } operations=${scope.directoryGrant?.operations.length ?? 0}`,
    );
    const claim = {
      ...(await resolveSandboxWorkspaceClaim({ binding, scope })),
      ref: `workspace:${foreignEnvironment}`,
    };
    await fixture.f.repository.executionEnvironmentStore(OWNER_ID, AGENT_ID).reserve({
      authority: SERVICE_AUTHORITY,
      now: T1,
      runId: foreignRun,
      hostId: claim.hostId,
      role: "primary",
      rotationReason: "initial",
      backendRef: SRT_TASK_ENVIRONMENT_BACKEND_REF,
      envelope: {
        schemaVersion: "execution-envelope.v1",
        directories: [
          {
            hostId: claim.hostId,
            grantRef: claim.ref,
            canonicalRootId: claim.canonicalRootId ?? "root-fixture",
            access: claim.access,
            source: {
              authorizationRef: `authorization:${foreignRun}`,
              decidedBy: "user",
              delegationListRef: null,
              expiresAt: T2,
            },
          },
        ],
        network: [],
        resources: {
          cpuMillicores: 1000,
          memoryBytes: 536870912,
          maxProcesses: 128,
          privateStorageBytes: 268435456,
        },
      },
      policyDigest: "a".repeat(64),
      imageDigest: "b".repeat(64),
      runnerDigest: "c".repeat(64),
      deadlineAt: T2,
      leases: [claim],
      requestJobId: "job-resident-queue-foreign",
      ids: {
        executionJobId: foreignJob,
        environmentId: foreignEnvironment,
        createIntentId: `${foreignEnvironment}-create`,
      },
    });
  }

  async function releaseForeignLease(fixture: QueueFixture) {
    const store = fixture.f.repository.executionEnvironmentStore(OWNER_ID, AGENT_ID);
    await store.requestStop({
      authority: SERVICE_AUTHORITY,
      now: T1,
      environmentId: foreignEnvironment,
      stopIntentId: `${foreignEnvironment}-stop`,
      reason: "run_cancelled",
      stoppedResourceRefs: [],
    });
    await store.acceptRelease({
      authority: SERVICE_AUTHORITY,
      now: T1,
      environmentId: foreignEnvironment,
      proof: { basis: "create_not_dispatched" },
    });
  }

  async function settleOrQueue<T>(
    promise: Promise<T>,
    queued: () => boolean,
    timeoutMs = 15000,
  ): Promise<
    | { readonly kind: "queued" }
    | { readonly kind: "rejected"; readonly error: unknown }
    | { readonly kind: "resolved"; readonly value: T }
  > {
    const box: {
      value?:
        | { readonly kind: "rejected"; readonly error: unknown }
        | { readonly kind: "resolved"; readonly value: T };
    } = {};
    void promise.then(
      (value) => {
        box.value = { kind: "resolved", value };
      },
      (error) => {
        box.value = { kind: "rejected", error };
      },
    );
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (box.value) return box.value;
      if (queued()) return { kind: "queued" };
      if (Date.now() >= deadline) throw new Error("RESIDENT_QUEUE_TIMEOUT");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  beforeEach(() => {
    forkState.children = [];
    forkState.stderr = "";
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("[R2-P2] queues a resident call behind another Run's unresolved workspace occupancy", async () => {
    const fixture = await queueFixture();
    await seedForeignLease(fixture);
    const tool = fixture.tool();
    await tool.listAuthorized(RUN_ID, [fixture.f.input.handleRef]);
    const invoked = fixture.f.input.invocationId;
    const running = tool.execute(fixture.f.call);
    const queued = await settleOrQueue(running, () => queueStatus(fixture, invoked) !== undefined);
    expect(queued).toMatchObject({ kind: "queued" });
    expect(queueStatus(fixture, invoked)).toMatchObject({ status: "queued" });
    expect(fixture.sent).toHaveLength(0);
    expect(executionCount(fixture)).toBe(0);
    expect(environmentCount(fixture)).toBe(0);

    await releaseForeignLease(fixture);
    await expect(running).resolves.toMatchObject({ outcome: "result_unknown" });
    expect(queueStatus(fixture, invoked)).toMatchObject({ status: "admitted" });
    expect(fixture.sent).toHaveLength(1);
    expect(executionCount(fixture)).toBe(1);
    expect(environmentCount(fixture)).toBe(1);
  });

  it("[R2-P2] cancels a queued resident call without acquiring its environment", async () => {
    const fixture = await queueFixture();
    await seedForeignLease(fixture);
    const tool = fixture.tool();
    await tool.listAuthorized(RUN_ID, [fixture.f.input.handleRef]);
    const invoked = fixture.f.input.invocationId;
    const running = tool.execute(fixture.f.call);
    const queued = await settleOrQueue(running, () => queueStatus(fixture, invoked) !== undefined);
    expect(queued).toMatchObject({ kind: "queued" });
    const run = await fixture.f.repository
      .runLifecycle(OWNER_ID, AGENT_ID, SERVICE_AUTHORITY.product)
      .readRun(RUN_ID);
    if (!run) throw new Error("Run missing");
    await fixture.f.repository
      .runLifecycle(OWNER_ID, AGENT_ID, SERVICE_AUTHORITY.product)
      .cancelRun({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
        authority: SERVICE_AUTHORITY.lease,
        expectedRevision: run.revision,
        idempotencyKey: createIdempotencyKey("resident-queue-cancel"),
        commandFingerprint: "resident-queue-cancel",
        payloadRef: "restart-prompt",
      });
    const cancelled = await running.then(
      (value) => ({ resolved: value }),
      (error: unknown) => ({ rejected: error }),
    );
    expect(cancelled).toMatchObject({
      rejected: expect.objectContaining({ message: "RUN_NOT_ACTIVE" }),
    });
    expect(queueStatus(fixture, invoked)).toMatchObject({ status: "cancelled" });
    expect(fixture.sent).toHaveLength(0);
    expect(executionCount(fixture)).toBe(0);
    expect(environmentCount(fixture)).toBe(0);
  });

  it("[R2-P2] refuses a resident call while its own Run still occupies the workspace", async () => {
    const fixture = await queueFixture();
    const tool = fixture.tool();
    await tool.listAuthorized(RUN_ID, [fixture.f.input.handleRef]);
    const first = { ...fixture.f.call, toolCallId: `${fixture.f.call.toolCallId}:first` };
    await expect(tool.execute(first)).resolves.toMatchObject({ outcome: "result_unknown" });
    const environmentsAfterFirst = environmentCount(fixture);
    const createsAfterFirst = fixture.lifecycle.calls.filter((call) => call === "create").length;
    expect(executionCount(fixture)).toBe(1);
    fixture.lifecycle.runtimeInstanceId = "resident-queue-daemon-restarted";
    const invoked = fixture.f.input.invocationId;
    const second = { ...fixture.f.call, toolCallId: `${fixture.f.call.toolCallId}:second` };
    const running = tool.execute(second);
    const settled = await settleOrQueue(
      running,
      () => queueStatus(fixture, invoked) !== undefined,
      20000,
    );
    if (settled.kind === "queued") fixture.setNow(fixture.f.input.deadlineAt);
    const final =
      settled.kind === "queued" ? await settleOrQueue(running, () => false, 20000) : settled;
    expect(final).toMatchObject({
      kind: "resolved",
      value: { dispatchState: "not_sent", outcome: "failed" },
    });
    const queued = queueStatus(fixture, invoked)?.status;
    expect(queued === undefined || queued === "cancelled").toBe(true);
    expect(fixture.sent).toHaveLength(1);
    expect(environmentCount(fixture)).toBe(environmentsAfterFirst);
    expect(fixture.lifecycle.calls.filter((call) => call === "create")).toHaveLength(
      createsAfterFirst,
    );
  });

  it("[R2-P2] ends a queued resident call at its deadline without dispatching", async () => {
    const fixture = await queueFixture();
    await seedForeignLease(fixture);
    const tool = fixture.tool();
    await tool.listAuthorized(RUN_ID, [fixture.f.input.handleRef]);
    const invoked = fixture.f.input.invocationId;
    const running = tool.execute(fixture.f.call);
    const queued = await settleOrQueue(running, () => queueStatus(fixture, invoked) !== undefined);
    expect(queued).toMatchObject({ kind: "queued" });
    fixture.setNow(fixture.f.input.deadlineAt);
    await expect(running).resolves.toMatchObject({
      dispatchState: "not_sent",
      outcome: "failed",
    });
    expect(queueStatus(fixture, invoked)).toMatchObject({ status: "cancelled" });
    expect(fixture.sent).toHaveLength(0);
    expect(executionCount(fixture)).toBe(0);
    expect(environmentCount(fixture)).toBe(0);
  });

  it("[R2-P2] acquires the environment when a restart re-dispatches an already queued resident call", async () => {
    const fixture = await queueFixture({ seedIntent: true });
    const prepared = await fixture.f.services.runtime.prepare(fixture.f.input, fixture.f.call);
    if (!("reservation" in prepared)) throw new Error("expected sandbox-execution.v2 admission");
    const position = await fixture.f.services.brokerV2.preparations.enqueue({
      ...prepared,
      invocation: fixture.f.input,
    });
    expect(position.status).toBe("queued");
    const tool = fixture.tool();
    await tool.listAuthorized(RUN_ID, [fixture.f.input.handleRef]);
    const invoked = fixture.f.input.invocationId;
    const createsBefore = fixture.lifecycle.calls.filter((call) => call === "create").length;
    const running = tool.execute(fixture.f.call);
    await expect(running).resolves.toMatchObject({ outcome: "result_unknown" });
    expect(fixture.lifecycle.calls.filter((call) => call === "create")).toHaveLength(
      createsBefore + 1,
    );
    expect(environmentCount(fixture)).toBe(1);
    expect(fixture.sent).toHaveLength(1);
    expect(queueStatus(fixture, invoked)).toMatchObject({ status: "admitted" });
  });
});
