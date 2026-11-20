import { createHash } from "node:crypto";
import type {
  RunTransitionReceipt,
  StoredRun,
  TransitionRunStateInput,
  RunCompletionInput,
  RunCancellationInput,
  RuntimeSuccessfulOutput,
  DataClassification,
  RunExecutionLeaseClaim,
  RunExecutionLeaseTransactionGuard,
  FinishBackgroundRunInput,
  FinishBackgroundRunResult,
  BackgroundRunRecord,
  UnattendedRunRecord,
} from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createIdempotencyKey,
  createOwnerId,
  createRunId,
  createRunExecutionLeaseId,
  createSessionId,
  createThreadId,
  createTriggerId,
  createMessageId,
  createTurnId,
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
import {
  appendThreadGatewayEventInTransaction,
  type SqliteThreadOperations,
} from "./sqlite-thread-operations.ts";
import {
  RUN_COMPLETION_RECOVERY_SQL,
  RUN_RESOURCES_RELEASED_SQL,
} from "./sqlite-run-resource-guard.ts";

type RunMutationInput = TransitionRunStateInput | RunCompletionInput;
type RunAuthorityInput = RunMutationInput | RunCancellationInput;
type ExecutionLeaseGuard = Pick<
  RunExecutionLeaseTransactionGuard,
  "assertHeldInTransaction" | "invalidateForOwnerCancellationInTransaction"
>;
type ExecutionLeaseGuardFactory = (input: {
  readonly ownerId: string;
  readonly agentId: string;
  readonly authority: ProductAuthorityFence;
  readonly authorityLeaseId: string;
  readonly authorityFencingToken: number;
  readonly consumerId: string;
}) => ExecutionLeaseGuard;
const CLASSIFICATIONS = ["public", "private", "sensitive", "restricted"] as const;

function classification(value: unknown): DataClassification {
  const found = CLASSIFICATIONS.find((candidate) => candidate === value);
  if (!found) throw new TypeError("Run completion classification is invalid");
  return found;
}

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

function optionalExecutionLease(value: unknown): RunExecutionLeaseClaim | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  return {
    executionLeaseId: createRunExecutionLeaseId(string(input["executionLeaseId"])),
    expectedLeaseRevision: integer(input["expectedLeaseRevision"]),
    authorityLeaseId: createAuthorityLeaseId(string(input["authorityLeaseId"])),
    authorityFencingToken: integer(input["authorityFencingToken"]),
    deploymentId: createDeploymentId(string(input["deploymentId"])),
    authorityEpoch: integer(input["authorityEpoch"]),
    fencingToken: integer(input["fencingToken"]),
    consumerId: string(input["consumerId"]),
  };
}

function status(value: unknown): StoredRun["run"]["status"] {
  const found = RUN_STATUSES.find((candidate) => candidate === value);
  if (!found) throw new TypeError("Run lifecycle status is invalid");
  return found;
}

function command(value: unknown): TransitionRunStateInput {
  const input = record(value);
  const fence = record(input["authority"]);
  const executionLease = optionalExecutionLease(input["executionLease"]);
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
    ...(executionLease ? { executionLease } : {}),
  };
}

function cancellation(value: unknown): RunCancellationInput {
  const input = record(value);
  if (input["executionLease"] !== undefined)
    throw new TypeError("Owner cancellation cannot carry an execution lease");
  const parsed = command({ ...input, nextStatus: "cancelled" });
  const { nextStatus: _nextStatus, executionLease: _executionLease, ...base } = parsed;
  return base;
}

function cancelledMutation(input: RunCancellationInput): TransitionRunStateInput {
  return { ...input, nextStatus: "cancelled" };
}

function completion(value: unknown): RunCompletionInput {
  const raw = record(value);
  const { nextStatus: _status, ...base } = command({ ...raw, nextStatus: "completed" });
  const output = record(raw["output"]);
  let parsed: RuntimeSuccessfulOutput;
  if (output["kind"] === "no-answer") parsed = { kind: "no-answer" };
  else if (output["kind"] === "assistant-answer")
    parsed = { kind: "assistant-answer", contentRef: string(output["contentRef"]) };
  else throw new TypeError("Run completion output is invalid");
  return {
    ...base,
    output: parsed,
    dataClassification: classification(raw["dataClassification"]),
    ...(raw["background"] === undefined ? {} : { background: backgroundHolds(raw["background"]) }),
    ...(raw["recoveryCheckpointRevision"] === undefined
      ? {}
      : { recoveryCheckpointRevision: integer(raw["recoveryCheckpointRevision"]) }),
  };
}

function instantText(value: unknown): string {
  const text = string(value);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError("Run lifecycle time is invalid");
  return text;
}

