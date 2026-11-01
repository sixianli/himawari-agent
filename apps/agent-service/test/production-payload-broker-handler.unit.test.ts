import type {
  CapabilityInvocationAuthority,
  SandboxExecutionJournalPort,
  SandboxExecutionRecord,
  CapabilityInvocationReceiptPort,
  CapabilityInvocationResultPort,
  CapabilityResourceCeiling,
  FrozenCapabilityInvocationReceipt,
  PayloadProtectionRequest,
  PayloadProtectorPort,
  PayloadRecord,
  PayloadStorePort,
  RunPayloadArtifactCommitResult,
} from "@himawari-agent/application";
import { createApplicationServiceIdentityFactory } from "@himawari-agent/application";
import {
  type PayloadBrokerInputReadRequest,
  type PayloadBrokerOutputWriteRequest,
  type PayloadBrokerSandboxExecutionRequest,
  payloadBrokerV1MessageSchema,
} from "@himawari-agent/execution-contracts";
import { createV02Fixture } from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";
import { CommandSilenceWatch } from "../src/command-silence-watch.js";
import {
  PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES,
  ProductionPayloadBrokerHandler,
  RESOLVED_AUTHORITY_REUSE_MS,
} from "../src/production-payload-broker-handler.js";

type OwnerId = PayloadProtectionRequest["ownerId"];
type AgentId = PayloadProtectionRequest["agentId"];

const V02_FIXTURE = createV02Fixture();
const IDENTITY_FACTORY = createApplicationServiceIdentityFactory();
const OWNER_ID = V02_FIXTURE.scope.ownerId;
const AGENT_ID = V02_FIXTURE.scope.agentId;
const RUN_ID = V02_FIXTURE.scope.runId;
const HANDLE_REF = "handle:payload-handler";
const INVOCATION_ID = "invocation:payload-handler";
const INPUT_REF = "payload:input:payload-handler";
const REQUESTED_AT = "2026-09-04T00:00:00.000Z";
const DEADLINE_AT = "2026-09-04T00:00:05.000Z";
const AUTHORITY_EPOCH = 7;
const FENCING_TOKEN = 13;
const AGENT_SERVICE_INSTANCE_ID = "agent-service:payload-handler";
const AGENT_SERVICE_BOOT_ID = "agent-boot:payload-handler";
const WORKER_INSTANCE_ID = "worker:payload-handler";
const WORKER_BOOT_ID = "worker-boot:payload-handler";
const AUTHORITY_LEASE = IDENTITY_FACTORY.createAuthorityLease({
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  leaseId: "lease:payload-handler",
  holderId: "holder:payload-handler",
});

const ceiling: CapabilityResourceCeiling = Object.freeze({
  maxWallTimeMs: 10_000,
  maxCpuTimeMs: 5_000,
  maxMemoryBytes: 16_777_216,
  maxOutputBytes: 4,
  maxProgressEvents: 8,
});

const authority: CapabilityInvocationAuthority = Object.freeze({
  product: {
    deploymentId: V02_FIXTURE.scope.authority.deploymentId,
    authorityEpoch: AUTHORITY_EPOCH,
    fencingToken: FENCING_TOKEN,
  },
  lease: {
    leaseId: AUTHORITY_LEASE.id,
    fencingToken: FENCING_TOKEN,
  },
  agentServiceInstanceId: AGENT_SERVICE_INSTANCE_ID,
  agentServiceBootId: AGENT_SERVICE_BOOT_ID,
  workerInstanceId: WORKER_INSTANCE_ID,
  workerBootId: WORKER_BOOT_ID,
});

