import { createHash } from "node:crypto";
import type {
  DerivedMemories,
  MemoryBasisChainNode,
  MemoryConsolidationChange,
  MemoryConsolidationRun,
  MemoryConsolidationWrite,
} from "@himawari-agent/application";
import type { AgentId, MemoryId, OwnerId } from "@himawari-agent/domain";
import type Database from "better-sqlite3";
import { insertLedgerRow } from "./sqlite-decision-ledger-operations.ts";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";
import { insertObservationEvent } from "./sqlite-observation-operations.ts";

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
export function consolidationLedgerId(changeId: string): string {
  return `ledger:${createHash("sha256").update(changeId).digest("hex").slice(0, 40)}`;
}

export const MEMORY_BASIS_CHAIN_MAX_DEPTH = 8;
const MEMORY_BASIS_CHAIN_MAX_NODES = 200;

export interface DerivedMemoryNode {
  readonly memoryId: MemoryId;
  readonly via: string;
  readonly depth: number;
}

export interface DerivedMemoryTree {
  readonly nodes: readonly DerivedMemoryNode[];
  readonly truncated: boolean;
}

export function derivedMemories(
  database: Database.Database,
  input: { readonly ownerId: string; readonly agentId: string; readonly memoryId: string },
  maxDepth: number,
): DerivedMemoryTree {
  const children = database.prepare(
    `SELECT DISTINCT change.memory_id AS memoryId
    FROM memory_consolidation_change_basis basis
    JOIN memory_consolidation_changes change ON change.id = basis.change_id
    WHERE basis.memory_id = ? AND change.owner_id = ? AND change.agent_id = ?
      AND change.action = 'reflect' AND change.undone_at IS NULL AND change.memory_id <> basis.memory_id
    ORDER BY change.memory_id`,
  );
  const seen = new Set<string>([input.memoryId]);
  const found: DerivedMemoryNode[] = [];
  let frontier: string[] = [input.memoryId];
  let truncated = false;
  for (let depth = 0; frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const memoryId of frontier)
      for (const { memoryId: child } of children.all(memoryId, input.ownerId, input.agentId) as {
        memoryId: MemoryId;
      }[]) {
        if (seen.has(child)) continue;
        if (depth >= maxDepth || found.length >= MEMORY_BASIS_CHAIN_MAX_NODES) {
          truncated = true;
          continue;
        }
        seen.add(child);
        found.push(Object.freeze({ memoryId: child, via: memoryId, depth: depth + 1 }));
        next.push(child);
      }
    frontier = next;
  }
  return Object.freeze({ nodes: Object.freeze(found), truncated });
}
const ACTIONS = new Set(["merge", "supersede", "archive", "reflect", "hold"]);

const runSelect = `SELECT id, owner_id AS ownerId, agent_id AS agentId, day,
  trigger_run_id AS triggerRunId, status, reviewed_through AS reviewedThrough,
  model_called AS modelCalled, change_count AS changeCount, error_code AS errorCode,
  started_at AS startedAt, finished_at AS finishedAt
  FROM memory_consolidation_runs`;

const changeSelect = `SELECT id, consolidation_id AS consolidationId, owner_id AS ownerId,
  agent_id AS agentId, memory_id AS memoryId, related_memory_id AS relatedMemoryId, action,
  before_revision AS beforeRevision, after_revision AS afterRevision,
  before_status AS beforeStatus, before_superseded_by AS beforeSupersededBy,
  before_valid_to AS beforeValidTo, created_at AS createdAt, undone_at AS undoneAt
  FROM memory_consolidation_changes`;