function optionalRef(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const ref = string(value);
  if (ref.length > 128) throw new TypeError("Run background payload ref is invalid");
  return ref;
}

function backgroundHolds(value: unknown): NonNullable<RunCompletionInput["background"]> {
  const holds = record(value)["holds"];
  if (!Array.isArray(holds) || holds.length < 1 || holds.length > 16)
    throw new TypeError("Run background holds are invalid");
  return {
    holds: holds.map((hold) => {
      const item = record(hold);
      const taskRef = string(item["taskRef"]);
      if (taskRef.length > 128) throw new TypeError("Run background task ref is invalid");
      const commandRef = optionalRef(item["commandRef"]);
      return {
        taskRef,
        startedAt: instantText(item["startedAt"]),
        deadlineAt: instantText(item["deadlineAt"]),
        ...(commandRef ? { commandRef } : {}),
      };
    }),
  };
}

const BACKGROUND_OUTCOMES = ["completed", "failed", "stopped", "timed_out", "interrupted"] as const;

function finishInput(value: unknown): FinishBackgroundRunInput {
  const input = record(value);
  const fence = record(input["authority"]);
  const executionLease = optionalExecutionLease(input["executionLease"]);
  const outcomes = input["outcomes"];
  if (!Array.isArray(outcomes) || outcomes.length < 1 || outcomes.length > 16)
    throw new TypeError("Run background outcomes are invalid");
  const notice = record(input["notice"]);
  return {
    ownerId: createOwnerId(string(input["ownerId"])),
    agentId: createAgentId(string(input["agentId"])),
    runId: createRunId(string(input["runId"])),
    idempotencyKey: createIdempotencyKey(string(input["idempotencyKey"])),
    authority: {
      leaseId: createAuthorityLeaseId(string(fence["leaseId"])),
      fencingToken: integer(fence["fencingToken"]),
    },
    ...(executionLease ? { executionLease } : {}),
    outcomes: outcomes.map((entry) => {
      const item = record(entry);
      const outcome = BACKGROUND_OUTCOMES.find((candidate) => candidate === item["outcome"]);
      if (!outcome) throw new TypeError("Run background outcome is invalid");
      const outputRef = optionalRef(item["outputRef"]);
      return { taskRef: string(item["taskRef"]), outcome, ...(outputRef ? { outputRef } : {}) };
    }),
    notice: {
      triggerId: string(notice["triggerId"]),
      runId: createRunId(string(notice["runId"])),
      turnId: string(notice["turnId"]),
      messageId: string(notice["messageId"]),
      contentRef: string(notice["contentRef"]),
      dataClassification: classification(notice["dataClassification"]),
    },
  };
}

function commandType(input: RunMutationInput): "run.transition" | "run.complete" | "run.park" {
  if ("nextStatus" in input) return "run.transition";
  return input.background ? "run.park" : "run.complete";
}

function fingerprint(input: RunMutationInput): string {
  return `run-transition:v1:${createHash("sha256")
    .update(
      JSON.stringify([
        input.ownerId,
        input.agentId,
        input.runId,
        "nextStatus" in input
          ? input.nextStatus
          : input.background
            ? [input.output, input.dataClassification, input.background]
            : [input.output, input.dataClassification],
        input.payloadRef,
        input.commandFingerprint,
      ]),
    )
    .digest("hex")}`;
}

