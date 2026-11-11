import {
  REAL_EVAL_ITEM_KINDS,
  REAL_EVAL_RETIRE_REASONS,
  REAL_EVAL_RUN_OUTCOMES,
  REAL_EVAL_TRIGGERS,
  type RealEvalQuestionRecord,
  type RealEvalRunRecord,
  type RealEvalStorePort,
} from "@himawari-agent/application/real-eval";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Scope = { readonly ownerId: string; readonly agentId: string };
type AddInput = Parameters<RealEvalStorePort["addQuestion"]>[0];
type RetireInput = Parameters<RealEvalStorePort["retireQuestion"]>[0];
type RecordRunInput = Parameters<RealEvalStorePort["recordRun"]>[0];
type ListRunsInput = Parameters<RealEvalStorePort["listRuns"]>[0];

const MAXIMUM_RUNS = 520;

function instant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

interface QuestionRow {
  id: string;
  memoryId: string;
  memoryRevision: number;
  kind: string;
  questionRef: string;
  questionModel: string;
  promptSha256: string;
  createdAt: string;
  retiredAt: string | null;
  retiredReason: string | null;
}

interface RunRow {
  id: string;
  startedAt: string;
  finishedAt: string;
  outcome: string;
  trigger: string;
  model: string;
  costMicros: number;
  summary: string;
}

export class SqliteRealEvalOperations {
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
      case "realEval.listQuestions":
        return this.listQuestions(payload as Scope);
      case "realEval.addQuestion":
        return this.addQuestion(payload as AddInput);
      case "realEval.retireQuestion":
        return this.retireQuestion(payload as RetireInput);
      case "realEval.recordRun":
        return this.recordRun(payload as RecordRunInput);
      case "realEval.listRuns":
        return this.listRuns(payload as ListRunsInput);
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown real eval operation ${operation}`);
    }
  }

  private listQuestions(input: Scope): readonly RealEvalQuestionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT id, memory_id AS memoryId, memory_revision AS memoryRevision, kind,
          question_ref AS questionRef, question_model AS questionModel,
          prompt_sha256 AS promptSha256, created_at AS createdAt, retired_at AS retiredAt,
          retired_reason AS retiredReason
        FROM real_eval_questions WHERE owner_id = ? AND agent_id = ?
        ORDER BY created_at, id`,
      )
      .all(input.ownerId, input.agentId) as QuestionRow[];
    return rows.map((row) =>
      Object.freeze({
        ...row,
        kind: row.kind as RealEvalQuestionRecord["kind"],
        retiredReason: row.retiredReason as RealEvalQuestionRecord["retiredReason"],
      }),
    );
  }

  private addQuestion(input: AddInput): boolean {
    const question = input.question;
    if (
      !member(REAL_EVAL_ITEM_KINDS, question.kind) ||
      !instant(question.createdAt) ||
      !Number.isSafeInteger(question.memoryRevision) ||
      question.memoryRevision < 0 ||
      !/^[0-9a-f]{64}$/u.test(question.promptSha256)
    )
      return this.fail("PORT_INVALID_OPERATION", "Real eval question is invalid") as never;
    this.assertDiskHeadroom();
    const owned = this.database
      .prepare("SELECT 1 FROM memory_records WHERE id = ? AND owner_id = ? AND agent_id = ?")
      .get(question.memoryId, input.ownerId, input.agentId);
    if (!owned) return false;
    return (
      Number(
        this.database
          .prepare(
            `INSERT INTO real_eval_questions (
              id, owner_id, agent_id, memory_id, memory_revision, kind, question_ref,
              question_model, prompt_sha256, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (memory_id, memory_revision, kind) DO NOTHING`,
          )
          .run(
            question.id,
            input.ownerId,
            input.agentId,
            question.memoryId,
            question.memoryRevision,
            question.kind,
            question.questionRef,
            question.questionModel,
            question.promptSha256,
            question.createdAt,
          ).changes,
      ) > 0
    );
  }

  private retireQuestion(input: RetireInput): void {
    if (!member(REAL_EVAL_RETIRE_REASONS, input.reason) || !instant(input.at)) {
      this.fail("PORT_INVALID_OPERATION", "Real eval retirement is invalid");
      return;
    }
    this.database
      .prepare(
        `UPDATE real_eval_questions SET retired_at = ?, retired_reason = ?
        WHERE id = ? AND owner_id = ? AND agent_id = ? AND retired_at IS NULL`,
      )
      .run(input.at, input.reason, input.id, input.ownerId, input.agentId);
  }

  private recordRun(input: RecordRunInput): void {
    const run = input.run;
    if (
      !member(REAL_EVAL_RUN_OUTCOMES, run.outcome) ||
      !member(REAL_EVAL_TRIGGERS, run.trigger) ||
      !instant(run.startedAt) ||
      !instant(run.finishedAt) ||
      !Number.isSafeInteger(run.costMicros) ||
      run.costMicros < 0
    ) {
      this.fail("PORT_INVALID_OPERATION", "Real eval run is invalid");
      return;
    }
    this.assertDiskHeadroom();
    this.database
      .prepare(
        `INSERT INTO real_eval_runs (
          id, owner_id, agent_id, started_at, finished_at, outcome, trigger, model,
          cost_micros, summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        input.ownerId,
        input.agentId,
        run.startedAt,
        run.finishedAt,
        run.outcome,
        run.trigger,
        run.model,
        run.costMicros,
        JSON.stringify(run.summary),
      );
  }

  private listRuns(input: ListRunsInput): readonly RealEvalRunRecord[] {
    const limit = Math.min(MAXIMUM_RUNS, Math.max(1, Math.floor(input.limit)));
    const rows = this.database
      .prepare(
        `SELECT id, started_at AS startedAt, finished_at AS finishedAt, outcome, trigger, model,
          cost_micros AS costMicros, summary
        FROM real_eval_runs WHERE owner_id = ? AND agent_id = ?
        ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(input.ownerId, input.agentId, limit) as RunRow[];
    return rows.map((row) =>
      Object.freeze({
        ...row,
        outcome: row.outcome as RealEvalRunRecord["outcome"],
        trigger: row.trigger as RealEvalRunRecord["trigger"],
        summary: JSON.parse(row.summary) as Record<string, unknown>,
      }),
    );
  }
}
