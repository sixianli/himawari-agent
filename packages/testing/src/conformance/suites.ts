import type {
  AgentRuntimePort,
  ApprovalRequest,
  AttentionDecision,
  AttentionPort,
  AuditLedgerPort,
  AuthorizationStorePort,
  AuthorityLeasePort,
  CapabilityDescriptor,
  CapabilityExecutionHandleStorePort,
  CapabilityInvocationEvent,
  CapabilityPort,
  CapabilityRegistryStorePort,
  ClockPort,
  IdGeneratorPort,
  JsonObject,
  GrantRecord,
  MemoryPort,
  ModelDescriptor,
  ModelInvocationEvent,
  ModelPort,
  PayloadStorePort,
  ProductStateRepositoryPort,
  ReliableEventPort,
  ReliableEventSinkPort,
  RuntimeEvent,
  RuntimeToolDescriptor,
  RuntimeToolExecutionResult,
  RuntimeToolPort,
  SchedulerPort,
  SecretPort,
  StateStorePort,
  TraceEvent,
  TraceStorePort,
  WorkerRunEvent,
  WorkerRunPort,
} from "@himawari-agent/application";
import { PORT_ERROR_CODES, ApplicationPortError } from "@himawari-agent/application";
import {
  createAgent,
  createAgentAuthorityLease,
  createAgentId,
  createAuthorityHolderId,
  createAuthorityLeaseId,
  createIdempotencyKey,
  createOwner,
  createOwnerId,
  createRunId,
  createSessionId,
  createThreadId,
  createTurnId,
} from "@himawari-agent/domain";
import { describe, expect, it } from "vitest";
import {
  type ConfiguredPortConformanceHarness,
  type PortConformanceHarness,
  withConfiguredPort,
  withPort,
} from "./harness.js";

const OWNER_ID = createOwnerId("owner-conformance");
const AGENT_ID = createAgentId("agent-conformance");
const RUN_ID = createRunId("run-conformance");
const SESSION_ID = createSessionId("session-conformance");
const THREAD_ID = createThreadId("thread-conformance");
const TURN_ID = createTurnId("turn-conformance");
const T0 = "2026-08-25T00:00:00.000Z";
const T1 = "2026-08-25T00:00:01.000Z";
const T2 = "2026-08-25T00:00:02.000Z";

async function collect<TValue>(values: AsyncIterable<TValue>): Promise<readonly TValue[]> {
  const collected: TValue[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}

async function expectPortError(action: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await action();
    throw new Error("Expected an ApplicationPortError");
  } catch (error) {
    expect(error).toBeInstanceOf(ApplicationPortError);
    expect((error as ApplicationPortError).code).toBe(code);
  }
}

export function stateStorePortConformance(harness: PortConformanceHarness<StateStorePort>): void {
  describe("StateStorePort conformance", () => {
    it("creates and conditionally advances immutable revisions", async () => {
      await withPort(harness, async (port) => {
        expect(await port.read("run:01")).toBeUndefined();
        const created = await port.compareAndSet({
          key: "run:01",
          expectedRevision: null,
          value: { status: "accepted" },
        });
        const updated = await port.compareAndSet({
          key: "run:01",
          expectedRevision: 1,
          value: { status: "running" },
        });

        expect(created).toMatchObject({ revision: 1, value: { status: "accepted" } });
        expect(updated).toMatchObject({ revision: 2, value: { status: "running" } });
      });
    });

    it("rejects stale compare-and-set writes", async () => {
      await withPort(harness, async (port) => {
        await port.compareAndSet({ key: "run:01", expectedRevision: null, value: { value: 1 } });
        await expectPortError(
          () => port.compareAndSet({ key: "run:01", expectedRevision: null, value: { value: 2 } }),
          PORT_ERROR_CODES.CONFLICT,
        );
      });
    });

    it("does not expose mutable stored state", async () => {
      await withPort(harness, async (port) => {
        const source = { nested: { value: 1 } } as JsonObject;
        await port.compareAndSet({ key: "run:01", expectedRevision: null, value: source });
        const first = await port.read("run:01");
        expect(first).toBeDefined();
        try {
          const exposed = first?.value as { nested: { value: number } };
          exposed.nested.value = 2;
        } catch {
          // Frozen values are also valid defensive isolation.
        }
        expect(await port.read("run:01")).toMatchObject({ value: { nested: { value: 1 } } });
      });
    });
  });
}

