import type {
  DeliveryTimingSettings,
  DeliveryTimingSettingsScope,
  DeliveryTimingSettingsStorePort,
} from "@himawari-agent/application";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type WriteInput = Parameters<DeliveryTimingSettingsStorePort["write"]>[0];

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const EMPTY: DeliveryTimingSettings = Object.freeze({ overrides: Object.freeze({}), revision: 0 });

function validTime(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export class SqliteDeliveryTimingSettingsOperations {
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
      case "deliveryTimingSettings.read":
        return this.read(payload as DeliveryTimingSettingsScope);
      case "deliveryTimingSettings.write":
        return this.write(payload as WriteInput);
      default:
        return this.fail(
          "PORT_INVALID_OPERATION",
          `Unknown delivery timing settings operation ${operation}`,
        );
    }
  }

  private read(scope: DeliveryTimingSettingsScope): DeliveryTimingSettings {
    const row = this.database
      .prepare(
        `SELECT overrides, revision FROM delivery_timing_settings
          WHERE owner_id = ? AND agent_id = ?`,
      )
      .get(scope.ownerId, scope.agentId) as { overrides: string; revision: number } | undefined;
    if (!row) return EMPTY;
    const parsed: unknown = JSON.parse(row.overrides);
    const overrides =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, number>)
        : {};
    return Object.freeze({
      overrides: Object.freeze(overrides),
      revision: row.revision,
    });
  }

  private write(input: WriteInput): DeliveryTimingSettings {
    this.assertDiskHeadroom();
    if (
      !validTime(input.now) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !KEY_PATTERN.test(input.key) ||
      (input.value !== null && (!Number.isSafeInteger(input.value) || input.value < 0))
    )
      return this.fail("PORT_INVALID_OPERATION", "Delivery timing setting is invalid");
    return this.database.transaction(() => {
      const current = this.read(input);
      if (current.revision !== input.expectedRevision)
        return this.fail("PORT_CONFLICT", "Delivery timing settings changed on another device", {
          revision: String(current.revision),
        });
      const next: Record<string, number> = { ...current.overrides };
      if (input.value === null) delete next[input.key];
      else next[input.key] = input.value;
      this.database
        .prepare(
          `INSERT INTO delivery_timing_settings
            (owner_id, agent_id, overrides, revision, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (owner_id, agent_id) DO UPDATE SET overrides = excluded.overrides,
            revision = excluded.revision, updated_at = excluded.updated_at`,
        )
        .run(input.ownerId, input.agentId, JSON.stringify(next), current.revision + 1, input.now);
      return this.read(input);
    })();
  }
}
