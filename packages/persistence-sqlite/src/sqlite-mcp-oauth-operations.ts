import { createHash, randomBytes } from "node:crypto";
import {
  MCP_CONNECTION_MAXIMUM,
  MCP_CONNECTION_PUSH_POLICIES,
  MCP_CONNECTION_READ_CEILINGS,
  type McpConnectionRecord,
  type McpConnectionScope,
} from "@himawari-agent/application/mcp-connections";
import {
  MCP_OAUTH_CLIENT_ID_MAXIMUM,
  MCP_OAUTH_CLIENT_NAME_MAXIMUM,
  MCP_OAUTH_REDIRECT_URI_MAXIMUM,
  MCP_OAUTH_REDIRECT_URIS_MAXIMUM,
  MCP_OAUTH_REGISTRATIONS,
  MCP_OAUTH_UNBOUND_CLIENT_KEEP_MS,
  MCP_OAUTH_UNBOUND_CLIENT_MAXIMUM,
  type McpOAuthAccess,
  type McpOAuthClientRecord,
  type McpOAuthClientRegister,
  type McpOAuthGrantBind,
  type McpOAuthRotation,
  type McpOAuthStorePort,
  type McpOAuthTokenPair,
  type McpOAuthTokenRecord,
} from "@himawari-agent/application/mcp-oauth";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";
import {
  boundedText,
  MCP_CONNECTION_ID_PATTERN,
  MCP_CONNECTION_SELECT,
  type McpConnectionRow,
  mcpConnectionRecord,
  oneOf,
  sortedCapabilities,
  validConnectionName,
  validInstant,
} from "./sqlite-mcp-connection-operations.ts";

type Scope = McpConnectionScope;
type Rotate = Parameters<McpOAuthStorePort["rotateRefresh"]>[0];

const DIGEST = /^[0-9a-f]{64}$/u;
const FAMILY = /^[A-Za-z0-9_-]{16,64}$/u;
const SCOPE_NAME = /^[a-z][a-z0-9:_.-]{0,63}$/u;

interface ClientRow {
  readonly clientId: string;
  readonly ownerId: McpOAuthClientRecord["ownerId"];
  readonly agentId: McpOAuthClientRecord["agentId"];
  readonly registration: McpOAuthClientRecord["registration"];
  readonly clientName: string;
  readonly redirectUris: string;
  readonly connectionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface TokenRow {
  readonly tokenSha256: string;
  readonly ownerId: McpOAuthTokenRecord["ownerId"];
  readonly agentId: McpOAuthTokenRecord["agentId"];
  readonly kind: McpOAuthTokenRecord["kind"];
  readonly connectionId: string;
  readonly clientId: string;
  readonly familyId: string;
  readonly scopes: string;
  readonly resource: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly usedAt: string | null;
  readonly revokedAt: string | null;
}

const clientSelect = `SELECT client_id AS clientId, owner_id AS ownerId, agent_id AS agentId,
  registration, client_name AS clientName, redirect_uris AS redirectUris,
  connection_id AS connectionId, created_at AS createdAt, updated_at AS updatedAt
  FROM mcp_oauth_clients`;

const tokenSelect = `SELECT token_sha256 AS tokenSha256, owner_id AS ownerId, agent_id AS agentId,
  kind, connection_id AS connectionId, client_id AS clientId, family_id AS familyId, scopes,
  resource, created_at AS createdAt, expires_at AS expiresAt, used_at AS usedAt,
  revoked_at AS revokedAt
  FROM mcp_oauth_tokens`;

function clientRecord(row: ClientRow): McpOAuthClientRecord {
  return Object.freeze({
    ...row,
    redirectUris: Object.freeze(JSON.parse(row.redirectUris) as string[]),
  });
}

function tokenRecord(row: TokenRow): McpOAuthTokenRecord {
  return Object.freeze({
    ...row,
    scopes: Object.freeze(JSON.parse(row.scopes) as string[]),
  });
}

function clientIdValid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MCP_OAUTH_CLIENT_ID_MAXIMUM &&
    !/[\s\p{Cc}]/u.test(value)
  );
}

function redirectUrisValid(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= MCP_OAUTH_REDIRECT_URIS_MAXIMUM &&
    new Set(value).size === value.length &&
    value.every(
      (entry) =>
        typeof entry === "string" &&
        entry.length >= 1 &&
        entry.length <= MCP_OAUTH_REDIRECT_URI_MAXIMUM &&
        URL.canParse(entry),
    )
  );
}

function scopesValid(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    new Set(value).size === value.length &&
    value.every((entry) => typeof entry === "string" && SCOPE_NAME.test(entry))
  );
}

