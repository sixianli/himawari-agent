// biome-ignore-all lint/complexity/useLiteralKeys: mock repository uses dynamic ports
import { PassThrough } from "node:stream";
import { EXECUTION_UDS_ERROR_CODES, ExecutionUdsError } from "@himawari-agent/platform-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runAgentService,
  startTenantRuntime,
  TENANT_RUNTIME_ERROR_CODES,
  type StartTenantRuntimeInput,
} from "../src/service-main.js";

const boundary = vi.hoisted(() => ({
  load: vi.fn(),
  initialize: vi.fn(),
  authorityFile: vi.fn(),
  persistedAuthority: vi.fn(),
  database: vi.fn(),
  status: vi.fn(),
  open: vi.fn(),
  token: vi.fn(),
  boot: vi.fn(),
  writeBoot: vi.fn(),
  authority: vi.fn(),
  admissionStart: vi.fn(),
  admissionStop: vi.fn(),
  payloadStart: vi.fn(),
  payloadStop: vi.fn(),
  connect: vi.fn(),
  stopWorker: vi.fn(),
  workerReady: vi.fn(),
  checkWorkerReady: vi.fn(),
  recoverJobs: vi.fn(),
  recoverExecutions: vi.fn(),
  fileRead: vi.fn(),
  sandbox: vi.fn(),
  key: vi.fn(),
  modelComposition: vi.fn(),
  memoryComposition: vi.fn(),
  http: vi.fn(),
  runs: vi.fn(),
  memoryWorker: vi.fn(),
  durableMemory: vi.fn(),
  memoryRecall: vi.fn(),
  events: [] as string[],
}));
vi.mock("@himawari-agent/platform-node", async (original) => ({
  ...(await original<object>()),
  JsonFileConfigurationPort: class {
    load = boundary.load;
  },
  SystemdCredentialSecretSource: class {
    kind = "systemd-credential";
    productionSuitable = true;
    resolve = boundary.key;
  },
  MacOsKeychainSecretSource: class {
    kind = "macos-keychain";
    productionSuitable = true;
    resolve = boundary.key;
  },
  initializeStateRoot: boundary.initialize,
  readAuthorityFile: boundary.authorityFile,
  readRestrictedExecutionTokenFile: boundary.token,
  readWorkerServiceBootBinding: boundary.boot,
  writeAgentServiceBootBinding: boundary.writeBoot,
  ExecutionAdmissionUdsServer: class {
    start = boundary.admissionStart;
    stop = boundary.admissionStop;
  },
  PayloadUdsServer: class {
    start = boundary.payloadStart;
    stop = boundary.payloadStop;
  },
}));
vi.mock("@himawari-agent/persistence-sqlite", async (original) => ({
  ...(await original<object>()),
  inspectDeploymentAuthorityReadOnly: boundary.persistedAuthority,
  openQualifiedDatabase: boundary.database,
  readSqliteRuntimeStatus: boundary.status,
  SqliteProductStateRepository: { open: boundary.open },
}));
vi.mock("@himawari-agent/application", async (original) => {
  const actual = await original<typeof import("@himawari-agent/application")>();
  return {
    ...actual,
    DurableMemoryService: class extends actual.DurableMemoryService {
      constructor(options: ConstructorParameters<typeof actual.DurableMemoryService>[0]) {
        super(options);
        boundary.durableMemory(options);
      }
    },
    recoverSandboxJobsAtStartup: boundary.recoverJobs,
    recoverSandboxExecutionsAtStartup: boundary.recoverExecutions,
  };
});
vi.mock("../src/production-memory-recall.js", async (original) => {
  const actual = await original<typeof import("../src/production-memory-recall.js")>();
  return {
    ...actual,
    ProductionMemoryRecall: class extends actual.ProductionMemoryRecall {
      constructor(options: ConstructorParameters<typeof actual.ProductionMemoryRecall>[0]) {
        super(options);
        boundary.memoryRecall(options);
      }
    },
  };
});
vi.mock("../src/production-model-composition.js", () => ({
  createProductionModelCompositionFromConfiguration: boundary.modelComposition,
}));
vi.mock("../src/production-memory-composition.js", () => ({
  createProductionMemoryCompositionFromConfiguration: boundary.memoryComposition,
}));
vi.mock("../src/production-http-composition.js", () => ({
  createProductionHttpComposition: boundary.http,
}));
vi.mock("../src/production-run-composition.js", () => ({
  createProductionRunComposition: boundary.runs,
}));
vi.mock("../src/production-memory-worker.js", () => ({
  ProductionMemoryWorker: class {
    constructor(options: unknown) {
      boundary.memoryWorker(options);
    }
    start = async () => {
      boundary.events.push("memory-worker.start");
    };
    stopAccepting = vi.fn();
    drain = vi.fn();
  },
}));
vi.mock("../src/production-authority-lifecycle.js", () => ({
  createProductionAuthorityLifecycle: boundary.authority,
}));
vi.mock("../src/production-execution-client.js", () => ({
  AgentServiceExecutionClient: class {
    start = boundary.connect;
    stop = boundary.stopWorker;
    isReady = boundary.workerReady;
    checkReadiness = boundary.checkWorkerReady;
  },
}));
vi.mock("../src/production-file-read-services.js", () => ({
  createProductionFileReadServices: boundary.fileRead,
}));
vi.mock("../src/production-sandbox-services.js", () => ({
  createProductionSandboxServices: boundary.sandbox,
}));