export function reliableEventPortConformance(
  harness: PortConformanceHarness<ReliableEventPort>,
): void {
  describe("ReliableEventPort conformance", () => {
    const event = {
      id: "event-01",
      idempotencyKey: createIdempotencyKey("event-idempotency-01"),
      topic: "run.changed",
      payloadRef: "payload-event-01",
      occurredAt: T0,
    } as const;

    it("appends idempotently and lists pending events", async () => {
      await withPort(harness, async (port) => {
        const first = await port.append(event);
        const duplicate = await port.append(event);

        expect(duplicate).toEqual(first);
        expect(await port.listPending(10)).toEqual([first]);
      });
    });

    it("marks publication without deleting the durable event", async () => {
      await withPort(harness, async (port) => {
        await port.append(event);
        const published = await port.markPublished(event.id, T1);

        expect(published.publishedAt).toBe(T1);
        expect(await port.listPending(10)).toEqual([]);
      });
    });
  });
}

export interface ProductStateRepositoryFixture {
  readonly repository: ProductStateRepositoryPort;
  readonly authority: {
    readonly leaseId: ReturnType<typeof createAuthorityLeaseId>;
    readonly fencingToken: number;
  };
}

export interface ProductStateRepositoryConfiguration {
  readonly ownerId: typeof OWNER_ID;
  readonly agentId: typeof AGENT_ID;
}

export function productStateRepositoryPortConformance(
  harness: ConfiguredPortConformanceHarness<
    ProductStateRepositoryFixture,
    ProductStateRepositoryConfiguration
  >,
): void {
  describe("ProductStateRepositoryPort conformance", () => {
    it("atomically commits state, outbox events, and a stable command result", async () => {
      await withConfiguredPort(
        harness,
        { ownerId: OWNER_ID, agentId: AGENT_ID },
        async ({ repository, authority }) => {
          const input = {
            command: {
              ownerId: OWNER_ID,
              agentId: AGENT_ID,
              idempotencyKey: createIdempotencyKey("command-conformance-01"),
              commandType: "run.transition",
              commandFingerprint: "run.transition:accepted:running",
              authority,
            },
            state: {
              key: "run:conformance",
              expectedRevision: null,
              value: { status: "accepted" },
            },
            events: [
              {
                id: "event-conformance-01",
                idempotencyKey: createIdempotencyKey("command-conformance-01"),
                topic: "run.accepted",
                payloadRef: "payload-event-conformance-01",
                occurredAt: T0,
              },
            ],
            resultRef: "run:conformance",
            committedAt: T0,
          } as const;

          const committed = await repository.commitStateAndEvents(input);
          const replayed = await repository.commitStateAndEvents(input);

          expect(committed).toMatchObject({
            replayed: false,
            state: { revision: 1 },
            commandResult: { resultRef: "run:conformance", stateRevision: 1 },
          });
          expect(await repository.read("run:conformance")).toEqual(committed.state);
          expect(await repository.listPending(10)).toEqual(committed.events);
          expect(
            await repository.findCommandResult({
              ownerId: OWNER_ID,
              agentId: AGENT_ID,
              idempotencyKey: input.command.idempotencyKey,
            }),
          ).toEqual(committed.commandResult);
          expect(replayed).toEqual({ ...committed, replayed: true });
        },
      );
    });

    it("rejects reuse of an idempotency key for different command content", async () => {
      await withConfiguredPort(
        harness,
        { ownerId: OWNER_ID, agentId: AGENT_ID },
        async ({ repository, authority }) => {
          const idempotencyKey = createIdempotencyKey("command-conformance-02");
          const input = {
            command: {
              ownerId: OWNER_ID,
              agentId: AGENT_ID,
              idempotencyKey,
              commandType: "run.admit",
              commandFingerprint: "run.admit:one",
              authority,
            },
            state: {
              key: "run:conformance",
              expectedRevision: null,
              value: { status: "accepted" },
            },
            events: [
              {
                id: "event-conformance-02",
                idempotencyKey,
                topic: "run.accepted",
                payloadRef: "payload-event-conformance-02",
                occurredAt: T0,
              },
            ],
            resultRef: "run:conformance",
            committedAt: T0,
          } as const;
          await repository.commitStateAndEvents(input);

          await expectPortError(
            () =>
              repository.commitStateAndEvents({
                ...input,
                command: { ...input.command, commandFingerprint: "run.admit:different" },
              }),
            PORT_ERROR_CODES.CONFLICT,
          );
        },
      );
    });
  });
}

export function reliableEventSinkPortConformance(
  harness: PortConformanceHarness<ReliableEventSinkPort>,
): void {
  describe("ReliableEventSinkPort conformance", () => {
    it("deduplicates redelivery by event identity", async () => {
      await withPort(harness, async (port) => {
        const event = {
          id: "event-sink-conformance-01",
          idempotencyKey: createIdempotencyKey("event-sink-command-01"),
          topic: "run.accepted",
          payloadRef: "payload-event-sink-conformance-01",
          occurredAt: T0,
          publishedAt: null,
        } as const;

        await expect(port.publish(event)).resolves.toEqual({
          eventId: event.id,
          outcome: "published",
        });
        await expect(port.publish(event)).resolves.toEqual({
          eventId: event.id,
          outcome: "duplicate",
        });
        await expectPortError(
          () => port.publish({ ...event, payloadRef: "payload-different" }),
          PORT_ERROR_CODES.CONFLICT,
        );
      });
    });
  });
}

