import type {
  AdmitOwnerMessageInput,
  CommitAssistantMessageInput,
  ForkThreadInput,
  RequestThreadDeletionInput,
  ResolveThreadTaskInput,
  ScheduledJob,
  ThreadCreateInput,
  ThreadDeletionImpact,
  ThreadListQuery,
  ThreadMutationReceipt,
  ThreadSearchProjectionInput,
  ThreadSearchQuery,
  ThreadTaskBinding,
  ThreadTitleSearchProjectionInput,
  ThreadUpdateInput,
} from "@himawari-agent/application";
import type {
  AgentId,
  MessageId,
  OwnerId,
  ProductThread,
  ProductThreadMessage,
  RunId,
  ThreadForkLineage,
  ThreadId,
  TurnId,
} from "@himawari-agent/domain";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

interface ThreadRow {
  readonly id: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly revision: number;
  readonly status: "open" | "trashed" | "deletion_pending" | "deleted_verified";
  readonly titleRef: string | null;
  readonly titleSource: "automatic" | "owner" | null;
  readonly titleRevision: number;
  readonly pinOrder: number | null;
  readonly answerLocale: ProductThread["answerLocale"];
  readonly messageWatermark: number;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface LineageRow {
  readonly sourceThreadId: string | null;
  readonly sourceTurnId: string | null;
  readonly sourceThreadMarker: string;
  readonly sourceTurnMarker: string;
  readonly sourceWatermark: number;
  readonly summaryRefsJson: string;
  readonly policyRefsJson: string;
  readonly sourceContentAvailable: number;
  readonly forkedAt: string;
}

interface ReceiptRow {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly commandType: string;
  readonly semanticFingerprint: string;
  readonly threadId: string;
  readonly threadRevision: number;
  readonly resultRef: string;
  readonly committedAt: string;
}

interface MessageRow {
  readonly id: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly runId: string | null;
  readonly sequence: number;
  readonly role: ProductThreadMessage["role"];
  readonly contentRef: string;
  readonly dataClassification: ProductThreadMessage["dataClassification"];
  readonly status: ProductThreadMessage["status"];
  readonly committedAt: string;
}

interface TaskBindingRow {
  readonly id: string;
  readonly revision: number;
  readonly threadId: string | null;
  readonly status: "active" | "paused" | "revoked";
  readonly recordJson: string | null;
}

const THREAD_SELECT = `SELECT id, owner_id AS ownerId, agent_id AS agentId, revision, status,
  title_ref AS titleRef, title_source AS titleSource, title_revision AS titleRevision,
  pin_order AS pinOrder, answer_locale AS answerLocale,
  message_watermark AS messageWatermark, archived_at AS archivedAt,
  created_at AS createdAt, updated_at AS updatedAt FROM threads`;

const MESSAGE_SELECT = `SELECT id, owner_id AS ownerId, agent_id AS agentId,
  thread_id AS threadId, turn_id AS turnId, run_id AS runId, sequence, role,
  content_ref AS contentRef, classification AS dataClassification,
  message_status AS status, committed_at AS committedAt FROM thread_messages`;

export class SqliteThreadOperations {
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
    switch (operation) {
      case "thread.create":
        return this.create((payload as { input: ThreadCreateInput }).input);
      case "thread.read": {
        const input = payload as { ownerId: OwnerId; agentId: AgentId; threadId: ThreadId };
        return this.read(input.ownerId, input.agentId, input.threadId);
      }
      case "thread.update":
        return this.update((payload as { input: ThreadUpdateInput }).input);
      case "thread.findReceipt": {
        const input = payload as {
          ownerId: OwnerId;
          agentId: AgentId;
          idempotencyKey: ThreadMutationReceipt["idempotencyKey"];
        };
        return this.findReceipt(input.ownerId, input.agentId, input.idempotencyKey);
      }
      case "thread.admitOwnerMessage":
        return this.admitOwnerMessage((payload as { input: AdmitOwnerMessageInput }).input);
      case "thread.commitAssistantMessage":
        return this.commitAssistantMessage(
          (payload as { input: CommitAssistantMessageInput }).input,
        );
      case "thread.fork":
        return this.fork((payload as { input: ForkThreadInput }).input);
      case "thread.list":
        return this.list((payload as { query: ThreadListQuery }).query);
      case "thread.listMessages": {
        const input = payload as {
          ownerId: OwnerId;
          agentId: AgentId;
          threadId: ThreadId;
          afterSequence: number;
          limit: number;
        };
        return this.listMessages(
          input.ownerId,
          input.agentId,
          input.threadId,
          input.afterSequence,
          input.limit,
        );
      }
      case "thread.hasCommittedTurn": {
        const input = payload as {
          ownerId: OwnerId;
          agentId: AgentId;
          threadId: ThreadId;
          turnId: TurnId;
          atOrBeforeWatermark: number;
        };
        return this.hasCommittedTurn(
          input.ownerId,
          input.agentId,
          input.threadId,
          input.turnId,
          input.atOrBeforeWatermark,
        );
      }
      case "thread.projectSearch":
        return this.projectSearch((payload as { input: ThreadSearchProjectionInput }).input);
      case "thread.projectTitleSearch":
        return this.projectTitleSearch(
          (payload as { input: ThreadTitleSearchProjectionInput }).input,
        );
      case "thread.search":
        return this.search((payload as { query: ThreadSearchQuery }).query);
      case "thread.rebuildSearch": {
        const input = payload as {
          ownerId: OwnerId;
          agentId: AgentId;
          threadId: ThreadId;
          projectionVersion: string;
        };
        return this.rebuildSearch(
          input.ownerId,
          input.agentId,
          input.threadId,
          input.projectionVersion,
        );
      }
      case "thread.inspectDeletionImpact": {
        const input = payload as { ownerId: OwnerId; agentId: AgentId; threadId: ThreadId };
        return this.inspectDeletionImpact(input.ownerId, input.agentId, input.threadId);
      }
      case "thread.resolveDeletionTask":
        return this.resolveDeletionTask((payload as { input: ResolveThreadTaskInput }).input);
      case "thread.requestDeletion":
        return this.requestDeletion((payload as { input: RequestThreadDeletionInput }).input);
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown Thread operation ${operation}`);
    }
  }

  private lineage(threadId: string): ThreadForkLineage | null {
    const row = this.database
      .prepare(
        `SELECT source_thread_id AS sourceThreadId, source_turn_id AS sourceTurnId,
          source_thread_marker AS sourceThreadMarker, source_turn_marker AS sourceTurnMarker,
          source_watermark AS sourceWatermark, summary_refs_json AS summaryRefsJson,
          policy_refs_json AS policyRefsJson, source_content_available AS sourceContentAvailable,
          forked_at AS forkedAt FROM thread_fork_lineage WHERE thread_id = ?`,
      )
      .get(threadId) as LineageRow | undefined;
    if (!row) return null;
    return {
      sourceThreadId: (row.sourceThreadId ?? row.sourceThreadMarker) as ThreadId,
      sourceTurnId: (row.sourceTurnId ?? row.sourceTurnMarker) as TurnId,
      sourceWatermark: row.sourceWatermark,
      summaryRefs:
        row.sourceContentAvailable === 1 ? (JSON.parse(row.summaryRefsJson) as string[]) : [],
      policyRefs: JSON.parse(row.policyRefsJson) as string[],
      sourceContentAvailable: row.sourceContentAvailable === 1,
      forkedAt: row.forkedAt,
    };
  }

  private fromThreadRow(row: ThreadRow): ProductThread {
    const status: ProductThread["status"] =
      row.status === "open" ? (row.archivedAt === null ? "active" : "archived") : row.status;
    return {
      id: row.id as ThreadId,
      ownerId: row.ownerId as OwnerId,
      agentId: row.agentId as AgentId,
      revision: row.revision,
      status,
      titleRef: row.titleRef,
      titleSource: row.titleSource,
      titleRevision: row.titleRevision,
      pinOrder: row.pinOrder,
      answerLocale: row.answerLocale,
      messageWatermark: row.messageWatermark,
      lineage: this.lineage(row.id),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private read(ownerId: OwnerId, agentId: AgentId, threadId: ThreadId): ProductThread | undefined {
    const row = this.database
      .prepare(`${THREAD_SELECT} WHERE owner_id = ? AND agent_id = ? AND id = ?`)
      .get(ownerId, agentId, threadId) as ThreadRow | undefined;
    return row ? this.fromThreadRow(row) : undefined;
  }

  private receiptFromRow(row: ReceiptRow): ThreadMutationReceipt {
    return {
      ...row,
      idempotencyKey: row.idempotencyKey as ThreadMutationReceipt["idempotencyKey"],
      threadId: row.threadId as ThreadId,
    };
  }

  private findReceipt(
    ownerId: OwnerId,
    agentId: AgentId,
    idempotencyKey: ThreadMutationReceipt["idempotencyKey"],
  ): ThreadMutationReceipt | undefined {
    const row = this.database
      .prepare(
        `SELECT command_id AS commandId, idempotency_key AS idempotencyKey,
          command_type AS commandType, semantic_fingerprint AS semanticFingerprint,
          thread_id AS threadId, thread_revision AS threadRevision,
          result_ref AS resultRef, committed_at AS committedAt
          FROM thread_command_receipts
          WHERE owner_id = ? AND agent_id = ? AND idempotency_key = ?`,
      )
      .get(ownerId, agentId, idempotencyKey) as ReceiptRow | undefined;
    return row ? this.receiptFromRow(row) : undefined;
  }

  private replay(
    ownerId: OwnerId,
    agentId: AgentId,
    idempotencyKey: ThreadMutationReceipt["idempotencyKey"],
    commandType: string,
    semanticFingerprint: string,
  ): ThreadMutationReceipt | undefined {
    const receipt = this.findReceipt(ownerId, agentId, idempotencyKey);
    if (
      receipt &&
      (receipt.commandType !== commandType || receipt.semanticFingerprint !== semanticFingerprint)
    ) {
      this.fail("PORT_CONFLICT", "Thread idempotency key was reused with different semantics", {
        idempotencyKey,
      });
    }
    return receipt;
  }

  private assertAuthority(
    ownerId: OwnerId,
    agentId: AgentId,
    authority: ThreadCreateInput["authority"],
  ): void {
    const current = this.database
      .prepare(
        `SELECT 1 FROM deployments WHERE id = ? AND owner_id = ? AND agent_id = ?
          AND status = 'active' AND authority_epoch = ? AND fencing_token = ?`,
      )
      .get(
        authority.deploymentId,
        ownerId,
        agentId,
        authority.authorityEpoch,
        authority.fencingToken,
      );
    if (!current) this.fail("PORT_STALE_FENCE", "Thread command authority fence is stale");
  }

  private assertPayload(ownerId: OwnerId, agentId: AgentId, ref: string): void {
    if (
      !this.database
        .prepare(
          "SELECT 1 FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ? AND lifecycle_state = 'active'",
        )
        .get(ref, ownerId, agentId)
    ) {
      this.fail("PORT_INVALID_OPERATION", `Payload ${ref} is outside the Thread scope`);
    }
  }

  private physicalStatus(status: ProductThread["status"]): ThreadRow["status"] {
    return status === "active" || status === "archived" ? "open" : status;
  }

  private writeReceipt(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    idempotencyKey: ThreadMutationReceipt["idempotencyKey"];
    commandType: string;
    semanticFingerprint: string;
    threadId: ThreadId;
    threadRevision: number;
    resultRef: string;
    committedAt: string;
  }): ThreadMutationReceipt {
    const commandId = `thread-command:${input.idempotencyKey}`;
    this.database
      .prepare(
        `INSERT INTO thread_command_receipts (
          command_id, owner_id, agent_id, idempotency_key, command_type,
          semantic_fingerprint, thread_id, thread_revision, result_ref, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        commandId,
        input.ownerId,
        input.agentId,
        input.idempotencyKey,
        input.commandType,
        input.semanticFingerprint,
        input.threadId,
        input.threadRevision,
        input.resultRef,
        input.committedAt,
      );
    this.database
      .prepare(
        `INSERT INTO reliable_events (
          id, owner_id, agent_id, idempotency_key, topic, payload_ref,
          publication_state, occurred_at
        ) VALUES (?, ?, ?, ?, 'thread.changed', ?, 'pending', ?)`,
      )
      .run(
        `thread-event:${input.idempotencyKey}`,
        input.ownerId,
        input.agentId,
        input.idempotencyKey,
        input.resultRef,
        input.committedAt,
      );
    return {
      commandId,
      idempotencyKey: input.idempotencyKey,
      commandType: input.commandType,
      semanticFingerprint: input.semanticFingerprint,
      threadId: input.threadId,
      threadRevision: input.threadRevision,
      resultRef: input.resultRef,
      committedAt: input.committedAt,
    };
  }