const authority = {
  id: "deployment-entry",
  ownerId: "owner-entry",
  agentId: "agent-entry",
  status: "active",
  transferId: null,
  authorityEpoch: 1,
  fencingToken: 1,
};
let configuration: ReturnType<typeof config>;
let mockListenPort = 43117;
let repository: {
  close: ReturnType<typeof vi.fn>;
  startupRecovery: ReturnType<typeof vi.fn>;
  [key: string]: unknown;
};
let lease: {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  startAutomaticRenewal: ReturnType<typeof vi.fn>;
  assertActive: ReturnType<typeof vi.fn>;
  isAccepting: ReturnType<typeof vi.fn>;
  authorityFence: ReturnType<typeof vi.fn>;
  authorityLease: ReturnType<typeof vi.fn>;
};
let output: PassThrough, errors: PassThrough, stdout: string, stderr: string;
let signal: (() => void) | undefined;
let exit: Promise<number> | undefined;
function config() {
  const modelDescriptors: Array<{
    ref: string;
    role: string;
    provider: string;
    model?: string;
    version?: string;
    dimensions?: number;
  }> = [
    { ref: "primary", role: "primary", provider: "deterministic" },
    {
      ref: "embedding",
      role: "embedding",
      provider: "deterministic",
      model: "embedding",
      version: "v1",
      dimensions: 16,
    },
  ];
  return {
    deploymentId: authority.id,
    ownerId: authority.ownerId,
    agentId: authority.agentId,
    stateRoot: "/fixture-state",
    runtimeDirectory: "/fixture-state/runtime",
    cacheDirectory: "/fixture-state/cache",
    publicMode: false,
    http: undefined as unknown,
    identity: undefined as unknown,
    runPolicy: undefined as unknown,
    modelDescriptors,
    secretReferences: [{ ref: "payload-kek", version: "v1", purpose: "payload-encryption" }],
    deadlines: { runMs: 1000, workerRequestMs: 150, providerRequestMs: 1000 },
    concurrency: { totalRuns: 2, foregroundReserved: 1, perCategory: {} },
  };
}
function start() {
  exit = runAgentService(
    [
      "--config",
      "/fixture-config.json",
      "--worker-token-file",
      "/fixture-token.json",
      "--profile",
      "production",
    ],
    output,
    errors,
  );
  return exit;
}
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  signal = undefined;
  exit = undefined;
  boundary.events = [];
  mockListenPort = 43117;
  configuration = config();
  boundary.load.mockImplementation(async () => configuration);
  output = new PassThrough();
  errors = new PassThrough();
  stdout = "";
  stderr = "";
  output.on("data", (data) => {
    stdout += data.toString();
  });
  errors.on("data", (data) => {
    stderr += data.toString();
  });
  const once = process.once.bind(process);
  vi.spyOn(process, "once").mockImplementation((event, listener) => {
    if (event === "SIGTERM" || event === "SIGINT") {
      signal = listener as () => void;
      return process;
    }
    return once(event, listener);
  });
  boundary.initialize.mockResolvedValue({
    data: "/fixture-state/data",
    runtime: "/fixture-state/runtime",
  });
  boundary.authorityFile.mockResolvedValue(authority);
  boundary.persistedAuthority.mockReturnValue(authority);
  boundary.database.mockReturnValue({ close: vi.fn() });
  boundary.status.mockReturnValue({ quickCheck: "ok", sqliteVersion: "fixture" });
  repository = {
    close: vi.fn(async () => {
      boundary.events.push("repository.close");
    }),
    startupRecovery: vi.fn(async () => ({
      unfinishedRunKeys: [],
      pendingApprovalRequestIds: [],
      retryableJobOccurrenceIds: [],
      expiredWorkLeaseOccurrenceIds: [],
      blockedOccurrenceIds: [],
      pendingDeliveryRequestIds: [],
    })),
  };
  for (const key of [
    "deploymentAuthorityPort",
    "authorityLeasePort",
    "sandboxJobJournal",
    "sandboxExecutionJournal",
    "sandboxExecutionPreparations",
    "capabilityInvocationReceiptPort",
    "capabilityInvocationResultPort",
    "memoryIndex",
    "memoryEpisodes",
    "conversationTurns",
    "externalMemoryProposals",
    "mcpMemorySync",
    "memoryConsolidation",
    "threadRepository",
    "sensitiveInterceptions",
  ])
    repository[key] = vi.fn(() => ({}));
  repository["ledgerObservation"] = vi.fn(() => ({
    ensureSnapshot: vi.fn(async () => {}),
    beat: vi.fn(async () => {}),
    readStart: vi.fn(async () => null),
    listChecks: vi.fn(async () => []),
  }));
  boundary.open.mockResolvedValue(repository);
  lease = {
    start: vi.fn(async () => {
      boundary.events.push("authority.start");
    }),
    stop: vi.fn(async () => {
      boundary.events.push("authority.stop");
    }),
    startAutomaticRenewal: vi.fn(),
    assertActive: vi.fn(),
    isAccepting: vi.fn(() => true),
    authorityFence: vi.fn(() => ({
      deploymentId: authority.id,
      authorityEpoch: 1,
      fencingToken: 1,
    })),
    authorityLease: vi.fn(() => ({ leaseId: "lease-entry", fencingToken: 1 })),
  };
  boundary.authority.mockReturnValue(lease);
  boundary.token.mockResolvedValue({
    tokenRef: "worker-credential",
    tokenValue: "synthetic-component-value",
  });
  boundary.boot.mockResolvedValue({
    ...authority,
    deploymentId: authority.id,
    workerInstanceId: `execution-worker:${authority.id}`,
    workerBootId: "worker-boot",
  });
  boundary.admissionStart.mockImplementation(async () => {
    boundary.events.push("admission.start");
  });
  boundary.payloadStart.mockImplementation(async () => {
    boundary.events.push("payload.start");
  });
  boundary.admissionStop.mockImplementation(async () => {
    boundary.events.push("admission.stop");
  });
  boundary.payloadStop.mockImplementation(async () => {
    boundary.events.push("payload.stop");
  });
  boundary.stopWorker.mockImplementation(() => {
    boundary.events.push("worker.stop");
  });
  boundary.connect.mockResolvedValue({
    payload: { ready: true, selectedSchemaVersion: "execution.v2" },
  });
  boundary.workerReady.mockReturnValue(true);
  boundary.checkWorkerReady.mockResolvedValue(true);
  boundary.key.mockResolvedValue(new Uint8Array(32).fill(3));
  boundary.fileRead.mockReturnValue({});
  boundary.sandbox.mockResolvedValue(undefined);
});
afterEach(async () => {
  signal?.();
  await settle();
  if (exit) await exit;
  output.destroy();
  errors.destroy();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("agent service startup ownership", () => {
  it("[R2-T6] reports the actual bound listen port in service.ready", async () => {
    web();
    start();
    await settle();
    const line = stdout
      .split("\n")
      .find((candidate) => candidate.includes('"event":"service.ready"'));
    if (!line) throw new Error("SERVICE_READY_MISSING");
    expect(JSON.parse(line).listenPort).toBe(mockListenPort);
  });
  it("[R2-T6] reports port 80 as 80 instead of the URL default", async () => {
    mockListenPort = 80;
    web();
    start();
    await settle();
    const line = stdout
      .split("\n")
      .find((candidate) => candidate.includes('"event":"service.ready"'));
    if (!line) throw new Error("SERVICE_READY_MISSING");
    expect(JSON.parse(line).listenPort).toBe(80);
  });
  it("leaves the whole-database check to the repository so one startup scans the database once", async () => {
    start();
    await settle();
    expect(boundary.open).toHaveBeenCalledOnce();
    expect(boundary.database).not.toHaveBeenCalled();
    expect(boundary.status).not.toHaveBeenCalled();
  });

  it("reports each startup step in order with the time since the process started", async () => {
    start();
    await settle();
    const lines = stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const steps = lines.filter((line) => line["event"] === "startup.step");
    expect(steps.map((line) => line["step"])).toEqual([
      "state-opened",
      "authority-claimed",
      "worker-binding-read",
      "sandbox-recovered",
      "coding-network-resolved",
      "workspace-synced",
      "sandbox-services-created",
      "agent-binding-written",
      "worker-connected",
    ]);
    const elapsed = steps.map((line) => line["elapsedMs"] as number);
    expect(elapsed.every((value) => Number.isInteger(value) && value >= 0)).toBe(true);
    expect([...elapsed].sort((left, right) => left - right)).toEqual(elapsed);
    expect(lines.findIndex((line) => line["event"] === "service.ready")).toBeGreaterThan(
      lines.indexOf(steps.at(-1) as Record<string, unknown>),
    );
  });
  it("recovers before publishing boot, connects the worker, then drains in dependency order", async () => {
    start();
    await settle();
    expect(stdout).toContain('"event":"service.ready"');
    expect(stderr).toBe("");
    expect(boundary.recoverJobs).toHaveBeenCalledOnce();
    expect(boundary.recoverExecutions).toHaveBeenCalledOnce();
    expect(boundary.writeBoot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workerBootId: "worker-boot", authorityLeaseId: "lease-entry" }),
    );
    expect(boundary.events.slice(0, 3)).toEqual([
      "authority.start",
      "admission.start",
      "payload.start",
    ]);
    signal?.();
    await settle();
    expect(await exit).toBe(0);
    expect(stdout).toContain('"event":"service.stopped"');
    expect(boundary.events.slice(-5)).toEqual([
      "admission.stop",
      "payload.stop",
      "worker.stop",
      "authority.stop",
      "repository.close",
    ]);
    expect(repository.close).toHaveBeenCalledOnce();
  });
  it.each([
    "public-incomplete",
    "payload-key",
    "inactive",
    "wrong-owner",
    "persisted-mismatch",
    "open",
    "claim",
    "claimed-fence",
    "missing-embedding",
    "boot",
    "worker",
  ])("fails closed and releases owned resources for %s", async (kind) => {
    if (kind === "public-incomplete") configuration.publicMode = true;
    if (kind === "payload-key") configuration.secretReferences = [];
    if (kind === "inactive")
      boundary.authorityFile.mockResolvedValue({ ...authority, status: "inactive" });
    if (kind === "wrong-owner")
      boundary.authorityFile.mockResolvedValue({ ...authority, ownerId: "other" });
    if (kind === "persisted-mismatch")
      boundary.persistedAuthority.mockReturnValue({ ...authority, transferId: "transfer" });
    if (kind === "open") boundary.open.mockRejectedValue(new Error("SQLITE_STATE_ROOT_LOCKED"));
    if (kind === "claim") lease.start.mockRejectedValue(new Error("AGENT_AUTHORITY_INACTIVE"));
    if (kind === "claimed-fence")
      boundary.authorityFile
        .mockResolvedValueOnce(authority)
        .mockResolvedValue({ ...authority, fencingToken: 2 });
    if (kind === "missing-embedding")
      configuration.modelDescriptors = configuration.modelDescriptors.filter(
        (item) => item.role !== "embedding",
      );
    if (kind === "boot") boundary.boot.mockResolvedValue(undefined);
    if (kind === "worker") boundary.connect.mockResolvedValue({ payload: { ready: false } });
    start();
    await vi.advanceTimersByTimeAsync(200);
    expect(await exit).toBe(1);
    expect(stdout).not.toContain('"event":"service.ready"');
    expect(stderr).toContain('"event":"service.failed"');
    if (["claim", "claimed-fence", "missing-embedding", "boot", "worker"].includes(kind))
      expect(repository.close).toHaveBeenCalledOnce();
  });
  it("shuts down the first reverse socket if the second socket cannot start", async () => {
    boundary.payloadStart.mockRejectedValue(new Error("payload bind failed"));
    start();
    await settle();
    expect(await exit).toBe(1);
    expect(boundary.admissionStop).toHaveBeenCalledOnce();
    expect(boundary.connect).not.toHaveBeenCalled();
    expect(repository.close).toHaveBeenCalledOnce();
  });
  it("retries a transient transport failure within the declared startup budget", async () => {
    boundary.connect.mockRejectedValueOnce(
      new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.TRANSPORT_UNAVAILABLE, 503),
    );
    start();
    await vi.advanceTimersByTimeAsync(60);
    expect(boundary.connect).toHaveBeenCalledTimes(2);
    expect(stdout).toContain('"event":"service.ready"');
  });
  it("loses readiness and stops reverse services when its authority is revoked", async () => {
    start();
    await settle();
    expect(stdout).toContain('"event":"service.ready"');
    boundary.authority.mock.calls[0]?.[0].onLost(new Error("AGENT_AUTHORITY_LOST"), {
      msSinceLastRenewal: 12_000,
    });
    await settle();
    expect(await exit).toBe(1);
    expect(stdout).toContain('"signal":"AUTHORITY_LOST"');
    expect(stdout).toMatch(/"event":"service.draining"[^\n]*"code":"AGENT_AUTHORITY_LOST"/);
    expect(stderr).toContain('"event":"authority.lost"');
    expect(stderr).toContain('"code":"AGENT_AUTHORITY_LOST"');
    expect(stderr).toContain('"msSinceLastRenewal":12000');
    expect(boundary.admissionStop).toHaveBeenCalledOnce();
    expect(boundary.stopWorker).toHaveBeenCalledOnce();
  });
});

