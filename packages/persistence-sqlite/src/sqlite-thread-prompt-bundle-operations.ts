import {
  THREAD_PROMPT_BUNDLE_ORIGINS,
  type ThreadPromptBundleCreateInput,
  type ThreadPromptBundleCreateResult,
  type ThreadPromptBundleIdentity,
  type ThreadPromptBundleRebuildInput,
  type ThreadPromptBundleRecord,
  type ThreadPromptBundleScope,
} from "@himawari-agent/application/thread-prompt-bundles";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";
import { parseRunPayloadArtifactPayload } from "./sqlite-run-payload-artifact-operations.ts";

const columns = `owner_id AS ownerId, agent_id AS agentId, thread_id AS threadId, generation, origin,
  identity_json AS identityJson, system_prompt_ref AS systemPromptRef, tools_ref AS toolsRef,
  system_prompt_sha256 AS systemPromptSha256, tools_sha256 AS toolsSha256,
  classification AS dataClassification, created_by_run_id AS createdByRunId, created_at AS createdAt,
  superseded_at AS supersededAt, rebuild_reason AS rebuildReason, rebuild_operator AS rebuildOperator`;

type Row = Omit<ThreadPromptBundleRecord, "identity"> & { readonly identityJson: string };

export const THREAD_PROMPT_REBUILD_ERROR_CODES = Object.freeze({
  NOT_FOUND: "THREAD_PROMPT_BUNDLE_NOT_FOUND",
  INVALID: "THREAD_PROMPT_REBUILD_INVALID",
} as const);

function fromRow(row: Row): ThreadPromptBundleRecord {
  const { identityJson, ...rest } = row;
  return Object.freeze({
    ...rest,
    identity: Object.freeze(JSON.parse(identityJson) as ThreadPromptBundleIdentity),
  });
}

function latestRow(
  database: Database.Database,
  scope: ThreadPromptBundleScope,
): ThreadPromptBundleRecord | undefined {
  const row = database
    .prepare(
      `SELECT ${columns} FROM thread_prompt_bundles
       WHERE owner_id = ? AND agent_id = ? AND thread_id = ?
       ORDER BY generation DESC LIMIT 1`,
    )
    .get(scope.ownerId, scope.agentId, scope.threadId) as Row | undefined;
  return row ? fromRow(row) : undefined;
}