  private insertThread(thread: ProductThread): void {
    this.database
      .prepare(
        `INSERT INTO threads (
          id, owner_id, agent_id, revision, status, title_ref, title_source,
          title_revision, pin_order, answer_locale, message_watermark,
          archived_at, trashed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thread.id,
        thread.ownerId,
        thread.agentId,
        thread.revision,
        this.physicalStatus(thread.status),
        thread.titleRef,
        thread.titleSource,
        thread.titleRevision,
        thread.pinOrder,
        thread.answerLocale,
        thread.messageWatermark,
        thread.status === "archived" ? thread.updatedAt : null,
        thread.status === "trashed" ? thread.updatedAt : null,
        thread.createdAt,
        thread.updatedAt,
      );
  }

  private create(input: ThreadCreateInput) {
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      const replay = this.replay(
        input.thread.ownerId,
        input.thread.agentId,
        input.idempotencyKey,
        "thread.create",
        input.semanticFingerprint,
      );
      if (replay) {
        const thread = this.read(input.thread.ownerId, input.thread.agentId, replay.threadId);
        if (!thread) this.fail("PORT_NOT_FOUND", "Replayed Thread no longer exists");
        return { thread, receipt: replay };
      }
      this.assertAuthority(input.thread.ownerId, input.thread.agentId, input.authority);
      this.assertPayload(input.thread.ownerId, input.thread.agentId, input.resultRef);
      this.insertThread(input.thread);
      const receipt = this.writeReceipt({
        ownerId: input.thread.ownerId,
        agentId: input.thread.agentId,
        idempotencyKey: input.idempotencyKey,
        commandType: "thread.create",
        semanticFingerprint: input.semanticFingerprint,
        threadId: input.thread.id,
        threadRevision: input.thread.revision,
        resultRef: input.resultRef,
        committedAt: input.thread.createdAt,
      });
      return { thread: input.thread, receipt };
    });
    return transaction.immediate();
  }

  private update(input: ThreadUpdateInput) {
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      const replay = this.replay(
        input.ownerId,
        input.agentId,
        input.idempotencyKey,
        input.commandType,
        input.semanticFingerprint,
      );
      if (replay) {
        const thread = this.read(input.ownerId, input.agentId, replay.threadId);
        if (!thread) this.fail("PORT_NOT_FOUND", "Replayed Thread no longer exists");
        return { thread, receipt: replay };
      }
      this.assertAuthority(input.ownerId, input.agentId, input.authority);
      this.assertPayload(input.ownerId, input.agentId, input.resultRef);
      if (input.thread.titleRef)
        this.assertPayload(input.ownerId, input.agentId, input.thread.titleRef);
      const result = this.database
        .prepare(
          `UPDATE threads SET revision = ?, status = ?, title_ref = ?, title_source = ?,
            title_revision = ?, pin_order = ?, answer_locale = ?, message_watermark = ?,
            archived_at = ?, trashed_at = ?, updated_at = ?
          WHERE id = ? AND owner_id = ? AND agent_id = ? AND revision = ?`,
        )
        .run(
          input.thread.revision,
          this.physicalStatus(input.thread.status),
          input.thread.titleRef,
          input.thread.titleSource,
          input.thread.titleRevision,
          input.thread.pinOrder,
          input.thread.answerLocale,
          input.thread.messageWatermark,
          input.thread.status === "archived" ? input.thread.updatedAt : null,
          input.thread.status === "trashed" ? input.thread.updatedAt : null,
          input.thread.updatedAt,
          input.thread.id,
          input.ownerId,
          input.agentId,
          input.expectedRevision,
        );
      if (result.changes !== 1) this.fail("PORT_CONFLICT", "Thread revision conflict");
      const receipt = this.writeReceipt({
        ownerId: input.ownerId,
        agentId: input.agentId,
        idempotencyKey: input.idempotencyKey,
        commandType: input.commandType,
        semanticFingerprint: input.semanticFingerprint,
        threadId: input.thread.id,
        threadRevision: input.thread.revision,
        resultRef: input.resultRef,
        committedAt: input.thread.updatedAt,
      });
      return { thread: input.thread, receipt };
    });
    return transaction.immediate();
  }

  private taskBindingFromRow(row: TaskBindingRow): ThreadTaskBinding {
    if (row.threadId === null) {
      this.fail("PORT_INVALID_OPERATION", `Task ${row.id} is not bound to a Thread`);
    }
    return Object.freeze({
      taskId: row.id,
      revision: row.revision,
      threadId: row.threadId as ThreadId,
      status: row.status === "revoked" ? "cancelled" : row.status,
    });
  }

  private taskRow(taskId: string): TaskBindingRow | undefined {
    return this.database
      .prepare(
        `SELECT id, revision, thread_id AS threadId, status,
          record_json AS recordJson FROM scheduled_jobs WHERE id = ?`,
      )
      .get(taskId) as TaskBindingRow | undefined;
  }

  private inspectDeletionImpact(
    ownerId: OwnerId,
    agentId: AgentId,
    threadId: ThreadId,
  ): ThreadDeletionImpact {
    const thread = this.read(ownerId, agentId, threadId);
    if (!thread) this.fail("PORT_NOT_FOUND", `Thread ${threadId} not found`);
    const rows = this.database
      .prepare(
        `SELECT id, revision, thread_id AS threadId, status,
          record_json AS recordJson FROM scheduled_jobs
        WHERE owner_id = ? AND agent_id = ? AND thread_id = ? ORDER BY id`,
      )
      .all(ownerId, agentId, threadId) as TaskBindingRow[];
    const associatedTasks = Object.freeze(rows.map((row) => this.taskBindingFromRow(row)));
    return Object.freeze({
      threadId,
      threadRevision: thread.revision,
      associatedTasks,
      activeTaskIds: Object.freeze(
        associatedTasks.filter((task) => task.status === "active").map((task) => task.taskId),
      ),
    });
  }

  private resolveDeletionTask(input: ResolveThreadTaskInput) {
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      const replay = this.replay(
        input.ownerId,
        input.agentId,
        input.idempotencyKey,
        "thread.task.resolve",
        input.semanticFingerprint,
      );
      if (replay) {
        const replayedTask = this.taskRow(input.taskId);
        if (!replayedTask || replayedTask.threadId === null) {
          this.fail("PORT_NOT_FOUND", "Replayed Thread task resolution state is missing");
        }
        return {
          impact: this.inspectDeletionImpact(input.ownerId, input.agentId, input.threadId),
          task: this.taskBindingFromRow(replayedTask),
          receipt: replay,
        };
      }
      this.assertAuthority(input.ownerId, input.agentId, input.authority);
      this.assertPayload(input.ownerId, input.agentId, input.resultRef);
      if (!this.read(input.ownerId, input.agentId, input.threadId)) {
        this.fail("PORT_NOT_FOUND", `Thread ${input.threadId} not found`);
      }
      const current = this.taskRow(input.taskId);
      if (!current || current.threadId !== input.threadId) {
        this.fail("PORT_INVALID_OPERATION", `Task ${input.taskId} is outside the Thread scope`);
      }
      if (current.revision !== input.expectedTaskRevision) {
        this.fail("PORT_CONFLICT", `Task ${input.taskId} revision conflict`);
      }
      if (current.recordJson === null) {
        this.fail("PORT_INVALID_OPERATION", `Task ${input.taskId} has no durable product record`);
      }
      const record = JSON.parse(current.recordJson) as ScheduledJob;
      let threadId: ThreadId | null = input.threadId;
      let status: ScheduledJob["status"] = record.status;
      let physicalStatus: TaskBindingRow["status"] = current.status;
      if (input.resolution.action === "pause") {
        if (current.status !== "active") {
          this.fail("PORT_CONFLICT", `Task ${input.taskId} is not active`);
        }
        status = "paused";
        physicalStatus = "paused";
      } else if (input.resolution.action === "cancel") {
        if (current.status === "revoked") {
          this.fail("PORT_CONFLICT", `Task ${input.taskId} is already cancelled`);
        }
        status = "cancelled";
        physicalStatus = "revoked";
      } else {
        if (input.resolution.targetThreadId === input.threadId) {
          this.fail(
            "PORT_INVALID_OPERATION",
            "Task rebind target must differ from its source Thread",
          );
        }
        const target = this.read(input.ownerId, input.agentId, input.resolution.targetThreadId);
        if (!target || (target.status !== "active" && target.status !== "archived")) {
          this.fail("PORT_INVALID_OPERATION", "Task rebind target is unavailable");
        }
        threadId = input.resolution.targetThreadId;
      }
      const next: ScheduledJob = Object.freeze({
        ...record,
        revision: current.revision + 1,
        threadId,
        status,
      });
      this.database
        .prepare(
          `UPDATE scheduled_jobs SET revision = ?, thread_id = ?, status = ?, record_json = ?
          WHERE id = ? AND owner_id = ? AND agent_id = ? AND revision = ?`,
        )
        .run(
          next.revision,
          next.threadId,
          physicalStatus,
          JSON.stringify(next),
          input.taskId,
          input.ownerId,
          input.agentId,
          input.expectedTaskRevision,
        );
      const source = this.read(input.ownerId, input.agentId, input.threadId);
      if (!source) this.fail("PORT_NOT_FOUND", `Thread ${input.threadId} not found`);
      const receipt = this.writeReceipt({
        ownerId: input.ownerId,
        agentId: input.agentId,
        idempotencyKey: input.idempotencyKey,
        commandType: "thread.task.resolve",
        semanticFingerprint: input.semanticFingerprint,
        threadId: input.threadId,
        threadRevision: source.revision,
        resultRef: input.resultRef,
        committedAt: input.resolvedAt,
      });
      const stored = this.taskRow(input.taskId);
      if (!stored || stored.threadId === null) {
        this.fail("PORT_NOT_FOUND", "Resolved Thread task state is missing");
      }
      return {
        impact: this.inspectDeletionImpact(input.ownerId, input.agentId, input.threadId),
        task: this.taskBindingFromRow(stored),
        receipt,
      };
    });
    return transaction.immediate();
  }

  private requestDeletion(input: RequestThreadDeletionInput) {
    this.assertDiskHeadroom();
    const commandType = input.mode === "trash" ? "thread.trash" : "thread.delete_permanently";
    const transaction = this.database.transaction(() => {
      const replay = this.replay(
        input.ownerId,
        input.agentId,
        input.idempotencyKey,
        commandType,
        input.semanticFingerprint,
      );
      if (replay) {
        const thread = this.read(input.ownerId, input.agentId, input.threadId);
        if (!thread) this.fail("PORT_NOT_FOUND", "Replayed Thread deletion state is missing");
        return {
          thread,
          impact: this.inspectDeletionImpact(input.ownerId, input.agentId, input.threadId),
          receipt: replay,
        };
      }
      this.assertAuthority(input.ownerId, input.agentId, input.authority);
      this.assertPayload(input.ownerId, input.agentId, input.resultRef);
      if (
        input.mode === "permanent" &&
        (!input.authorizationRef || !input.recentAuthenticationRef)
      ) {
        this.fail(
          "PORT_INVALID_OPERATION",
          "Permanent Thread deletion requires authorization and recent authentication",
        );
      }
      const current = this.read(input.ownerId, input.agentId, input.threadId);
      if (!current) this.fail("PORT_NOT_FOUND", `Thread ${input.threadId} not found`);
      if (current.revision !== input.expectedThreadRevision) {
        this.fail("PORT_CONFLICT", "Thread revision conflict");
      }
      const impact = this.inspectDeletionImpact(input.ownerId, input.agentId, input.threadId);
      if (impact.activeTaskIds.length > 0) {
        this.fail("PORT_CONFLICT", "Active tasks must be resolved before deleting a Thread", {
          threadId: input.threadId,
          activeTaskIds: impact.activeTaskIds.join(","),
        });
      }
      const target = input.mode === "trash" ? "trashed" : "deletion_pending";
      const allowed =
        input.mode === "trash"
          ? current.status === "active" || current.status === "archived"
          : current.status === "active" ||
            current.status === "archived" ||
            current.status === "trashed";
      if (!allowed) {
        this.fail("PORT_INVALID_OPERATION", `Thread cannot enter ${target} from ${current.status}`);
      }
      const thread: ProductThread = Object.freeze({
        ...current,
        revision: current.revision + 1,
        status: target,
        updatedAt: input.requestedAt,
      });
      const result = this.database
        .prepare(
          `UPDATE threads SET revision = ?, status = ?, archived_at = NULL,
            trashed_at = ?, updated_at = ?
          WHERE id = ? AND owner_id = ? AND agent_id = ? AND revision = ?`,
        )
        .run(
          thread.revision,
          target,
          target === "trashed" ? input.requestedAt : null,
          input.requestedAt,
          input.threadId,
          input.ownerId,
          input.agentId,
          input.expectedThreadRevision,
        );
      if (result.changes !== 1) this.fail("PORT_CONFLICT", "Thread revision conflict");
      this.database
        .prepare("DELETE FROM thread_search_projection WHERE thread_id = ?")
        .run(input.threadId);
      this.database
        .prepare("DELETE FROM thread_title_search_projection WHERE thread_id = ?")
        .run(input.threadId);
      const receipt = this.writeReceipt({
        ownerId: input.ownerId,
        agentId: input.agentId,
        idempotencyKey: input.idempotencyKey,
        commandType,
        semanticFingerprint: input.semanticFingerprint,
        threadId: input.threadId,
        threadRevision: thread.revision,
        resultRef: input.resultRef,
        committedAt: input.requestedAt,
      });
      return {
        thread,
        impact: this.inspectDeletionImpact(input.ownerId, input.agentId, input.threadId),
        receipt,
      };
    });
    return transaction.immediate();
  }

  private messageFromRow(row: MessageRow): ProductThreadMessage {
    return {
      ...row,
      id: row.id as MessageId,
      ownerId: row.ownerId as OwnerId,
      agentId: row.agentId as AgentId,
      threadId: row.threadId as ThreadId,
      turnId: row.turnId as TurnId | null,
      runId: row.runId as RunId | null,
    };
  }

  private readMessage(
    ownerId: OwnerId,
    agentId: AgentId,
    threadId: ThreadId,
    id: MessageId,
  ): ProductThreadMessage | undefined {
    const row = this.database
      .prepare(`${MESSAGE_SELECT} WHERE id = ? AND owner_id = ? AND agent_id = ? AND thread_id = ?`)
      .get(id, ownerId, agentId, threadId) as MessageRow | undefined;
    return row ? this.messageFromRow(row) : undefined;
  }

  private admitOwnerMessage(input: AdmitOwnerMessageInput) {
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      const replay = this.replay(
        input.ownerId,
        input.agentId,
        input.idempotencyKey,
        "thread.message.submit",
        input.semanticFingerprint,
      );
      if (replay) {
        const thread = this.read(input.ownerId, input.agentId, replay.threadId);
        const message = this.readMessage(
          input.ownerId,
          input.agentId,
          input.threadId,
          input.messageId,
        );
        if (!thread || !message) this.fail("PORT_NOT_FOUND", "Replayed message state is missing");
        return { thread, message, receipt: replay };
      }
      this.assertAuthority(input.ownerId, input.agentId, input.authority);
      this.assertPayload(input.ownerId, input.agentId, input.contentRef);
      this.assertPayload(input.ownerId, input.agentId, input.resultRef);
      const current = this.read(input.ownerId, input.agentId, input.threadId);
      if (
        !current ||
        current.status !== "active" ||
        current.revision !== input.expectedThreadRevision
      ) {
        this.fail("PORT_CONFLICT", "Thread is not active at the expected revision");
      }
      const sequence = current.messageWatermark + 1;
      this.database
        .prepare(
          `INSERT INTO triggers (
            id, owner_id, agent_id, thread_id, idempotency_key, source_type,
            source_id, payload_ref, source_proof_ref, occurred_at
          ) VALUES (?, ?, ?, ?, ?, 'user_message', ?, ?, ?, ?)`,
        )
        .run(
          input.triggerId,
          input.ownerId,
          input.agentId,
          input.threadId,
          input.idempotencyKey,
          input.messageId,
          input.contentRef,
          input.sourceProofRef,
          input.occurredAt,
        );
      this.database
        .prepare(
          `INSERT INTO runs (
            id, owner_id, agent_id, thread_id, session_id, trigger_id,
            revision, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, 'accepted', ?, ?)`,
        )
        .run(
          input.runId,
          input.ownerId,
          input.agentId,
          input.threadId,
          input.sessionId,
          input.triggerId,
          input.occurredAt,
          input.occurredAt,
        );
      this.database
        .prepare(
          `INSERT INTO turns (
            id, owner_id, agent_id, thread_id, session_id, run_id, turn_index, committed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          input.turnId,
          input.ownerId,
          input.agentId,
          input.threadId,
          input.sessionId,
          input.runId,
          sequence,
        );
      this.database
        .prepare(
          `INSERT INTO thread_messages (
            id, owner_id, agent_id, thread_id, revision, sequence, role,
            content_ref, classification, committed_at, turn_id, run_id, message_status
          ) VALUES (?, ?, ?, ?, 1, ?, 'owner', ?, ?, ?, ?, ?, 'committed')`,
        )
        .run(
          input.messageId,
          input.ownerId,
          input.agentId,
          input.threadId,
          sequence,
          input.contentRef,
          input.dataClassification,
          input.occurredAt,
          input.turnId,
          input.runId,
        );
      const nextRevision = current.revision + 1;
      this.database
        .prepare(
          "UPDATE threads SET revision = ?, message_watermark = ?, updated_at = ? WHERE id = ? AND revision = ?",
        )
        .run(nextRevision, sequence, input.occurredAt, input.threadId, current.revision);
      const receipt = this.writeReceipt({
        ownerId: input.ownerId,
        agentId: input.agentId,
        idempotencyKey: input.idempotencyKey,
        commandType: "thread.message.submit",
        semanticFingerprint: input.semanticFingerprint,
        threadId: input.threadId,
        threadRevision: nextRevision,
        resultRef: input.resultRef,
        committedAt: input.occurredAt,
      });
      const thread = this.read(input.ownerId, input.agentId, input.threadId);
      const message = this.readMessage(
        input.ownerId,
        input.agentId,
        input.threadId,
        input.messageId,
      );
      if (!thread || !message) this.fail("PORT_NOT_FOUND", "Committed message state is missing");
      return { thread, message, receipt };
    });
    return transaction.immediate();
  }

