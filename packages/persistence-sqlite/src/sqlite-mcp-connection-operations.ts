import {
  MCP_CONNECTION_CAPABILITIES,
  MCP_CONNECTION_ENTRIES,
  MCP_CONNECTION_MAXIMUM,
  MCP_CONNECTION_NAME_MAXIMUM,
  MCP_CONNECTION_PUSH_POLICIES,
  MCP_CONNECTION_READ_CEILINGS,
  MCP_CONNECTION_REPORTED_CLIENT_MAXIMUM,
  MCP_CONNECTION_STATUSES,
  MCP_USAGE_COUNTERS,
  type McpConnectionChange,
  type McpConnectionCreate,
  type McpConnectionRecord,
  type McpConnectionScope,
  type McpConnectionUsageAdd,
  type McpConnectionUsageRow,
  mcpConnectionNameHasHiddenCharacter,
} from "@himawari-agent/application/mcp-connections";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Scope = McpConnectionScope;

interface Row {
  readonly id: string;
  readonly ownerId: McpConnectionRecord["ownerId"];
  readonly agentId: McpConnectionRecord["agentId"];
  readonly name: string;
  readonly capabilities: string;
  readonly readCeiling: McpConnectionRecord["readCeiling"];
  readonly pushPolicy: McpConnectionRecord["pushPolicy"];
  readonly status: McpConnectionRecord["status"];
  readonly reportedClient: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly secretRotatedAt: string | null;
  readonly lastSeenAt: string | null;
}

const select = `SELECT id, owner_id AS ownerId, agent_id AS agentId, name, capabilities,
  read_ceiling AS readCeiling, push_policy AS pushPolicy, status,
  reported_client AS reportedClient, created_at AS createdAt, updated_at AS updatedAt,
  secret_rotated_at AS secretRotatedAt, last_seen_at AS lastSeenAt
  FROM mcp_connections`;

const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

function instant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function name(value: unknown): value is string {
  return text(value, MCP_CONNECTION_NAME_MAXIMUM) && !mcpConnectionNameHasHiddenCharacter(value);
}

function text(value: unknown, maximum: number): value is string {
  if (typeof value !== "string" || value.trim() !== value) return false;
  const length = [...value].length;
  return length >= 1 && length <= maximum;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function capabilitiesValid(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every((entry) => oneOf(MCP_CONNECTION_CAPABILITIES, entry))
  );
}

function sortedCapabilities(value: readonly string[]): string {
  return JSON.stringify(
    MCP_CONNECTION_CAPABILITIES.filter((capability) => value.includes(capability)),
  );
}

function record(row: Row): McpConnectionRecord {
  return Object.freeze({
    ...row,
    capabilities: Object.freeze(
      JSON.parse(row.capabilities) as McpConnectionRecord["capabilities"],
    ),
  });
}