function traceEvent(id: string, sequence: number): TraceEvent {
  return {
    id,
    schemaVersion: "trace.v1",
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    runId: RUN_ID,
    turnId: TURN_ID,
    parentEventId: sequence === 1 ? null : "trace-01",
    causationId: sequence === 1 ? null : "trace-01",
    correlationId: "correlation-01",
    sequence,
    occurredAt: sequence === 1 ? T0 : T1,
    recordedAt: sequence === 1 ? T0 : T1,
    actorId: "actor-01",
    dataClassification: "private",
    eventType: sequence === 1 ? "run.accepted" : "run.running",
    payloadRef: null,
  };
}

export function traceStorePortConformance(harness: PortConformanceHarness<TraceStorePort>): void {
  describe("TraceStorePort conformance", () => {
    it("preserves append order and supports Run-local resume", async () => {
      await withPort(harness, async (port) => {
        await port.append(traceEvent("trace-01", 1));
        await port.append(traceEvent("trace-02", 2));

        expect((await port.readRun(RUN_ID, 0, 10)).map(({ id }) => id)).toEqual([
          "trace-01",
          "trace-02",
        ]);
        expect((await port.readRun(RUN_ID, 1, 10)).map(({ id }) => id)).toEqual(["trace-02"]);
      });
    });

    it("rejects a duplicate event identity", async () => {
      await withPort(harness, async (port) => {
        await port.append(traceEvent("trace-01", 1));
        await expectPortError(
          () => port.append(traceEvent("trace-01", 2)),
          PORT_ERROR_CODES.DUPLICATE,
        );
      });
    });
  });
}

export function payloadStorePortConformance(
  harness: PortConformanceHarness<PayloadStorePort>,
): void {
  describe("PayloadStorePort conformance", () => {
    it("round-trips defensive byte copies and deletes explicitly", async () => {
      await withPort(harness, async (port) => {
        const ciphertext = new Uint8Array([1, 2, 3]);
        await port.put({
          ref: "payload-01",
          dataClassification: "sensitive",
          contentType: "application/octet-stream",
          ciphertext,
          encryption: { algorithm: "test", keyRef: "key-01" },
          contentDigest: "digest-01",
          createdAt: T0,
        });
        ciphertext[0] = 9;

        const stored = await port.get("payload-01");
        expect([...(stored?.ciphertext ?? [])]).toEqual([1, 2, 3]);
        expect(await port.delete("payload-01")).toBe(true);
        expect(await port.get("payload-01")).toBeUndefined();
      });
    });

    it("rejects duplicate payload references", async () => {
      await withPort(harness, async (port) => {
        const payload = {
          ref: "payload-01",
          dataClassification: "private" as const,
          contentType: "text/plain",
          ciphertext: new Uint8Array([1]),
          encryption: { algorithm: "test", keyRef: "key-01" },
          contentDigest: "digest-01",
          createdAt: T0,
        };
        await port.put(payload);
        await expectPortError(() => port.put(payload), PORT_ERROR_CODES.DUPLICATE);
      });
    });
  });
}

export function auditLedgerPortConformance(harness: PortConformanceHarness<AuditLedgerPort>): void {
  describe("AuditLedgerPort conformance", () => {
    it("appends minimal records and resumes after a stable identity", async () => {
      await withPort(harness, async (port) => {
        const first = {
          id: "audit-01",
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          action: "run.create",
          targetRef: "run-conformance",
          outcome: "accepted" as const,
          occurredAt: T0,
        };
        const second = { ...first, id: "audit-02", action: "run.start", occurredAt: T1 };
        await port.append(first);
        await port.append(second);

        expect((await port.listByAgent(AGENT_ID, "audit-01")).map(({ id }) => id)).toEqual([
          "audit-02",
        ]);
      });
    });
  });
}