const receipt: FrozenCapabilityInvocationReceipt = {
  receiptVersion: "capability-invocation.v1",
  receiptRef: "receipt:payload-handler",
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  runId: RUN_ID,
  handleRef: HANDLE_REF,
  handleRevision: 3,
  invocationId: INVOCATION_ID,
  workerRunId: "worker-run:payload-handler",
  idempotencyKey: "idempotency:payload-handler",
  capabilityRef: "capability:payload-handler",
  capabilityVersion: "1.0.0",
  authorization: { type: "policy", ref: "policy:payload-handler" },
  authorizationRef: "policy:payload-handler",
  operation: "execute",
  inputRef: INPUT_REF,
  delegatedContextRefs: [],
  secretRefs: [],
  dataClassification: "private",
  resourceCeiling: ceiling,
  requestedAt: REQUESTED_AT,
  deadlineAt: DEADLINE_AT,
  effectiveExpiresAt: DEADLINE_AT,
  authority,
  semanticFingerprint: "fingerprint:payload-handler",
  consumedAt: REQUESTED_AT,
};

const inputPayload: PayloadRecord = Object.freeze({
  ref: INPUT_REF,
  dataClassification: "private",
  contentType: "application/octet-stream",
  ciphertext: new Uint8Array([0x01, 0x02]),
  encryption: { algorithm: "fixture", keyRef: "fixture:key" },
  contentDigest: "digest:input",
  createdAt: REQUESTED_AT,
});

const outputPayload: PayloadRecord = Object.freeze({
  ref: "payload:output:payload-handler",
  dataClassification: "private",
  contentType: "application/json",
  ciphertext: new Uint8Array([0x03, 0x04]),
  encryption: { algorithm: "fixture", keyRef: "fixture:key" },
  contentDigest: "digest:output",
  createdAt: REQUESTED_AT,
});

const outputArtifact: RunPayloadArtifactCommitResult = {
  ref: outputPayload.ref,
  replayed: false,
  artifact: {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    purpose: "worker_result",
    operationKey: `capability-output:${INVOCATION_ID}`,
    payloadRef: outputPayload.ref,
    contentDigest: outputPayload.contentDigest,
    contentType: outputPayload.contentType,
    dataClassification: outputPayload.dataClassification,
    createdAt: outputPayload.createdAt,
  },
};

const identity = {
  handleRef: HANDLE_REF,
  invocationId: INVOCATION_ID,
  workerInstanceId: WORKER_INSTANCE_ID,
  workerBootId: WORKER_BOOT_ID,
  authorityEpoch: AUTHORITY_EPOCH,
  fencingToken: FENCING_TOKEN,
} as const;

function inputRequest(): PayloadBrokerInputReadRequest {
  const parsed = payloadBrokerV1MessageSchema.parse({
    schemaVersion: "payload-broker.v1",
    kind: "request",
    type: "payload.input.read",
    messageId: "message:payload-input-read",
    correlationId: "message:payload-input-read",
    causationId: null,
    idempotencyKey: "idempotency:payload-input-read",
    payload: identity,
  });
  if (parsed.kind !== "request" || parsed.type !== "payload.input.read") {
    throw new TypeError("payload input request fixture is invalid");
  }
  return parsed;
}

function outputRequest(contentType = "application/json"): PayloadBrokerOutputWriteRequest {
  const parsed = payloadBrokerV1MessageSchema.parse({
    schemaVersion: "payload-broker.v1",
    kind: "request",
    type: "payload.output.write",
    messageId: "message:payload-output-write",
    correlationId: "message:payload-output-write",
    causationId: null,
    idempotencyKey: "idempotency:payload-output-write",
    payload: {
      ...identity,
      bytesBase64: "AQID",
      contentType,
    },
  });
  if (parsed.kind !== "request" || parsed.type !== "payload.output.write") {
    throw new TypeError("payload output request fixture is invalid");
  }
  return parsed;
}