export class SqliteMcpConnectionOperations {
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
      case "mcpConnection.create":
        return this.create(payload as McpConnectionCreate);
      case "mcpConnection.list":
        return this.list(payload as Scope);
      case "mcpConnection.read":
        return this.read(payload as Scope & { id: string });
      case "mcpConnection.findBySecret":
        return this.findBySecret(payload as Scope & { secretSha256: string });
      case "mcpConnection.change":
        return this.change(payload as McpConnectionChange);
      case "mcpConnection.rotateSecret":
        return this.rotateSecret(
          payload as Scope & { id: string; secretSha256: string; rotatedAt: string },
        );
      case "mcpConnection.touch":
        return this.touch(
          payload as Scope & { id: string; seenAt: string; reportedClient: string | null },
        );
      case "mcpConnection.addUsage":
        return this.addUsage(payload as McpConnectionUsageAdd);
      case "mcpConnection.usage":
        return this.usage(payload as Scope & { fromDay: string; toDay: string });
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown MCP connection operation ${operation}`);
    }
  }

  private invalid(): never {
    return this.fail("PORT_INVALID_OPERATION", "MCP_CONNECTION_INPUT_INVALID");
  }

  private create(input: McpConnectionCreate): McpConnectionRecord {
    this.assertDiskHeadroom();
    if (
      typeof input.id !== "string" ||
      !CONNECTION_ID.test(input.id) ||
      !name(input.name) ||
      typeof input.secretSha256 !== "string" ||
      !DIGEST.test(input.secretSha256) ||
      !capabilitiesValid(input.capabilities) ||
      !oneOf(MCP_CONNECTION_READ_CEILINGS, input.readCeiling) ||
      !oneOf(MCP_CONNECTION_PUSH_POLICIES, input.pushPolicy) ||
      !instant(input.createdAt)
    )
      return this.invalid();
    return this.database.transaction(() => {
      const count = this.database
        .prepare(
          "SELECT COUNT(*) FROM mcp_connections WHERE owner_id = ? AND agent_id = ? AND status <> 'revoked'",
        )
        .pluck()
        .get(input.ownerId, input.agentId) as number;
      if (count >= MCP_CONNECTION_MAXIMUM)
        return this.fail("PORT_CONFLICT", "MCP_CONNECTION_LIMIT_REACHED");
      this.database
        .prepare(
          `INSERT INTO mcp_connections (
            id, owner_id, agent_id, name, secret_sha256, capabilities, read_ceiling, push_policy,
            status, reported_client, created_at, updated_at, secret_rotated_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, NULL, NULL)`,
        )
        .run(
          input.id,
          input.ownerId,
          input.agentId,
          input.name,
          input.secretSha256,
          sortedCapabilities(input.capabilities),
          input.readCeiling,
          input.pushPolicy,
          input.createdAt,
          input.createdAt,
        );
      return this.read({
        ownerId: input.ownerId,
        agentId: input.agentId,
        id: input.id,
      }) as McpConnectionRecord;
    })();
  }

  private list(scope: Scope): readonly McpConnectionRecord[] {
    const rows = this.database
      .prepare(`${select} WHERE owner_id = ? AND agent_id = ? ORDER BY created_at, id`)
      .all(scope.ownerId, scope.agentId) as Row[];
    return Object.freeze(rows.map(record));
  }

  private read(input: Scope & { id: string }): McpConnectionRecord | null {
    const row = this.database
      .prepare(`${select} WHERE owner_id = ? AND agent_id = ? AND id = ?`)
      .get(input.ownerId, input.agentId, input.id) as Row | undefined;
    return row ? record(row) : null;
  }

  private findBySecret(input: Scope & { secretSha256: string }): McpConnectionRecord | null {
    if (typeof input.secretSha256 !== "string" || !DIGEST.test(input.secretSha256)) return null;
    const row = this.database
      .prepare(`${select} WHERE owner_id = ? AND agent_id = ? AND secret_sha256 = ?`)
      .get(input.ownerId, input.agentId, input.secretSha256) as Row | undefined;
    return row ? record(row) : null;
  }

  private change(input: McpConnectionChange): McpConnectionRecord | null {
    this.assertDiskHeadroom();
    if (
      !instant(input.updatedAt) ||
      (input.name !== undefined && !name(input.name)) ||
      (input.capabilities !== undefined && !capabilitiesValid(input.capabilities)) ||
      (input.readCeiling !== undefined &&
        !oneOf(MCP_CONNECTION_READ_CEILINGS, input.readCeiling)) ||
      (input.pushPolicy !== undefined && !oneOf(MCP_CONNECTION_PUSH_POLICIES, input.pushPolicy)) ||
      (input.status !== undefined && !oneOf(MCP_CONNECTION_STATUSES, input.status))
    )
      return this.invalid();
    return this.database.transaction(() => {
      const current = this.read(input);
      if (!current) return null;
      if (current.status === "revoked") return this.fail("PORT_CONFLICT", "MCP_CONNECTION_REVOKED");
      this.database
        .prepare(
          `UPDATE mcp_connections SET name = ?, capabilities = ?, read_ceiling = ?,
            push_policy = ?, status = ?, updated_at = ?
           WHERE owner_id = ? AND agent_id = ? AND id = ?`,
        )
        .run(
          input.name ?? current.name,
          sortedCapabilities(input.capabilities ?? current.capabilities),
          input.readCeiling ?? current.readCeiling,
          input.pushPolicy ?? current.pushPolicy,
          input.status ?? current.status,
          input.updatedAt,
          input.ownerId,
          input.agentId,
          input.id,
        );
      return this.read(input);
    })();
  }

  private rotateSecret(
    input: Scope & { id: string; secretSha256: string; rotatedAt: string },
  ): McpConnectionRecord | null {
    this.assertDiskHeadroom();
    if (
      typeof input.secretSha256 !== "string" ||
      !DIGEST.test(input.secretSha256) ||
      !instant(input.rotatedAt)
    )
      return this.invalid();
    return this.database.transaction(() => {
      const current = this.read(input);
      if (!current) return null;
      if (current.status === "revoked") return this.fail("PORT_CONFLICT", "MCP_CONNECTION_REVOKED");
      this.database
        .prepare(
          `UPDATE mcp_connections SET secret_sha256 = ?, secret_rotated_at = ?, updated_at = ?
           WHERE owner_id = ? AND agent_id = ? AND id = ?`,
        )
        .run(
          input.secretSha256,
          input.rotatedAt,
          input.rotatedAt,
          input.ownerId,
          input.agentId,
          input.id,
        );
      return this.read(input);
    })();
  }

  private touch(
    input: Scope & { id: string; seenAt: string; reportedClient: string | null },
  ): void {
    if (
      !instant(input.seenAt) ||
      (input.reportedClient !== null &&
        !text(input.reportedClient, MCP_CONNECTION_REPORTED_CLIENT_MAXIMUM))
    )
      this.invalid();
    this.database
      .prepare(
        `UPDATE mcp_connections
           SET last_seen_at = CASE
                 WHEN last_seen_at IS NULL OR last_seen_at < ? THEN ? ELSE last_seen_at END,
               reported_client = COALESCE(?, reported_client)
         WHERE owner_id = ? AND agent_id = ? AND id = ?`,
      )
      .run(
        input.seenAt,
        input.seenAt,
        input.reportedClient,
        input.ownerId,
        input.agentId,
        input.id,
      );
  }

  private addUsage(input: McpConnectionUsageAdd): void {
    const counts = Object.entries(input.counts ?? {});
    if (
      typeof input.connectionId !== "string" ||
      typeof input.day !== "string" ||
      !DAY.test(input.day) ||
      !text(input.tool, 64) ||
      !oneOf(MCP_CONNECTION_ENTRIES, input.entry) ||
      typeof input.auto !== "boolean" ||
      counts.length === 0 ||
      !counts.every(
        ([counter, value]) =>
          oneOf(MCP_USAGE_COUNTERS, counter) && Number.isSafeInteger(value) && value > 0,
      )
    )
      this.invalid();
    const statement = this.database.prepare(
      `INSERT INTO mcp_connection_usage_daily (
         owner_id, agent_id, connection_id, day, tool, entry, auto, counter, value
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_id, agent_id, connection_id, day, tool, entry, auto, counter)
       DO UPDATE SET value = value + excluded.value`,
    );
    this.database.transaction(() => {
      for (const [counter, value] of [...counts].sort(([left], [right]) =>
        left.localeCompare(right),
      ))
        statement.run(
          input.ownerId,
          input.agentId,
          input.connectionId,
          input.day,
          input.tool,
          input.entry,
          input.auto ? 1 : 0,
          counter,
          value,
        );
    })();
  }

  private usage(
    input: Scope & { fromDay: string; toDay: string },
  ): readonly McpConnectionUsageRow[] {
    if (!DAY.test(input.fromDay) || !DAY.test(input.toDay)) return this.invalid();
    const rows = this.database
      .prepare(
        `SELECT connection_id AS connectionId, day, tool, entry, auto, counter, value
           FROM mcp_connection_usage_daily
          WHERE owner_id = ? AND agent_id = ? AND day >= ? AND day <= ?
          ORDER BY connection_id, day, tool, entry, auto, counter`,
      )
      .all(input.ownerId, input.agentId, input.fromDay, input.toDay) as (Omit<
      McpConnectionUsageRow,
      "auto"
    > & { auto: number })[];
    return Object.freeze(rows.map((row) => Object.freeze({ ...row, auto: row.auto === 1 })));
  }
}