export function writeRunReceiptInTransaction(
  database: Database.Database,
  input: RunMutationInput,
  authority: ProductAuthorityFence,
  now: string,
  revision: number,
): RunTransitionReceipt {
  const identity = createHash("sha256")
    .update(JSON.stringify([input["ownerId"], input["agentId"], input["idempotencyKey"]]))
    .digest("hex");
  const stateKey = input["runId"];
  database
    .prepare(`INSERT INTO command_results
      (id, owner_id, agent_id, idempotency_key, command_type, command_fingerprint,
        deployment_id, authority_epoch, fencing_token, result_ref, state_key, state_revision, committed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      `run-command:${identity}`,
      input["ownerId"],
      input["agentId"],
      input["idempotencyKey"],
      commandType(input),
      fingerprint(input),
      authority.deploymentId,
      authority.authorityEpoch,
      authority.fencingToken,
      stateKey,
      stateKey,
      revision,
      now,
    );
  database
    .prepare(`INSERT INTO reliable_events
      (id, owner_id, agent_id, idempotency_key, topic, payload_ref, publication_state, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .run(
      `run-event:${identity}`,
      input["ownerId"],
      input["agentId"],
      input["idempotencyKey"],
      `run.${"nextStatus" in input ? input.nextStatus : input.background ? "parked" : "completed"}`,
      input["payloadRef"],
      now,
    );
  if ("nextStatus" in input) {
    const changedThread = database
      .prepare(`UPDATE threads
      SET revision = revision + 1, updated_at = ?
      WHERE id = (SELECT thread_id FROM runs WHERE id = ? AND owner_id = ? AND agent_id = ?)
        AND owner_id = ? AND agent_id = ?
      RETURNING id, revision`)
      .get(now, input.runId, input.ownerId, input.agentId, input.ownerId, input.agentId);
    if (changedThread !== undefined) {
      const row = record(changedThread);
      appendThreadGatewayEventInTransaction(database, {
        ownerId: input.ownerId,
        agentId: input.agentId,
        threadId: createThreadId(string(row["id"])),
        threadRevision: integer(row["revision"]),
        eventId: `run-event:${identity}`,
        commandId: `run-command:${identity}`,
        commandType: `run.${input.nextStatus}`,
        resultRef: null,
        committedAt: now,
        authority,
      });
    }
  }
  return {
    replayed: false,
    commandResult: {
      ownerId: input["ownerId"],
      agentId: input["agentId"],
      idempotencyKey: input["idempotencyKey"],
      commandType: commandType(input),
      commandFingerprint: fingerprint(input),
      stateKey,
      stateRevision: revision,
      resultRef: stateKey,
      committedAt: now,
    },
  };
}

export class SqliteRunLifecycleOperations {
  private readonly database: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly assertDiskHeadroom: () => void;
  private readonly thread: Pick<
    SqliteThreadOperations,
    "commitAssistantMessage" | "admitBackgroundNoticeInTransaction"
  >;
  private readonly executionLease: ExecutionLeaseGuardFactory;

  constructor(
    database: Database.Database,
    fail: SqliteApplicationFailure,
    assertDiskHeadroom: () => void,
    thread: Pick<
      SqliteThreadOperations,
      "commitAssistantMessage" | "admitBackgroundNoticeInTransaction"
    >,
    executionLease: ExecutionLeaseGuardFactory,
  ) {
    this.database = database;
    this.fail = fail;
    this.assertDiskHeadroom = assertDiskHeadroom;
    this.thread = thread;
    this.executionLease = executionLease;
  }

  execute(operation: string, payload: unknown): unknown {
    const parsed = record(payload);
    const ownerId = createOwnerId(string(parsed["ownerId"]));
    const agentId = createAgentId(string(parsed["agentId"]));
    if (operation === "runLifecycle.read")
      return this.read(ownerId, agentId, createRunId(string(parsed["runId"])));
    if (operation === "runLifecycle.listBackground")
      return this.listBackground(ownerId, agentId, instantText(parsed["now"]));
    if (operation === "runLifecycle.listUnattended")
      return this.listUnattended(
        ownerId,
        agentId,
        instantText(parsed["failedSince"]),
        integer(parsed["limit"]),
      );
    if (
      operation !== "runLifecycle.transition" &&
      operation !== "runLifecycle.finishBackground" &&
      operation !== "runLifecycle.cancel" &&
      operation !== "runLifecycle.complete"
    )
      return this.fail("PORT_INVALID_OPERATION", "Unknown Run lifecycle operation");
    const fence = record(parsed["authority"]);
    const authority: ProductAuthorityFence = {
      deploymentId: createDeploymentId(string(fence["deploymentId"])),
      authorityEpoch: integer(fence["authorityEpoch"]),
      fencingToken: integer(fence["fencingToken"]),
    };
    if (operation === "runLifecycle.finishBackground") {
      const input = finishInput(parsed["input"]);
      if (input.ownerId !== ownerId || input.agentId !== agentId)
        return this.fail("PORT_NOT_AUTHORITATIVE", "Run command is outside the bound scope");
      return this.finishBackground(input, authority, instantText(parsed["now"]));
    }
    if (operation === "runLifecycle.cancel") {
      const input = cancellation(parsed["input"]);
      if (input["ownerId"] !== ownerId || input["agentId"] !== agentId)
        return this.fail("PORT_NOT_AUTHORITATIVE", "Run command is outside the bound scope");
      const now = string(parsed["now"]);
      if (!Number.isFinite(Date.parse(now))) throw new TypeError("Run lifecycle time is invalid");
      return this.cancel(input, authority, now);
    }
    const input =
      operation === "runLifecycle.complete"
        ? completion(parsed["input"])
        : command(parsed["input"]);
    if (input["ownerId"] !== ownerId || input["agentId"] !== agentId)
      return this.fail("PORT_NOT_AUTHORITATIVE", "Run command is outside the bound scope");
    const now = string(parsed["now"]);
    if (!Number.isFinite(Date.parse(now))) throw new TypeError("Run lifecycle time is invalid");
    return "nextStatus" in input
      ? this.transition(input, authority, now)
      : this.complete(input, authority, now);
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

  private replay(input: RunMutationInput): RunTransitionReceipt | undefined {
    const value = this.database
      .prepare(`SELECT command_type, command_fingerprint, state_key,
      state_revision, result_ref, committed_at FROM command_results
      WHERE owner_id = ? AND agent_id = ? AND idempotency_key = ?`)
      .get(input["ownerId"], input["agentId"], input["idempotencyKey"]);
    if (value === undefined) return undefined;
    const row = record(value);
    if (
      row["command_type"] !== commandType(input) ||
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
        commandType: commandType(input),
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
        this.assertAuthority(input, authority, now);
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
        this.assertTransition(stored, input.nextStatus);
        this.assertPayload(input);
        this.assertExecutionLease(input, authority, now);
        const revision = stored.revision + 1;
        this.database
          .prepare(`UPDATE runs SET status = ?, revision = ?, updated_at = ?
          WHERE id = ? AND owner_id = ? AND agent_id = ? AND revision = ?`)
          .run(
            input.nextStatus,
            revision,
            now,
            input.runId,
            input.ownerId,
            input.agentId,
            stored.revision,
          );
        return writeRunReceiptInTransaction(this.database, input, authority, now, revision);
      })
      .immediate();
  }

  private assertAuthority(
    input: Pick<RunAuthorityInput, "ownerId" | "agentId" | "authority">,
    authority: ProductAuthorityFence,
    now: string,
  ): void {
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
    if (!lease) this.fail("PORT_NOT_AUTHORITATIVE", "Run transition authority is not current");
  }

  private assertTransition(
    stored: StoredRun,
    nextStatus: TransitionRunStateInput["nextStatus"],
  ): void {
    try {
      transitionRun(stored.run, nextStatus);
    } catch (error) {
      if (error instanceof DomainError) this.fail("PORT_INVALID_OPERATION", error.message);
      throw error;
    }
  }

  private assertPayload(input: RunAuthorityInput): void {
    const payload = this.database
      .prepare(`SELECT 1 FROM payloads WHERE ref = ?
        AND owner_id = ? AND agent_id = ? AND lifecycle_state = 'active'`)
      .get(input["payloadRef"], input["ownerId"], input["agentId"]);
    if (!payload)
      this.fail("PORT_INVALID_OPERATION", "Run event Payload is outside the active scope");
  }

  private assertExecutionLease(
    input: Pick<RunMutationInput, "ownerId" | "agentId" | "runId" | "authority" | "executionLease">,
    authority: ProductAuthorityFence,
    now: string,
  ): void {
    const claim = input.executionLease;
    if (!claim) {
      this.fail(
        "PORT_NOT_AUTHORITATIVE",
        "Execution-owned Run mutation requires an execution lease",
        { runId: input.runId },
      );
    }
    if (
      claim.authorityLeaseId !== input.authority.leaseId ||
      claim.authorityFencingToken !== input.authority.fencingToken ||
      claim.deploymentId !== authority.deploymentId ||
      claim.authorityEpoch !== authority.authorityEpoch ||
      claim.fencingToken !== authority.fencingToken
    ) {
      this.fail(
        "PORT_NOT_AUTHORITATIVE",
        "Execution lease claim does not match the command authority",
        { runId: input.runId },
      );
    }
    const guard = this.executionLease({
      ownerId: input.ownerId,
      agentId: input.agentId,
      authority,
      authorityLeaseId: claim.authorityLeaseId,
      authorityFencingToken: claim.authorityFencingToken,
      consumerId: claim.consumerId,
    });
    guard.assertHeldInTransaction({
      runId: input.runId,
      expectedLeaseRevision: claim.expectedLeaseRevision,
      executionLeaseId: claim.executionLeaseId,
      at: now,
    });
  }

  private cancel(
    input: RunCancellationInput,
    authority: ProductAuthorityFence,
    now: string,
  ): RunTransitionReceipt {
    this.assertDiskHeadroom();
    const mutation = cancelledMutation(input);
    return this.database
      .transaction(() => {
        this.assertAuthority(input, authority, now);
        const stored = this.read(input.ownerId, input.agentId, input.runId);
        if (!stored)
          return this.fail("PORT_NOT_FOUND", "Run is missing from the bound relational scope");
        const replay = this.replay(mutation);
        if (replay) return replay;
        if (stored.revision !== input.expectedRevision)
          return this.fail("PORT_CONFLICT", "Run cancellation revision conflict", {
            runId: input.runId,
          });
        this.assertTransition(stored, "cancelled");
        this.assertPayload(input);
        const guard = this.executionLease({
          ownerId: input.ownerId,
          agentId: input.agentId,
          authority,
          authorityLeaseId: input.authority.leaseId,
          authorityFencingToken: input.authority.fencingToken,
          consumerId: "owner-cancellation",
        });
        guard.invalidateForOwnerCancellationInTransaction({
          runId: input.runId,
          at: now,
        });
        const revision = stored.revision + 1;
        const changed = this.database
          .prepare(`UPDATE runs SET status = 'cancelled', revision = ?, updated_at = ?
          WHERE id = ? AND owner_id = ? AND agent_id = ? AND revision = ?`)
          .run(revision, now, input.runId, input.ownerId, input.agentId, stored.revision);
        if (changed.changes !== 1)
          return this.fail("PORT_CONFLICT", "Run cancellation revision conflict", {
            runId: input.runId,
          });
        this.writeCancelledCheckpoint(input, now);
        return writeRunReceiptInTransaction(this.database, mutation, authority, now, revision);
      })
      .immediate();
  }

  private writeCancelledCheckpoint(input: RunCancellationInput, now: string): void {
    const existing = this.database
      .prepare(`SELECT revision, context_ref, runtime_event_count, last_trace_event_id,
        output_kind, final_answer_ref, diagnostic_code
        FROM run_coordination_checkpoints
        WHERE run_id = ? AND owner_id = ? AND agent_id = ?`)
      .get(input.runId, input.ownerId, input.agentId);
    if (!existing) {
      this.database
        .prepare(`INSERT INTO run_coordination_checkpoints
          (run_id, owner_id, agent_id, revision, phase, context_ref, runtime_event_count,
           last_trace_event_id, terminal_status, output_kind, final_answer_ref, diagnostic_code,
           updated_at)
          VALUES (?, ?, ?, 1, 'cancelled', NULL, 0, NULL, 'cancelled', NULL, NULL, NULL, ?)`)
        .run(input.runId, input.ownerId, input.agentId, now);
      return;
    }
    const row = record(existing);
    this.database
      .prepare(`UPDATE run_coordination_checkpoints
        SET revision = ?, phase = 'cancelled', terminal_status = 'cancelled', updated_at = ?
        WHERE run_id = ? AND owner_id = ? AND agent_id = ? AND revision = ?`)
      .run(
        integer(row["revision"]) + 1,
        now,
        input.runId,
        input.ownerId,
        input.agentId,
        integer(row["revision"]),
      );
  }

  private complete(
    input: RunCompletionInput,
    authority: ProductAuthorityFence,
    now: string,
  ): RunTransitionReceipt {
    this.assertDiskHeadroom();
    return this.database
      .transaction(() => {
        const replay = this.replay(input);
        if (replay) return replay;
        this.assertAuthority(input, authority, now);
        const stored = this.read(input.ownerId, input.agentId, input.runId);
        if (!stored)
          return this.fail("PORT_NOT_FOUND", "Run is missing from the bound relational scope");
        if (stored.revision !== input.expectedRevision)
          return this.fail("PORT_CONFLICT", "Run completion revision conflict");
        this.assertTransition(stored, "completed");
        if (input.background && (stored.run.status !== "running" || !stored.run.threadId))
          return this.fail(
            "PORT_INVALID_OPERATION",
            "Only a running Thread Run can keep background commands after its answer",
          );
        const pendingResource = input.background
          ? undefined
          : this.database
              .prepare(
                `SELECT 1 FROM runs r WHERE r.owner_id=@ownerId AND r.agent_id=@agentId AND r.id=@runId
              AND NOT (${RUN_RESOURCES_RELEASED_SQL})`,
              )
              .get({
                ownerId: input.ownerId,
                agentId: input.agentId,
                runId: input.runId,
                resourceNow: now,
              });
        if (pendingResource)
          return this.fail("PORT_CONFLICT", "Run still owns unreleased sandbox resources");
        if (
          stored.run.status === "reconciling_external_result" ||
          input.recoveryCheckpointRevision !== undefined
        ) {
          const recoverable = this.database
            .prepare(
              `SELECT c.output_kind AS kind,c.final_answer_ref AS contentRef,c.revision AS revision
              FROM runs r JOIN run_coordination_checkpoints c
                ON c.run_id=r.id AND c.owner_id=r.owner_id AND c.agent_id=r.agent_id
              WHERE r.id=@runId AND r.owner_id=@ownerId AND r.agent_id=@agentId
                AND (${RUN_COMPLETION_RECOVERY_SQL})`,
            )
            .get({
              runId: input.runId,
              ownerId: input.ownerId,
              agentId: input.agentId,
              resourceNow: now,
            }) as { kind: string; contentRef: string | null; revision: number } | undefined;
          if (
            !recoverable ||
            (input.recoveryCheckpointRevision !== undefined &&
              recoverable.revision !== input.recoveryCheckpointRevision) ||
            recoverable.kind !== input.output.kind ||
            (input.output.kind === "assistant-answer" &&
              recoverable.contentRef !== input.output.contentRef)
          )
            return this.fail("PORT_CONFLICT", "Run completion recovery changed or is not eligible");
        }
        this.assertPayload(input);
        let dataClassification = input.dataClassification;
        if (input.output.kind === "assistant-answer") {
          const answerValue = this.database
            .prepare(`SELECT classification, content_type FROM payloads
          WHERE ref = ? AND owner_id = ? AND agent_id = ? AND lifecycle_state = 'active'`)
            .get(input.output.contentRef, input.ownerId, input.agentId);
          if (!answerValue)
            return this.fail(
              "PORT_INVALID_OPERATION",
              "Final answer Payload is outside the active scope",
            );
          const answer = record(answerValue);
          dataClassification = classification(answer["classification"]);
          const triggerValue = this.database
            .prepare(`SELECT p.classification FROM triggers t
          JOIN payloads p ON p.ref = t.payload_ref AND p.owner_id = t.owner_id AND p.agent_id = t.agent_id
          WHERE t.id = ? AND p.lifecycle_state = 'active'`)
            .get(stored.run.triggerId);
          if (!triggerValue)
            return this.fail("PORT_INVALID_OPERATION", "Run input Payload is unavailable");
          const inputClassification = classification(record(triggerValue)["classification"]);
          if (
            answer["content_type"] !== "text/plain" ||
            CLASSIFICATIONS.indexOf(dataClassification) <
              Math.max(
                CLASSIFICATIONS.indexOf(inputClassification),
                CLASSIFICATIONS.indexOf(input.dataClassification),
              )
          )
            return this.fail(
              "PORT_INVALID_OPERATION",
              "Final answer Payload type or classification is invalid",
            );
        }
        if (stored.run.threadId) {
          if (input.output.kind !== "assistant-answer")
            return this.fail(
              "PORT_INVALID_OPERATION",
              "Thread completion requires an assistant answer",
            );
          const turns = this.database
            .prepare(`SELECT DISTINCT u.id FROM turns u JOIN thread_messages m
          ON m.turn_id = u.id AND m.run_id = u.run_id AND m.thread_id = u.thread_id
            AND m.owner_id = u.owner_id AND m.agent_id = u.agent_id
          WHERE u.run_id = ? AND u.thread_id = ? AND u.owner_id = ? AND u.agent_id = ?
            AND u.session_id = ? AND u.committed_at IS NULL AND m.role IN ('owner', 'system')
            AND m.message_status = 'committed'`)
            .all(
              input.runId,
              stored.run.threadId,
              input.ownerId,
              input.agentId,
              stored.run.sessionId,
            );
          if (turns.length !== 1)
            return this.fail(
              "PORT_INVALID_OPERATION",
              "Run completion requires one admitted Owner Turn",
            );
          const turn = record(turns[0]);
          const threadValue = this.database
            .prepare("SELECT revision FROM threads WHERE id = ?")
            .get(stored.run.threadId);
          if (!threadValue) return this.fail("PORT_NOT_FOUND", "Completion Thread is missing");
          const identity = createHash("sha256")
            .update(
              JSON.stringify([
                "runtime-assistant",
                input.ownerId,
                input.agentId,
                input.runId,
                input.idempotencyKey,
              ]),
            )
            .digest("hex");
          this.thread.commitAssistantMessage(
            {
              ownerId: input.ownerId,
              agentId: input.agentId,
              threadId: stored.run.threadId,
              runId: input.runId,
              turnId: createTurnId(string(turn["id"])),
              messageId: createMessageId(`assistant:${identity}`),
              idempotencyKey: createIdempotencyKey(`runtime-assistant:${identity}`),
              semanticFingerprint: fingerprint(input),
              contentRef: input.output.contentRef,
              dataClassification,
              resultRef: input.payloadRef,
              expectedThreadRevision: integer(record(threadValue)["revision"]),
              committedAt: now,
              authority,
            },
            { keepRunOpen: input.background !== undefined },
          );
          for (const hold of input.background?.holds ?? [])
            this.database
              .prepare(`INSERT INTO run_background_holds (
                owner_id, agent_id, run_id, task_ref, thread_id, started_at, deadline_at, parked_at,
                command_ref
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(
                input.ownerId,
                input.agentId,
                input.runId,
                hold.taskRef,
                stored.run.threadId,
                hold.startedAt,
                hold.deadlineAt,
                now,
                hold.commandRef ?? null,
              );
        } else {
          this.database
            .prepare(
              "UPDATE runs SET status = 'completed', revision = revision + 1, updated_at = ? WHERE id = ?",
            )
            .run(now, input.runId);
        }
        this.assertExecutionLease(input, authority, now);
        return writeRunReceiptInTransaction(
          this.database,
          input,
          authority,
          now,
          stored.revision + 1,
        );
      })
      .immediate();
  }

  private listBackground(ownerId: OwnerId, agentId: AgentId, now: string): BackgroundRunRecord[] {
    const rows = this.database
      .prepare(
        `SELECT h.run_id, h.thread_id, h.task_ref, h.started_at, h.deadline_at, r.status,
          EXISTS (SELECT 1 FROM run_execution_leases l
            WHERE l.run_id=r.id AND l.owner_id=r.owner_id AND l.agent_id=r.agent_id
              AND l.released_at IS NULL AND l.expires_at > @resourceNow) AS lease_live,
          (${RUN_RESOURCES_RELEASED_SQL}) AS resources_released
        FROM run_background_holds h
        JOIN runs r ON r.id=h.run_id AND r.owner_id=h.owner_id AND r.agent_id=h.agent_id
        WHERE h.owner_id=@ownerId AND h.agent_id=@agentId AND h.released_at IS NULL
        ORDER BY h.parked_at, h.run_id, h.task_ref`,
      )
      .all({ ownerId, agentId, resourceNow: now }) as Record<string, unknown>[];
    const runs = new Map<string, BackgroundRunRecord>();
    for (const row of rows) {
      const runId = string(row["run_id"]);
      const hold = {
        taskRef: string(row["task_ref"]),
        startedAt: string(row["started_at"]),
        deadlineAt: string(row["deadline_at"]),
      };
      const existing = runs.get(runId);
      runs.set(
        runId,
        existing
          ? { ...existing, holds: [...existing.holds, hold] }
          : {
              runId: createRunId(runId),
              threadId: string(row["thread_id"]),
              holds: [hold],
              runStatus: status(row["status"]),
              leaseLive: row["lease_live"] === 1,
              resourcesReleased: row["resources_released"] === 1,
            },
      );
    }
    return [...runs.values()];
  }

  private listUnattended(
    ownerId: OwnerId,
    agentId: AgentId,
    failedSince: string,
    limit: number,
  ): UnattendedRunRecord[] {
    if (limit > 500) this.fail("PORT_INVALID_OPERATION", "Unattended Run limit is invalid");
    const rows = this.database
      .prepare(
        `SELECT r.id, r.thread_id, r.created_at, r.updated_at,
          (r.status NOT IN ('completed', 'failed', 'cancelled') OR EXISTS (
            SELECT 1 FROM run_background_holds h WHERE h.owner_id = r.owner_id
              AND h.agent_id = r.agent_id AND h.run_id = r.id AND h.released_at IS NULL)) AS active
        FROM runs r
        JOIN triggers t ON t.id = r.trigger_id AND t.owner_id = r.owner_id
          AND t.agent_id = r.agent_id
        WHERE r.owner_id = @ownerId AND r.agent_id = @agentId
          AND NOT EXISTS (SELECT 1 FROM threads hidden
            WHERE hidden.id = r.thread_id AND hidden.origin = 'think')
          AND (
          (r.status NOT IN ('completed', 'failed', 'cancelled')
            AND t.source_type != 'user_message')
          OR EXISTS (SELECT 1 FROM run_background_holds h WHERE h.owner_id = r.owner_id
            AND h.agent_id = r.agent_id AND h.run_id = r.id AND h.released_at IS NULL)
          OR (r.status = 'failed' AND r.updated_at >= @failedSince AND (
            t.source_type != 'user_message'
            OR EXISTS (SELECT 1 FROM run_background_holds h WHERE h.owner_id = r.owner_id
              AND h.agent_id = r.agent_id AND h.run_id = r.id))))
        ORDER BY r.updated_at DESC, r.id LIMIT @limit`,
      )
      .all({ ownerId, agentId, failedSince, limit }) as Record<string, unknown>[];
    return rows.map((row) => ({
      runId: createRunId(string(row["id"])),
      threadId: row["thread_id"] === null ? null : string(row["thread_id"]),
      state: row["active"] === 1 ? "running" : "failed",
      startedAt: string(row["created_at"]),
      updatedAt: string(row["updated_at"]),
    }));
  }

  private finishBackground(
    input: FinishBackgroundRunInput,
    authority: ProductAuthorityFence,
    now: string,
  ): FinishBackgroundRunResult {
    this.assertDiskHeadroom();
    return this.database
      .transaction((): FinishBackgroundRunResult => {
        const done = this.database
          .prepare(
            `SELECT notice_run_id FROM run_background_holds
              WHERE owner_id=? AND agent_id=? AND run_id=? AND released_at IS NOT NULL LIMIT 1`,
          )
          .get(input.ownerId, input.agentId, input.runId) as
          | { notice_run_id: string | null }
          | undefined;
        const open = this.database
          .prepare(
            `SELECT task_ref FROM run_background_holds
              WHERE owner_id=? AND agent_id=? AND run_id=? AND released_at IS NULL ORDER BY task_ref`,
          )
          .pluck()
          .all(input.ownerId, input.agentId, input.runId) as string[];
        if (open.length === 0) {
          if (!done) return this.fail("PORT_NOT_FOUND", "Run has no background commands");
          return {
            finished: false,
            noticeRunId: done.notice_run_id === null ? null : createRunId(done.notice_run_id),
          };
        }
        const reported = input.outcomes.map((entry) => entry.taskRef).sort();
        if (reported.length !== open.length || reported.some((ref, index) => ref !== open[index]))
          return this.fail("PORT_CONFLICT", "Background outcomes do not match the open commands");
        this.assertAuthority(input, authority, now);
        const stored = this.read(input.ownerId, input.agentId, input.runId);
        if (!stored || !stored.run.threadId)
          return this.fail("PORT_NOT_FOUND", "Background Run is missing from the bound scope");
        const release = this.database.prepare(
          `UPDATE run_background_holds SET released_at=?, outcome=?, notice_run_id=?, output_ref=?
            WHERE owner_id=? AND agent_id=? AND run_id=? AND task_ref=? AND released_at IS NULL`,
        );
        if (stored.run.status !== "running") {
          for (const entry of input.outcomes)
            release.run(
              now,
              entry.outcome,
              null,
              entry.outputRef ?? null,
              input.ownerId,
              input.agentId,
              input.runId,
              entry.taskRef,
            );
          return { finished: false, noticeRunId: null };
        }
        const pendingResource = this.database
          .prepare(
            `SELECT 1 FROM runs r WHERE r.owner_id=@ownerId AND r.agent_id=@agentId AND r.id=@runId
              AND NOT (${RUN_RESOURCES_RELEASED_SQL})`,
          )
          .get({
            ownerId: input.ownerId,
            agentId: input.agentId,
            runId: input.runId,
            resourceNow: now,
          });
        if (pendingResource)
          return this.fail("PORT_CONFLICT", "Run still owns unreleased sandbox resources");
        if (input.executionLease) this.assertExecutionLease(input, authority, now);
        else if (
          this.database
            .prepare(
              `SELECT 1 FROM run_execution_leases WHERE run_id=? AND owner_id=? AND agent_id=?
                AND released_at IS NULL AND expires_at > ?`,
            )
            .get(input.runId, input.ownerId, input.agentId, now)
        )
          return this.fail("PORT_CONFLICT", "Background Run still has a live execution lease");
        for (const entry of input.outcomes)
          release.run(
            now,
            entry.outcome,
            input.notice.runId,
            entry.outputRef ?? null,
            input.ownerId,
            input.agentId,
            input.runId,
            entry.taskRef,
          );
        this.database
          .prepare(
            `UPDATE runs SET status='completed', revision=revision+1, updated_at=?
              WHERE id=? AND owner_id=? AND agent_id=? AND status='running'`,
          )
          .run(now, input.runId, input.ownerId, input.agentId);
        this.database
          .prepare(
            `UPDATE run_coordination_checkpoints SET revision=revision+1, phase='completed',
              terminal_status='completed', updated_at=?
              WHERE run_id=? AND owner_id=? AND agent_id=?`,
          )
          .run(now, input.runId, input.ownerId, input.agentId);
        if (input.executionLease)
          this.database
            .prepare(
              `UPDATE run_execution_leases SET revision=revision+1, released_at=?
                WHERE run_id=? AND owner_id=? AND agent_id=? AND released_at IS NULL`,
            )
            .run(now, input.runId, input.ownerId, input.agentId);
        this.thread.admitBackgroundNoticeInTransaction({
          ownerId: input.ownerId,
          agentId: input.agentId,
          threadId: stored.run.threadId,
          parentRunId: input.runId,
          triggerId: input.notice.triggerId,
          runId: input.notice.runId,
          turnId: input.notice.turnId,
          messageId: input.notice.messageId,
          idempotencyKey: input.idempotencyKey,
          contentRef: input.notice.contentRef,
          dataClassification: input.notice.dataClassification,
          occurredAt: now,
          authority,
        });
        return { finished: true, noticeRunId: input.notice.runId };
      })
      .immediate();
  }
}
