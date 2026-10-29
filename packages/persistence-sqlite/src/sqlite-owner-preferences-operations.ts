import type {
  OwnerPreferenceAccent,
  OwnerPreferenceLocale,
  OwnerPreferences,
  OwnerPreferencesScope,
  OwnerPreferencesStorePort,
} from "@himawari-agent/application";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type WriteInput = Parameters<OwnerPreferencesStorePort["write"]>[0];

const LOCALES: readonly OwnerPreferenceLocale[] = ["zh-CN", "en", "ja"];
const ACCENTS: readonly OwnerPreferenceAccent[] = [
  "violet",
  "blue",
  "teal",
  "amber",
  "rose",
  "graphite",
];
const NAME_LIMIT = 40;

const EMPTY: OwnerPreferences = Object.freeze({
  name: null,
  locale: null,
  accent: null,
  updatedAt: null,
});

function validTime(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.includes(value as T);
}

export class SqliteOwnerPreferencesOperations {
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
      case "ownerPreferences.read":
        return this.read(payload as OwnerPreferencesScope);
      case "ownerPreferences.write":
        return this.write(payload as WriteInput);
      default:
        return this.fail(
          "PORT_INVALID_OPERATION",
          `Unknown owner preference operation ${operation}`,
        );
    }
  }

  private read(scope: OwnerPreferencesScope): OwnerPreferences {
    const row = this.database
      .prepare(
        `SELECT name, locale, accent, updated_at AS updatedAt FROM owner_preferences
          WHERE owner_id = ? AND agent_id = ?`,
      )
      .get(scope.ownerId, scope.agentId) as OwnerPreferences | undefined;
    return row ? Object.freeze({ ...row }) : EMPTY;
  }

  private write(input: WriteInput): OwnerPreferences {
    this.assertDiskHeadroom();
    const name = input.name === null ? null : input.name.trim();
    if (
      !validTime(input.now) ||
      (name !== null && (name.length < 1 || name.length > NAME_LIMIT)) ||
      (input.locale !== null && !includes(LOCALES, input.locale)) ||
      (input.accent !== null && !includes(ACCENTS, input.accent))
    )
      return this.fail("PORT_INVALID_OPERATION", "Owner preferences are invalid");
    this.database
      .prepare(
        `INSERT INTO owner_preferences (owner_id, agent_id, name, locale, accent, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (owner_id, agent_id) DO UPDATE SET name = excluded.name,
          locale = excluded.locale, accent = excluded.accent, updated_at = excluded.updated_at`,
      )
      .run(input.ownerId, input.agentId, name, input.locale, input.accent, input.now);
    return this.read(input);
  }
}