function generationRow(
  database: Database.Database,
  input: ThreadPromptBundleScope & { readonly generation: number },
): ThreadPromptBundleRecord | undefined {
  const row = database
    .prepare(
      `SELECT ${columns} FROM thread_prompt_bundles
       WHERE owner_id = ? AND agent_id = ? AND thread_id = ? AND generation = ?`,
    )
    .get(input.ownerId, input.agentId, input.threadId, input.generation) as Row | undefined;
  return row ? fromRow(row) : undefined;
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

export function requestThreadPromptRebuild(
  database: Database.Database,
  input: ThreadPromptBundleRebuildInput,
): ThreadPromptBundleRecord {
  if (
    !validText(input.reason, 500) ||
    !validText(input.operator, 128) ||
    !Number.isFinite(Date.parse(input.now))
  )
    throw new Error(THREAD_PROMPT_REBUILD_ERROR_CODES.INVALID);
  return database
    .transaction(() => {
      const latest = latestRow(database, input);
      if (!latest) throw new Error(THREAD_PROMPT_REBUILD_ERROR_CODES.NOT_FOUND);
      database
        .prepare(
          `UPDATE thread_prompt_bundles
           SET superseded_at = coalesce(superseded_at, ?), rebuild_reason = ?, rebuild_operator = ?
           WHERE owner_id = ? AND agent_id = ? AND thread_id = ? AND generation = ?`,
        )
        .run(
          input.now,
          input.reason,
          input.operator,
          input.ownerId,
          input.agentId,
          input.threadId,
          latest.generation,
        );
      return generationRow(database, {
        ...input,
        generation: latest.generation,
      }) as ThreadPromptBundleRecord;
    })
    .immediate();
}

export class SqliteThreadPromptBundleOperations {
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
      case "threadPromptBundle.latest":
        return latestRow(this.database, payload as ThreadPromptBundleScope);
      case "threadPromptBundle.get":
        return generationRow(
          this.database,
          payload as ThreadPromptBundleScope & { readonly generation: number },
        );
      case "threadPromptBundle.create":
        return this.create(payload as ThreadPromptBundleCreateInput);
      case "threadPromptBundle.requestRebuild":
        try {
          return requestThreadPromptRebuild(
            this.database,
            payload as ThreadPromptBundleRebuildInput,
          );
        } catch (error) {
          return this.fail(
            error instanceof Error && error.message === THREAD_PROMPT_REBUILD_ERROR_CODES.NOT_FOUND
              ? "PORT_NOT_FOUND"
              : "PORT_INVALID_OPERATION",
            "Thread prompt rebuild was refused",
          );
        }
      default:
        return this.fail("PORT_INVALID_OPERATION", "Unknown thread prompt bundle operation");
    }
  }

  private create(input: ThreadPromptBundleCreateInput): ThreadPromptBundleCreateResult {
    if (
      !THREAD_PROMPT_BUNDLE_ORIGINS.includes(input.origin) ||
      !/^[0-9a-f]{64}$/.test(input.systemPromptSha256) ||
      !/^[0-9a-f]{64}$/.test(input.toolsSha256) ||
      !Array.isArray(input.identity.toolNames) ||
      input.identity.toolNames.some((name) => typeof name !== "string" || name.length === 0) ||
      !validText(input.identity.modelRef, 256) ||
      !validText(input.identity.thinkingLevel, 64) ||
      (input.identity.answerLocale !== null && !validText(input.identity.answerLocale, 256)) ||
      (input.expectedLatestGeneration !== null &&
        (!Number.isSafeInteger(input.expectedLatestGeneration) ||
          input.expectedLatestGeneration < 1))
    )
      return this.fail("PORT_INVALID_OPERATION", "Thread prompt bundle is invalid");
    const systemPrompt = parseRunPayloadArtifactPayload(input.systemPrompt);
    const tools = parseRunPayloadArtifactPayload(input.tools);
    if (
      systemPrompt.dataClassification !== input.dataClassification ||
      tools.dataClassification !== input.dataClassification
    )
      return this.fail("PORT_INVALID_OPERATION", "Thread prompt bundle classification differs");
    this.assertDiskHeadroom();
    return this.database
      .transaction((): ThreadPromptBundleCreateResult => {
        const thread = this.database
          .prepare("SELECT 1 FROM threads WHERE id = ? AND owner_id = ? AND agent_id = ?")
          .get(input.threadId, input.ownerId, input.agentId);
        if (!thread) return this.fail("PORT_NOT_FOUND", "Thread was not found");
        const latest = latestRow(this.database, input);
        if ((latest?.generation ?? null) !== input.expectedLatestGeneration) {
          if (latest) return { created: false, record: latest };
          return this.fail("PORT_CONFLICT", "Thread prompt bundle generation is missing");
        }
        const generation = (latest?.generation ?? 0) + 1;
        if (latest)
          this.database
            .prepare(
              `UPDATE thread_prompt_bundles SET superseded_at = coalesce(superseded_at, ?)
               WHERE owner_id = ? AND agent_id = ? AND thread_id = ? AND generation = ?`,
            )
            .run(input.now, input.ownerId, input.agentId, input.threadId, latest.generation);
        this.insertPayload(input, systemPrompt);
        this.insertPayload(input, tools);
        this.database
          .prepare(
            `INSERT INTO thread_prompt_bundles (
               owner_id, agent_id, thread_id, generation, origin, identity_json,
               system_prompt_ref, tools_ref, system_prompt_sha256, tools_sha256, classification,
               created_by_run_id, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.ownerId,
            input.agentId,
            input.threadId,
            generation,
            input.origin,
            JSON.stringify({
              toolNames: [...input.identity.toolNames],
              modelRef: input.identity.modelRef,
              thinkingLevel: input.identity.thinkingLevel,
              answerLocale: input.identity.answerLocale,
            }),
            systemPrompt.ref,
            tools.ref,
            input.systemPromptSha256,
            input.toolsSha256,
            input.dataClassification,
            input.runId,
            input.now,
          );
        return {
          created: true,
          record: generationRow(this.database, {
            ...input,
            generation,
          }) as ThreadPromptBundleRecord,
        };
      })
      .immediate();
  }

  private insertPayload(
    scope: ThreadPromptBundleScope,
    payload: ReturnType<typeof parseRunPayloadArtifactPayload>,
  ): void {
    if (this.database.prepare("SELECT 1 FROM payloads WHERE ref = ?").get(payload.ref))
      this.fail("PORT_DUPLICATE", "Thread prompt bundle payload already exists");
    this.database
      .prepare(
        `INSERT INTO payloads (
          ref, owner_id, agent_id, classification, storage_kind, ciphertext,
          ciphertext_path, content_digest, encryption_algorithm, key_ref,
          lifecycle_state, created_at, content_type, encryption_metadata_json
        ) VALUES (?, ?, ?, ?, 'sqlite_blob', ?, NULL, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        payload.ref,
        scope.ownerId,
        scope.agentId,
        payload.dataClassification,
        payload.ciphertext,
        payload.contentDigest,
        payload.encryption.algorithm,
        payload.encryption.keyRef,
        payload.createdAt,
        payload.contentType,
        JSON.stringify(payload.encryption),
      );
  }
}