export function authorizationStorePortConformance(
  harness: PortConformanceHarness<AuthorizationStorePort>,
): void {
  describe("AuthorizationStorePort conformance", () => {
    const approval: ApprovalRequest = {
      id: "approval-conformance-01",
      revision: 1,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      intentId: "intent-conformance-01",
      intentSnapshot: {
        id: "intent-conformance-01",
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
        capabilityRef: "restaurant-search",
        operation: "search",
        resourceRef: "city:tokyo",
        dataClassification: "private",
        sideEffect: "none",
        estimatedCostMicros: 100,
        frequency: { count: 1, intervalMs: null },
        idempotencyKey: createIdempotencyKey("intent-conformance-01"),
        reversible: true,
        requestedAt: T0,
      },
      semanticSnapshotHash: "intent-hash-conformance-01",
      status: "pending",
      deliveryState: "queued_no_ui",
      requestedAt: T0,
      expiresAt: T2,
      decidedAt: null,
      grantId: null,
    };
    const grant: GrantRecord = {
      id: "grant-conformance-01",
      revision: 1,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      kind: "one_time",
      scope: {
        capabilityRef: "restaurant-search",
        operations: ["search"],
        exactResourceRef: "city:tokyo",
        resourcePrefixes: [],
        maxDataClassification: "private",
        sideEffects: ["none"],
        maxCostMicrosPerUse: 100,
        maxFrequency: { count: 1, intervalMs: null },
      },
      intentFingerprint: "intent-hash-conformance-01",
      sourceApprovalRequestId: approval.id,
      validFrom: T0,
      expiresAt: T2,
      maxUses: 1,
      uses: 0,
      maxTotalCostMicros: 100,
      spentCostMicros: 0,
      revokedAt: null,
      revocationReasonCode: null,
    };

    it("atomically resolves an approval with its Grant and accounts usage", async () => {
      await withPort(harness, async (port) => {
        await port.createApproval(approval);
        expect(await port.findApprovalByIntent(approval.intentId)).toEqual(approval);

        const resolved = await port.resolveApproval({
          approvalRequestId: approval.id,
          expectedRevision: 1,
          semanticSnapshotHash: approval.semanticSnapshotHash,
          resolution: "approved",
          decidedAt: T1,
          grant,
        });
        expect(resolved).toMatchObject({ status: "approved", grantId: grant.id, revision: 2 });
        expect(await port.listGrants(OWNER_ID, AGENT_ID)).toEqual([grant]);

        const consumed = await port.consumeGrant({
          grantId: grant.id,
          expectedRevision: 1,
          costMicros: 100,
          consumedAt: T1,
        });
        expect(consumed).toMatchObject({ revision: 2, uses: 1, spentCostMicros: 100 });
        await expectPortError(
          () =>
            port.consumeGrant({
              grantId: grant.id,
              expectedRevision: 2,
              costMicros: 1,
              consumedAt: T1,
            }),
          PORT_ERROR_CODES.INVALID_OPERATION,
        );
      });
    });

    it("rejects a changed semantic snapshot during resolution", async () => {
      await withPort(harness, async (port) => {
        await port.createApproval(approval);
        await expectPortError(
          () =>
            port.resolveApproval({
              approvalRequestId: approval.id,
              expectedRevision: 1,
              semanticSnapshotHash: "different-hash",
              resolution: "denied",
              decidedAt: T1,
              grant: null,
            }),
          PORT_ERROR_CODES.CONFLICT,
        );
      });
    });
  });
}

export function memoryPortConformance(harness: PortConformanceHarness<MemoryPort>): void {
  describe("MemoryPort conformance", () => {
    it("keeps write proposals separate until explicitly committed", async () => {
      await withPort(harness, async (port) => {
        const proposal = {
          id: "memory-proposal-01",
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          contentRef: "payload-memory-01",
          sourceRef: "trace-source-01",
          searchTerms: ["beef", "restaurant"],
          dataClassification: "private" as const,
          proposedAt: T0,
        };
        await port.proposeWrite(proposal);
        expect(
          await port.search({
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            queryRef: "q",
            queryTerms: ["beef"],
            limit: 10,
          }),
        ).toEqual([]);
        expect(await port.listWriteProposals(AGENT_ID)).toEqual([proposal]);

        await port.commitWrite(proposal.id, "memory-01", T1);
        const candidates = await port.search({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          queryRef: "payload-query-01",
          queryTerms: ["beef"],
          limit: 10,
        });
        expect(candidates).toMatchObject([
          { id: "memory-01", contentRef: proposal.contentRef, sourceRef: proposal.sourceRef },
        ]);
      });
    });

    it("supports correction and deletion without losing provenance", async () => {
      await withPort(harness, async (port) => {
        await port.proposeWrite({
          id: "memory-proposal-01",
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          contentRef: "payload-memory-01",
          sourceRef: "trace-source-01",
          searchTerms: ["beef"],
          dataClassification: "private",
          proposedAt: T0,
        });
        await port.commitWrite("memory-proposal-01", "memory-01", T1);
        const corrected = await port.correct({
          memoryId: "memory-01",
          contentRef: "payload-memory-corrected-01",
          sourceRef: "trace-correction-01",
          searchTerms: ["wagyu"],
          correctedAt: T2,
        });

        expect(corrected).toMatchObject({
          contentRef: "payload-memory-corrected-01",
          sourceRef: "trace-correction-01",
          searchTerms: ["wagyu"],
        });
        expect(await port.delete("memory-01")).toBe(true);
      });
    });

    it("ranks only matching terms and retains candidate provenance", async () => {
      await withPort(harness, async (port) => {
        await port.proposeWrite({
          id: "memory-proposal-beef",
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          contentRef: "payload-memory-beef",
          sourceRef: "trace-source-beef",
          searchTerms: ["beef", "restaurant"],
          dataClassification: "private",
          proposedAt: T0,
        });
        await port.commitWrite("memory-proposal-beef", "memory-beef", T1);
        await port.proposeWrite({
          id: "memory-proposal-sushi",
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          contentRef: "payload-memory-sushi",
          sourceRef: "trace-source-sushi",
          searchTerms: ["sushi"],
          dataClassification: "private",
          proposedAt: T0,
        });
        await port.commitWrite("memory-proposal-sushi", "memory-sushi", T1);

        expect(
          await port.search({
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            queryRef: "payload-query-beef",
            queryTerms: ["beef", "dinner"],
            limit: 10,
          }),
        ).toMatchObject([
          {
            id: "memory-beef",
            sourceRef: "trace-source-beef",
            searchTerms: ["beef", "restaurant"],
            score: 0.5,
          },
        ]);
      });
    });
  });
}

