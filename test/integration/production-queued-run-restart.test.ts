import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  ActionPolicyService,
  ApprovalService,
  CapabilityHandleService,
  type CapabilityManifest,
  type GovernedGrantRecord,
} from "@himawari-agent/application";
import {
  createAuthorityHolderId,
  createAuthorityLeaseId,
  createRunExecutionLeaseId,
} from "@himawari-agent/domain";
import type { ExecutionV2Event, ExecutionV2Request } from "@himawari-agent/execution-contracts";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { createProductionRunComposition } from "../../apps/agent-service/src/production-run-composition.ts";
import { ProductionRuntimeTools } from "../../apps/agent-service/src/production-runtime-tools.ts";
import { createProductionWorkerParentBindingRegistry } from "../../apps/agent-service/src/production-worker-parent-binding-registry.ts";
import { createFauxModelFixture } from "../../packages/runtime-pi/test/faux-model-fixture.ts";
import { productionSandboxScope } from "../fixtures/production-sandbox-scope.ts";
import {
  AGENT_ID,
  grant,
  LIVE_SANDBOX,
  OWNER_ID,
  SERVICE_AUTHORITY,
  T1,
  T2,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

it.each([
  { coding: false, scenario: "resume" },
  ...[
    "resume",
    "cancelled",
    "admitted",
    "receipt",
    "payload-unavailable",
    "changed-model",
    "changed-tools",
    "boot-only",
    "revoked",
  ].map((scenario) => ({ coding: true, scenario })),
])(
  "recovers the original Pi queue safely (coding=$coding, $scenario)",
  async ({ coding, scenario }) => {
    const live = LIVE_SANDBOX && coding && scenario === "resume";
    if (live && process.platform !== "darwin") throw new Error("QUEUED_LIVE_PROBE_REQUIRES_MACOS");
    const codingName = live ? "write" : "bash";
    let liveWorker:
      | Awaited<ReturnType<typeof import("../fixtures/queued-live-worker.ts").queuedLiveWorker>>
      | undefined;
    const started = performance.now();
    const milestone = (stage: string) => {
      if (live)
        console.log(
          JSON.stringify({
            queuedLiveStage: stage,
            elapsedMs: Math.round(performance.now() - started),
          }),
        );
    };
    let authority = SERVICE_AUTHORITY;
    const clock = { now: () => (live ? new Date().toISOString() : T1) };
    const f = await productionSandboxScope(
      {
        operation: codingName,
        mode: "foreground",
        contract: live
          ? {
              ref: "pi-coding-tool",
              version: "3",
              kind: "verified_effect",
              verifierRef: "pi-atomic-write",
              verifierVersion: "1",
              targetRef: "pi-input:path",
            }
          : { ref: "bash", version: "1", kind: "command" },
        backendRef: "srt",
        scopeSource: "grant_targets",
        directoryOperations: ["read", "create", "update"],
        network: "disabled",
      },
      undefined,
      {
        ...(live
          ? { piRuntimeRoot: path.resolve("dist/node-runtime"), realFileIdentity: true }
          : {}),
        authority: () => authority,
        seedRuntimeIntent: false,
        resourceCeiling: {
          maxWallTimeMs: live ? 300000 : 30000,
          maxCpuTimeMs: live ? 10000 : 1000,
          maxMemoryBytes: live ? 268435456 : 1000000,
          maxOutputBytes: 4096,
          maxProgressEvents: 10,
        },
      },
    );
    milestone("fixture-ready");
    const adapters = createReferenceAdapterSet({ clock });
    const runId = f.call.runId;
    const handleRef = f.input.handleRef;
    const name = coding
      ? codingName
      : `authorized_${createHash("sha256").update(JSON.stringify(handleRef)).digest("hex").slice(0, 24)}`;
    let completedProbeCalls = 0;
    const model = await createFauxModelFixture("恢复后的回答", [
      { name: "completed_probe", id: "completed-probe-call", arguments: {} },
      {
        name,
        id: f.call.toolCallId,
        arguments: coding
          ? live
            ? { path: "queued.txt", content: "queued" }
            : { command: "printf queued" }
          : f.call.arguments,
      },
    ]);
    const models = {
      resolve: async (ref: string) => {
        expect(ref).toBe(f.model.ref);
        const binding = await model.models.resolve(model.descriptor.ref);
        return { ...binding, descriptor: { ...model.descriptor, ref } };
      },
    };
    f.setFileBindingAvailable(true);
    let approvalCount = 0;
    let issueCount = 0;
    let observedQueue!: () => void;
    const queued = new Promise<void>((resolve) => {
      observedQueue = resolve;
    });
    let releaseOld!: () => void;
    const oldProcessLost = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let stopAtQueue = true;
    let toolFailure: unknown;
    let toolResult: unknown;
    let sent: Extract<ExecutionV2Request, { type: "work.execute" }> | undefined;
    const request = vi.fn(async (message: ExecutionV2Request) => {
      if (liveWorker) {
        if (message.type === "work.execute") sent = message;
        try {
          return await liveWorker.worker.request(message);
        } catch (error) {
          console.error(
            JSON.stringify({ liveWorkerRequestFailed: message.type, error: String(error) }),
          );
          throw error;
        }
      }
      if (message.type === "work.delegate")
        return {
          ...message,
          kind: "response" as const,
          type: "work.delegate.accepted" as const,
          messageId: "accepted",
          causationId: message.messageId,
          payload: {
            handleRef: message.payload.handle.ref,
            workerBootId: authority.workerBootId,
            acceptedAt: T1,
          },
        };
      if (message.type === "work.execute") sent = message;
      return null;
    });
    const make = (instanceId: string) => {
      const peer = {
        ...authority.product,
        agentServiceInstanceId: authority.agentServiceInstanceId,
        agentServiceBootId: authority.agentServiceBootId,
        workerInstanceId: authority.workerInstanceId,
        workerBootId: authority.workerBootId,
      };
      const registry = createProductionWorkerParentBindingRegistry({
        trustedPeerBinding: () => peer,
      });
      const preparations = f.services.brokerV2.preparations;
      const sandbox = {
        ...f.services.runtime,
        preparations: {
          ...preparations,
          enqueue: async (input: Parameters<typeof preparations.enqueue>[0]) => {
            const result = await preparations.enqueue(input);
            if (stopAtQueue) {
              observedQueue();
              await oldProcessLost;
              throw new Error("TEST_OLD_PROCESS_LOST");
            }
            return result;
          },
        },
      };
      const store = f.repository.authorizationStore();
      const capabilities = f.repository.capabilityStore(OWNER_ID, AGENT_ID);
      const policy = new ActionPolicyService({
        store,
        capabilities: {
          inspect: async (ref) => {
            const record = await capabilities.get(ref);
            return record
              ? { lifecycle: record.lifecycle, manifest: record.declaration as CapabilityManifest }
              : undefined;
          },
        },
        policy: { version: "restart-policy", rules: [] },
        clock,
        ids: adapters.ids,
      });
      const handles = new CapabilityHandleService({
        store: capabilities,
        clock,
        ids: adapters.ids,
      });
      const fileRead = {
        binding: async () => f.fileBinding,
        issue: async (input: Parameters<typeof handles.issue>[0]) => {
          issueCount++;
          return handles.issue(input);
        },
        authorize: async (intent: Parameters<typeof policy.evaluate>[0]) => {
          const decision = await policy.evaluate(intent, {
            uiAvailable: true,
            approvalExpiresAt: intent.expiresAt,
          });
          if (decision.decision !== "ASK") return decision;
          approvalCount++;
          const approval = decision.approvalRequest;
          const approved: GovernedGrantRecord = {
            ...grant(),
            id: "restart-coding-grant",
            sourceApprovalRequestId: approval.id,
            intentFingerprint: approval.semanticSnapshotHash,
            validFrom: T1,
            expiresAt: intent.expiresAt,
            scope: {
              capabilityRef: intent.capabilityRef,
              capabilityVersion: intent.capabilityVersion,
              operations: [intent.operation],
              exactResourceRef: intent.resourceRef,
              resourcePrefixes: [],
              resourceIdentities: intent.resourceRefs,
              maxDataClassification: intent.dataClassification,
              sideEffects: [intent.sideEffect],
              maxCostMicrosPerUse: 0,
              maxFrequency: intent.frequency,
              disclosure: intent.disclosure,
              recipients: intent.recipients,
              credentialOrAccessChange: false,
            },
          };
          await new ApprovalService({ store, clock }).respond({
            approvalRequestId: approval.id,
            expectedRevision: approval.revision,
            semanticSnapshotHash: approval.semanticSnapshotHash,
            response: {
              decision: "approved",
              grant: approved,
              recentAuthenticationRef: "fixture-owner-decision",
            },
          });
          return policy.evaluate(intent, {
            uiAvailable: true,
            approvalExpiresAt: intent.expiresAt,
          });
        },
      };
      const tools = new ProductionRuntimeTools({
        ...(coding
          ? {
              coding: {
                ...f.fileBinding,
                grantId: f.fileBinding.grant.id,
                capabilityRef: f.input.capabilityRef,
                enabledTools: [codingName],
              },
              fileRead,
            }
          : {}),
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        capabilities: f.repository.capabilityStore(OWNER_ID, AGENT_ID),
        invocations: f.repository.capabilityInvocationReceiptPort(OWNER_ID, AGENT_ID),
        results: live
          ? f.repository.capabilityInvocationResultPort(OWNER_ID, AGENT_ID)
          : { lookupOutput: async () => undefined },
        artifacts: f.artifacts(),
        payloads: f.repository.payloadStore(OWNER_ID, AGENT_ID),
        protector: f.f.protector,
        sandbox,
        authority: () => authority,
        peer: () => peer,
        parents: registry.writer,
        assertRunActive: async () => {
          const run = await f.repository
            .runLifecycle(OWNER_ID, AGENT_ID, authority.product)
            .readRun(runId);
          if (run?.run.status !== "running") throw new Error("RUN_INACTIVE");
        },
        ceiling: f.input.resourceCeiling,
        clock,
        ids: adapters.ids,
        fileReadEnabled: false,
        transport: {
          request,
          async *events() {
            if (liveWorker) {
              await liveWorker.worker.waitForIdle();
              yield* liveWorker.worker.events(null);
              return;
            }
            if (sent)
              yield {
                ...sent,
                kind: "event",
                type: "work.cancelled",
                messageId: "cancelled",
                causationId: sent.messageId,
                payload: {
                  requestId: sent.messageId,
                  cursor: "1",
                  sequence: 1,
                  cancelledAt: T1,
                  reasonCode: "TEST_WORKER_CANCELLED",
                },
              } satisfies ExecutionV2Event;
          },
        },
      });
      const listAuthorized = tools.listAuthorized.bind(tools);
      tools.listAuthorized = async (...args) => [
        ...(await listAuthorized(...args)).filter(
          (tool) => scenario !== "changed-tools" || stopAtQueue || tool.name !== "bash",
        ),
        {
          name: "completed_probe",
          capabilityRef: "fixture.probe",
          capabilityHandleRef: null,
          description: "local completed result",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ];
      const preflight = tools.preflight.bind(tools);
      tools.preflight = async (call) =>
        call.capabilityRef === "fixture.probe"
          ? {
              allowed: true,
              permissionDecisionRef: "fixture-probe",
              reasonCode: "controlled-pure-read",
            }
          : preflight(call);
      const execute = tools.execute.bind(tools);
      tools.execute = async (...args) => {
        if (args[0].capabilityRef === "fixture.probe") {
          completedProbeCalls++;
          return {
            outcome: "succeeded",
            resultRef: null,
            errorCode: null,
            externalActionId: null,
            modelContent: "already completed",
          };
        }
        try {
          toolResult = await execute(...args);
          return toolResult as Awaited<ReturnType<typeof execute>>;
        } catch (error) {
          toolFailure = error;
          throw error;
        }
      };
      return createProductionRunComposition({
        repository: f.repository,
        configuration: {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          concurrency: { totalRuns: 1, foregroundReserved: 1, perCategory: {} },
          deadlines: { runMs: 300000, workerRequestMs: 10000, providerRequestMs: 10000 },
          budgets: {
            globalCostMicros: 100,
            perRunCostMicros: 100,
            perClassificationCostMicros: { public: 100, private: 100, sensitive: 0, restricted: 0 },
          },
        },
        authority: {
          authorityFence: () => authority.product,
          authorityLease: () => authority.lease,
          assertActive: async () => {},
          isAccepting: () => true,
        },
        models,
        modelRegistry: [{ ...model.descriptor, ref: f.model.ref }],
        protector: f.f.protector,
        memory: adapters.memory,
        tools,
        prepareQueuedSandboxExecutions: f.services.rebindQueuedRun,
        policy: async () => ({
          modelRef: f.model.ref,
          systemInstructionRef: "restart-prompt",
          policyVersion: "restart-policy",
          policies: [],
          capabilities: [],
          capabilityHandleRefs: coding ? [] : [handleRef],
          maxMemoryClassification: "private",
          memoryLimit: 1,
          maxSelectedMemories: 0,
        }),
        clock,
        ids: adapters.ids,
        instanceId,
        cwd: f.f.resource.stateRoot,
        agentDir: path.join(f.f.resource.stateRoot, "pi-agent"),
        onFailure: () => {},
      });
    };
    let running: Promise<unknown> | undefined;
    try {
      const runs = f.repository.runLifecycle(OWNER_ID, AGENT_ID, authority.product);
      const stored = await runs.readRun(runId);
      if (!stored || !f.call.context) throw new Error("scope missing");
      const first = make("sandbox-consumer");
      const originalDispatch = f.repository.runDispatch(
        OWNER_ID,
        AGENT_ID,
        authority.product,
        authority.lease,
        "sandbox-consumer",
      );
      const originalLease = await originalDispatch.assertHeld({
        runId,
        executionLeaseId: f.call.context.executionLease.executionLeaseId,
        expectedLeaseRevision: f.call.context.executionLease.expectedLeaseRevision,
        at: T1,
      });
      const input = await first.input.create({
        lease: originalLease,
        candidate: {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          runId,
          sessionId: stored.run.sessionId,
          threadId: f.call.context.threadId,
          triggerId: stored.run.triggerId,
          runRevision: stored.revision,
          leaseRevision: originalLease.revision,
          runStatus: "running",
          checkpointPhase: null,
          action: "resume",
        },
      });
      running = first.coordinator.execute(input);
      // The original Pi call must have reached the real queue before loss of the owner.
      await Promise.race([
        queued,
        running.then(async (result) => {
          const hash = (value: unknown) =>
            createHash("sha256").update(JSON.stringify(value)).digest("hex");
          const childId = `file-phase:${hash([hash([runId, f.call.toolCallId]), codingName])}`;
          const artifact = await f.artifacts().lookup({
            runId,
            purpose: "trace",
            operationKey: `runtime-tool-diagnostic:${hash([runId, coding ? childId : f.call.toolCallId])}`,
          });
          const payload = artifact
            ? await f.repository.payloadStore(OWNER_ID, AGENT_ID).get(artifact.payloadRef)
            : undefined;
          const diagnostic = payload
            ? Buffer.from(
                await f.f.protector.unprotect({ ownerId: OWNER_ID, agentId: AGENT_ID, payload }),
              ).toString()
            : "";
          throw new Error(
            `Run settled before enqueue: ${diagnostic} ${String(toolFailure)} ${JSON.stringify(toolResult)} ${JSON.stringify(result)}`,
          );
        }),
      ]);
      expect(
        (await f.repository.runCheckpointStore(OWNER_ID, AGENT_ID, authority.product).read(runId))
          ?.checkpoint.phase,
      ).toBe("runtime_running");
      expect(model.observed).toHaveLength(1);
      expect(request.mock.calls.filter(([x]) => x.type === "work.execute")).toHaveLength(0);
      if (live)
        await expect(stat(path.join(f.host.workspace, "queued.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      const inventory = await f.services.brokerV2.preparations.readRunInventory({ runId });
      const original = inventory.queue[0];
      if (!original?.recovery) throw new Error("Missing original Pi queue recovery link");
      const databasePath = path.join(f.f.resource.stateRoot, "product.sqlite");
      const readOriginal = () => {
        const db = new Database(databasePath, { readonly: true });
        try {
          return db
            .prepare(
              "SELECT sequence,deadline_at,request_json FROM sandbox_admission_queue WHERE job_id=?",
            )
            .get(original.plan.identity.jobId);
        } finally {
          db.close();
        }
      };
      const originalBytes = readOriginal();
      milestone("original-queue-persisted");
      const readReservations = () => {
        const db = new Database(databasePath, { readonly: true });
        try {
          return db
            .prepare(
              "SELECT id, status, expires_at, handle_ref FROM authorization_reservations WHERE handle_ref=?",
            )
            .all(original.plan.handleRef);
        } finally {
          db.close();
        }
      };
      const originalReservations = readReservations();
      if (coding) {
        expect(originalReservations).toEqual([
          expect.objectContaining({ status: "reserved", handle_ref: original.plan.handleRef }),
        ]);
        expect(
          (await f.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID)).find(
            (item) => item.id === original.plan.authorizationRef,
          ),
        ).toMatchObject({ uses: 0 });
      }
      expect(
        await f.repository
          .capabilityStore(OWNER_ID, AGENT_ID)
          .getExecutionHandle(original.plan.handleRef),
      ).toMatchObject({ uses: 0 });
      if (scenario === "cancelled")
        await f.services.brokerV2.preparations.cancelQueued({
          identity: original.plan.identity,
          authority,
          now: T1,
        });
      if (scenario === "admitted")
        await f.services.brokerV2.preparations.reserve({
          ...original,
          invocation: { ...original.invocation, consumedAt: T1 },
        });
      if (scenario === "receipt")
        await f.repository
          .capabilityInvocationReceiptPort(OWNER_ID, AGENT_ID)
          .consume({ ...original.invocation, consumedAt: T1 });
      if (scenario === "payload-unavailable") {
        const db = new Database(databasePath);
        try {
          db.prepare("UPDATE payloads SET lifecycle_state='trashed' WHERE ref=?").run(
            original.recovery.continuationRef,
          );
        } finally {
          db.close();
        }
      }
      if (scenario === "revoked") {
        const store = f.repository.authorizationStore();
        const grant = (await store.listGrants(OWNER_ID, AGENT_ID)).find(
          (item) => item.id === original.plan.authorizationRef,
        );
        if (!grant) throw new Error("Grant missing");
        await store.revokeGrant(grant.id, T1, "test-owner-withdrawal", grant.revision);
      }
      const oldDispatch = f.repository.runDispatch(
        OWNER_ID,
        AGENT_ID,
        authority.product,
        authority.lease,
        "sandbox-consumer",
      );
      const released = await oldDispatch.release({
        runId,
        executionLeaseId: input.executionLease.executionLeaseId,
        expectedLeaseRevision: input.executionLease.expectedLeaseRevision,
        releasedAt: T1,
      });
      const leases = f.repository.authorityLeasePort(clock);
      if (scenario !== "boot-only") {
        await leases.release(authority.lease.leaseId);
        const next = await leases.claim(
          {
            id: createAuthorityLeaseId("restart-authority"),
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            holderId: createAuthorityHolderId("restart-holder"),
          },
          600000,
        );
        authority = {
          ...authority,
          product: { ...authority.product, fencingToken: next.fencingToken },
          lease: { leaseId: next.lease.id, fencingToken: next.fencingToken },
          workerBootId: "restarted-worker",
          agentServiceBootId: "restarted-agent",
        };
      } else {
        authority = {
          ...authority,
          workerBootId: "restarted-worker",
          agentServiceBootId: "restarted-agent",
        };
      }
      await f.reopen();
      milestone("database-reopened");
      const dispatch = f.repository.runDispatch(
        OWNER_ID,
        AGENT_ID,
        authority.product,
        authority.lease,
        "restart-consumer",
      );
      const candidates = await dispatch.listClaimable({ now: T1, limit: 10 });
      if (["cancelled", "admitted", "receipt", "payload-unavailable"].includes(scenario)) {
        expect(candidates.map((x) => x.runId)).not.toContain(runId);
        expect(
          (await dispatch.listReconciliationRequired({ now: T1, limit: 10 })).map((x) => x.runId),
        ).toContain(runId);
        expect(request.mock.calls.filter(([x]) => x.type === "work.execute")).toHaveLength(0);
        return;
      }
      expect(candidates.map((x) => x.runId)).toContain(runId);
      expect(
        (await dispatch.listReconciliationRequired({ now: T1, limit: 10 })).map((x) => x.runId),
      ).not.toContain(runId);
      const candidate = candidates.find((x) => x.runId === runId);
      if (!candidate) throw new Error("Resumable candidate missing");
      stopAtQueue = false;
      if (live) {
        const { queuedLiveWorker } = await import("../fixtures/queued-live-worker.ts");
        liveWorker = await queuedLiveWorker(f, authority);
        milestone("worker-ready");
      }
      const resumed = make("restart-consumer");
      if (scenario === "changed-model") {
        const resumedLease = await dispatch.claim({
          runId,
          expectedRunRevision: candidate.runRevision,
          expectedLeaseRevision: released.revision,
          executionLeaseId: createRunExecutionLeaseId("restart-execution"),
          claimedAt: T1,
          expiresAt: T2,
        });
        const invalid = await resumed.input.create({ candidate, lease: resumedLease });
        await expect(
          resumed.coordinator.execute({
            ...invalid,
            runtime: { ...invalid.runtime, modelRef: "different-model" },
          }),
        ).rejects.toThrow();
        expect(request.mock.calls.filter(([x]) => x.type === "work.execute")).toHaveLength(0);
        return;
      }
      const rival = make("restart-rival");
      const pumps = await Promise.allSettled([resumed.dispatcher.pump(), rival.dispatcher.pump()]);
      milestone("dispatch-settled");
      if (scenario === "revoked") {
        const rejected = pumps.filter((item) => item.status === "rejected");
        expect(rejected).toHaveLength(1);
        expect(String(rejected[0]?.reason)).toContain("grant or approval changed");
      } else {
        expect(pumps.filter((item) => item.status === "rejected")).toEqual([]);
        expect(
          pumps.reduce(
            (sum, item) => sum + (item.status === "fulfilled" ? item.value.claimed : 0),
            0,
          ),
        ).toBe(1);
      }
      await expect(
        oldDispatch.assertHeld({
          runId,
          executionLeaseId: input.executionLease.executionLeaseId,
          expectedLeaseRevision: input.executionLease.expectedLeaseRevision,
          at: T1,
        }),
      ).rejects.toThrow();
      if (scenario === "revoked") {
        expect(
          (await f.repository.runLifecycle(OWNER_ID, AGENT_ID, authority.product).readRun(runId))
            ?.run.status,
        ).toBe("reconciling_external_result");
        expect(request.mock.calls.filter(([x]) => x.type === "work.execute")).toHaveLength(0);
        expect(model.observed).toHaveLength(1);
        return;
      }
      const result = await f.repository
        .runLifecycle(OWNER_ID, AGENT_ID, authority.product)
        .readRun(runId);
      if (scenario === "changed-tools") {
        expect(result?.run.status).toBe("failed");
        expect(request.mock.calls.filter(([x]) => x.type === "work.execute")).toHaveLength(0);
        expect(model.observed).toHaveLength(1);
        return;
      }
      if (live) {
        const snapshot = await f.services.brokerV2.preparations.readAdmission(
          original.plan.identity,
        );
        console.log(
          JSON.stringify({
            liveAdmission: snapshot?.phase,
            calls: request.mock.calls.map(([call]) => call.type),
            toolFailure: String(toolFailure),
            toolResult,
          }),
        );
        expect(await readFile(path.join(f.host.workspace, "queued.txt"), "utf8")).toBe("queued");
        const record = await f.services.brokerV2.journal.read(original.plan.identity);
        expect(record).toBeDefined();
        // macOS best-effort termination cannot prove an arbitrary command's full tree stopped.
        expect(record?.workspaceBlocked).toBe(process.platform === "darwin");
        expect(Boolean(record?.releaseReceipt)).toBe(process.platform !== "darwin");
        const events = [];
        if (liveWorker)
          for await (const event of liveWorker.worker.events(null)) events.push(event);
        expect(events.filter((event) => event.type === "work.result")).toHaveLength(1);
        if (!liveWorker || !sent) throw new Error("LIVE_WORKER_NOT_DISPATCHED");
        const fileBeforeReplay = await stat(path.join(f.host.workspace, "queued.txt"));
        await expect(
          liveWorker.worker.request({
            ...sent,
            scope: { ...sent.scope, fencingToken: SERVICE_AUTHORITY.product.fencingToken },
          }),
        ).rejects.toThrow("WORKER_STALE_FENCE");
        await liveWorker.worker.request(sent);
        await liveWorker.worker.waitForIdle();
        const fileAfterReplay = await stat(path.join(f.host.workspace, "queued.txt"));
        expect([fileAfterReplay.ino, fileAfterReplay.mtimeMs, fileAfterReplay.ctimeMs]).toEqual([
          fileBeforeReplay.ino,
          fileBeforeReplay.mtimeMs,
          fileBeforeReplay.ctimeMs,
        ]);
        expect(await readFile(path.join(f.host.workspace, "queued.txt"), "utf8")).toBe("queued");
        const afterReplay = [];
        for await (const event of liveWorker.worker.events(null)) afterReplay.push(event);
        expect(afterReplay.filter((event) => event.type === "work.result")).toHaveLength(1);
        console.log(
          JSON.stringify({
            liveQueuedRecovery: true,
            file: "queued",
            workspaceBlocked: record?.workspaceBlocked,
            releaseReceipt: Boolean(record?.releaseReceipt),
            resource: record?.facts.resource,
            events: events.map((event) => event.type),
          }),
        );
      }
      // Worker cancellation is intentionally unknown: it may not trigger a second execution.
      expect(result?.run.status).toBe("reconciling_external_result");
      expect(request.mock.calls.filter(([x]) => x.type === "work.execute")).toHaveLength(1);
      expect(model.observed).toHaveLength(1);
      expect(approvalCount).toBe(coding ? 1 : 0);
      expect(issueCount).toBe(coding ? 1 : 0);
      expect(completedProbeCalls).toBe(1);
      expect(readOriginal()).toEqual(originalBytes);
      const used = await f.repository
        .capabilityStore(OWNER_ID, AGENT_ID)
        .getExecutionHandle(original.plan.handleRef);
      expect(used).toMatchObject({ uses: 1 });
      if (coding) {
        expect(readReservations()).toEqual(
          originalReservations.map((row) => ({ ...(row as object), status: "committed" })),
        );
        expect(
          (await f.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID)).find(
            (item) => item.id === original.plan.authorizationRef,
          ),
        ).toMatchObject({ uses: 1 });
      }
      expect(
        (await f.services.brokerV2.preparations.readRunInventory({ runId })).queue[0],
      ).toMatchObject({ status: "admitted", sequence: original.sequence });
      expect(
        (await dispatch.listClaimable({ now: T1, limit: 10 })).map((x) => x.runId),
      ).not.toContain(runId);
    } finally {
      releaseOld();
      await running?.catch(() => {});
      await liveWorker?.close();
      await f.close();
      if (live) {
        await expect(stat(path.dirname(f.host.workspace))).rejects.toMatchObject({
          code: "ENOENT",
        });
        if (liveWorker)
          await expect(stat(liveWorker.directory)).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
  },
);