function issueValid(value: {
  readonly tokenSha256: unknown;
  readonly expiresAt: unknown;
}): boolean {
  return (
    typeof value.tokenSha256 === "string" &&
    DIGEST.test(value.tokenSha256) &&
    validInstant(value.expiresAt)
  );
}

export class SqliteMcpOAuthOperations {
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
      case "mcpOAuth.registerClient":
        return this.registerClient(payload as McpOAuthClientRegister);
      case "mcpOAuth.readClient":
        return this.readClient(payload as Scope & { clientId: string });
      case "mcpOAuth.bindGrant":
        return this.bindGrant(payload as McpOAuthGrantBind);
      case "mcpOAuth.issueTokens":
        return this.issueTokens(payload as McpOAuthTokenPair);
      case "mcpOAuth.findAccess":
        return this.findAccess(payload as Scope & { tokenSha256: string; now: string });
      case "mcpOAuth.rotateRefresh":
        return this.rotateRefresh(payload as Rotate);
      case "mcpOAuth.revokeToken":
        return this.revokeToken(
          payload as Scope & { tokenSha256: string; clientId: string; now: string },
        );
      case "mcpOAuth.pruneExpired":
        return this.pruneExpired(payload as Scope & { now: string });
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown MCP OAuth operation ${operation}`);
    }
  }

  private invalid(): never {
    return this.fail("PORT_INVALID_OPERATION", "MCP_OAUTH_INPUT_INVALID");
  }

  private registerClient(input: McpOAuthClientRegister): McpOAuthClientRecord {
    this.assertDiskHeadroom();
    if (
      !clientIdValid(input.clientId) ||
      !boundedText(input.clientName, MCP_OAUTH_CLIENT_NAME_MAXIMUM) ||
      !redirectUrisValid(input.redirectUris) ||
      !validInstant(input.createdAt)
    )
      return this.invalid();
    return this.database.transaction(() => {
      const cutoff = new Date(
        Date.parse(input.createdAt) - MCP_OAUTH_UNBOUND_CLIENT_KEEP_MS,
      ).toISOString();
      this.database
        .prepare(
          `DELETE FROM mcp_oauth_clients
            WHERE owner_id = ? AND agent_id = ? AND connection_id IS NULL
              AND registration = 'dynamic' AND created_at < ?`,
        )
        .run(input.ownerId, input.agentId, cutoff);
      const unbound = this.database
        .prepare(
          `SELECT COUNT(*) FROM mcp_oauth_clients
            WHERE owner_id = ? AND agent_id = ? AND connection_id IS NULL`,
        )
        .pluck()
        .get(input.ownerId, input.agentId) as number;
      if (unbound >= MCP_OAUTH_UNBOUND_CLIENT_MAXIMUM)
        return this.fail("PORT_CONFLICT", "MCP_OAUTH_REGISTRATIONS_FULL");
      this.database
        .prepare(
          `INSERT INTO mcp_oauth_clients (
             client_id, owner_id, agent_id, registration, client_name, redirect_uris,
             connection_id, created_at, updated_at
           ) VALUES (?, ?, ?, 'dynamic', ?, ?, NULL, ?, ?)`,
        )
        .run(
          input.clientId,
          input.ownerId,
          input.agentId,
          input.clientName,
          JSON.stringify(input.redirectUris),
          input.createdAt,
          input.createdAt,
        );
      return this.readClient(input) as McpOAuthClientRecord;
    })();
  }

  private readClient(input: Scope & { clientId: string }): McpOAuthClientRecord | null {
    if (!clientIdValid(input.clientId)) return null;
    const row = this.database
      .prepare(`${clientSelect} WHERE owner_id = ? AND agent_id = ? AND client_id = ?`)
      .get(input.ownerId, input.agentId, input.clientId) as ClientRow | undefined;
    return row ? clientRecord(row) : null;
  }

  private readConnection(scope: Scope, id: string): McpConnectionRecord | null {
    const row = this.database
      .prepare(`${MCP_CONNECTION_SELECT} WHERE c.owner_id = ? AND c.agent_id = ? AND c.id = ?`)
      .get(scope.ownerId, scope.agentId, id) as McpConnectionRow | undefined;
    return row ? mcpConnectionRecord(row) : null;
  }

  private bindGrant(input: McpOAuthGrantBind): McpConnectionRecord {
    this.assertDiskHeadroom();
    const connection = input.newConnection;
    if (
      !clientIdValid(input.clientId) ||
      !oneOf(MCP_OAUTH_REGISTRATIONS, input.registration) ||
      !boundedText(input.clientName, MCP_OAUTH_CLIENT_NAME_MAXIMUM) ||
      !redirectUrisValid(input.redirectUris) ||
      !validInstant(input.now) ||
      typeof connection?.id !== "string" ||
      !MCP_CONNECTION_ID_PATTERN.test(connection.id) ||
      !validConnectionName(connection.name) ||
      !oneOf(MCP_CONNECTION_READ_CEILINGS, connection.readCeiling) ||
      !oneOf(MCP_CONNECTION_PUSH_POLICIES, connection.pushPolicy)
    )
      return this.invalid();
    return this.database.transaction(() => {
      const existing = this.readClient(input);
      if (existing && existing.registration !== input.registration)
        return this.fail("PORT_CONFLICT", "MCP_OAUTH_CLIENT_REGISTRATION_CHANGED");
      const bound =
        existing?.connectionId === null || existing === null
          ? null
          : this.readConnection(input, existing.connectionId);
      if (bound && bound.status !== "revoked") {
        this.database
          .prepare(
            `UPDATE mcp_oauth_clients SET client_name = ?, redirect_uris = ?, updated_at = ?
              WHERE owner_id = ? AND agent_id = ? AND client_id = ?`,
          )
          .run(
            input.clientName,
            JSON.stringify(input.redirectUris),
            input.now,
            input.ownerId,
            input.agentId,
            input.clientId,
          );
        return bound;
      }
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
          connection.id,
          input.ownerId,
          input.agentId,
          connection.name,
          createHash("sha256").update(randomBytes(32)).digest("hex"),
          sortedCapabilities(["mcp"]),
          connection.readCeiling,
          connection.pushPolicy,
          input.now,
          input.now,
        );
      if (existing)
        this.database
          .prepare(
            `UPDATE mcp_oauth_clients
                SET client_name = ?, redirect_uris = ?, connection_id = ?, updated_at = ?
              WHERE owner_id = ? AND agent_id = ? AND client_id = ?`,
          )
          .run(
            input.clientName,
            JSON.stringify(input.redirectUris),
            connection.id,
            input.now,
            input.ownerId,
            input.agentId,
            input.clientId,
          );
      else
        this.database
          .prepare(
            `INSERT INTO mcp_oauth_clients (
               client_id, owner_id, agent_id, registration, client_name, redirect_uris,
               connection_id, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.clientId,
            input.ownerId,
            input.agentId,
            input.registration,
            input.clientName,
            JSON.stringify(input.redirectUris),
            connection.id,
            input.now,
            input.now,
          );
      return this.readConnection(input, connection.id) as McpConnectionRecord;
    })();
  }

  private insertPair(input: McpOAuthTokenPair): void {
    const statement = this.database.prepare(
      `INSERT INTO mcp_oauth_tokens (
         token_sha256, owner_id, agent_id, kind, connection_id, client_id, family_id, scopes,
         resource, created_at, expires_at, used_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    );
    for (const [kind, issue] of [
      ["access", input.access],
      ["refresh", input.refresh],
    ] as const)
      statement.run(
        issue.tokenSha256,
        input.ownerId,
        input.agentId,
        kind,
        input.connectionId,
        input.clientId,
        input.familyId,
        JSON.stringify(input.scopes),
        input.resource,
        input.now,
        issue.expiresAt,
      );
  }

  private pairValid(input: McpOAuthTokenPair): boolean {
    return (
      typeof input.connectionId === "string" &&
      MCP_CONNECTION_ID_PATTERN.test(input.connectionId) &&
      clientIdValid(input.clientId) &&
      typeof input.familyId === "string" &&
      FAMILY.test(input.familyId) &&
      scopesValid(input.scopes) &&
      typeof input.resource === "string" &&
      URL.canParse(input.resource) &&
      validInstant(input.now) &&
      issueValid(input.access) &&
      issueValid(input.refresh) &&
      input.access.tokenSha256 !== input.refresh.tokenSha256
    );
  }

  private issueTokens(input: McpOAuthTokenPair): void {
    this.assertDiskHeadroom();
    if (!this.pairValid(input)) this.invalid();
    this.database.transaction(() => {
      const connection = this.readConnection(input, input.connectionId);
      if (!connection || connection.status === "revoked")
        this.fail("PORT_CONFLICT", "MCP_CONNECTION_REVOKED");
      this.insertPair(input);
    })();
  }

  private readToken(scope: Scope, tokenSha256: string): McpOAuthTokenRecord | null {
    const row = this.database
      .prepare(`${tokenSelect} WHERE owner_id = ? AND agent_id = ? AND token_sha256 = ?`)
      .get(scope.ownerId, scope.agentId, tokenSha256) as TokenRow | undefined;
    return row ? tokenRecord(row) : null;
  }

  private findAccess(input: Scope & { tokenSha256: string; now: string }): McpOAuthAccess | null {
    if (
      typeof input.tokenSha256 !== "string" ||
      !DIGEST.test(input.tokenSha256) ||
      !validInstant(input.now)
    )
      return null;
    const token = this.readToken(input, input.tokenSha256);
    if (
      !token ||
      token.kind !== "access" ||
      token.revokedAt !== null ||
      token.expiresAt <= input.now
    )
      return null;
    const connection = this.readConnection(input, token.connectionId);
    if (
      !connection ||
      connection.status === "revoked" ||
      connection.oauthClientId !== token.clientId
    )
      return null;
    return Object.freeze({ token, connection });
  }

  private revokeFamily(scope: Scope, familyId: string, now: string): void {
    this.database
      .prepare(
        `UPDATE mcp_oauth_tokens SET revoked_at = ?
          WHERE owner_id = ? AND agent_id = ? AND family_id = ? AND revoked_at IS NULL`,
      )
      .run(now, scope.ownerId, scope.agentId, familyId);
  }

  private rotateRefresh(input: Rotate): McpOAuthRotation {
    this.assertDiskHeadroom();
    if (
      typeof input.refreshSha256 !== "string" ||
      !DIGEST.test(input.refreshSha256) ||
      !clientIdValid(input.clientId) ||
      !validInstant(input.now) ||
      !issueValid(input.next.access) ||
      !issueValid(input.next.refresh)
    )
      return this.invalid();
    return this.database.transaction((): McpOAuthRotation => {
      const previous = this.readToken(input, input.refreshSha256);
      if (!previous || previous.kind !== "refresh" || previous.clientId !== input.clientId)
        return { status: "not_found" };
      if (previous.revokedAt !== null) return { status: "not_found" };
      if (previous.usedAt !== null) {
        this.revokeFamily(input, previous.familyId, input.now);
        return { status: "reused" };
      }
      if (previous.expiresAt <= input.now) return { status: "expired" };
      const connection = this.readConnection(input, previous.connectionId);
      if (
        !connection ||
        connection.status === "revoked" ||
        connection.oauthClientId !== previous.clientId
      )
        return { status: "connection_closed" };
      this.database
        .prepare(
          `UPDATE mcp_oauth_tokens SET used_at = ?
            WHERE owner_id = ? AND agent_id = ? AND token_sha256 = ?`,
        )
        .run(input.now, input.ownerId, input.agentId, previous.tokenSha256);
      this.database
        .prepare(
          `UPDATE mcp_oauth_tokens SET revoked_at = ?
            WHERE owner_id = ? AND agent_id = ? AND family_id = ? AND kind = 'access'
              AND revoked_at IS NULL`,
        )
        .run(input.now, input.ownerId, input.agentId, previous.familyId);
      this.insertPair({
        ownerId: input.ownerId,
        agentId: input.agentId,
        connectionId: previous.connectionId,
        clientId: previous.clientId,
        familyId: previous.familyId,
        scopes: previous.scopes,
        resource: previous.resource,
        access: input.next.access,
        refresh: input.next.refresh,
        now: input.now,
      });
      return { status: "rotated", previous };
    })();
  }

  private revokeToken(input: Scope & { tokenSha256: string; clientId: string; now: string }): void {
    if (
      typeof input.tokenSha256 !== "string" ||
      !DIGEST.test(input.tokenSha256) ||
      !validInstant(input.now)
    )
      return;
    this.database.transaction(() => {
      const token = this.readToken(input, input.tokenSha256);
      if (!token || token.clientId !== input.clientId) return;
      if (token.kind === "refresh") this.revokeFamily(input, token.familyId, input.now);
      else
        this.database
          .prepare(
            `UPDATE mcp_oauth_tokens SET revoked_at = ?
              WHERE owner_id = ? AND agent_id = ? AND token_sha256 = ? AND revoked_at IS NULL`,
          )
          .run(input.now, input.ownerId, input.agentId, token.tokenSha256);
    })();
  }

  private pruneExpired(input: Scope & { now: string }): number {
    if (!validInstant(input.now)) return this.invalid();
    return this.database
      .prepare(
        `DELETE FROM mcp_oauth_tokens WHERE owner_id = ? AND agent_id = ? AND expires_at <= ?`,
      )
      .run(input.ownerId, input.agentId, input.now).changes;
  }
}