function handlerFixture(
  options: {
    readonly receipt?: FrozenCapabilityInvocationReceipt | undefined;
    readonly outputResult?: RunPayloadArtifactCommitResult;
    readonly inputPayload?: PayloadRecord;
    readonly onUnprotect?: () => void;
  } = {},
) {
  const frozenReceipt = "receipt" in options ? options.receipt : receipt;
  const observed: Array<{
    readonly payload: PayloadRecord;
    readonly plaintextByteLength: number;
  }> = [];
  const protectedRequests: PayloadProtectionRequest[] = [];
  let active = true;
  let readCalls = 0;
  let unprotectCalls = 0;
  let lookupFrozenCalls = 0;
  let payloadScope: { readonly ownerId: OwnerId; readonly agentId: AgentId } | undefined;

  const receipts: CapabilityInvocationReceiptPort = {
    consume: async () => {
      throw new Error("consume is not part of the trusted handler boundary");
    },
    read: async () => {
      readCalls += 1;
      if (!active) throw new Error("Grant revoked");
      return frozenReceipt;
    },
  };
  const results: CapabilityInvocationResultPort = {
    lookupFrozen: async () => {
      lookupFrozenCalls += 1;
      return frozenReceipt;
    },
    observeOutput: async (input) => {
      observed.push({
        payload: input.payload,
        plaintextByteLength: input.plaintextByteLength,
      });
      return options.outputResult ?? outputArtifact;
    },
    lookupOutput: async () => undefined,
  };
  const payloads: Pick<PayloadStorePort, "get"> = {
    get: async (ref) => (ref === INPUT_REF ? (options.inputPayload ?? inputPayload) : undefined),
  };
  const protector: PayloadProtectorPort = {
    protect: async (input) => {
      protectedRequests.push(input);
      return outputPayload;
    },
    unprotect: async () => {
      unprotectCalls += 1;
      options.onUnprotect?.();
      return new Uint8Array([0x10, 0x11, 0x12]);
    },
    rewrap: async ({ payload }) => payload,
  };
  const handler = new ProductionPayloadBrokerHandler({
    receipts,
    results,
    payloadsFor: (ownerId, agentId) => {
      payloadScope = { ownerId, agentId };
      return payloads;
    },
    protector,
    currentAuthority: () => ({ product: authority.product, lease: authority.lease }),
    clock: { now: () => REQUESTED_AT },
    ids: { next: () => "payload:generated-output" },
    agentServiceInstanceId: AGENT_SERVICE_INSTANCE_ID,
    agentServiceBootId: AGENT_SERVICE_BOOT_ID,
    maximumPayloadBytes: 32,
    allowedContentTypes: ["application/json", "text/plain"],
  });
  return {
    handler,
    observed,
    protectedRequests,
    revoke: () => {
      active = false;
    },
    get readCalls() {
      return readCalls;
    },
    get unprotectCalls() {
      return unprotectCalls;
    },
    get lookupFrozenCalls() {
      return lookupFrozenCalls;
    },
    get payloadScope() {
      return payloadScope;
    },
  };
}

const SANDBOX_HOST_ID = "host:payload-handler";
const executionIdentity = {
  jobId: "job:payload-handler",
  attemptId: "attempt:payload-handler",
  invocationId: INVOCATION_ID,
  receiptRef: receipt.receiptRef,
  hostId: SANDBOX_HOST_ID,
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  threadId: null,
  runId: RUN_ID,
  toolCallId: "tool-call:payload-handler",
} as const;

function resolveRequest(): PayloadBrokerSandboxExecutionRequest {
  const parsed = payloadBrokerV1MessageSchema.parse({
    schemaVersion: "payload-broker.v1",
    kind: "request",
    type: "payload.sandbox.execution",
    messageId: "message:payload-sandbox-resolve",
    correlationId: "message:payload-sandbox-resolve",
    causationId: null,
    idempotencyKey: "idempotency:payload-sandbox-resolve",
    payload: { ...identity, identity: executionIdentity, command: { kind: "resolve" } },
  });
  if (parsed.kind !== "request" || parsed.type !== "payload.sandbox.execution") {
    throw new TypeError("payload sandbox resolve request fixture is invalid");
  }
  return parsed;
}