describe("signal exit diagnostics", () => {
  it("does not report an authority loss or an error code when stopped by a signal", async () => {
    start();
    await settle();
    expect(stdout).toContain('"event":"service.ready"');
    signal?.();
    await settle();
    expect(await exit).toBe(0);
    expect(stdout).toMatch(/"event":"service.draining"[^\n]*"signal":"SIGTERM"/);
    expect(stdout).not.toMatch(/"event":"service.draining"[^\n]*"code"/);
    expect(stderr).not.toContain('"event":"authority.lost"');
  });

  it("names an unknown loss cause instead of calling it a startup failure", async () => {
    start();
    await settle();
    boundary.authority.mock.calls[0]?.[0].onLost(new Error("plain failure"), {
      msSinceLastRenewal: null,
    });
    await settle();
    expect(await exit).toBe(1);
    expect(stdout).toMatch(/"event":"service.draining"[^\n]*"code":"AUTHORITY_LOSS_CODE_UNKNOWN"/);
    expect(stderr).toContain('"code":"AUTHORITY_LOSS_CODE_UNKNOWN"');
    expect(stderr).not.toContain('"msSinceLastRenewal"');
  });
});

describe("resource recovery without web Run dispatch", () => {
  it("starts after recovery and worker readiness, then drains before its dependencies close", async () => {
    let recoverySignal: AbortSignal | undefined;
    let finish: (() => void) | undefined;
    const recoverPending = vi.fn(async (signal_: AbortSignal) => {
      recoverySignal = signal_;
      boundary.events.push("resource-recovery.start");
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      boundary.events.push("resource-recovery.finished");
    });
    boundary.recoverExecutions.mockImplementation(async () => {
      boundary.events.push("recovery.register");
    });
    boundary.connect.mockImplementation(async () => {
      boundary.events.push("worker.ready");
      return { payload: { ready: true, selectedSchemaVersion: "execution.v2" } };
    });
    boundary.sandbox.mockResolvedValue({ resources: { recoverPending } });
    start();
    await settle();
    expect(stdout).toContain('"event":"service.ready"');
    expect(recoverPending).toHaveBeenCalledWith(expect.any(AbortSignal), 2);
    expect(boundary.events.indexOf("resource-recovery.start")).toBeGreaterThan(
      boundary.events.indexOf("recovery.register"),
    );
    expect(boundary.events.indexOf("resource-recovery.start")).toBeGreaterThan(
      boundary.events.indexOf("worker.ready"),
    );
    expect(boundary.runs).not.toHaveBeenCalled();
    expect(boundary.modelComposition).not.toHaveBeenCalled();
    expect(boundary.http).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(recoverPending).toHaveBeenCalledOnce();
    signal?.();
    await settle();
    expect(recoverySignal?.aborted).toBe(true);
    expect(repository.close).not.toHaveBeenCalled();
    finish?.();
    await settle();
    expect(await exit).toBe(0);
    expect(boundary.events.indexOf("resource-recovery.finished")).toBeLessThan(
      boundary.events.indexOf("repository.close"),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(recoverPending).toHaveBeenCalledOnce();
  });

  it.each(["worker", "payload", "authority"])(
    "does not start resource scans after %s startup failure",
    async (stage) => {
      const recoverPending = vi.fn(async () => {});
      boundary.sandbox.mockResolvedValue({ resources: { recoverPending } });
      if (stage === "worker")
        boundary.connect.mockRejectedValue(new Error("WORKER_STARTUP_FAILED"));
      if (stage === "payload")
        boundary.payloadStart.mockRejectedValue(new Error("PAYLOAD_STARTUP_FAILED"));
      if (stage === "authority")
        boundary.connect.mockImplementation(async () => {
          boundary.authority.mock.calls[0]?.[0].onLost(new Error("AGENT_AUTHORITY_LOST"), {
            msSinceLastRenewal: 12_000,
          });
          return { payload: { ready: true, selectedSchemaVersion: "execution.v2" } };
        });
      start();
      await settle();
      expect(await exit).toBe(1);
      expect(recoverPending).not.toHaveBeenCalled();
      expect(stdout).not.toContain('"event":"service.ready"');
      expect(repository.close).toHaveBeenCalledOnce();
    },
  );

  it.each(["signal", "authority"])("cancels a running recovery on %s shutdown", async (cause) => {
    let received: AbortSignal | undefined;
    const recoverPending = vi.fn(async (input: AbortSignal) => {
      received = input;
      await new Promise<void>((resolve) =>
        input.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    boundary.sandbox.mockResolvedValue({ resources: { recoverPending } });
    start();
    await settle();
    expect(recoverPending).toHaveBeenCalledOnce();
    if (cause === "signal") signal?.();
    else
      boundary.authority.mock.calls[0]?.[0].onLost(new Error("AGENT_AUTHORITY_LOST"), {
        msSinceLastRenewal: 12_000,
      });
    await settle();
    expect(received?.aborted).toBe(true);
    expect(await exit).toBe(cause === "signal" ? 0 : 1);
    expect(repository.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(recoverPending).toHaveBeenCalledOnce();
  });

  it("ends startup/runtime on recovery storage failure without retrying or exposing diagnostics", async () => {
    const recoverPending = vi.fn(async () => {
      throw new Error("private database failure");
    });
    boundary.sandbox.mockResolvedValue({ resources: { recoverPending } });
    start();
    await settle();
    expect(recoverPending).toHaveBeenCalledOnce();
    expect(await exit).toBe(1);
    expect(stderr).toContain('"event":"runtime.failed"');
    expect(stderr).not.toContain("private database failure");
    expect(repository.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect(recoverPending).toHaveBeenCalledOnce();
  });

  it("checks current authority before every fallback scan", async () => {
    const recoverPending = vi.fn(async () => {});
    boundary.sandbox.mockResolvedValue({ resources: { recoverPending } });
    start();
    await settle();
    expect(recoverPending).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(recoverPending).toHaveBeenCalledTimes(2);
    lease.assertActive.mockRejectedValue(new Error("AGENT_AUTHORITY_LOST"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await exit).toBe(1);
    expect(recoverPending).toHaveBeenCalledTimes(2);
  });

  it("bounds shutdown even when a faulty recovery port ignores cancellation", async () => {
    let release: (() => void) | undefined;
    const recoverPending = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    boundary.sandbox.mockResolvedValue({ resources: { recoverPending } });
    start();
    await settle();
    expect(recoverPending).toHaveBeenCalledOnce();
    signal?.();
    await settle();
    expect(repository.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(configuration.deadlines.providerRequestMs + 30000);
    expect(repository.close).toHaveBeenCalledOnce();
    expect(await exit).toBe(1);
    expect(stderr).toContain('"event":"service.failed"');
    release?.();
    await settle();
    expect(recoverPending).toHaveBeenCalledOnce();
  });

  it.each(["public", "built-in"])(
    "leaves %s resource recovery on its existing Run loop without a second scanner",
    async (mode) => {
      const f = web();
      if (mode === "built-in") {
        configuration.publicMode = false;
        configuration.identity = { kind: "built-in" };
      }
      const resources = {
        recoverPending: vi.fn(async () => {}),
        stopRun: vi.fn(async () => ({ released: true })),
      };
      boundary.sandbox.mockResolvedValue({ resources });
      start();
      await settle();
      expect(stdout).toContain('"event":"service.ready"');
      expect(boundary.runs.mock.calls[0]?.[0].resources).toBe(resources);
      expect(f.runs.loop.start).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2000);
      expect(resources.recoverPending).not.toHaveBeenCalled();
    },
  );
});

function web() {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const primary = {
    ref: "primary",
    role: "primary",
    provider: "openrouter",
    model: "fixture",
    version: "1",
    name: "Fixture",
    routingClass: "primary",
    priority: 1,
    disclosure: "external_remote",
    allowedDataClassifications: ["private"],
    capabilities: ["text"],
    secretRequirement: null,
    contextWindow: 8192,
    maxTokens: 1024,
    cost,
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
  };
  configuration.publicMode = true;
  configuration.http = {};
  configuration.identity = {};
  configuration.runPolicy = {};
  configuration.modelDescriptors = [
    primary,
    { ...primary, ref: "embedding", role: "embedding", dimensions: 16 },
  ];
  const port = { get: vi.fn(), listRunExecutionHandles: vi.fn() };
  for (const key of [
    "payloadStore",
    "productMemoryState",
    "memoryBook",
    "memoryReminders",
    "ownerRules",
    "ownerProposals",
    "ruleReviews",
    "memoryReviews",
    "memoryProjectionJobs",
    "runPayloadArtifactPort",
    "capabilityStore",
    "authorizationStore",
    "auditLedger",
    "runExecutionSource",
    "modelBudgetPort",
    "modelUsage",
    "decisionLedger",
    "gapCaseMarks",
    "perception",
    "pairedDevices",
    "deviceActions",
    "vault",
  ])
    repository[key] = vi.fn(() => port);
  const memory = {
    projection: {},
    dedupeSameSource: false,
    bindEmbeddingBoundary: vi.fn(),
    descriptor: configuration.modelDescriptors[1],
    close: vi.fn(async () => {
      boundary.events.push("memory.close");
    }),
  };
  const model = {
    descriptors: { generation: [primary], embedding: configuration.modelDescriptors[1] },
    composition: {
      generateTitle: vi.fn(),
      piModels: {
        resolve: vi.fn(async () => ({
          descriptor: primary,
          model: { ...primary, id: primary.model, baseUrl: "https://fixture.invalid" },
        })),
      },
      close: vi.fn(async () => {
        boundary.events.push("model.close");
      }),
    },
  };
  boundary.modelComposition.mockResolvedValue(model);
  boundary.memoryComposition.mockResolvedValue(memory);
  const runs = {
    admission: vi.fn(),
    dispatcher: { stopAccepting: vi.fn() },
    coordinator: { cancel: vi.fn(), interruptAllExecutions: vi.fn() },
    loop: {
      state: "running",
      start: vi.fn(async () => {
        boundary.events.push("runs.start");
      }),
      stop: vi.fn(async () => ({ drained: true })),
    },
    titles: { stop: vi.fn() },
  };
  boundary.runs.mockReturnValue(runs);
  const http = {
    app: { addHook: vi.fn(), server: { address: () => ({ port: mockListenPort }) } },
    assertIdentityReady: vi.fn(),
    listen: vi.fn(async () => {
      boundary.events.push("http.listen");
      return `http://127.0.0.1:${mockListenPort}`;
    }),
    close: vi.fn(async () => {
      boundary.events.push("http.close");
    }),
  };
  boundary.http.mockResolvedValue(http);
  return { model, memory, runs, http, port };
}
describe("web service composition and readiness", () => {
  it("registers specialist pricing without asking Pi to present the reviewer", async () => {
    const f = web();
    const primary = f.model.descriptors.generation[0];
    if (!primary) throw new Error("PRIMARY_FIXTURE_MISSING");
    f.model.descriptors.generation.push({
      ...primary,
      ref: "review-specialist",
      api: "typesafe-systemone",
      routingClass: "specialist",
      provider: "typesafe",
      model: "jev-latest",
      cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    start();
    await settle();
    expect(boundary.runs.mock.calls[0]?.[0].modelRegistry).toContainEqual(
      expect.objectContaining({
        ref: "review-specialist",
        estimatedCostMicros: Math.ceil(65_536 * 0.042),
      }),
    );
    expect(boundary.http.mock.calls[0]?.[0].modelCatalog).toMatchObject([{ ref: "primary" }]);
    expect(f.model.composition.piModels.resolve).toHaveBeenCalledWith("primary");
    expect(f.model.composition.piModels.resolve).not.toHaveBeenCalledWith("review-specialist");
    signal?.();
    await settle();
    expect(await exit).toBe(0);
  });
  it("binds the default model admission to the Run boot lease consumer", async () => {
    const f = web();
    const gate = {
      context: { ownerId: authority.ownerId, agentId: authority.agentId, runId: "run-fixture" },
      begin: vi.fn(),
    };
    f.runs.admission.mockReturnValue(gate);
    repository["runDispatch"] = vi.fn((_ownerId, _agentId, _fence, _lease, consumerId) => ({
      currentExecutionLease: vi.fn(async () => ({
        executionLeaseId: "execution-fixture",
        revision: 1,
        authorityLeaseId: "lease-entry",
        deploymentId: authority.id,
        authorityEpoch: 1,
        fencingToken: 1,
        consumerId,
        releasedAt: null,
      })),
    }));
    start();
    await settle();
    const runOptions = boundary.runs.mock.calls[0]?.[0];
    const modelOptions = boundary.modelComposition.mock.calls[0]?.[0];
    expect(boundary.durableMemory).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeSameSource: false }),
    );
    expect(boundary.memoryRecall).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeSameSource: false }),
    );
    expect(modelOptions.admission).toEqual(expect.any(Function));
    expect(
      await modelOptions.admission({
        ownerId: authority.ownerId,
        agentId: authority.agentId,
        runId: "run-fixture",
      }),
    ).toBe(gate);
    expect(repository["runDispatch"]).toHaveBeenCalledWith(
      authority.ownerId,
      authority.agentId,
      expect.anything(),
      expect.anything(),
      runOptions.instanceId,
    );
    expect(f.runs.admission).toHaveBeenCalledWith(
      expect.objectContaining({
        executionLease: expect.objectContaining({ consumerId: runOptions.instanceId }),
      }),
    );
    signal?.();
    await settle();
    expect(await exit).toBe(0);
  });
  it("closes title consumers even when the Run loop drain rejects", async () => {
    const f = web();
    f.runs.loop.stop.mockRejectedValue(new Error("RUN_DRAIN_FAILED"));
    start();
    await settle();
    signal?.();
    await settle();
    expect(await exit).toBe(1);
    expect(f.runs.titles.stop).toHaveBeenCalledOnce();
    expect(repository.close).toHaveBeenCalledOnce();
    expect(f.model.composition.close).toHaveBeenCalledOnce();
  });

  it("stops background scans while Run interruption is still draining", async () => {
    const f = web();
    let finish = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.runs.coordinator.interruptAllExecutions.mockImplementation(() => pending);
    start();
    await settle();
    try {
      signal?.();
      await settle();
      expect(f.runs.loop.stop).toHaveBeenCalledOnce();
      expect(repository.close).not.toHaveBeenCalled();
    } finally {
      finish();
    }
    await settle();
    expect(await exit).toBe(0);
    expect(f.runs.loop.stop).toHaveBeenCalledOnce();
    expect(repository.close).toHaveBeenCalledOnce();
  });

  it.each(["linux", "darwin"])(
    "opens HTTP only after memory and dispatch are ready on %s, then closes models after consumers",
    async (platform) => {
      vi.stubGlobal("process", Object.create(process, { platform: { value: platform } }));
      const f = web();
      start();
      await settle();
      expect(stderr).toBe("");
      expect(stdout).toContain('"event":"service.ready"');
      expect(boundary.events.slice(-3)).toEqual([
        "memory-worker.start",
        "runs.start",
        "http.listen",
      ]);
      const options = boundary.http.mock.calls[0]?.[0];
      expect(options.modelCatalog).toMatchObject([{ ref: "primary", name: "Fixture" }]);
      await options.cancelRun({ runId: "run-fixture", command: { commandId: "cancel-fixture" } });
      expect(f.runs.coordinator.cancel).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "run-fixture", reasonCode: "OWNER_REQUESTED_STOP" }),
      );
      signal?.();
      await settle();
      expect(await exit).toBe(0);
      expect(f.runs.dispatcher.stopAccepting).toHaveBeenCalledOnce();
      expect(f.runs.titles.stop).toHaveBeenCalledOnce();
      expect(boundary.events.indexOf("http.close")).toBeLessThan(
        boundary.events.indexOf("memory.close"),
      );
      expect(boundary.events.indexOf("memory.close")).toBeLessThan(
        boundary.events.indexOf("model.close"),
      );
      expect(boundary.events.at(-1)).toBe("repository.close");
    },
  );
  it.each([
    "models",
    "memory",
    "identity",
    "key",
    "dispatch",
    "listen",
    "interrupt",
    "drain",
    "model-close",
  ])("cleans up acquired resources after %s failure", async (kind) => {
    const f = web();
    if (kind === "models")
      boundary.modelComposition.mockRejectedValue(new Error("MODEL_FIXTURE_FAILURE"));
    if (kind === "memory")
      boundary.memoryComposition.mockRejectedValue(new Error("MEMORY_FIXTURE_FAILURE"));
    if (kind === "identity")
      f.http.assertIdentityReady.mockRejectedValue(new Error("IDENTITY_FIXTURE_FAILURE"));
    if (kind === "key") boundary.key.mockRejectedValue(new Error("HOST_SECRET_NOT_FOUND"));
    if (kind === "dispatch") f.runs.loop.start.mockRejectedValue(new Error("RUN_START_FAILURE"));
    if (kind === "listen") f.http.listen.mockRejectedValue(new Error("EADDRINUSE"));
    if (kind === "interrupt")
      f.runs.coordinator.interruptAllExecutions.mockRejectedValue(
        new Error("RUN_INTERRUPT_FAILURE"),
      );
    if (kind === "drain") f.runs.loop.stop.mockResolvedValue({ drained: false });
    if (kind === "model-close")
      f.model.composition.close.mockRejectedValue(new Error("MODEL_CLOSE_FAILURE"));
    start();
    await settle();
    if (kind === "interrupt" || kind === "drain" || kind === "model-close") {
      signal?.();
      await settle();
    }
    expect(await exit).toBe(1);
    expect(stderr).toContain('"event":"service.failed"');
    expect(repository.close).toHaveBeenCalledOnce();
    expect(lease.stop).toHaveBeenCalledOnce();
    if (kind !== "models") expect(f.model.composition.close).toHaveBeenCalledOnce();
    if (!["models", "memory"].includes(kind)) expect(f.memory.close).toHaveBeenCalledOnce();
  });
  it.each(["run", "memory"])("withdraws readiness when the %s consumer fails", async (kind) => {
    web();
    start();
    await settle();
    expect(stdout).toContain('"event":"service.ready"');
    const failure = new Error("FIXTURE_RUNTIME_LOST");
    if (kind === "run") boundary.runs.mock.calls[0]?.[0].onFailure({ error: failure });
    else boundary.memoryWorker.mock.calls[0]?.[0].onFailure(failure);
    await settle();
    expect(await exit).toBe(1);
    expect(stdout).toContain('"signal":"AUTHORITY_LOST"');
    expect(repository.close).toHaveBeenCalledOnce();
  });
});

