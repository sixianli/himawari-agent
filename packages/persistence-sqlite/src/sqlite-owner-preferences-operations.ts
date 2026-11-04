import type {
  OwnerPreferenceAccent,
  OwnerPreferenceLocale,
  OwnerPreferences,
  OwnerPreferenceTheme,
  OwnerPreferenceThinkingLevel,
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
const THEMES: readonly OwnerPreferenceTheme[] = ["light", "dark", "system"];
const THINKING_LEVELS: readonly OwnerPreferenceThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const NAME_LIMIT = 40;
const MODEL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

const EMPTY: OwnerPreferences = Object.freeze({
  name: null,
  locale: null,
  accent: null,
  theme: null,
  modelRef: null,
  thinkingLevel: null,
  revision: 0,
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
        `SELECT name, locale, accent, theme, model_ref AS modelRef,
          thinking_level AS thinkingLevel, revision, updated_at AS updatedAt
          FROM owner_preferences WHERE owner_id = ? AND agent_id = ?`,
      )
      .get(scope.ownerId, scope.agentId) as OwnerPreferences | undefined;
    return row ? Object.freeze({ ...row }) : EMPTY;
  }

  private write(input: WriteInput): OwnerPreferences {
    this.assertDiskHeadroom();
    const name = input.name === null ? null : input.name.trim();
    if (
      !validTime(input.now) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      (name !== null && (name.length < 1 || name.length > NAME_LIMIT)) ||
      (input.locale !== null && !includes(LOCALES, input.locale)) ||
      (input.accent !== null && !includes(ACCENTS, input.accent)) ||
      (input.theme !== null && !includes(THEMES, input.theme)) ||
      (input.modelRef !== null && !MODEL_REF_PATTERN.test(input.modelRef)) ||
      (input.thinkingLevel !== null && !includes(THINKING_LEVELS, input.thinkingLevel))
    )
      return this.fail("PORT_INVALID_OPERATION", "Owner preferences are invalid");
    return this.database.transaction(() => {
      const current = this.read(input);
      if (current.revision !== input.expectedRevision)
        return this.fail("PORT_CONFLICT", "Owner preferences changed on another device", {
          revision: String(current.revision),
        });
      this.database
        .prepare(
          `INSERT INTO owner_preferences (owner_id, agent_id, name, locale, accent, theme,
            model_ref, thinking_level, revision, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (owner_id, agent_id) DO UPDATE SET name = excluded.name,
            locale = excluded.locale, accent = excluded.accent, theme = excluded.theme,
            model_ref = excluded.model_ref, thinking_level = excluded.thinking_level,
            revision = excluded.revision, updated_at = excluded.updated_at`,
        )
        .run(
          input.ownerId,
          input.agentId,
          name,
          input.locale,
          input.accent,
          input.theme,
          input.modelRef,
          input.thinkingLevel,
          current.revision + 1,
          input.now,
        );
      return this.read(input);
    })();
  }
}