function resolveFixture(
  options: {
    readonly phase?: "bound" | "reserved";
    readonly supervision?: string;
    readonly silenceWatch?: CommandSilenceWatch;
  } = {},
) {
  const startedAt = Date.parse(REQUESTED_AT);
  const plan = {
    identity: executionIdentity,
    handleRef: HANDLE_REF,
    inputRef: INPUT_REF,
    semanticFingerprint: receipt.semanticFingerprint,
  };
  const bound = {
    plan,
    facts: {
      resource: { sequence: 2, supervision: options.supervision ?? "controlled" },
      environment: { resourceRef: "resource:payload-handler" },
    },
    startedAt: REQUESTED_AT,
    operationRevision: 1,
  } as unknown as SandboxExecutionRecord;
  const reserved = {
    phase: "reserved" as const,
    plan,
    reservation: { sequence: 1, resourceRef: "resource:payload-handler" },
  };
  const state = {
    now: startedAt,
    version: "authority:1",
    active: true,
    resolveCalls: 0,
    receiptReads: 0,
    onResolve: undefined as (() => void) | undefined,
  };
  const handler = new ProductionPayloadBrokerHandler({
    ...(options.silenceWatch ? { silenceWatch: options.silenceWatch } : {}),
    sandboxExecutions: {
      hostId: SANDBOX_HOST_ID,
      journal: { read: async () => bound } as unknown as SandboxExecutionJournalPort,
      ...(options.phase === "reserved"
        ? {
            preparations: {
              readAdmission: async () => reserved,
            } as never,
          }
        : {}),
      verifyStart: async () => {},
      authorityVersion: async () => state.version,
      resolveScope: async () => {
        state.resolveCalls += 1;
        state.onResolve?.();
        return { scope: { handleRef: HANDLE_REF }, allowedDomains: ["example.com"] } as never;
      },
    },
    receipts: {
      consume: async () => {
        throw new Error("consume is not part of the trusted handler boundary");
      },
      read: async () => {
        state.receiptReads += 1;
        if (!state.active) throw new Error("Grant revoked");
        return receipt;
      },
    },
    results: {
      lookupFrozen: async () => receipt,
      observeOutput: async () => outputArtifact,
      lookupOutput: async () => undefined,
    },
    payloadsFor: () => ({ get: async () => undefined }),
    protector: {
      protect: async () => outputPayload,
      unprotect: async () => new Uint8Array(),
      rewrap: async ({ payload }) => payload,
    },
    currentAuthority: () => ({ product: authority.product, lease: authority.lease }),
    clock: { now: () => new Date(state.now).toISOString() },
    ids: { next: () => "payload:generated-output" },
    agentServiceInstanceId: AGENT_SERVICE_INSTANCE_ID,
    agentServiceBootId: AGENT_SERVICE_BOOT_ID,
    maximumPayloadBytes: 32,
    allowedContentTypes: ["application/json"],
  });
  return { handler, state, resolve: () => handler.sandboxExecution(resolveRequest()) };
}

describe("[SILENCE-4] the handler feeds the silence watch from real worker polls", () => {
  function watched() {
    const silent: string[] = [];
    const watch = new CommandSilenceWatch({
      onSilent: (detail) => silent.push(detail.runId),
      onResumed: () => {},
    });
    return { watch, silent };
  }
  const tick = (watch: CommandSilenceWatch, from: number, to: number) => {
    for (let at = from; at <= to; at += 5_000) watch.check(at);
  };

  it("a running command whose worker stops polling is reported with its run id", async () => {
    const { watch, silent } = watched();
    const fixture = resolveFixture({ silenceWatch: watch });
    await fixture.resolve();
    const start = fixture.state.now;
    tick(watch, start + 5_000, start + 29_999);
    expect(silent).toEqual([]);
    tick(watch, start + 30_000, start + 35_000);
    expect(silent).toEqual([RUN_ID]);
  });

  it("negative: a worker that keeps polling is never reported", async () => {
    const { watch, silent } = watched();
    const fixture = resolveFixture({ silenceWatch: watch });
    const start = fixture.state.now;
    for (let at = 0; at <= 120_000; at += 250) {
      fixture.state.now = start + at;
      await fixture.resolve();
      if (at % 5_000 === 0) watch.check(start + at);
    }
    expect(silent).toEqual([]);
  });

  it("negative: a command that is no longer controlled is never reported", async () => {
    const { watch, silent } = watched();
    const fixture = resolveFixture({ silenceWatch: watch, supervision: "released" });
    await fixture.resolve();
    const start = fixture.state.now;
    tick(watch, start + 5_000, start + 120_000);
    expect(silent).toEqual([]);
    expect(watch.size()).toBe(0);
  });
});