export interface ModelPortFixture {
  readonly descriptors: readonly ModelDescriptor[];
  readonly events: readonly ModelInvocationEvent[];
}

export function modelPortConformance(
  harness: ConfiguredPortConformanceHarness<ModelPort, ModelPortFixture>,
): void {
  describe("ModelPort conformance", () => {
    it("exposes product descriptors and a deterministic product event stream", async () => {
      const descriptor: ModelDescriptor = {
        ref: "model-primary",
        provider: "deterministic",
        model: "fixture-model",
        version: "1.0.0",
        routingClass: "primary",
        priority: 10,
        disclosure: "trusted_remote",
        capabilities: ["text"],
        allowedDataClassifications: ["public", "private"],
        secretRequirement: null,
      };
      const events: readonly ModelInvocationEvent[] = [
        { type: "model.started", invocationId: "model-call-01", occurredAt: T0 },
        {
          type: "model.completed",
          invocationId: "model-call-01",
          inputTokens: 10,
          outputTokens: 5,
          costMicros: 0,
          latencyMs: 1000,
          occurredAt: T1,
        },
      ];
      await withConfiguredPort(harness, { descriptors: [descriptor], events }, async (port) => {
        expect(await port.listAvailable()).toEqual([descriptor]);
        expect(
          await collect(
            port.invoke({
              invocationId: "model-call-01",
              runId: RUN_ID,
              modelRef: descriptor.ref,
              inputRef: "payload-model-input-01",
              dataClassification: "private",
              allowedDisclosureRef: "disclosure-01",
              secretHandleRefs: [],
              correlationId: "correlation-01",
            }),
          ),
        ).toEqual(events);
      });
    });
  });
}

export interface RuntimePortFixture {
  readonly events: readonly RuntimeEvent[];
}

export function agentRuntimePortConformance(
  harness: ConfiguredPortConformanceHarness<AgentRuntimePort, RuntimePortFixture>,
): void {
  describe("AgentRuntimePort conformance", () => {
    const request = {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      threadId: null,
      modelRef: "model-primary",
      systemInstructionRef: "payload-system-01",
      messageRefs: ["payload-message-01"],
      capabilityHandleRefs: ["capability-handle-01"],
      budget: { maxTurns: 3 },
      correlationId: "correlation-01",
      dataClassification: "private",
    } as const;

    it("streams only product runtime events", async () => {
      const events: readonly RuntimeEvent[] = [
        { type: "runtime.model_started", runId: RUN_ID, occurredAt: T0 },
        { type: "runtime.completed", runId: RUN_ID, occurredAt: T1 },
      ];
      await withConfiguredPort(harness, { events }, async (port) => {
        const observed = await collect(port.run(request));
        expect(observed).toEqual(events);
        expect(JSON.stringify(observed)).not.toMatch(/AgentSession|AgentEvent|ToolDefinition/);
      });
    });

    it("makes cancellation idempotent and observable", async () => {
      await withConfiguredPort(harness, { events: [] }, async (port) => {
        await port.cancel(RUN_ID);
        await port.cancel(RUN_ID);
        expect(await collect(port.run(request))).toEqual([
          {
            type: "runtime.cancelled",
            runId: RUN_ID,
            reasonCode: "RUNTIME_CANCELLED",
            occurredAt: T0,
          },
        ]);
      });
    });
  });
}

