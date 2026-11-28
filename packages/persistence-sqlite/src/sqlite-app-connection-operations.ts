import type {
  AddedAppRecord,
  AppClientRecord,
  AppConnectionRecord,
  AppConnectionScope,
  AppConnectionStorePort,
} from "@himawari-agent/application";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Input<TName extends keyof AppConnectionStorePort> = Parameters<
  AppConnectionStorePort[TName]
>[0];

const NAME = /^[a-z][a-z0-9_]{0,63}$/u;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const STATUSES: readonly string[] = ["connected", "needs_reconnect"];

const COLUMNS = `name, tokens_ref AS tokensRef, status, connected_at AS connectedAt,
  updated_at AS updatedAt`;
const TITLE_MAXIMUM = 80;
const SERVER_URL_MAXIMUM = 2048;

export class SqliteAppConnectionOperations {
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
      case "appConnections.read":
        return this.read(payload as Input<"read">);
      case "appConnections.list":
        return this.list(payload as AppConnectionScope);
      case "appConnections.save":
        return this.save(payload as Input<"save">);
      case "appConnections.mark":
        return this.mark(payload as Input<"mark">);
      case "appConnections.remove":
        return this.remove(payload as Input<"remove">);
      case "appConnections.listApps":
        return this.listApps(payload as AppConnectionScope);
      case "appConnections.addApp":
        return this.addApp(payload as Input<"addApp">);
      case "appConnections.removeApp":
        return this.removeApp(payload as Input<"removeApp">);
      case "appConnections.readClient":
        return this.readClient(payload as Input<"readClient">);
      case "appConnections.saveClient":
        return this.saveClient(payload as Input<"saveClient">);
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown app connection operation ${operation}`);
    }
  }

  private invalid(message: string): never {
    return this.fail("PORT_INVALID_OPERATION", message) as never;
  }

  private name(value: unknown): string {
    if (typeof value !== "string" || !NAME.test(value))
      this.invalid("App connection name is invalid");
    return value as string;
  }

  private time(value: unknown): void {
    if (typeof value !== "string" || !TIME.test(value) || Number.isNaN(Date.parse(value)))
      this.invalid("App connection time is invalid");
  }

  private status(value: unknown): void {
    if (typeof value !== "string" || !STATUSES.includes(value))
      this.invalid("App connection status is invalid");
  }

  private read(input: Input<"read">): AppConnectionRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT ${COLUMNS} FROM app_connections WHERE owner_id = ? AND agent_id = ? AND name = ?`,
      )
      .get(input.ownerId, input.agentId, this.name(input.name)) as AppConnectionRecord | undefined;
    return row ? Object.freeze({ ...row }) : undefined;
  }

  private list(scope: AppConnectionScope): readonly AppConnectionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT ${COLUMNS} FROM app_connections WHERE owner_id = ? AND agent_id = ? ORDER BY name`,
      )
      .all(scope.ownerId, scope.agentId) as AppConnectionRecord[];
    return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
  }

  private save(input: Input<"save">): readonly string[] {
    this.assertDiskHeadroom();
    const name = this.name(input.name);
    this.status(input.status);
    this.time(input.connectedAt);
    this.time(input.now);
    if (typeof input.tokensRef !== "string" || input.tokensRef.length === 0)
      this.invalid("App connection token reference is invalid");
    return this.database.transaction(() => {
      const before = this.read(input);
      this.database
        .prepare(
          `INSERT INTO app_connections (
            owner_id, agent_id, name, tokens_ref, status, connected_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (owner_id, agent_id, name) DO UPDATE SET
            tokens_ref = excluded.tokens_ref, status = excluded.status,
            connected_at = excluded.connected_at, updated_at = excluded.updated_at`,
        )
        .run(
          input.ownerId,
          input.agentId,
          name,
          input.tokensRef,
          input.status,
          input.connectedAt,
          input.now,
        );
      return before && before.tokensRef !== input.tokensRef ? [before.tokensRef] : [];
    })();
  }

  private mark(input: Input<"mark">): void {
    const name = this.name(input.name);
    this.status(input.status);
    this.time(input.now);
    this.database
      .prepare(
        `UPDATE app_connections SET status = ?, updated_at = ?
         WHERE owner_id = ? AND agent_id = ? AND name = ?`,
      )
      .run(input.status, input.now, input.ownerId, input.agentId, name);
  }

  private remove(input: Input<"remove">): readonly string[] {
    const name = this.name(input.name);
    return this.database.transaction(() => {
      const before = this.read(input);
      this.database
        .prepare("DELETE FROM app_connections WHERE owner_id = ? AND agent_id = ? AND name = ?")
        .run(input.ownerId, input.agentId, name);
      return before ? [before.tokensRef] : [];
    })();
  }

  private listApps(scope: AppConnectionScope): readonly AddedAppRecord[] {
    const rows = this.database
      .prepare(
        `SELECT name, title, server_url AS serverUrl, created_at AS createdAt
         FROM app_connection_apps WHERE owner_id = ? AND agent_id = ? ORDER BY created_at, name`,
      )
      .all(scope.ownerId, scope.agentId) as AddedAppRecord[];
    return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
  }

  private addApp(input: Input<"addApp">): void {
    this.assertDiskHeadroom();
    const name = this.name(input.name);
    this.time(input.now);
    if (
      typeof input.title !== "string" ||
      input.title.trim().length === 0 ||
      input.title.length > TITLE_MAXIMUM
    )
      this.invalid("App title is invalid");
    if (
      typeof input.serverUrl !== "string" ||
      !URL.canParse(input.serverUrl) ||
      input.serverUrl.length > SERVER_URL_MAXIMUM
    )
      this.invalid("App server address is invalid");
    this.database
      .prepare(
        `INSERT INTO app_connection_apps (owner_id, agent_id, name, title, server_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.ownerId, input.agentId, name, input.title, input.serverUrl, input.now);
  }

  private removeApp(input: Input<"removeApp">): readonly string[] {
    const name = this.name(input.name);
    return this.database.transaction(() => {
      const released = [...this.remove(input)];
      const client = this.readClient(input);
      if (client) released.push(client.clientRef);
      this.database
        .prepare(
          "DELETE FROM app_connection_clients WHERE owner_id = ? AND agent_id = ? AND name = ?",
        )
        .run(input.ownerId, input.agentId, name);
      this.database
        .prepare("DELETE FROM app_connection_apps WHERE owner_id = ? AND agent_id = ? AND name = ?")
        .run(input.ownerId, input.agentId, name);
      return released;
    })();
  }

  private readClient(input: Input<"readClient">): AppClientRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT name, client_ref AS clientRef, updated_at AS updatedAt FROM app_connection_clients
         WHERE owner_id = ? AND agent_id = ? AND name = ?`,
      )
      .get(input.ownerId, input.agentId, this.name(input.name)) as AppClientRecord | undefined;
    return row ? Object.freeze({ ...row }) : undefined;
  }

  private saveClient(input: Input<"saveClient">): readonly string[] {
    this.assertDiskHeadroom();
    const name = this.name(input.name);
    this.time(input.now);
    if (typeof input.clientRef !== "string" || input.clientRef.length === 0)
      this.invalid("App client reference is invalid");
    return this.database.transaction(() => {
      const before = this.readClient(input);
      this.database
        .prepare(
          `INSERT INTO app_connection_clients (owner_id, agent_id, name, client_ref, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (owner_id, agent_id, name) DO UPDATE SET
             client_ref = excluded.client_ref, updated_at = excluded.updated_at`,
        )
        .run(input.ownerId, input.agentId, name, input.clientRef, input.now);
      return before && before.clientRef !== input.clientRef ? [before.clientRef] : [];
    })();
  }
}
