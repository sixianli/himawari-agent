import {
  MCP_CONNECTION_CAPABILITIES,
  MCP_CONNECTION_ENTRIES,
  MCP_CONNECTION_NAME_MAXIMUM,
  MCP_CONNECTION_PUSH_POLICIES,
  MCP_CONNECTION_REPORTED_CLIENT_MAXIMUM,
  MCP_CONNECTION_STATUSES,
  MCP_USAGE_COUNTERS,
  type McpConnectionChange,
  type McpConnectionRecord,
  type McpConnectionScope,
  type McpConnectionUsageAdd,
  type McpConnectionUsageRow,
  mcpConnectionNameHasHiddenCharacter,
} from "@himawari-agent/application/mcp-connections";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Scope = McpConnectionScope;

export interface McpConnectionRow {
  readonly id: string;
  readonly ownerId: McpConnectionRecord["ownerId"];
  readonly agentId: McpConnectionRecord["agentId"];
  readonly name: string;
  readonly capabilities: string;
  readonly pushPolicy: McpConnectionRecord["pushPolicy"];
  readonly status: McpConnectionRecord["status"];
  readonly reportedClient: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly oauthClientId: string | null;
  readonly lastSeenAt: string | null;
}

export const MCP_CONNECTION_SELECT = `SELECT c.id AS id, c.owner_id AS ownerId,
  c.agent_id AS agentId, c.name AS name, c.capabilities AS capabilities,
  c.push_policy AS pushPolicy, c.status AS status,
  c.reported_client AS reportedClient, c.created_at AS createdAt, c.updated_at AS updatedAt,
  o.client_id AS oauthClientId, c.last_seen_at AS lastSeenAt
  FROM mcp_connections c LEFT JOIN mcp_oauth_clients o ON o.connection_id = c.id`;

export const MCP_CONNECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

export function validInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function validConnectionName(value: unknown): value is string {
  return (
    boundedText(value, MCP_CONNECTION_NAME_MAXIMUM) && !mcpConnectionNameHasHiddenCharacter(value)
  );
}

export function boundedText(value: unknown, maximum: number): value is string {
  if (typeof value !== "string" || value.trim() !== value) return false;
  const length = [...value].length;
  return length >= 1 && length <= maximum;
}

export function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function capabilitiesValid(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every((entry) => oneOf(MCP_CONNECTION_CAPABILITIES, entry))
  );
}

export function sortedCapabilities(value: readonly string[]): string {
  return JSON.stringify(
    MCP_CONNECTION_CAPABILITIES.filter((capability) => value.includes(capability)),
  );
}

export function mcpConnectionRecord(row: McpConnectionRow): McpConnectionRecord {
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
      case "mcpConnection.list":
        return this.list(payload as Scope);
      case "mcpConnection.read":
        return this.read(payload as Scope & { id: string });
      case "mcpConnection.change":
        return this.change(payload as McpConnectionChange);
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

  private list(scope: Scope): readonly McpConnectionRecord[] {
    const rows = this.database
      .prepare(
        `${MCP_CONNECTION_SELECT} WHERE c.owner_id = ? AND c.agent_id = ? ORDER BY c.created_at, c.id`,
      )
      .all(scope.ownerId, scope.agentId) as McpConnectionRow[];
    return Object.freeze(rows.map(mcpConnectionRecord));
  }

  private read(input: Scope & { id: string }): McpConnectionRecord | null {
    const row = this.database
      .prepare(`${MCP_CONNECTION_SELECT} WHERE c.owner_id = ? AND c.agent_id = ? AND c.id = ?`)
      .get(input.ownerId, input.agentId, input.id) as McpConnectionRow | undefined;
    return row ? mcpConnectionRecord(row) : null;
  }

  private change(input: McpConnectionChange): McpConnectionRecord | null {
    this.assertDiskHeadroom();
    if (
      !validInstant(input.updatedAt) ||
      (input.name !== undefined && !validConnectionName(input.name)) ||
      (input.capabilities !== undefined && !capabilitiesValid(input.capabilities)) ||
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
          `UPDATE mcp_connections SET name = ?, capabilities = ?,
            push_policy = ?, status = ?, updated_at = ?
           WHERE owner_id = ? AND agent_id = ? AND id = ?`,
        )
        .run(
          input.name ?? current.name,
          sortedCapabilities(input.capabilities ?? current.capabilities),
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

  private touch(
    input: Scope & { id: string; seenAt: string; reportedClient: string | null },
  ): void {
    if (
      !validInstant(input.seenAt) ||
      (input.reportedClient !== null &&
        !boundedText(input.reportedClient, MCP_CONNECTION_REPORTED_CLIENT_MAXIMUM))
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
      !boundedText(input.tool, 64) ||
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
