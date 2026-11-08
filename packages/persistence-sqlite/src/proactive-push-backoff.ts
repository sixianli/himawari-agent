import type {
  ProactiveBackoffClass,
  ProactiveBackoffPreview,
  ProactiveBackoffSettings,
  ProactiveBackoffStage,
  ProactiveBackoffWrite,
} from "@himawari-agent/application";
import type Database from "better-sqlite3";

const EPOCH = "1970-01-01T00:00:00.000Z";

interface Scope {
  readonly ownerId: string;
  readonly agentId: string;
}

interface StateRow {
  readonly stage: number;
  readonly sinceAt: string;
  readonly lastPushAt: string | null;
  readonly stageChangedAt: string | null;
}

interface HistoryRow {
  readonly at: string;
  readonly rating: string | null;
  readonly openedAt: string | null;
}

function stageOf(value: number): ProactiveBackoffStage {
  return value >= 2 ? 2 : value === 1 ? 1 : 0;
}

export function countIgnoredPushes(
  database: Database.Database,
  scope: Scope,
  classKey: string,
  sinceAt: string,
  now: string,
  ignoreAfterMs: number,
): number {
  const rows = database
    .prepare(
      `SELECT COALESCE(feedback.first_sent_at, insight.updated_at) AS at,
         insight.owner_rating AS rating, feedback.opened_at AS openedAt
       FROM source_insights insight
       LEFT JOIN web_push_feedback feedback
         ON feedback.owner_id = insight.owner_id AND feedback.agent_id = insight.agent_id
         AND feedback.source_key = insight.push_source_key
       WHERE insight.owner_id = ? AND insight.agent_id = ? AND insight.push_class = ?
         AND insight.push_source_key IS NOT NULL
         AND COALESCE(feedback.first_sent_at, insight.updated_at) > ?
       ORDER BY at DESC, insight.id DESC`,
    )
    .all(scope.ownerId, scope.agentId, classKey, sinceAt) as HistoryRow[];
  const cutoff = Date.parse(now) - ignoreAfterMs;
  let ignored = 0;
  for (const row of rows) {
    if (row.rating === "unneeded") ignored += 1;
    else if (row.openedAt !== null) break;
    else if (Date.parse(row.at) <= cutoff) ignored += 1;
  }
  return ignored;
}

export function previewBackoff(
  database: Database.Database,
  scope: Scope,
  classKeys: readonly string[],
  settings: ProactiveBackoffSettings,
  now: string,
): readonly ProactiveBackoffPreview[] {
  const read = database.prepare(
    `SELECT stage, since_at AS sinceAt, last_push_at AS lastPushAt,
       stage_changed_at AS stageChangedAt FROM proactive_push_backoff
     WHERE owner_id = ? AND agent_id = ? AND class_key = ?`,
  );
  return classKeys.map((classKey): ProactiveBackoffPreview => {
    const row = read.get(scope.ownerId, scope.agentId, classKey) as StateRow | undefined;
    const stage = stageOf(row?.stage ?? 0);
    const sinceAt = row?.sinceAt ?? EPOCH;
    const ignored =
      stage >= 2
        ? 0
        : countIgnoredPushes(database, scope, classKey, sinceAt, now, settings.ignoreAfterMs);
    if (stage < 2 && ignored >= settings.threshold) {
      const next = stageOf(stage + 1);
      return {
        classKey,
        action: "suppress",
        stage: next,
        sinceAt: now,
        lastPushAt: now,
        stageChangedAt: now,
        ignoredCount: ignored,
        steppedUp: true,
      };
    }
    const base = {
      classKey,
      stage,
      sinceAt,
      stageChangedAt: row?.stageChangedAt ?? null,
      ignoredCount: ignored,
      steppedUp: false,
    };
    if (stage === 0) return { ...base, action: "allow", lastPushAt: row?.lastPushAt ?? null };
    if (stage === 2) return { ...base, action: "suppress", lastPushAt: row?.lastPushAt ?? null };
    const last = row?.lastPushAt ?? null;
    if (last === null || Date.parse(now) - Date.parse(last) >= settings.gapMs)
      return { ...base, action: "allow", lastPushAt: now };
    return { ...base, action: "suppress", lastPushAt: last };
  });
}

export function applyBackoffWrites(
  database: Database.Database,
  scope: Scope,
  decisionId: string,
  writes: readonly ProactiveBackoffWrite[],
  now: string,
): void {
  const upsert = database.prepare(
    `INSERT INTO proactive_push_backoff (
       owner_id, agent_id, class_key, stage, since_at, last_push_at, stage_changed_at,
       step_decision_id, ignored_count, restored_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT (owner_id, agent_id, class_key) DO UPDATE SET
       stage = excluded.stage, since_at = excluded.since_at, last_push_at = excluded.last_push_at,
       stage_changed_at = excluded.stage_changed_at,
       step_decision_id = CASE WHEN ? THEN excluded.step_decision_id ELSE step_decision_id END,
       ignored_count = CASE WHEN ? THEN excluded.ignored_count ELSE ignored_count END,
       updated_at = excluded.updated_at`,
  );
  for (const write of writes)
    upsert.run(
      scope.ownerId,
      scope.agentId,
      write.classKey,
      write.stage,
      write.sinceAt,
      write.lastPushAt,
      write.stageChangedAt,
      write.steppedUp ? decisionId : null,
      write.steppedUp ? write.ignoredCount : 0,
      now,
      write.steppedUp ? 1 : 0,
      write.steppedUp ? 1 : 0,
    );
}

export function listBackoff(
  database: Database.Database,
  scope: Scope,
): readonly ProactiveBackoffClass[] {
  return (
    database
      .prepare(
        `SELECT class_key AS classKey, stage, since_at AS sinceAt, last_push_at AS lastPushAt,
           stage_changed_at AS stageChangedAt, step_decision_id AS stepDecisionId,
           ignored_count AS ignoredCount, restored_at AS restoredAt, updated_at AS updatedAt
         FROM proactive_push_backoff
         WHERE owner_id = ? AND agent_id = ?
         ORDER BY class_key`,
      )
      .all(scope.ownerId, scope.agentId) as (Omit<ProactiveBackoffClass, "stage"> & {
      stage: number;
    })[]
  ).map((row) => ({ ...row, stage: stageOf(row.stage) }));
}

export function restoreBackoff(
  database: Database.Database,
  scope: Scope,
  classKey: string | null,
  now: string,
): number {
  return database
    .prepare(
      `UPDATE proactive_push_backoff SET stage = 0, since_at = ?, last_push_at = NULL,
         stage_changed_at = ?, restored_at = ?, updated_at = ?
       WHERE owner_id = ? AND agent_id = ? AND stage > 0 AND (? IS NULL OR class_key = ?)`,
    )
    .run(now, now, now, now, scope.ownerId, scope.agentId, classKey, classKey).changes;
}
