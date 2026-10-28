import {
  THREAD_ARTIFACT_KINDS,
  THREAD_ARTIFACT_LIST_LIMIT,
  THREAD_ARTIFACT_SOURCES,
  type ThreadArtifact,
  type ThreadArtifactListQuery,
  type ThreadArtifactPage,
  type ThreadArtifactRegistration,
  type ThreadArtifactScope,
} from "@himawari-agent/application/thread-artifacts";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

const columns = `id, thread_id AS threadId, run_id AS runId, tool_call_id AS toolCallId, source, path,
  kind, media_type AS mediaType, size_bytes AS sizeBytes, sha256, version, copy_ref AS copyRef,
  overlapped, created_at AS createdAt`;

type Row = Omit<ThreadArtifact, "overlapped"> & { readonly overlapped: number };

function fromRow(row: Row): ThreadArtifact {
  return Object.freeze({ ...row, overlapped: row.overlapped === 1 });
}

function encodeCursor(artifact: ThreadArtifact): string {
  return Buffer.from(JSON.stringify([artifact.createdAt, artifact.id])).toString("base64url");
}

function decodeCursor(cursor: string): readonly [string, string] | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    return Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "string"
      ? [value[0], value[1]]
      : null;
  } catch {
    return null;
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export class SqliteThreadArtifactOperations {
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
      case "threadArtifact.register":
        return this.register(
          payload as ThreadArtifactScope & { readonly artifact: ThreadArtifactRegistration },
        );
      case "threadArtifact.latest":
        return this.latest(
          payload as ThreadArtifactScope & { readonly threadId: string; readonly path: string },
        );
      case "threadArtifact.get":
        return this.get(payload as ThreadArtifactScope & { readonly id: string });
      case "threadArtifact.versions":
        return this.versions(
          payload as ThreadArtifactScope & { readonly threadId: string; readonly path: string },
        );
      case "threadArtifact.list":
        return this.list(payload as ThreadArtifactListQuery);
      default:
        return this.fail("PORT_INVALID_OPERATION", "Unknown thread artifact operation");
    }
  }

  private register(
    input: ThreadArtifactScope & { readonly artifact: ThreadArtifactRegistration },
  ): { readonly artifact: ThreadArtifact; readonly created: boolean } {
    const artifact = input.artifact;
    if (
      !THREAD_ARTIFACT_SOURCES.includes(artifact.source) ||
      !THREAD_ARTIFACT_KINDS.includes(artifact.kind) ||
      (artifact.sha256 !== null && !/^[0-9a-f]{64}$/.test(artifact.sha256)) ||
      !Number.isSafeInteger(artifact.sizeBytes) ||
      artifact.sizeBytes < 0 ||
      artifact.path.length === 0 ||
      artifact.path.length > 1024
    )
      return this.fail("PORT_INVALID_OPERATION", "Thread artifact registration is invalid");
    this.assertDiskHeadroom();
    return this.database
      .transaction(() => {
        const replayed = this.database
          .prepare(
            `SELECT ${columns} FROM thread_artifacts
             WHERE owner_id = ? AND agent_id = ? AND run_id = ? AND tool_call_id = ? AND path = ?`,
          )
          .get(input.ownerId, input.agentId, artifact.runId, artifact.toolCallId, artifact.path) as
          | Row
          | undefined;
        if (replayed) return { artifact: fromRow(replayed), created: false };
        const latest = this.latest({
          ownerId: input.ownerId,
          agentId: input.agentId,
          threadId: artifact.threadId,
          path: artifact.path,
        });
        if (latest && artifact.sha256 !== null && latest.sha256 === artifact.sha256)
          return { artifact: latest, created: false };
        const version = (latest?.version ?? 0) + 1;
        this.database
          .prepare(
            `INSERT INTO thread_artifacts (
               id, owner_id, agent_id, thread_id, run_id, tool_call_id, source, path, kind,
               media_type, size_bytes, sha256, version, copy_ref, overlapped, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            artifact.id,
            input.ownerId,
            input.agentId,
            artifact.threadId,
            artifact.runId,
            artifact.toolCallId,
            artifact.source,
            artifact.path,
            artifact.kind,
            artifact.mediaType,
            artifact.sizeBytes,
            artifact.sha256,
            version,
            artifact.copyRef,
            artifact.overlapped ? 1 : 0,
            artifact.createdAt,
          );
        return { artifact: Object.freeze({ ...artifact, version }), created: true };
      })
      .immediate();
  }

  private latest(
    input: ThreadArtifactScope & { readonly threadId: string; readonly path: string },
  ): ThreadArtifact | null {
    const row = this.database
      .prepare(
        `SELECT ${columns} FROM thread_artifacts
         WHERE owner_id = ? AND agent_id = ? AND thread_id = ? AND path = ?
         ORDER BY version DESC LIMIT 1`,
      )
      .get(input.ownerId, input.agentId, input.threadId, input.path) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  private get(input: ThreadArtifactScope & { readonly id: string }): ThreadArtifact | null {
    const row = this.database
      .prepare(
        `SELECT ${columns} FROM thread_artifacts WHERE owner_id = ? AND agent_id = ? AND id = ?`,
      )
      .get(input.ownerId, input.agentId, input.id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  private versions(
    input: ThreadArtifactScope & { readonly threadId: string; readonly path: string },
  ): readonly ThreadArtifact[] {
    return (
      this.database
        .prepare(
          `SELECT ${columns} FROM thread_artifacts
           WHERE owner_id = ? AND agent_id = ? AND thread_id = ? AND path = ?
           ORDER BY version`,
        )
        .all(input.ownerId, input.agentId, input.threadId, input.path) as Row[]
    ).map(fromRow);
  }

  private list(input: ThreadArtifactListQuery): ThreadArtifactPage {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > THREAD_ARTIFACT_LIST_LIMIT ||
      (input.kind !== null && !THREAD_ARTIFACT_KINDS.includes(input.kind))
    )
      return this.fail("PORT_INVALID_OPERATION", "Thread artifact list query is invalid");
    const cursor = input.before === null ? null : decodeCursor(input.before);
    if (input.before !== null && cursor === null)
      return this.fail("PORT_INVALID_OPERATION", "Thread artifact cursor is invalid");
    const conditions = ["owner_id = ?", "agent_id = ?"];
    const parameters: (string | number)[] = [input.ownerId, input.agentId];
    if (input.threadId !== null) {
      conditions.push("thread_id = ?");
      parameters.push(input.threadId);
    }
    if (input.kind !== null) {
      conditions.push("kind = ?");
      parameters.push(input.kind);
    }
    const search = input.search?.trim();
    if (search) {
      conditions.push("path LIKE ? ESCAPE '\\'");
      parameters.push(`%${escapeLike(search)}%`);
    }
    if (cursor) {
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      parameters.push(cursor[0], cursor[0], cursor[1]);
    }
    const rows = this.database
      .prepare(
        `SELECT ${columns} FROM thread_artifacts WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...parameters, input.limit + 1) as Row[];
    const items = rows.slice(0, input.limit).map(fromRow);
    const last = items.at(-1);
    return Object.freeze({
      items,
      nextCursor: rows.length > input.limit && last ? encodeCursor(last) : null,
    });
  }
}
