import { createHash } from "node:crypto";
import type {
  RunTransitionReceipt,
  StoredRun,
  TransitionRunStateInput,
} from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createIdempotencyKey,
  createOwnerId,
  createRunId,
  createSessionId,
  createThreadId,
  createTriggerId,
  DomainError,
  RUN_STATUSES,
  transitionRun,
  type AgentId,
  type OwnerId,
  type ProductAuthorityFence,
  type RunId,
} from "@himawari-agent/domain";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Run lifecycle input must be an object");
  return Object.fromEntries(Object.entries(value));
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError("Run lifecycle field must be a nonempty string");
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new TypeError("Run lifecycle revision or fence must be a positive integer");
  return value;
}

function status(value: unknown): StoredRun["run"]["status"] {
  const found = RUN_STATUSES.find((candidate) => candidate === value);
  if (!found) throw new TypeError("Run lifecycle status is invalid");
  return found;
}

function command(value: unknown): TransitionRunStateInput {
  const input = record(value);
  const fence = record(input["authority"]);
  return {
    ownerId: createOwnerId(string(input["ownerId"])),
    agentId: createAgentId(string(input["agentId"])),
    runId: createRunId(string(input["runId"])),
    expectedRevision: integer(input["expectedRevision"]),
    nextStatus: status(input["nextStatus"]),
    idempotencyKey: createIdempotencyKey(string(input["idempotencyKey"])),
    commandFingerprint: string(input["commandFingerprint"]),
    payloadRef: string(input["payloadRef"]),
    authority: {
      leaseId: createAuthorityLeaseId(string(fence["leaseId"])),
      fencingToken: integer(fence["fencingToken"]),
    },
  };
}

function fingerprint(input: TransitionRunStateInput): string {
  return `run-transition:v1:${createHash("sha256")
    .update(
      JSON.stringify([
        input.ownerId,
        input.agentId,
        input.runId,
        input.nextStatus,
        input.payloadRef,
        input.commandFingerprint,
      ]),
    )
    .digest("hex")}`;
}

export class SqliteRunLifecycleOperations {
  private readonly database: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly assertDiskHeadroom: () => void;

  constructor(
    database: Database.Database,
    fail: SqliteApplicationFailure,
    assertDiskHeadroom: () => void,
  ) {
    this.database = database;
    this.fail = fail;
    this.assertDiskHeadroom = assertDiskHeadroom;
  }

  execute(operation: string, payload: unknown): unknown {
    const parsed = record(payload);
    const ownerId = createOwnerId(string(parsed["ownerId"]));
    const agentId = createAgentId(string(parsed["agentId"]));
    if (operation === "runLifecycle.read")
      return this.read(ownerId, agentId, createRunId(string(parsed["runId"])));
    if (operation !== "runLifecycle.transition")
      return this.fail("PORT_INVALID_OPERATION", "Unknown Run lifecycle operation");
    const fence = record(parsed["authority"]);
    const authority: ProductAuthorityFence = {
      deploymentId: createDeploymentId(string(fence["deploymentId"])),
      authorityEpoch: integer(fence["authorityEpoch"]),
      fencingToken: integer(fence["fencingToken"]),
    };
    const input = command(parsed["input"]);
    if (input["ownerId"] !== ownerId || input["agentId"] !== agentId)
      return this.fail("PORT_NOT_AUTHORITATIVE", "Run command is outside the bound scope");
    const now = string(parsed["now"]);
    if (!Number.isFinite(Date.parse(now))) throw new TypeError("Run lifecycle time is invalid");
    return this.transition(input, authority, now);
  }

  private read(ownerId: OwnerId, agentId: AgentId, runId: RunId): StoredRun | undefined {
    const value = this.database
      .prepare(`SELECT r.id, r.owner_id, r.agent_id, r.session_id,
      r.trigger_id, r.thread_id, r.status, r.revision FROM runs r
      JOIN triggers t ON t.id = r.trigger_id AND t.owner_id = r.owner_id
        AND t.agent_id = r.agent_id AND (t.thread_id IS NULL OR t.thread_id IS r.thread_id)
      WHERE r.id = ? AND r.owner_id = ? AND r.agent_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM turns u WHERE u.run_id = r.id AND (u.owner_id != r.owner_id
            OR u.agent_id != r.agent_id OR u.thread_id IS NOT r.thread_id
            OR u.session_id != r.session_id))`)
      .get(runId, ownerId, agentId);
    if (value === undefined) return undefined;
    const row = record(value);
    return {
      revision: integer(row["revision"]),
      run: {
        id: createRunId(string(row["id"])),
        ownerId: createOwnerId(string(row["owner_id"])),
        agentId: createAgentId(string(row["agent_id"])),
        sessionId: createSessionId(string(row["session_id"])),
        triggerId: createTriggerId(string(row["trigger_id"])),
        status: status(row["status"]),
        ...(row["thread_id"] === null
          ? {}
          : { threadId: createThreadId(string(row["thread_id"])) }),
      },
    };
  }