describe("service request readiness and runtime callbacks", () => {
  it.each([
    "ready",
    "worker-unready",
    "dispatcher-stopped",
    "authority-inactive",
    "authority-lost",
  ])("admits product requests only while all dependencies are ready (%s)", async (state) => {
    const f = web();
    start();
    await settle();
    const hook = f.http.app.addHook.mock.calls.find(([event]) => event === "onRequest")?.[1];
    expect(hook).toBeTypeOf("function");
    if (state === "worker-unready") boundary.workerReady.mockReturnValue(false);
    if (state === "dispatcher-stopped") f.runs.loop.state = "stopped";
    if (state === "authority-inactive") lease.isAccepting.mockReturnValue(false);
    if (state === "authority-lost") lease.assertActive.mockRejectedValue(new Error("lease lost"));
    const reply = { code: vi.fn(), send: vi.fn() };
    reply.code.mockReturnValue(reply);
    await hook({ url: "/api/control-center/v1/config" }, reply);
    if (state === "ready") expect(reply.send).not.toHaveBeenCalled();
    else {
      expect(reply.code).toHaveBeenCalledWith(503);
      expect(reply.send).toHaveBeenCalledWith({
        error: state === "authority-lost" ? "AUTHORITY_UNAVAILABLE" : "SERVICE_NOT_READY",
      });
    }
  });
  it.each(["/assets/index-abc.js", "/icons/icon-192.png", "/sw.js", "/manifest.webmanifest", "/"])(
    "serves static file %s without a database authority check",
    async (url) => {
      const f = web();
      start();
      await settle();
      const hook = f.http.app.addHook.mock.calls.find(([event]) => event === "onRequest")?.[1];
      lease.assertActive.mockClear();
      const reply = { code: vi.fn(), send: vi.fn() };
      reply.code.mockReturnValue(reply);
      await hook({ url }, reply);
      expect(lease.assertActive).not.toHaveBeenCalled();
      expect(reply.send).not.toHaveBeenCalled();
      lease.isAccepting.mockReturnValue(false);
      await hook({ url }, reply);
      expect(reply.code).toHaveBeenCalledWith(503);
    },
  );
  it.each(["/api/gateway/v2/queries", "/preview/ticket-1", "/c/thread-1", "/files/new-route"])(
    "checks database authority before %s",
    async (url) => {
      const f = web();
      start();
      await settle();
      const hook = f.http.app.addHook.mock.calls.find(([event]) => event === "onRequest")?.[1];
      lease.assertActive.mockClear();
      const reply = { code: vi.fn(), send: vi.fn() };
      reply.code.mockReturnValue(reply);
      await hook({ url }, reply);
      expect(lease.assertActive).toHaveBeenCalledOnce();
    },
  );
  it.each(["healthy", "false", "throws", "authority"])(
    "checks the live worker for readiness probes (%s)",
    async (state) => {
      const f = web();
      start();
      await settle();
      const hook = f.http.app.addHook.mock.calls.find(([event]) => event === "onRequest")?.[1];
      if (state === "false") boundary.checkWorkerReady.mockResolvedValue(false);
      if (state === "throws")
        boundary.checkWorkerReady.mockRejectedValue(new Error("worker disconnected"));
      if (state === "authority")
        lease.assertActive.mockRejectedValue(new Error("authority revoked"));
      const health = boundary.http.mock.calls[0]?.[0].health;
      const observe = vi.spyOn(health, "observe");
      const reply = { code: vi.fn(), send: vi.fn() };
      await hook({ url: "/health/ready?probe=1" }, reply);
      expect(observe).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "worker",
          required: true,
          status: state === "healthy" ? "healthy" : "unavailable",
          reasonCode: state === "healthy" ? null : "WORKER_OR_AUTHORITY_UNAVAILABLE",
        }),
      );
      expect(reply.send).not.toHaveBeenCalled();
      if (state === "authority") expect(boundary.checkWorkerReady).not.toHaveBeenCalled();
    },
  );
  it("keeps liveness reachable while dependencies are unavailable", async () => {
    const f = web();
    start();
    await settle();
    lease.isAccepting.mockReturnValue(false);
    const hook = f.http.app.addHook.mock.calls.find(([event]) => event === "onRequest")?.[1];
    const reply = { code: vi.fn(), send: vi.fn() };
    await hook({ url: "/health/live" }, reply);
    expect(reply.code).not.toHaveBeenCalled();
    expect(boundary.checkWorkerReady).not.toHaveBeenCalled();
  });
  it("logs title-generation failure without exposing its message or stopping chat", async () => {
    web();
    start();
    await settle();
    boundary.runs.mock.calls[0]?.[0].onTitleFailure(new Error("private provider exception"));
    expect(stderr).toContain('"event":"thread-title.failed"');
    expect(stderr).not.toContain("private provider exception");
    expect(stdout).toContain('"event":"service.ready"');
    expect(repository.close).not.toHaveBeenCalled();
  });
  it("[I-94] names the refusing check in a model-call failure log only for port errors", async () => {
    web();
    start();
    await settle();
    const options = boundary.runs.mock.calls[0]?.[0];
    options.onTitleFailure(
      Object.assign(new Error("Budget account classification is immutable"), {
        code: "PORT_CONFLICT",
      }),
    );
    const line = stderr.split("\n").find((item: string) => item.includes('"code":"PORT_CONFLICT"'));
    expect(JSON.parse(line ?? "").site).toBe("Budget account classification is immutable");
    options.onTitleFailure(new Error("private provider exception"));
    expect(stderr).not.toContain("private provider exception");
  });
  it("[I-94] gives every model-call failure log the site field", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/service-main.ts", import.meta.url), "utf8");
    for (const event of [
      "thread-title.failed",
      "memory-capture.failed",
      "memory-episode.failed",
      "memory-consolidation.failed",
      "conversation-turn.failed",
    ]) {
      const start = source.indexOf(`event: "${event}"`);
      expect(start).toBeGreaterThan(-1);
      expect(source.slice(start, start + 200)).toContain("...siteField(error)");
    }
  });
  it("rechecks the memory worker authority at execution time", async () => {
    web();
    start();
    await settle();
    const check = boundary.memoryWorker.mock.calls[0]?.[0].assertActive;
    await expect(check()).resolves.toBeUndefined();
    lease.assertActive.mockRejectedValue(new Error("revoked before projection"));
    await expect(check()).rejects.toThrow("revoked before projection");
  });
  it.each(["before-reverse", "after-reverse", "after-handshake"])(
    "does not publish readiness after authority becomes unavailable %s",
    async (stage) => {
      if (stage === "before-reverse")
        boundary.sandbox.mockImplementation(async () => {
          lease.isAccepting.mockReturnValue(false);
          return undefined;
        });
      if (stage === "after-reverse")
        boundary.payloadStart.mockImplementation(async () => {
          lease.isAccepting.mockReturnValue(false);
        });
      if (stage === "after-handshake")
        boundary.connect.mockImplementation(async () => {
          lease.isAccepting.mockReturnValue(false);
          return { payload: { ready: true, selectedSchemaVersion: "execution.v2" } };
        });
      start();
      await settle();
      expect(await exit).toBe(1);
      expect(stdout).not.toContain('"event":"service.ready"');
      expect(repository.close).toHaveBeenCalledOnce();
    },
  );
});