export interface WorkerRunPortFixture {
  readonly events: readonly WorkerRunEvent[];
}

export function workerRunPortConformance(
  harness: ConfiguredPortConformanceHarness<WorkerRunPort, WorkerRunPortFixture>,
): void {
  describe("WorkerRunPort conformance", () => {
    const request = {
      workerRunId: "worker-run-01",
      idempotencyKey: "worker-command-01",
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      parentRunId: RUN_ID,
      taskRef: "payload-worker-task-01",
      delegatedContextRefs: ["payload-worker-context-01"],
      capabilityHandleRefs: ["capability-handle-01"],
      secretRefs: [],
      dataClassification: "private" as const,
      budget: { maxDurationMs: 1_000, maxCostMicros: 10_000, maxProgressEvents: 2 },
      deadlineAt: T2,
    };

    it("streams scoped progress and replays a duplicate command", async () => {
      const events: readonly WorkerRunEvent[] = [
        {
          type: "worker.progress",
          workerRunId: request.workerRunId,
          sequence: 1,
          payloadRef: "payload-worker-progress-01",
          occurredAt: T0,
        },
        {
          type: "worker.completed",
          workerRunId: request.workerRunId,
          resultRef: "payload-worker-result-01",
          costMicros: 1_000,
          durationMs: 500,
          occurredAt: T1,
        },
      ];
      await withConfiguredPort(harness, { events }, async (port) => {
        expect(await collect(port.run(request))).toEqual(events);
        expect(await collect(port.run(request))).toEqual(events);
        await expect(port.cancel(request.workerRunId, "owner_requested")).resolves.toBeUndefined();
        await expect(port.cancel(request.workerRunId, "owner_requested")).resolves.toBeUndefined();
      });
    });
  });
}

export interface RuntimeToolPortFixture {
  readonly descriptors: readonly RuntimeToolDescriptor[];
  readonly execution: RuntimeToolExecutionResult;
}

export function runtimeToolPortConformance(
  harness: ConfiguredPortConformanceHarness<RuntimeToolPort, RuntimeToolPortFixture>,
): void {
  describe("RuntimeToolPort conformance", () => {
    it("authorizes exact handles and deduplicates execution by Run and tool call", async () => {
      const descriptor: RuntimeToolDescriptor = {
        capabilityRef: "restaurant-search",
        capabilityHandleRef: "capability-handle-01",
        name: "restaurant_search",
        description: "Search restaurants",
        parameters: { type: "object" },
      };
      const execution: RuntimeToolExecutionResult = {
        outcome: "succeeded",
        resultRef: "payload-tool-result-01",
        errorCode: null,
        externalActionId: "external-action-01",
        modelContent: "One matching restaurant",
      };
      await withConfiguredPort(harness, { descriptors: [descriptor], execution }, async (port) => {
        expect(await port.listAuthorized(RUN_ID, [descriptor.capabilityHandleRef])).toEqual([
          descriptor,
        ]);
        const invocation = {
          runId: RUN_ID,
          toolCallId: "tool-call-01",
          capabilityRef: descriptor.capabilityRef,
          capabilityHandleRef: descriptor.capabilityHandleRef,
          arguments: { query: "dinner" },
          dataClassification: "private" as const,
        };
        await expect(port.preflight(invocation)).resolves.toMatchObject({ allowed: true });
        expect(await port.execute(invocation)).toEqual(execution);
        expect(await port.execute(invocation)).toEqual(execution);
      });
    });
  });
}

export interface CapabilityPortFixture {
  readonly descriptors: readonly CapabilityDescriptor[];
  readonly events: readonly CapabilityInvocationEvent[];
}

export function capabilityPortConformance(
  harness: ConfiguredPortConformanceHarness<CapabilityPort, CapabilityPortFixture>,
): void {
  describe("CapabilityPort conformance", () => {
    it("exposes governed descriptors and reference-only execution events", async () => {
      const descriptor: CapabilityDescriptor = {
        ref: "restaurant-search",
        version: "1.0.0",
        integrity: "sha256-fixture",
        lifecycle: "active",
        permissionRefs: ["permission-network-map"],
        isolation: "worker",
      };
      const events: readonly CapabilityInvocationEvent[] = [
        {
          type: "capability.completed",
          invocationId: "capability-call-01",
          resultRef: "payload-capability-result-01",
          occurredAt: T1,
        },
      ];
      await withConfiguredPort(harness, { descriptors: [descriptor], events }, async (port) => {
        expect(await port.list()).toEqual([descriptor]);
        const observed = await collect(
          port.invoke({
            invocationId: "capability-call-01",
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            runId: RUN_ID,
            capabilityRef: descriptor.ref,
            capabilityHandleRef: "capability-handle-01",
            operation: "search",
            inputRef: "payload-capability-input-01",
            delegatedContextRefs: ["payload-capability-context-01"],
            secretHandleRefs: ["secret-handle-01"],
            dataClassification: "private",
          }),
        );
        expect(observed).toEqual(events);
        expect(JSON.stringify(observed)).not.toContain("secretValue");
        await expect(port.cancel("capability-call-01", "owner_requested")).resolves.toBeUndefined();
        await expect(port.cancel("capability-call-01", "owner_requested")).resolves.toBeUndefined();
      });
    });
  });
}