describe("[NL-4] sandbox authority resolve reuse", () => {
  it("[NL-4] runs the full check once and then reuses it while the authority version is unchanged", async () => {
    const fixture = resolveFixture();
    const first = await fixture.resolve();
    const second = await fixture.resolve();
    expect(fixture.state.resolveCalls).toBe(1);
    expect(second.resolvedScope).toEqual(first.resolvedScope);
    expect(fixture.state.receiptReads).toBe(3);
  });

  it("[NL-4] still rejects a reused check when the live receipt read fails", async () => {
    const fixture = resolveFixture();
    await fixture.resolve();
    fixture.state.active = false;
    await expect(fixture.resolve()).rejects.toMatchObject({
      code: PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.SANDBOX_JOB_REJECTED,
    });
    expect(fixture.state.resolveCalls).toBe(1);
  });

  it("[NL-4] runs the full check again when the authority version changes", async () => {
    const fixture = resolveFixture();
    await fixture.resolve();
    fixture.state.version = "authority:2";
    await fixture.resolve();
    await fixture.resolve();
    expect(fixture.state.resolveCalls).toBe(2);
  });

  it("[NL-4] runs the full check again once the reuse window has passed", async () => {
    const fixture = resolveFixture();
    await fixture.resolve();
    fixture.state.now += RESOLVED_AUTHORITY_REUSE_MS - 1;
    await fixture.resolve();
    expect(fixture.state.resolveCalls).toBe(1);
    fixture.state.now += 1;
    await fixture.resolve();
    expect(fixture.state.resolveCalls).toBe(2);
  });

  it("[NL-4] runs the full check again when the clock moves backwards", async () => {
    const fixture = resolveFixture();
    await fixture.resolve();
    fixture.state.now -= 1;
    await fixture.resolve();
    expect(fixture.state.resolveCalls).toBe(2);
  });

  it("[NL-4] does not keep a check whose authority version changed while it ran", async () => {
    const fixture = resolveFixture();
    fixture.state.onResolve = () => {
      fixture.state.version = `authority:${fixture.state.resolveCalls + 1}`;
    };
    await fixture.resolve();
    fixture.state.onResolve = undefined;
    await fixture.resolve();
    await fixture.resolve();
    expect(fixture.state.resolveCalls).toBe(2);
  });

  it("[NL-4] never reuses a check for a reservation that has not started", async () => {
    const fixture = resolveFixture({ phase: "reserved" });
    await fixture.resolve();
    await fixture.resolve();
    expect(fixture.state.resolveCalls).toBe(2);
  });
});