  private replay(input: TransitionRunStateInput): RunTransitionReceipt | undefined {
    const value = this.database
      .prepare(`SELECT command_type, command_fingerprint, state_key,
      state_revision, result_ref, committed_at FROM command_results
      WHERE owner_id = ? AND agent_id = ? AND idempotency_key = ?`)
      .get(input["ownerId"], input["agentId"], input["idempotencyKey"]);
    if (value === undefined) return undefined;
    const row = record(value);
    if (
      row["command_type"] !== "run.transition" ||
      row["command_fingerprint"] !== fingerprint(input) ||
      row["state_key"] !== input["runId"]
    )
      return this.fail("PORT_CONFLICT", "Run transition idempotency key has different semantics");
    return {
      replayed: true,
      commandResult: {
        ownerId: input["ownerId"],
        agentId: input["agentId"],
        idempotencyKey: input["idempotencyKey"],
        commandType: "run.transition",
        commandFingerprint: fingerprint(input),
        stateKey: string(row["state_key"]),
        stateRevision: integer(row["state_revision"]),
        resultRef: string(row["result_ref"]),
        committedAt: string(row["committed_at"]),
      },
    };
  }

  private transition(
    input: TransitionRunStateInput,
    authority: ProductAuthorityFence,
    now: string,
  ): RunTransitionReceipt {
    this.assertDiskHeadroom();
    return this.database
      .transaction(() => {
        const replay = this.replay(input);
        if (replay) return replay;
        const lease = this.database
          .prepare(`SELECT 1 FROM authority_leases l
        JOIN deployments d ON d.id = l.deployment_id
          AND d.owner_id = l.owner_id AND d.agent_id = l.agent_id
        WHERE l.id = ? AND l.owner_id = ? AND l.agent_id = ? AND l.released_at IS NULL
          AND l.expires_at > ? AND l.fencing_token = ? AND d.fencing_token = l.fencing_token
          AND d.authority_epoch = l.authority_epoch AND d.status = 'active'
          AND d.id = ? AND d.authority_epoch = ? AND d.fencing_token = ?`)
          .get(
            input["authority"].leaseId,
            input["ownerId"],
            input["agentId"],
            now,
            input["authority"].fencingToken,
            authority.deploymentId,
            authority.authorityEpoch,
            authority.fencingToken,
          );
        if (!lease)
          return this.fail("PORT_NOT_AUTHORITATIVE", "Run transition authority is not current");
        const stored = this.read(input["ownerId"], input["agentId"], input["runId"]);
        if (!stored)
          return this.fail("PORT_NOT_FOUND", "Run is missing from the bound relational scope");
        if (stored.revision !== input["expectedRevision"])
          return this.fail("PORT_CONFLICT", "Run transition revision conflict");
        if (stored.run.threadId && input["nextStatus"] === "completed")
          return this.fail(
            "PORT_INVALID_OPERATION",
            "Thread Run completion requires an atomic assistant commit",
          );
        if (stored.run.threadId && !["failed", "cancelled"].includes(input["nextStatus"])) {
          const active = this.database
            .prepare(`SELECT 1 FROM threads WHERE id = ?
          AND owner_id = ? AND agent_id = ? AND status = 'open' AND archived_at IS NULL`)
            .get(stored.run.threadId, input["ownerId"], input["agentId"]);
          if (!active)
            return this.fail("PORT_INVALID_OPERATION", "Thread Run requires an active Thread");
        }
        try {
          transitionRun(stored.run, input["nextStatus"]);
        } catch (error) {
          if (error instanceof DomainError)
            return this.fail("PORT_INVALID_OPERATION", error.message);
          throw error;
        }
        const payload = this.database
          .prepare(`SELECT 1 FROM payloads WHERE ref = ?
        AND owner_id = ? AND agent_id = ? AND lifecycle_state = 'active'`)
          .get(input["payloadRef"], input["ownerId"], input["agentId"]);
        if (!payload)
          return this.fail(
            "PORT_INVALID_OPERATION",
            "Run event Payload is outside the active scope",
          );
        const revision = stored.revision + 1;
        this.database
          .prepare(`UPDATE runs SET status = ?, revision = ?, updated_at = ?
        WHERE id = ? AND owner_id = ? AND agent_id = ? AND revision = ?`)
          .run(
            input["nextStatus"],
            revision,
            now,
            input["runId"],
            input["ownerId"],
            input["agentId"],
            stored.revision,
          );
        const identity = createHash("sha256")
          .update(JSON.stringify([input["ownerId"], input["agentId"], input["idempotencyKey"]]))
          .digest("hex");
        const stateKey = input["runId"];
        this.database
          .prepare(`INSERT INTO command_results
        (id, owner_id, agent_id, idempotency_key, command_type, command_fingerprint,
          deployment_id, authority_epoch, fencing_token, result_ref, state_key, state_revision, committed_at)
        VALUES (?, ?, ?, ?, 'run.transition', ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            `run-command:${identity}`,
            input["ownerId"],
            input["agentId"],
            input["idempotencyKey"],
            fingerprint(input),
            authority.deploymentId,
            authority.authorityEpoch,
            authority.fencingToken,
            stateKey,
            stateKey,
            revision,
            now,
          );
        this.database
          .prepare(`INSERT INTO reliable_events
        (id, owner_id, agent_id, idempotency_key, topic, payload_ref, publication_state, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
          .run(
            `run-event:${identity}`,
            input["ownerId"],
            input["agentId"],
            input["idempotencyKey"],
            `run.${input["nextStatus"]}`,
            input["payloadRef"],
            now,
          );
        return {
          replayed: false,
          commandResult: {
            ownerId: input["ownerId"],
            agentId: input["agentId"],
            idempotencyKey: input["idempotencyKey"],
            commandType: "run.transition",
            commandFingerprint: fingerprint(input),
            stateKey,
            stateRevision: revision,
            resultRef: stateKey,
            committedAt: now,
          },
        };
      })
      .immediate();
  }
}