export function capabilityRegistryStorePortConformance(
  harness: PortConformanceHarness<CapabilityRegistryStorePort & CapabilityExecutionHandleStorePort>,
): void {
  describe("CapabilityRegistryStorePort conformance", () => {
    const declaration = {
      ref: "restaurant-search",
      displayName: "Restaurant Search",
      version: "1.0.0",
      source: { type: "builtin" as const, locator: "builtin:restaurant-search" },
      integrity: `sha256:${"a".repeat(64)}`,
      operations: ["search"],
      permissionRefs: ["network:maps.test"],
      isolation: "worker" as const,
    };
    const record = {
      ref: declaration.ref,
      revision: 1,
      lifecycle: "discovered" as const,
      declaration,
      pendingDeclaration: null,
      permissionExpansion: false,
      approvalRefs: [],
      discoveredAt: T0,
      updatedAt: T0,
    };

    it("persists revision-checked lifecycle records", async () => {
      await withPort(harness, async (port) => {
        expect(await port.create(record)).toEqual(record);
        const proposed = { ...record, revision: 2, lifecycle: "installation_proposed" as const };
        expect(await port.save(proposed, 1)).toEqual(proposed);
        await expectPortError(
          () => port.save({ ...proposed, revision: 3 }, 1),
          PORT_ERROR_CODES.CONFLICT,
        );
      });
    });

    it("keeps short-lived handles separate and makes revocation observable", async () => {
      await withPort(harness, async (port) => {
        await port.create(record);
        const handle = {
          ref: "capability-handle-conformance-01",
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          runId: RUN_ID,
          capabilityRef: declaration.ref,
          capabilityVersion: declaration.version,
          authorization: { type: "grant" as const, ref: "grant-conformance-01" },
          operations: ["search"],
          inputRefs: ["payload-input-01"],
          delegatedContextRefs: ["payload-context-01"],
          secretRefs: [],
          maxDataClassification: "private" as const,
          issuedAt: T0,
          expiresAt: T2,
          revokedAt: null,
        };
        await port.createExecutionHandle(handle);
        expect(await port.getExecutionHandle(handle.ref)).toEqual(handle);
        expect(await port.revokeExecutionHandle(handle.ref, T1)).toMatchObject({ revokedAt: T1 });
      });
    });
  });
}

export function secretPortConformance(harness: PortConformanceHarness<SecretPort>): void {
  describe("SecretPort conformance", () => {
    const request = {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      secretRef: "secret-map-provider",
      secretVersion: "version-01",
      purpose: "restaurant-search",
      scopeRef: "capability-call-01",
      expiresAt: T2,
    } as const;

    it("issues opaque handles without returning secret material", async () => {
      await withPort(harness, async (port) => {
        const handle = await port.issueHandle(request);
        expect(handle).toMatchObject({
          ownerId: request.ownerId,
          agentId: request.agentId,
          runId: request.runId,
          secretRef: request.secretRef,
          secretVersion: request.secretVersion,
          purpose: request.purpose,
          scopeRef: request.scopeRef,
          revokedAt: null,
        });
        expect(Object.keys(handle)).not.toContain("secretValue");
      });
    });

    it("makes revocation observable through handle inspection", async () => {
      await withPort(harness, async (port) => {
        const handle = await port.issueHandle(request);
        expect((await port.revokeHandle(handle.ref, T1)).revokedAt).toBe(T1);
        expect((await port.inspectHandle(handle.ref))?.revokedAt).toBe(T1);
      });
    });
  });
}