  private commitAssistantMessage(input: CommitAssistantMessageInput) {
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      const replay = this.replay(
        input.ownerId,
        input.agentId,
        input.idempotencyKey,
        "thread.message.commit_assistant",
        input.semanticFingerprint,
      );
      if (replay) {
        const thread = this.read(input.ownerId, input.agentId, replay.threadId);
        const message = this.readMessage(
          input.ownerId,
          input.agentId,
          input.threadId,
          input.messageId,
        );
        if (!thread || !message) this.fail("PORT_NOT_FOUND", "Replayed assistant state is missing");
        return { thread, message, receipt: replay };
      }
      this.assertAuthority(input.ownerId, input.agentId, input.authority);
      this.assertPayload(input.ownerId, input.agentId, input.contentRef);
      this.assertPayload(input.ownerId, input.agentId, input.resultRef);
      const current = this.read(input.ownerId, input.agentId, input.threadId);
      if (
        !current ||
        current.status !== "active" ||
        current.revision !== input.expectedThreadRevision
      ) {
        this.fail("PORT_CONFLICT", "Thread is not active at the expected revision");
      }
      const run = this.database
        .prepare(
          `SELECT status FROM runs WHERE id = ? AND owner_id = ? AND agent_id = ? AND thread_id = ?`,
        )
        .get(input.runId, input.ownerId, input.agentId, input.threadId) as
        | { status: string }
        | undefined;
      const turn = this.database
        .prepare("SELECT 1 FROM turns WHERE id = ? AND run_id = ? AND thread_id = ?")
        .get(input.turnId, input.runId, input.threadId);
      if (!run || !turn || ["completed", "failed", "cancelled"].includes(run.status)) {
        this.fail("PORT_INVALID_OPERATION", "Assistant commit requires an active Run and Turn");
      }
      const sequence = current.messageWatermark + 1;
      this.database
        .prepare(
          `INSERT INTO thread_messages (
            id, owner_id, agent_id, thread_id, revision, sequence, role,
            content_ref, classification, committed_at, turn_id, run_id, message_status
          ) VALUES (?, ?, ?, ?, 1, ?, 'agent', ?, ?, ?, ?, ?, 'committed')`,
        )
        .run(
          input.messageId,
          input.ownerId,
          input.agentId,
          input.threadId,
          sequence,
          input.contentRef,
          input.dataClassification,
          input.committedAt,
          input.turnId,
          input.runId,
        );
      this.database
        .prepare("UPDATE turns SET committed_at = ? WHERE id = ?")
        .run(input.committedAt, input.turnId);
      this.database
        .prepare(
          "UPDATE runs SET status = 'completed', revision = revision + 1, updated_at = ? WHERE id = ?",
        )
        .run(input.committedAt, input.runId);
      const nextRevision = current.revision + 1;
      this.database
        .prepare(
          "UPDATE threads SET revision = ?, message_watermark = ?, updated_at = ? WHERE id = ? AND revision = ?",
        )
        .run(nextRevision, sequence, input.committedAt, input.threadId, current.revision);
      const receipt = this.writeReceipt({
        ownerId: input.ownerId,
        agentId: input.agentId,
        idempotencyKey: input.idempotencyKey,
        commandType: "thread.message.commit_assistant",
        semanticFingerprint: input.semanticFingerprint,
        threadId: input.threadId,
        threadRevision: nextRevision,
        resultRef: input.resultRef,
        committedAt: input.committedAt,
      });
      const thread = this.read(input.ownerId, input.agentId, input.threadId);
      const message = this.readMessage(
        input.ownerId,
        input.agentId,
        input.threadId,
        input.messageId,
      );
      if (!thread || !message) this.fail("PORT_NOT_FOUND", "Committed assistant state is missing");
      return { thread, message, receipt };
    });
    return transaction.immediate();
  }

  private fork(input: ForkThreadInput) {
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      const replay = this.replay(
        input.ownerId,
        input.agentId,
        input.idempotencyKey,
        "thread.fork",
        input.semanticFingerprint,
      );
      if (replay) {
        const thread = this.read(input.ownerId, input.agentId, replay.threadId);
        if (!thread) this.fail("PORT_NOT_FOUND", "Replayed Fork state is missing");
        return { thread, receipt: replay };
      }
      this.assertAuthority(input.ownerId, input.agentId, input.authority);
      this.assertPayload(input.ownerId, input.agentId, input.resultRef);
      for (const summaryRef of input.summaryRefs)
        this.assertPayload(input.ownerId, input.agentId, summaryRef);
      const source = this.read(input.ownerId, input.agentId, input.sourceThreadId);
      const sourceTurn = this.database
        .prepare(
          `SELECT committed_at AS committedAt FROM turns
          WHERE id = ? AND thread_id = ? AND owner_id = ? AND agent_id = ?`,
        )
        .get(input.sourceTurnId, input.sourceThreadId, input.ownerId, input.agentId) as
        | { committedAt: string | null }
        | undefined;
      if (
        !source ||
        source.status === "deleted_verified" ||
        source.messageWatermark < input.sourceWatermark ||
        !sourceTurn?.committedAt
      ) {
        this.fail("PORT_INVALID_OPERATION", "Fork source is not a committed snapshot");
      }
      this.insertThread(input.targetThread);
      this.database
        .prepare(
          `INSERT INTO thread_fork_lineage (
            thread_id, owner_id, agent_id, source_thread_id, source_turn_id,
            source_thread_marker, source_turn_marker, source_watermark,
            summary_refs_json, policy_refs_json, source_content_available, forked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          input.targetThread.id,
          input.ownerId,
          input.agentId,
          input.sourceThreadId,
          input.sourceTurnId,
          input.sourceThreadId,
          input.sourceTurnId,
          input.sourceWatermark,
          JSON.stringify(input.summaryRefs),
          JSON.stringify(input.policyRefs),
          input.targetThread.createdAt,
        );
      const receipt = this.writeReceipt({
        ownerId: input.ownerId,
        agentId: input.agentId,
        idempotencyKey: input.idempotencyKey,
        commandType: "thread.fork",
        semanticFingerprint: input.semanticFingerprint,
        threadId: input.targetThread.id,
        threadRevision: input.targetThread.revision,
        resultRef: input.resultRef,
        committedAt: input.targetThread.createdAt,
      });
      const thread = this.read(input.ownerId, input.agentId, input.targetThread.id);
      if (!thread) this.fail("PORT_NOT_FOUND", "Fork target state is missing");
      return { thread, receipt };
    });
    return transaction.immediate();
  }

  private assertLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      this.fail("PORT_INVALID_OPERATION", "Thread query limit must be between 1 and 1000");
    }
  }

  private list(query: ThreadListQuery): readonly ProductThread[] {
    this.assertLimit(query.limit);
    const rows = this.database
      .prepare(
        `${THREAD_SELECT} WHERE owner_id = ? AND agent_id = ?
          AND (? IS NULL OR updated_at < ?) ORDER BY
          CASE WHEN pin_order IS NULL THEN 1 ELSE 0 END, pin_order, updated_at DESC, id
          LIMIT ?`,
      )
      .all(
        query.ownerId,
        query.agentId,
        query.afterUpdatedAt,
        query.afterUpdatedAt,
        Math.min(query.limit * 4, 1000),
      ) as ThreadRow[];
    return rows
      .map((row) => this.fromThreadRow(row))
      .filter(
        (thread) =>
          query.statuses.includes(thread.status) && (!query.pinnedOnly || thread.pinOrder !== null),
      )
      .slice(0, query.limit);
  }

  private listMessages(
    ownerId: OwnerId,
    agentId: AgentId,
    threadId: ThreadId,
    afterSequence: number,
    limit: number,
  ): readonly ProductThreadMessage[] {
    this.assertLimit(limit);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      this.fail("PORT_INVALID_OPERATION", "Thread message cursor is invalid");
    }
    const thread = this.read(ownerId, agentId, threadId);
    if (!thread || ["trashed", "deletion_pending", "deleted_verified"].includes(thread.status))
      return [];
    return (
      this.database
        .prepare(
          `${MESSAGE_SELECT} WHERE owner_id = ? AND agent_id = ? AND thread_id = ?
            AND sequence > ? AND message_status = 'committed' ORDER BY sequence LIMIT ?`,
        )
        .all(ownerId, agentId, threadId, afterSequence, limit) as MessageRow[]
    ).map((row) => this.messageFromRow(row));
  }

  private hasCommittedTurn(
    ownerId: OwnerId,
    agentId: AgentId,
    threadId: ThreadId,
    turnId: TurnId,
    atOrBeforeWatermark: number,
  ): boolean {
    if (!Number.isSafeInteger(atOrBeforeWatermark) || atOrBeforeWatermark < 1) return false;
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM thread_messages WHERE owner_id = ? AND agent_id = ?
            AND thread_id = ? AND turn_id = ? AND sequence <= ?
            AND message_status = 'committed' LIMIT 1`,
        )
        .get(ownerId, agentId, threadId, turnId, atOrBeforeWatermark),
    );
  }

  private projectSearch(input: ThreadSearchProjectionInput): void {
    this.assertDiskHeadroom();
    if (
      input.tokenRefs.length === 0 ||
      new Set(input.tokenRefs).size !== input.tokenRefs.length ||
      input.tokenRefs.some((ref) => !ref || /\s/.test(ref)) ||
      !input.projectionVersion
    ) {
      this.fail(
        "PORT_INVALID_OPERATION",
        "Thread search projection requires opaque unique token refs",
      );
    }
    const message = this.database
      .prepare(
        `SELECT classification AS dataClassification FROM thread_messages
          WHERE id = ? AND thread_id = ? AND owner_id = ?
          AND agent_id = ? AND sequence = ? AND content_ref IS NOT NULL`,
      )
      .get(input.messageId, input.threadId, input.ownerId, input.agentId, input.sequence) as
      | { dataClassification: ProductThreadMessage["dataClassification"] }
      | undefined;
    if (!message) this.fail("PORT_INVALID_OPERATION", "Search projection message is outside scope");
    if (message.dataClassification !== input.dataClassification) {
      this.fail("PORT_INVALID_OPERATION", "Search projection cannot change message classification");
    }
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          "DELETE FROM thread_search_projection WHERE thread_id = ? AND message_id = ? AND projection_version = ?",
        )
        .run(input.threadId, input.messageId, input.projectionVersion);
      const statement = this.database.prepare(
        `INSERT INTO thread_search_projection (
          owner_id, agent_id, thread_id, message_id, sequence, classification,
          token_ref, projection_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const tokenRef of input.tokenRefs) {
        statement.run(
          input.ownerId,
          input.agentId,
          input.threadId,
          input.messageId,
          input.sequence,
          input.dataClassification,
          tokenRef,
          input.projectionVersion,
        );
      }
    });
    transaction.immediate();
  }

  private projectTitleSearch(input: ThreadTitleSearchProjectionInput): void {
    this.assertDiskHeadroom();
    this.assertProjectionTokens(input.tokenRefs, input.projectionVersion);
    const thread = this.read(input.ownerId, input.agentId, input.threadId);
    if (
      !thread ||
      thread.titleRef === null ||
      thread.titleRevision !== input.titleRevision ||
      ["trashed", "deletion_pending", "deleted_verified"].includes(thread.status)
    ) {
      this.fail("PORT_INVALID_OPERATION", "Thread title projection is stale or outside scope");
    }
    const titlePayload = this.database
      .prepare(
        `SELECT classification AS dataClassification FROM payloads
          WHERE ref = ? AND owner_id = ? AND agent_id = ? AND lifecycle_state = 'active'`,
      )
      .get(thread.titleRef, input.ownerId, input.agentId) as
      | { dataClassification: ProductThreadMessage["dataClassification"] }
      | undefined;
    if (!titlePayload || titlePayload.dataClassification !== input.dataClassification) {
      this.fail("PORT_INVALID_OPERATION", "Title projection cannot change Payload classification");
    }
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `DELETE FROM thread_title_search_projection
            WHERE thread_id = ? AND projection_version = ?`,
        )
        .run(input.threadId, input.projectionVersion);
      const statement = this.database.prepare(
        `INSERT INTO thread_title_search_projection (
          owner_id, agent_id, thread_id, title_revision, classification,
          token_ref, projection_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const tokenRef of input.tokenRefs) {
        statement.run(
          input.ownerId,
          input.agentId,
          input.threadId,
          input.titleRevision,
          input.dataClassification,
          tokenRef,
          input.projectionVersion,
        );
      }
    });
    transaction.immediate();
  }

  private assertProjectionTokens(tokenRefs: readonly string[], projectionVersion: string): void {
    if (
      tokenRefs.length === 0 ||
      new Set(tokenRefs).size !== tokenRefs.length ||
      tokenRefs.some((ref) => !ref || /\s/.test(ref)) ||
      !projectionVersion
    ) {
      this.fail("PORT_INVALID_OPERATION", "Search projection requires opaque unique token refs");
    }
  }

  private search(query: ThreadSearchQuery): readonly ProductThread[] {
    this.assertLimit(query.limit);
    if (
      query.tokenRefs.length === 0 ||
      new Set(query.tokenRefs).size !== query.tokenRefs.length ||
      !query.projectionVersion ||
      (query.updatedAfter !== null && Number.isNaN(Date.parse(query.updatedAfter))) ||
      (query.updatedBefore !== null && Number.isNaN(Date.parse(query.updatedBefore)))
    ) {
      this.fail("PORT_INVALID_OPERATION", "Thread search requires unique opaque token refs");
    }
    const placeholders = query.tokenRefs.map(() => "?").join(", ");
    const ids = this.database
      .prepare(
        `SELECT thread_id AS threadId FROM (
          SELECT owner_id, agent_id, thread_id, token_ref, projection_version
            FROM thread_search_projection
          UNION ALL
          SELECT projection.owner_id, projection.agent_id, projection.thread_id,
            projection.token_ref, projection.projection_version
            FROM thread_title_search_projection AS projection
            JOIN threads AS current_thread
              ON current_thread.id = projection.thread_id
              AND current_thread.title_revision = projection.title_revision
        ) WHERE owner_id = ? AND agent_id = ? AND projection_version = ?
          AND token_ref IN (${placeholders})
          GROUP BY thread_id HAVING COUNT(DISTINCT token_ref) = ?
          ORDER BY thread_id LIMIT ?`,
      )
      .all(
        query.ownerId,
        query.agentId,
        query.projectionVersion,
        ...query.tokenRefs,
        query.tokenRefs.length,
        query.limit * 2,
      ) as Array<{ threadId: string }>;
    return ids
      .map(({ threadId }) => this.read(query.ownerId, query.agentId, threadId as ThreadId))
      .filter(
        (thread): thread is ProductThread =>
          thread !== undefined &&
          query.statuses.includes(thread.status) &&
          (query.updatedAfter === null || thread.updatedAt > query.updatedAfter) &&
          (query.updatedBefore === null || thread.updatedAt < query.updatedBefore) &&
          (query.jobStatuses.length === 0 ||
            this.hasJobStatus(query.ownerId, query.agentId, thread.id, query.jobStatuses)),
      )
      .slice(0, query.limit);
  }

  private hasJobStatus(
    ownerId: OwnerId,
    agentId: AgentId,
    threadId: ThreadId,
    statuses: ThreadSearchQuery["jobStatuses"],
  ): boolean {
    const placeholders = statuses.map(() => "?").join(", ");
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM scheduled_jobs WHERE owner_id = ? AND agent_id = ?
            AND thread_id = ? AND status IN (${placeholders}) LIMIT 1`,
        )
        .get(ownerId, agentId, threadId, ...statuses),
    );
  }

  private rebuildSearch(
    ownerId: OwnerId,
    agentId: AgentId,
    threadId: ThreadId,
    projectionVersion: string,
  ): number {
    this.assertDiskHeadroom();
    if (!projectionVersion) this.fail("PORT_INVALID_OPERATION", "Projection version is required");
    if (!this.read(ownerId, agentId, threadId)) {
      this.fail("PORT_INVALID_OPERATION", "Search rebuild Thread is outside scope");
    }
    const transaction = this.database.transaction(() => {
      const messages = this.database
        .prepare(
          `DELETE FROM thread_search_projection
            WHERE owner_id = ? AND agent_id = ? AND thread_id = ? AND projection_version != ?`,
        )
        .run(ownerId, agentId, threadId, projectionVersion).changes;
      const titles = this.database
        .prepare(
          `DELETE FROM thread_title_search_projection
            WHERE owner_id = ? AND agent_id = ? AND thread_id = ? AND projection_version != ?`,
        )
        .run(ownerId, agentId, threadId, projectionVersion).changes;
      return messages + titles;
    });
    return transaction.immediate();
  }
}
