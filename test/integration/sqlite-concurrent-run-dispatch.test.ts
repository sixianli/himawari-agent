import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type CoordinatedRunResult,
  claimFromRunExecutionLease,
  type ExecuteCoordinatedRunInput,
  ThreadCommandService,
} from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createIdempotencyKey,
  createOwnerId,
  createSessionId,
  type ProductAuthorityFence,
  type RunId,
} from "@himawari-agent/domain";
import {
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { ManualClock } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionRunDispatcher } from "../../apps/agent-service/src/production-run-dispatcher.js";
import { copyMigratedDatabase } from "../fixtures/sqlite-migrated-template.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

describe.each(["worker", "direct"] as const)(
  "concurrent Run dispatch on real SQLite through %s",
  (execution) => {
    useSqliteContractExecution(execution);

    const ownerId = createOwnerId("owner-concurrent-dispatch");
    const agentId = createAgentId("agent-concurrent-dispatch");
    const deploymentId = createDeploymentId("deployment-concurrent-dispatch");
    const authority: ProductAuthorityFence = { deploymentId, authorityEpoch: 1, fencingToken: 1 };
    const lease = {
      leaseId: createAuthorityLeaseId("lease-concurrent-dispatch"),
      fencingToken: 1,
    };
    const roots: string[] = [];
    const repositories: SqliteProductStateRepository[] = [];
    const clock = new ManualClock("2026-09-04T00:00:00.000Z");

    afterEach(async () => {
      await Promise.all(repositories.splice(0).map((repository) => repository.close()));
      await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function open() {
      const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-concurrent-dispatch-"));
      roots.push(stateRoot);
      await mkdir(path.join(stateRoot, "data"));
      const databasePath = path.join(stateRoot, "data", "product.sqlite");
      await copyMigratedDatabase(databasePath);
      const database = openQualifiedDatabase(databasePath);
      database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(ownerId);
      database
        .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
        .run(agentId, ownerId);
      database
        .prepare(`INSERT INTO deployments
    (id, owner_id, agent_id, revision, status, authority_epoch, fencing_token)
    VALUES (?, ?, ?, 0, 'active', 1, 1)`)
        .run(deploymentId, ownerId, agentId);
      database
        .prepare(`INSERT INTO payloads
    (ref, owner_id, agent_id, classification, storage_kind, ciphertext,
      content_digest, lifecycle_state, created_at)
    VALUES ('payload-concurrent-dispatch', ?, ?, 'private', 'sqlite_blob', X'00',
      'sha256:fixture', 'active', ?)`)
        .run(ownerId, agentId, clock.now());
      database
        .prepare(`INSERT INTO authority_leases
    (id, owner_id, agent_id, deployment_id, holder_id, authority_epoch, fencing_token, acquired_at, expires_at)
    VALUES (?, ?, ?, ?, 'holder-concurrent-dispatch', 1, 1, ?, '2026-09-05T00:00:00.000Z')`)
        .run(lease.leaseId, ownerId, agentId, deploymentId, clock.now());
      database.close();
      const repository = await SqliteProductStateRepository.open({
        stateRoot,
        databasePath,
        minimumFreeBytes: 0,
        now: () => clock.now(),
      });
      repositories.push(repository);
      const commands = new ThreadCommandService({
        repository: repository.threadRepository(),
        clock,
        authority: () => authority,
      });
      return { repository, commands, databasePath };
    }

    async function admitConversations(
      commands: ThreadCommandService,
      count: number,
    ): Promise<RunId[]> {
      const runIds: RunId[] = [];
      for (let index = 0; index < count; index += 1) {
        const created = await commands.create({
          ownerId,
          agentId,
          idempotencyKey: `thread-create-${index}`,
          resultRef: "payload-concurrent-dispatch",
        });
        const admitted = await commands.admitOwnerMessage({
          ownerId,
          agentId,
          threadId: created.thread.id,
          expectedThreadRevision: created.thread.revision,
          sessionId: createSessionId(`session-concurrent-dispatch-${index}`),
          idempotencyKey: `thread-submit-${index}`,
          contentRef: "payload-concurrent-dispatch",
          sourceProofRef: "proof:owner",
          dataClassification: "private",
          resultRef: "payload-concurrent-dispatch",
        });
        if (!admitted.message.runId) throw new Error("Thread admission did not create a Run");
        runIds.push(admitted.message.runId);
        clock.set(new Date(Date.parse(clock.now()) + 1000).toISOString());
      }
      return runIds;
    }

    function completed(input: ExecuteCoordinatedRunInput): CoordinatedRunResult {
      return {
        run: {
          revision: 2,
          run: {
            id: input.runId,
            ownerId,
            agentId,
            sessionId: createSessionId("session-concurrent-dispatch"),
            triggerId: "trigger" as never,
            status: "completed",
          },
        },
        checkpoint: {
          phase: "completed",
          contextRef: null,
          workerResults: {},
          runtimeEventCount: 0,
          lastTraceEventId: null,
          terminalStatus: "completed",
          output: null,
          diagnosticCode: null,
        },
        workerResultRefs: [],
        resumed: false,
      } as unknown as CoordinatedRunResult;
    }

    it("runs three conversations at the same time, each with its own lease, and releases all", async () => {
      const { repository, commands } = await open();
      const runIds = await admitConversations(commands, 3);
      const dispatch = repository.runDispatch(
        ownerId,
        agentId,
        authority,
        lease,
        "concurrent-dispatch",
      );
      let open3!: () => void;
      const opened = new Promise<void>((resolve) => {
        open3 = resolve;
      });
      const running = new Set<string>();
      let peak = 0;
      const dispatcher = new ProductionRunDispatcher({
        authority: { assertActive: async () => undefined, isAccepting: () => true },
        dispatch,
        coordinator: {
          execute: async (input) => {
            running.add(input.runId);
            peak = Math.max(peak, running.size);
            await opened;
            running.delete(input.runId);
            return completed(input);
          },
          recoverCompleted: async () => {
            throw new Error("unexpected completion recovery");
          },
          interruptExecution: async () => undefined,
        },
        input: async ({ candidate, lease: executionLease }) =>
          ({
            ownerId: candidate.ownerId,
            agentId: candidate.agentId,
            runId: candidate.runId,
            authority: { leaseId: executionLease.authorityLeaseId, fencingToken: 1 },
            executionLease: claimFromRunExecutionLease(executionLease),
            context: {},
            runtime: {},
            workers: [],
            delegableCapabilityHandleRefs: [],
            delegableContextRefs: [],
            commands: {},
          }) as unknown as ExecuteCoordinatedRunInput,
        reconcile: async () => undefined,
        clock,
        executionLeaseDurationMs: 60_000,
        maximumRunsPerPump: 3,
        instanceId: "concurrent-dispatch",
      });

      const filled = await dispatcher.fill();
      expect(filled.claimed).toBe(3);
      await vi_waitFor(() => running.size === 3);
      expect(peak).toBe(3);

      const claimedWhileRunning = await dispatch.listClaimable({ now: clock.now(), limit: 10 });
      expect(claimedWhileRunning).toEqual([]);

      open3();
      await dispatcher.drain(10_000);
      expect(running.size).toBe(0);
      expect(runIds).toHaveLength(3);
    });

    it("does not start more conversations than the limit and takes the waiting one when a slot frees", async () => {
      const { repository, commands } = await open();
      const runIds = await admitConversations(commands, 3);
      const dispatch = repository.runDispatch(
        ownerId,
        agentId,
        authority,
        lease,
        "concurrent-dispatch",
      );
      const gates = new Map<string, () => void>();
      const running = new Set<string>();
      const order: string[] = [];
      let peak = 0;
      const dispatcher = new ProductionRunDispatcher({
        authority: { assertActive: async () => undefined, isAccepting: () => true },
        dispatch,
        coordinator: {
          execute: async (input) => {
            running.add(input.runId);
            order.push(input.runId);
            peak = Math.max(peak, running.size);
            await new Promise<void>((resolve) => gates.set(input.runId, resolve));
            await repository.runLifecycle(ownerId, agentId, authority).cancelRun({
              ownerId,
              agentId,
              runId: input.runId,
              expectedRevision: 1,
              idempotencyKey: createIdempotencyKey(`cancel-${input.runId}`),
              commandFingerprint: `cancel:${input.runId}`,
              authority: lease,
              payloadRef: "payload-concurrent-dispatch",
            });
            running.delete(input.runId);
            return completed(input);
          },
          recoverCompleted: async () => {
            throw new Error("unexpected completion recovery");
          },
          interruptExecution: async () => undefined,
        },
        input: async ({ candidate, lease: executionLease }) =>
          ({
            ownerId: candidate.ownerId,
            agentId: candidate.agentId,
            runId: candidate.runId,
            authority: { leaseId: executionLease.authorityLeaseId, fencingToken: 1 },
            executionLease: claimFromRunExecutionLease(executionLease),
            context: {},
            runtime: {},
            workers: [],
            delegableCapabilityHandleRefs: [],
            delegableContextRefs: [],
            commands: {},
          }) as unknown as ExecuteCoordinatedRunInput,
        reconcile: async () => undefined,
        clock,
        executionLeaseDurationMs: 60_000,
        maximumRunsPerPump: 2,
        instanceId: "concurrent-dispatch",
      });

      expect((await dispatcher.fill()).claimed).toBe(2);
      await vi_waitFor(() => running.size === 2);
      expect((await dispatcher.fill()).claimed).toBe(0);
      expect(new Set(order).size).toBe(2);
      const first = order[0] as string;

      gates.get(first)?.();
      let claimedAfterFree = 0;
      await vi_waitFor(() => {
        void dispatcher.fill().then((result) => {
          claimedAfterFree += result.claimed;
        });
        return claimedAfterFree > 0;
      });
      await vi_waitFor(() => order.length === 3);
      expect(new Set(order)).toEqual(new Set(runIds));
      expect(peak).toBe(2);

      for (const release of gates.values()) release();
      await dispatcher.drain(10_000);
      expect(running.size).toBe(0);
    });
  },
);

async function vi_waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition was not met in time");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
