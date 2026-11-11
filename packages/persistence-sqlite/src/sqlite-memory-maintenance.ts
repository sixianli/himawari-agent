import type Database from "better-sqlite3";

export interface MemoryReindexScope {
  readonly ownerId: string;
  readonly agentId: string;
}

export interface MemoryReindexPlan {
  readonly idleArchivesToRestore: number;
  readonly indexedMemories: number;
  readonly activeMemories: number;
  readonly embeddedEpisodes: number;
}

export interface MemoryReindexResult {
  readonly restored: number;
  readonly clearedIndexRows: number;
  readonly clearedEpisodeVectors: number;
}

const IDLE_ARCHIVES = `SELECT c.id AS changeId, c.memory_id AS memoryId, c.after_revision AS revision
  FROM memory_consolidation_changes c
  JOIN memory_records m ON m.id = c.memory_id
  WHERE c.owner_id = @ownerId AND c.agent_id = @agentId AND c.action = 'archive'
    AND c.undone_at IS NULL AND m.status = 'archived' AND m.revision = c.after_revision
  ORDER BY c.created_at, c.id`;

function count(database: Database.Database, sql: string, scope: MemoryReindexScope): number {
  return database.prepare(sql).pluck().get(scope) as number;
}

export function planMemoryReindex(
  database: Database.Database,
  scope: MemoryReindexScope,
): MemoryReindexPlan {
  return Object.freeze({
    idleArchivesToRestore: count(database, `SELECT COUNT(*) FROM (${IDLE_ARCHIVES})`, scope),
    indexedMemories: count(
      database,
      "SELECT COUNT(*) FROM memory_search_index WHERE owner_id = @ownerId AND agent_id = @agentId",
      scope,
    ),
    activeMemories: count(
      database,
      `SELECT COUNT(*) FROM memory_records
        WHERE owner_id = @ownerId AND agent_id = @agentId AND status = 'active'`,
      scope,
    ),
    embeddedEpisodes: count(
      database,
      `SELECT COUNT(*) FROM memory_episodes
        WHERE owner_id = @ownerId AND agent_id = @agentId AND embedding IS NOT NULL`,
      scope,
    ),
  });
}

export function restoreIdleArchivesAndClearMemoryIndex(
  database: Database.Database,
  input: MemoryReindexScope & { readonly now: string },
): MemoryReindexResult {
  const scope = { ownerId: input.ownerId, agentId: input.agentId };
  return database.transaction(() => {
    const archives = database.prepare(IDLE_ARCHIVES).all(scope) as {
      changeId: string;
      memoryId: string;
      revision: number;
    }[];
    const restore = database.prepare(
      `UPDATE memory_records SET status = 'active', revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND status = 'archived'`,
    );
    const undo = database.prepare(
      "UPDATE memory_consolidation_changes SET undone_at = ? WHERE id = ? AND undone_at IS NULL",
    );
    let restored = 0;
    for (const archive of archives) {
      if (restore.run(input.now, archive.memoryId, archive.revision).changes !== 1) continue;
      undo.run(input.now, archive.changeId);
      restored += 1;
    }
    const clearedIndexRows = database
      .prepare("DELETE FROM memory_search_index WHERE owner_id = ? AND agent_id = ?")
      .run(input.ownerId, input.agentId).changes;
    const clearedEpisodeVectors = database
      .prepare(
        `UPDATE memory_episodes SET embedding_model = NULL, embedding_dimensions = NULL, embedding = NULL
          WHERE owner_id = ? AND agent_id = ? AND embedding IS NOT NULL`,
      )
      .run(input.ownerId, input.agentId).changes;
    return Object.freeze({ restored, clearedIndexRows, clearedEpisodeVectors });
  })();
}
