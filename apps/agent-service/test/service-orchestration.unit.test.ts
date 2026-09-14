import { PassThrough } from "node:stream";
import { EXECUTION_UDS_ERROR_CODES, ExecutionUdsError } from "@himawari-agent/platform-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentService } from "../src/service-main.js";

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
vi.mock("@himawari-agent/application", async (original) => ({
  ...(await original<object>()),
  recoverSandboxJobsAtStartup: boundary.recoverJobs,
  recoverSandboxExecutionsAtStartup: boundary.recoverExecutions,
}));
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
    "capabilityInvocationReceiptPort",
    "capabilityInvocationResultPort",
  ])
    repository[key] = vi.fn(() => ({}));
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
});

describe("agent service startup ownership", () => {
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
    "sqlite",
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
    if (kind === "sqlite") boundary.status.mockReturnValue({ quickCheck: "corrupt" });
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
    boundary.authority.mock.calls[0]?.[0].onLost(new Error("AGENT_AUTHORITY_LOST"));
    await settle();
    expect(await exit).toBe(1);
    expect(stdout).toContain('"signal":"AUTHORITY_LOST"');
    expect(boundary.admissionStop).toHaveBeenCalledOnce();
    expect(boundary.stopWorker).toHaveBeenCalledOnce();
  });
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
    "memoryProjectionJobs",
    "runPayloadArtifactPort",
    "capabilityStore",
    "modelBudgetPort",
  ])
    repository[key] = vi.fn(() => port);
  const memory = {
    projection: { bindEmbeddingBoundary: vi.fn() },
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
    app: { addHook: vi.fn() },
    assertIdentityReady: vi.fn(),
    listen: vi.fn(async () => {
      boundary.events.push("http.listen");
    }),
    close: vi.fn(async () => {
      boundary.events.push("http.close");
    }),
  };
  boundary.http.mockResolvedValue(http);
  return { model, memory, runs, http, port };
}
describe("web service composition and readiness", () => {
  it("opens HTTP only after memory and dispatch are ready, then closes models after consumers", async () => {
    const f = web();
    start();
    await settle();
    expect(stderr).toBe("");
    expect(stdout).toContain('"event":"service.ready"');
    expect(boundary.events.slice(-3)).toEqual(["memory-worker.start", "runs.start", "http.listen"]);
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
  });
  it.each(["models", "memory", "identity", "key", "dispatch", "listen", "drain", "model-close"])(
    "cleans up acquired resources after %s failure",
    async (kind) => {
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
      if (kind === "drain") f.runs.loop.stop.mockResolvedValue({ drained: false });
      if (kind === "model-close")
        f.model.composition.close.mockRejectedValue(new Error("MODEL_CLOSE_FAILURE"));
      start();
      await settle();
      if (kind === "drain" || kind === "model-close") {
        signal?.();
        await settle();
      }
      expect(await exit).toBe(1);
      expect(stderr).toContain('"event":"service.failed"');
      expect(repository.close).toHaveBeenCalledOnce();
      expect(lease.stop).toHaveBeenCalledOnce();
      if (kind !== "models") expect(f.model.composition.close).toHaveBeenCalledOnce();
      if (!["models", "memory"].includes(kind)) expect(f.memory.close).toHaveBeenCalledOnce();
    },
  );
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