describe("[MU-A] one tenant runtime started and stopped as a handle", () => {
  function tenantInput(extra: Partial<StartTenantRuntimeInput> = {}): StartTenantRuntimeInput {
    const sources = {
      provider: { resolve: boundary.key },
      keys: { kind: "systemd-credential", productionSuitable: true, resolve: boundary.key },
    } as unknown as StartTenantRuntimeInput["sources"];
    return {
      tenantId: "tenant-a",
      configuration: configuration as never,
      magpieModels: {
        configuration,
        prices: new Map(),
        automaticRefs: new Set(),
      } as never,
      sources,
      workerTokenPath: "/fixture-token.json",
      output,
      errorOutput: errors,
      ...extra,
    };
  }
  it("returns a ready handle without touching process signals and stops idempotently", async () => {
    const handle = await Promise.all([startTenantRuntime(tenantInput()), settle()]).then(
      ([started]) => started,
    );
    expect(handle.tenantId).toBe("tenant-a");
    expect(handle.listenPath).toBeUndefined();
    expect(handle.listenPort).toBeUndefined();
    expect(stdout).toContain('"event":"service.ready"');
    expect(signal).toBeUndefined();
    await handle.stop();
    await handle.stop();
    expect(repository.close).toHaveBeenCalledOnce();
    expect(boundary.stopWorker).toHaveBeenCalledOnce();
    expect(stdout).not.toContain('"event":"service.stopped"');
  });
  it("reports authority loss to every handler, including one registered after the loss", async () => {
    const handle = await startTenantRuntime(tenantInput());
    const early = vi.fn();
    handle.onAuthorityLost(early);
    const error = new Error("AGENT_AUTHORITY_LOST");
    boundary.authority.mock.calls[0]?.[0].onLost(error, { msSinceLastRenewal: 12_000 });
    await settle();
    expect(early).toHaveBeenCalledWith(error);
    const late = vi.fn();
    handle.onAuthorityLost(late);
    await settle();
    expect(late).toHaveBeenCalledWith(error);
    expect(boundary.stopWorker).toHaveBeenCalledOnce();
    await handle.stop();
    expect(process.exitCode).not.toBe(1);
  });
  it("logs and survives an authority-lost handler that throws, and still tells the other handlers", async () => {
    const handle = await startTenantRuntime(tenantInput());
    const other = vi.fn();
    handle.onAuthorityLost(() => {
      throw new Error("HANDLER_FAILED");
    });
    handle.onAuthorityLost(other);
    boundary.authority.mock.calls[0]?.[0].onLost(new Error("AGENT_AUTHORITY_LOST"), {
      msSinceLastRenewal: 12_000,
    });
    await settle();
    expect(other).toHaveBeenCalledOnce();
    expect(stderr).toContain('"event":"authority.lost_handler_failed"');
    await handle.stop();
  });
  it("asks the injected execution worker launcher to start before reading the worker binding", async () => {
    const ensureStarted = vi.fn(async () => {
      boundary.events.push("worker.ensure-started");
    });
    boundary.boot.mockImplementation(async () => {
      boundary.events.push("worker.binding-read");
      return {
        ...authority,
        deploymentId: authority.id,
        workerInstanceId: `execution-worker:${authority.id}`,
        workerBootId: "worker-boot",
      };
    });
    const handle = await startTenantRuntime(tenantInput({ executionWorker: { ensureStarted } }));
    expect(ensureStarted).toHaveBeenCalledOnce();
    expect(boundary.events.indexOf("worker.ensure-started")).toBeLessThan(
      boundary.events.indexOf("worker.binding-read"),
    );
    await handle.stop();
  });
  it("passes the shared read-thread budget to the repository and borrows the shared Pi pool without closing it", async () => {
    const budget = { tryAcquire: vi.fn(() => true), release: vi.fn() };
    const shared = { prepare: vi.fn(), close: vi.fn() };
    const handle = await startTenantRuntime(
      tenantInput({
        shared: { extraReadThreadBudget: budget, piFilePreparationPool: shared as never },
      }),
    );
    expect(boundary.open.mock.calls[0]?.[0]).toMatchObject({ extraReadThreadBudget: budget });
    expect(boundary.sandbox.mock.calls.length).toBe(1);
    const prepare = boundary.sandbox.mock.calls[0]?.[0].createPiFilePreparation();
    expect(prepare).toBe(shared.prepare);
    await handle.stop();
    expect(shared.close).not.toHaveBeenCalled();
  });
  it("listens on the requested unix socket and reports it as the listen path", async () => {
    const f = web();
    const handle = await startTenantRuntime(
      tenantInput({ listen: { kind: "unix", path: "/fixture-state/web/tenant-a.sock" } }),
    );
    expect(boundary.http.mock.calls[0]?.[0]).toMatchObject({
      listenUnixSocketPath: "/fixture-state/web/tenant-a.sock",
    });
    expect(handle.listenPath).toBe("/fixture-state/web/tenant-a.sock");
    expect(handle.listenPort).toBeUndefined();
    expect(handle.health).toBeDefined();
    expect(stdout).toContain('"listenPath":"/fixture-state/web/tenant-a.sock"');
    expect(stdout).not.toContain('"listenPort"');
    await handle.stop();
    expect(f.http.close).toHaveBeenCalledOnce();
  });
  it("keeps tcp listening and the port report when no unix socket is asked for", async () => {
    web();
    const handle = await startTenantRuntime(tenantInput());
    expect(boundary.http.mock.calls[0]?.[0]).not.toHaveProperty("listenUnixSocketPath");
    expect(handle.listenPort).toBe(mockListenPort);
    expect(handle.listenPath).toBeUndefined();
    await handle.stop();
  });
  it("rejects with the startup error and releases owned resources when startup fails", async () => {
    boundary.connect.mockResolvedValue({ payload: { ready: false } });
    const pending = startTenantRuntime(tenantInput());
    const outcome = expect(pending).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(400);
    await outcome;
    expect(repository.close).toHaveBeenCalledOnce();
    expect(stdout).not.toContain('"event":"service.ready"');
  });
  it("bounds stop() with the given timeout, and a later stop() waits for the same shutdown without closing twice", async () => {
    let release: () => void = () => undefined;
    boundary.admissionStop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const handle = await startTenantRuntime(tenantInput());
    const stopping = handle.stop(500);
    const outcome = expect(stopping).rejects.toMatchObject({
      code: TENANT_RUNTIME_ERROR_CODES.STOP_TIMEOUT,
    });
    await vi.advanceTimersByTimeAsync(600);
    await outcome;
    let finished = false;
    const again = handle.stop().then(() => {
      finished = true;
    });
    await settle();
    expect(finished).toBe(false);
    release();
    await again;
    expect(finished).toBe(true);
    expect(boundary.admissionStop).toHaveBeenCalledOnce();
    expect(repository.close).toHaveBeenCalledOnce();
  });
  it("starts, stops and starts again without leaving the first runtime's resources behind", async () => {
    for (let round = 0; round < 3; round += 1) {
      const handle = await startTenantRuntime(tenantInput());
      await handle.stop();
    }
    expect(boundary.open).toHaveBeenCalledTimes(3);
    expect(repository.close).toHaveBeenCalledTimes(3);
    expect(boundary.admissionStop).toHaveBeenCalledTimes(3);
    expect(boundary.payloadStop).toHaveBeenCalledTimes(3);
    expect(boundary.stopWorker).toHaveBeenCalledTimes(3);
    expect(lease.stop).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