export function insertConsolidationWrite(
  database: Database.Database,
  write: MemoryConsolidationWrite,
  fail: SqliteApplicationFailure,
): void {
  const { change, basisMemoryIds, resultMemoryIds } = write;
  if (!ACTIONS.has(change.action) || change.undoneAt !== null)
    fail("PORT_INVALID_OPERATION", "Memory consolidation change is invalid");
  const basis = [...new Set(basisMemoryIds)];
  if (basis.length === 0 || basis.length > 200)
    fail("PORT_INVALID_OPERATION", "Memory consolidation basis is invalid");
  const run = database
    .prepare(
      "SELECT status FROM memory_consolidation_runs WHERE id = ? AND owner_id = ? AND agent_id = ?",
    )
    .get(change.consolidationId, change.ownerId, change.agentId) as { status: string } | undefined;
  if (run?.status !== "running") fail("PORT_CONFLICT", "Memory consolidation run is not running");
  const owned = database
    .prepare(
      `SELECT COUNT(*) AS count FROM memory_records
       WHERE owner_id = ? AND agent_id = ? AND id IN (${basis.map(() => "?").join(", ")})`,
    )
    .get(change.ownerId, change.agentId, ...basis) as { count: number };
  if (owned.count !== basis.length)
    fail("PORT_INVALID_OPERATION", "Memory consolidation basis is not in the change scope");
  database
    .prepare(
      `INSERT INTO memory_consolidation_changes (
        id, consolidation_id, owner_id, agent_id, memory_id, related_memory_id, action,
        before_revision, after_revision, before_status, before_superseded_by,
        before_valid_to, created_at, undone_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      change.id,
      change.consolidationId,
      change.ownerId,
      change.agentId,
      change.memoryId,
      change.relatedMemoryId,
      change.action,
      change.beforeRevision,
      change.afterRevision,
      change.beforeStatus,
      change.beforeSupersededBy,
      change.beforeValidTo,
      change.createdAt,
    );
  const insertBasis = database.prepare(
    "INSERT INTO memory_consolidation_change_basis (change_id, position, memory_id) VALUES (?, ?, ?)",
  );
  for (const [position, memoryId] of basis.entries())
    insertBasis.run(change.id, position, memoryId);
  database
    .prepare("UPDATE memory_consolidation_runs SET change_count = change_count + 1 WHERE id = ?")
    .run(change.consolidationId);
  insertLedgerRow(database, {
    id: consolidationLedgerId(change.id),
    ownerId: change.ownerId,
    agentId: change.agentId,
    kind: "consolidation",
    decidedAt: change.createdAt,
    outcome: change.action,
    reasonCode: `consolidation_${change.action}`,
    subjectRef: change.memoryId,
    inputs: {
      memoryIds: basis,
      ruleIds: [],
      batchId: change.consolidationId,
      resultMemoryIds: [...new Set(resultMemoryIds)],
    },
    reasonRef: null,
    contentRef: null,
    costMicros: 0,
    durationMs: 0,
  });
}

type RunRow = Omit<MemoryConsolidationRun, "modelCalled"> & {
  readonly modelCalled: number;
};

export class SqliteMemoryConsolidationOperations {
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
      case "memoryConsolidation.begin":
        return this.begin((payload as { run: MemoryConsolidationRun }).run);
      case "memoryConsolidation.lastCompleted":
        return this.lastCompleted(payload as { ownerId: OwnerId; agentId: AgentId });
      case "memoryConsolidation.finish":
        return this.finish(
          payload as {
            id: string;
            status: "completed" | "failed";
            reviewedThrough: string | null;
            modelCalled: boolean;
            errorCode: string | null;
            finishedAt: string;
          },
        );
      case "memoryConsolidation.listChanges":
        return this.listChanges(payload as { ownerId: OwnerId; agentId: AgentId; limit: number });
      case "memoryConsolidation.listHeldPairs":
        return this.listHeldPairs(
          payload as { ownerId: OwnerId; agentId: AgentId; openOnly?: boolean },
        );
      case "memoryConsolidation.readChange":
        return this.readChange((payload as { id: string }).id);
      case "memoryConsolidation.readBasis":
        return this.readBasis((payload as { changeId: string }).changeId);
      case "memoryConsolidation.readBasisChain":
        return this.readBasisChain(
          payload as { ownerId: OwnerId; agentId: AgentId; memoryId: MemoryId },
        );
      case "memoryConsolidation.readDerived":
        return this.readDerived(
          payload as { ownerId: OwnerId; agentId: AgentId; memoryId: MemoryId },
        );
      case "memoryConsolidation.markUndone":
        return this.markUndone(payload as { id: string; undoneAt: string });
      default:
        return this.fail(
          "PORT_INVALID_OPERATION",
          `Unknown Memory consolidation operation ${operation}`,
        );
    }
  }

  private run(row: RunRow | undefined): MemoryConsolidationRun | undefined {
    return row ? Object.freeze({ ...row, modelCalled: row.modelCalled === 1 }) : undefined;
  }

  private begin(run: MemoryConsolidationRun): boolean {
    this.assertDiskHeadroom();
    if (!DAY.test(run.day) || run.status !== "running")
      this.fail("PORT_INVALID_OPERATION", "Memory consolidation run is invalid");
    const result = this.database
      .prepare(
        `INSERT INTO memory_consolidation_runs (
          id, owner_id, agent_id, day, trigger_run_id, status, reviewed_through, model_called,
          change_count, error_code, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, 'running', NULL, 0, 0, NULL, ?, NULL)
        ON CONFLICT (owner_id, agent_id, day) DO NOTHING`,
      )
      .run(run.id, run.ownerId, run.agentId, run.day, run.triggerRunId, run.startedAt);
    return result.changes === 1;
  }

  private lastCompleted(input: {
    ownerId: OwnerId;
    agentId: AgentId;
  }): MemoryConsolidationRun | undefined {
    return this.run(
      this.database
        .prepare(
          `${runSelect} WHERE owner_id = ? AND agent_id = ? AND status = 'completed'
          ORDER BY day DESC LIMIT 1`,
        )
        .get(input.ownerId, input.agentId) as RunRow | undefined,
    );
  }

  private finish(input: {
    id: string;
    status: "completed" | "failed";
    reviewedThrough: string | null;
    modelCalled: boolean;
    errorCode: string | null;
    finishedAt: string;
  }): void {
    const current = this.run(
      this.database.prepare(`${runSelect} WHERE id = ?`).get(input.id) as RunRow | undefined,
    );
    if (!current || current.status !== "running")
      this.fail("PORT_CONFLICT", "Memory consolidation run is not running");
    if (input.status === "failed" && current?.changeCount === 0) {
      this.database.transaction(() => {
        insertObservationEvent(this.database, {
          ownerId: current.ownerId,
          agentId: current.agentId,
          kind: "consolidation_failed",
          occurredAt: input.finishedAt,
          detail: {
            runId: input.id,
            day: current.day,
            errorCode: input.errorCode,
          },
        });
        this.database.prepare("DELETE FROM memory_consolidation_runs WHERE id = ?").run(input.id);
      })();
      return;
    }
    this.database
      .prepare(
        `UPDATE memory_consolidation_runs SET status = ?, reviewed_through = ?,
          model_called = ?, error_code = ?, finished_at = ?
        WHERE id = ?`,
      )
      .run(
        input.status,
        input.reviewedThrough,
        input.modelCalled ? 1 : 0,
        input.errorCode,
        input.finishedAt,
        input.id,
      );
  }

  private listChanges(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    limit: number;
  }): readonly MemoryConsolidationChange[] {
    if (!Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > 500)
      this.fail("PORT_INVALID_OPERATION", "Memory consolidation change limit is invalid");
    return Object.freeze(
      (
        this.database
          .prepare(
            `${changeSelect} WHERE owner_id = ? AND agent_id = ?
            ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(input.ownerId, input.agentId, input.limit) as MemoryConsolidationChange[]
      ).map((row) => Object.freeze(row)),
    );
  }

  private listHeldPairs(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    openOnly?: boolean;
  }): readonly (readonly [MemoryId, MemoryId])[] {
    return Object.freeze(
      (
        this.database
          .prepare(
            `SELECT memory_id AS memoryId, related_memory_id AS relatedMemoryId
            FROM memory_consolidation_changes
            WHERE owner_id = ? AND agent_id = ? AND action = 'hold' AND related_memory_id IS NOT NULL
            ${input.openOnly === true ? "AND undone_at IS NULL ORDER BY created_at DESC, id DESC" : "ORDER BY id"}`,
          )
          .all(input.ownerId, input.agentId) as {
          memoryId: MemoryId;
          relatedMemoryId: MemoryId;
        }[]
      ).map(({ memoryId, relatedMemoryId }) => Object.freeze([memoryId, relatedMemoryId] as const)),
    );
  }

  private readChange(id: string): MemoryConsolidationChange | undefined {
    const row = this.database.prepare(`${changeSelect} WHERE id = ?`).get(id) as
      | MemoryConsolidationChange
      | undefined;
    return row ? Object.freeze(row) : undefined;
  }

  private readBasis(changeId: string): readonly MemoryId[] {
    return Object.freeze(
      (
        this.database
          .prepare(
            "SELECT memory_id AS memoryId FROM memory_consolidation_change_basis WHERE change_id = ? ORDER BY position",
          )
          .all(changeId) as { memoryId: MemoryId }[]
      ).map(({ memoryId }) => memoryId),
    );
  }

  private readBasisChain(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    memoryId: MemoryId;
  }): MemoryBasisChainNode {
    const seen = new Set<string>();
    let nodes = 0;
    const walk = (memoryId: MemoryId, depth: number): MemoryBasisChainNode => {
      const changes = this.database
        .prepare(
          `${changeSelect} WHERE owner_id = ? AND agent_id = ? AND memory_id = ?
          AND undone_at IS NULL ORDER BY created_at DESC, id DESC`,
        )
        .all(input.ownerId, input.agentId, memoryId) as MemoryConsolidationChange[];
      const change = changes[0];
      if (!change)
        return Object.freeze({
          memoryId,
          change: null,
          ledgerId: null,
          basis: Object.freeze([]),
          repeated: false,
          truncated: false,
        });
      const parents = [
        ...new Set(changes.flatMap(({ id }) => this.readBasis(id)).filter((id) => id !== memoryId)),
      ];
      if (seen.has(memoryId))
        return Object.freeze({
          memoryId,
          change: Object.freeze(change),
          ledgerId: consolidationLedgerId(change.id),
          basis: Object.freeze([]),
          repeated: true,
          truncated: false,
        });
      seen.add(memoryId);
      nodes += 1;
      const truncated =
        (depth >= MEMORY_BASIS_CHAIN_MAX_DEPTH ||
          nodes + parents.length > MEMORY_BASIS_CHAIN_MAX_NODES) &&
        parents.length > 0;
      return Object.freeze({
        memoryId,
        change: Object.freeze(change),
        ledgerId: consolidationLedgerId(change.id),
        basis: Object.freeze(truncated ? [] : parents.map((id) => walk(id, depth + 1))),
        repeated: false,
        truncated,
      });
    };
    return walk(input.memoryId, 0);
  }

  private readDerived(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    memoryId: MemoryId;
  }): DerivedMemories {
    const tree = derivedMemories(this.database, input, MEMORY_BASIS_CHAIN_MAX_DEPTH);
    return Object.freeze({
      memoryIds: Object.freeze(tree.nodes.map(({ memoryId }) => memoryId)),
      truncated: tree.truncated,
    });
  }

  private markUndone(input: { id: string; undoneAt: string }): boolean {
    return this.database.transaction(() => {
      const changed =
        this.database
          .prepare(
            "UPDATE memory_consolidation_changes SET undone_at = ? WHERE id = ? AND undone_at IS NULL",
          )
          .run(input.undoneAt, input.id).changes === 1;
      if (changed)
        this.database
          .prepare(
            `UPDATE decision_ledger SET owner_rating = 'unneeded', rated_at = ?
             WHERE id = ? AND kind = 'consolidation'`,
          )
          .run(input.undoneAt, consolidationLedgerId(input.id));
      return changed;
    })();
  }
}