describe("production Payload broker trusted handler", () => {
  it("validates current receipt authority without disclosing input or using frozen results", async () => {
    const fixture = handlerFixture();
    const request = { ...inputRequest(), type: "payload.invocation.validate" as const };
    await fixture.handler.validateInvocation(request);
    await fixture.handler.validateInvocation(request);
    expect(fixture.readCalls).toBe(2);
    expect(fixture.unprotectCalls).toBe(0);
    expect(fixture.lookupFrozenCalls).toBe(0);
    expect(fixture.payloadScope).toBeUndefined();
  });

  it.each([
    undefined,
    { ...receipt, invocationId: "another:invocation" },
    { ...receipt, authority: { ...authority, workerBootId: "another:boot" } },
  ])("rejects absent or mismatched current receipt without disclosing input", async (current) => {
    const fixture = handlerFixture({ receipt: current });
    await expect(
      fixture.handler.validateInvocation({
        ...inputRequest(),
        type: "payload.invocation.validate",
      }),
    ).rejects.toMatchObject({ code: PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.AUTHORITY_REJECTED });
    expect(fixture.unprotectCalls).toBe(0);
  });

  it("does not disclose bytes when a Grant is revoked during input decryption", async () => {
    const fixture = handlerFixture({ onUnprotect: () => fixture.revoke() });
    await expect(fixture.handler.readInput(inputRequest())).rejects.toMatchObject({
      code: PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.AUTHORITY_REJECTED,
    });
    expect(fixture.unprotectCalls).toBe(1);
  });

  it("reads input only through a live receipt and scoped protected Payload", async () => {
    const fixture = handlerFixture();

    await expect(fixture.handler.readInput(inputRequest())).resolves.toEqual(
      new Uint8Array([0x10, 0x11, 0x12]),
    );
    expect(fixture.readCalls).toBe(2);
    expect(fixture.unprotectCalls).toBe(1);
    expect(fixture.payloadScope).toEqual({ ownerId: OWNER_ID, agentId: AGENT_ID });
  });

  it("allows a lower-classification input under a private invocation ceiling", async () => {
    const fixture = handlerFixture({
      inputPayload: { ...inputPayload, dataClassification: "public" },
    });

    await expect(fixture.handler.readInput(inputRequest())).resolves.toEqual(
      new Uint8Array([0x10, 0x11, 0x12]),
    );
    expect(fixture.unprotectCalls).toBe(1);
  });

  it("rejects an input above the frozen invocation classification", async () => {
    const fixture = handlerFixture({
      inputPayload: { ...inputPayload, dataClassification: "sensitive" },
    });

    await expect(fixture.handler.readInput(inputRequest())).rejects.toMatchObject({
      code: PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.PAYLOAD_CLASSIFICATION_MISMATCH,
    });
    expect(fixture.unprotectCalls).toBe(0);
  });

  it("protects output with frozen metadata and submits one observation", async () => {
    const fixture = handlerFixture();

    await expect(
      fixture.handler.writeOutput(
        outputRequest(),
        new Uint8Array([0x20, 0x21, 0x22]),
        "application/json",
      ),
    ).resolves.toEqual({ outputRef: outputPayload.ref, replayed: false });
    expect(fixture.lookupFrozenCalls).toBe(1);
    expect(fixture.protectedRequests).toMatchObject([
      {
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        dataClassification: "private",
        contentType: "application/json",
        plaintext: new Uint8Array([0x20, 0x21, 0x22]),
      },
    ]);
    expect(fixture.observed).toMatchObject([
      {
        payload: { ref: outputPayload.ref, dataClassification: "private" },
        plaintextByteLength: 3,
      },
    ]);
    expect(fixture.readCalls).toBe(0);
  });

  it("rejects a content type that disagrees with the output request", async () => {
    const fixture = handlerFixture();

    await expect(
      fixture.handler.writeOutput(
        outputRequest("application/json"),
        new Uint8Array([0x20]),
        "text/plain",
      ),
    ).rejects.toMatchObject({
      code: PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.CONTENT_TYPE_MISMATCH,
    });
    expect(fixture.protectedRequests).toHaveLength(0);
    expect(fixture.observed).toHaveLength(0);
  });

  it("rejects output before protection when media type or frozen byte ceiling is invalid", async () => {
    const fixture = handlerFixture();

    await expect(
      fixture.handler.writeOutput(outputRequest("text/html"), new Uint8Array([0x20]), "text/html"),
    ).rejects.toMatchObject({
      code: PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.CONTENT_TYPE_UNSUPPORTED,
    });
    await expect(
      fixture.handler.writeOutput(
        outputRequest(),
        new Uint8Array([0x20, 0x21, 0x22, 0x23, 0x24]),
        "application/json",
      ),
    ).rejects.toMatchObject({
      code: PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.OUTPUT_TOO_LARGE,
    });
    expect(fixture.protectedRequests).toHaveLength(0);
    expect(fixture.observed).toHaveLength(0);
  });

  it("fails closed when the consumed invocation is unavailable", async () => {
    const fixture = handlerFixture({ receipt: undefined });

    await expect(fixture.handler.readInput(inputRequest())).rejects.toMatchObject({
      code: PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.INVOCATION_NOT_FOUND,
    });
    await expect(
      fixture.handler.writeOutput(outputRequest(), new Uint8Array([0x20]), "application/json"),
    ).rejects.toMatchObject({
      code: PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.INVOCATION_NOT_FOUND,
    });
    expect(fixture.unprotectCalls).toBe(0);
    expect(fixture.protectedRequests).toHaveLength(0);
  });
});