export function schedulerPortConformance(harness: PortConformanceHarness<SchedulerPort>): void {
  describe("SchedulerPort conformance", () => {
    it("upserts and returns due active jobs in deterministic order", async () => {
      await withPort(harness, async (port) => {
        const later = {
          id: "job-02",
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          triggerRef: "trigger-schedule-02",
          idempotencyKey: createIdempotencyKey("schedule-job-02"),
          nextRunAt: T2,
          status: "active" as const,
        };
        const earlier = {
          ...later,
          id: "job-01",
          triggerRef: "trigger-schedule-01",
          idempotencyKey: createIdempotencyKey("schedule-job-01"),
          nextRunAt: T1,
        };
        await port.upsert(later);
        await port.upsert(earlier);
        expect((await port.listDue(T2, 10)).map(({ id }) => id)).toEqual(["job-01", "job-02"]);
      });
    });

    it("excludes cancelled jobs from due work", async () => {
      await withPort(harness, async (port) => {
        await port.upsert({
          id: "job-01",
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          triggerRef: "trigger-schedule-01",
          idempotencyKey: createIdempotencyKey("schedule-job-01"),
          nextRunAt: T1,
          status: "active",
        });
        await port.cancel("job-01");
        expect(await port.listDue(T2, 10)).toEqual([]);
      });
    });
  });
}

export interface AttentionPortFixture {
  readonly decision: AttentionDecision;
}

export function attentionPortConformance(
  harness: ConfiguredPortConformanceHarness<AttentionPort, AttentionPortFixture>,
): void {
  describe("AttentionPort conformance", () => {
    it("returns a deterministic decision and binds INTERRUPT to explicit authorization", async () => {
      const decision: AttentionDecision = {
        candidateId: "attention-01",
        level: "INTERRUPT",
        reasonCode: "authorized_urgent_result",
        interruptAuthorizationRef: "grant-interrupt-01",
      };
      await withConfiguredPort(harness, { decision }, async (port) => {
        const candidate = {
          id: "attention-01",
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          runId: RUN_ID,
          resultRef: "payload-result-01",
          dataClassification: "private" as const,
          urgency: 100,
          confidence: 95,
          duplicateKey: "restaurant-alert-01",
          interruptAuthorizationRef: "grant-interrupt-01",
        };
        expect(await port.evaluate(candidate)).toEqual(decision);
        expect(await port.evaluate(candidate)).toEqual(decision);
      });
    });
  });
}

class SuiteClock implements ClockPort {
  private current: string;

  constructor(current: string) {
    this.current = current;
  }

  now(): string {
    return this.current;
  }

  set(now: string): void {
    this.current = now;
  }
}

export interface AuthorityLeasePortHarness {
  create(clock: ClockPort): AuthorityLeasePort | Promise<AuthorityLeasePort>;
  dispose?(port: AuthorityLeasePort): void | Promise<void>;
}

export function authorityLeasePortConformance(harness: AuthorityLeasePortHarness): void {
  describe("AuthorityLeasePort conformance", () => {
    const owner = createOwner(OWNER_ID);
    const agent = createAgent({ id: AGENT_ID, owner });
    const firstLease = createAgentAuthorityLease({
      id: createAuthorityLeaseId("authority-lease-01"),
      agent,
      holderId: createAuthorityHolderId("authority-holder-01"),
    });
    const secondLease = createAgentAuthorityLease({
      id: createAuthorityLeaseId("authority-lease-02"),
      agent,
      holderId: createAuthorityHolderId("authority-holder-02"),
    });

    it("enforces a single live lease and supports matching renewal", async () => {
      const clock = new SuiteClock(T0);
      const port = await harness.create(clock);
      try {
        const claimed = await port.claim(firstLease, 1000);
        expect(claimed).toMatchObject({ fencingToken: 1, acquiredAt: T0, expiresAt: T1 });
        await expectPortError(() => port.claim(secondLease, 1000), PORT_ERROR_CODES.CONFLICT);
        expect((await port.renew(firstLease.id, 2000)).expiresAt).toBe(T2);
      } finally {
        await harness.dispose?.(port);
      }
    });

    it("expires by injected clock and advances the fencing token on a new claim", async () => {
      const clock = new SuiteClock(T0);
      const port = await harness.create(clock);
      try {
        await port.claim(firstLease, 1000);
        clock.set(T1);
        expect(await port.current(AGENT_ID)).toBeUndefined();
        expect((await port.claim(secondLease, 1000)).fencingToken).toBe(2);
      } finally {
        await harness.dispose?.(port);
      }
    });
  });
}

export function clockPortConformance(harness: PortConformanceHarness<ClockPort>): void {
  describe("ClockPort conformance", () => {
    it("returns a stable canonical UTC timestamp until explicitly advanced", async () => {
      await withPort(harness, async (port) => {
        expect(port.now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(port.now()).toBe(port.now());
      });
    });
  });
}

export function idGeneratorPortConformance(harness: PortConformanceHarness<IdGeneratorPort>): void {
  describe("IdGeneratorPort conformance", () => {
    it("returns stable machine identifiers without collisions in one generator", async () => {
      await withPort(harness, (port) => {
        const first = port.next("run");
        const second = port.next("run");
        expect(first).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
        expect(second).not.toBe(first);
      });
    });
  });
}
