import {
  MODEL_USAGE_PURPOSES,
  type ModelUsageObservation,
  type ModelUsageStorePort,
} from "@himawari-agent/application/model-usage";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type RecordInput = Parameters<ModelUsageStorePort["record"]>[0];

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validTime(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function valid(input: ModelUsageObservation): boolean {
  return (
    (MODEL_USAGE_PURPOSES as readonly string[]).includes(input.purpose) &&
    (input.source === "model-port" || input.source === "agent-stream") &&
    input.invocationId.trim().length > 0 &&
    input.provider.trim().length > 0 &&
    input.model.trim().length > 0 &&
    count(input.inputTokens) &&
    count(input.outputTokens) &&
    count(input.cacheReadTokens) &&
    count(input.cacheWriteTokens) &&
    input.cacheReadTokens <= input.inputTokens &&
    input.cacheWriteTokens <= input.inputTokens - input.cacheReadTokens &&
    (input.cacheReported || (input.cacheReadTokens === 0 && input.cacheWriteTokens === 0)) &&
    validTime(input.occurredAt)
  );
}

export class SqliteModelUsageOperations {
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
      case "modelUsage.record":
        return this.record(payload as RecordInput);
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown model usage operation ${operation}`);
    }
  }

  private record(input: RecordInput): void {
    if (!valid(input)) {
      this.fail("PORT_INVALID_OPERATION", "Model usage observation is invalid");
    }
    this.assertDiskHeadroom();
    this.database
      .prepare(
        `INSERT OR IGNORE INTO model_usage_observations (
          owner_id, agent_id, run_id, invocation_id, purpose, source, provider, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_reported,
          occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.ownerId,
        input.agentId,
        input.runId,
        input.invocationId,
        input.purpose,
        input.source,
        input.provider,
        input.model,
        input.inputTokens,
        input.outputTokens,
        input.cacheReadTokens,
        input.cacheWriteTokens,
        input.cacheReported ? 1 : 0,
        input.occurredAt,
      );
  }
}
