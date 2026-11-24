import type {
  VaultChangeResult,
  VaultItemRecord,
  VaultManifestRecord,
  VaultReleaseRequestRecord,
  VaultScope,
  VaultStorePort,
  VaultUsageListed,
  VaultUsageRecord,
} from "@himawari-agent/application";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type ChangeInput = Parameters<VaultStorePort["applyChange"]>[0];
type CreateInput = Parameters<VaultStorePort["createRequest"]>[0];
type DecideInput = Parameters<VaultStorePort["decideRequest"]>[0];
type UsageInput = Parameters<VaultStorePort["recordUsage"]>[0];

interface ItemRow {
  id: string;
  name: string;
  kind: string;
  origins: string;
  fields: string;
  version: number;
  background_allowed: number;
  wrapped_key: string;
  ciphertexts: string;
  created_at: string;
  updated_at: string;
}

interface RequestRow {
  id: string;
  owner_id: string;
  agent_id: string;
  run_id: string | null;
  purpose: string;
  item_ids: string;
  item_versions: string;
  origin: string;
  page_version: string | null;
  ephemeral_public_key: string;
  nonce: string;
  status: VaultReleaseRequestRecord["status"];
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  device_id: string | null;
}

function itemRecord(row: ItemRow): VaultItemRecord {
  return Object.freeze({
    id: row.id,
    name: row.name,
    kind: row.kind as VaultItemRecord["kind"],
    origins: Object.freeze(JSON.parse(row.origins) as string[]),
    fields: Object.freeze(JSON.parse(row.fields) as string[]),
    version: row.version,
    backgroundAllowed: row.background_allowed === 1,
    wrappedKey: row.wrapped_key,
    ciphertexts: Object.freeze(JSON.parse(row.ciphertexts) as Record<string, string>),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function requestRecord(row: RequestRow): VaultReleaseRequestRecord {
  return Object.freeze({
    id: row.id,
    ownerId: row.owner_id as VaultReleaseRequestRecord["ownerId"],
    agentId: row.agent_id as VaultReleaseRequestRecord["agentId"],
    runId: row.run_id,
    purpose: row.purpose,
    itemIds: Object.freeze(JSON.parse(row.item_ids) as string[]),
    itemVersions: Object.freeze(JSON.parse(row.item_versions) as number[]),
    origin: row.origin,
    pageVersion: row.page_version,
    ephemeralPublicKey: row.ephemeral_public_key,
    nonce: row.nonce,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    deviceId: row.device_id,
  });
}

export class SqliteVaultOperations {
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
      case "vault.listItems":
        return this.listItems(payload as VaultScope);
      case "vault.readManifest":
        return this.readManifest(payload as VaultScope);
      case "vault.applyChange":
        return this.applyChange(payload as ChangeInput);
      case "vault.createRequest":
        return this.createRequest(payload as CreateInput);
      case "vault.readRequest":
        return this.readRequest(payload as VaultScope & { id: string });
      case "vault.listPendingRequests":
        return this.listPendingRequests(payload as VaultScope & { now: string });
      case "vault.decideRequest":
        return this.decideRequest(payload as DecideInput);
      case "vault.expireOverdue":
        return this.expireOverdue(payload as VaultScope & { now: string });
      case "vault.recordUsage":
        return this.recordUsage(payload as UsageInput);
      case "vault.listUsage":
        return this.listUsage(payload as VaultScope & { itemId: string | null; limit: number });
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown vault operation ${operation}`);
    }
  }

  private listItems(scope: VaultScope): readonly VaultItemRecord[] {
    const rows = this.database
      .prepare(
        `SELECT id, name, kind, origins, fields, version, background_allowed, wrapped_key,
           ciphertexts, created_at, updated_at
         FROM vault_items WHERE owner_id = ? AND agent_id = ? ORDER BY id`,
      )
      .all(scope.ownerId, scope.agentId) as ItemRow[];
    return Object.freeze(rows.map(itemRecord));
  }

  private readManifest(scope: VaultScope): VaultManifestRecord | null {
    const row = this.database
      .prepare(
        `SELECT version, signature, updated_at FROM vault_manifests
         WHERE owner_id = ? AND agent_id = ?`,
      )
      .get(scope.ownerId, scope.agentId) as
      | { version: number; signature: string; updated_at: string }
      | undefined;
    return row
      ? Object.freeze({ version: row.version, signature: row.signature, updatedAt: row.updated_at })
      : null;
  }

  private applyChange(input: ChangeInput): VaultChangeResult {
    this.assertDiskHeadroom();
    return this.database.transaction((): VaultChangeResult => {
      const current = this.readManifest(input)?.version ?? 0;
      if (current !== input.expectedManifestVersion) return { kind: "manifest_conflict", current };
      const existing = new Map(this.listItems(input).map((item) => [item.id, item]));
      for (const id of input.deletes)
        if (!existing.has(id)) return { kind: "unknown_item", itemId: id };
      for (const item of input.upserts) {
        const before = existing.get(item.id);
        if (before && item.version <= before.version)
          return { kind: "version_not_newer", itemId: item.id };
      }
      if (input.rotation) {
        const rotated = new Set(input.upserts.map((item) => item.id));
        for (const id of existing.keys())
          if (!rotated.has(id) && !input.deletes.includes(id))
            return { kind: "unknown_item", itemId: id };
      }
      const remaining = new Set(existing.keys());
      for (const id of input.deletes) remaining.delete(id);
      for (const item of input.upserts) remaining.add(item.id);
      if (remaining.size > input.maximumItems) return { kind: "too_many_items" };
      const remove = this.database.prepare(
        "DELETE FROM vault_items WHERE owner_id = ? AND agent_id = ? AND id = ?",
      );
      for (const id of input.deletes) remove.run(input.ownerId, input.agentId, id);
      const upsert = this.database.prepare(
        `INSERT INTO vault_items
           (id, owner_id, agent_id, name, kind, origins, fields, version, background_allowed,
            wrapped_key, ciphertexts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind,
           origins = excluded.origins, fields = excluded.fields, version = excluded.version,
           background_allowed = excluded.background_allowed, wrapped_key = excluded.wrapped_key,
           ciphertexts = excluded.ciphertexts, updated_at = excluded.updated_at
         WHERE vault_items.owner_id = excluded.owner_id AND vault_items.agent_id = excluded.agent_id`,
      );
      for (const item of input.upserts) {
        const changed = upsert.run(
          item.id,
          input.ownerId,
          input.agentId,
          item.name,
          item.kind,
          JSON.stringify(item.origins),
          JSON.stringify(item.fields),
          item.version,
          item.backgroundAllowed ? 1 : 0,
          item.wrappedKey,
          JSON.stringify(item.ciphertexts),
          input.now,
          input.now,
        );
        if (changed.changes !== 1)
          return this.fail("PORT_CONFLICT", "Vault item belongs to another scope");
      }
      if (input.rotation || input.deletes.length > 0) {
        const open = this.database
          .prepare(
            `SELECT id, nonce FROM vault_release_requests
             WHERE owner_id = ? AND agent_id = ? AND status = 'pending' ORDER BY id`,
          )
          .all(input.ownerId, input.agentId) as { id: string; nonce: string }[];
        for (const request of open)
          this.close({
            ownerId: input.ownerId,
            agentId: input.agentId,
            id: request.id,
            nonce: request.nonce,
            status: "denied",
            deviceId: null,
            now: input.now,
            usage: "denied",
          });
      }
      this.database
        .prepare(
          `INSERT INTO vault_manifests (owner_id, agent_id, version, signature, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (owner_id, agent_id) DO UPDATE SET version = excluded.version,
             signature = excluded.signature, updated_at = excluded.updated_at`,
        )
        .run(
          input.ownerId,
          input.agentId,
          input.manifest.version,
          input.manifest.signature,
          input.now,
        );
      return { kind: "applied", manifest: this.readManifest(input) as VaultManifestRecord };
    })();
  }

  private createRequest(input: CreateInput): void {
    this.assertDiskHeadroom();
    this.database
      .prepare(
        `INSERT INTO vault_release_requests
           (id, owner_id, agent_id, run_id, purpose, item_ids, item_versions, origin, page_version,
            ephemeral_public_key, nonce, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        input.id,
        input.ownerId,
        input.agentId,
        input.runId,
        input.purpose,
        JSON.stringify(input.itemIds),
        JSON.stringify(input.itemVersions),
        input.origin,
        input.pageVersion,
        input.ephemeralPublicKey,
        input.nonce,
        input.createdAt,
        input.expiresAt,
      );
  }

  private readRequest(input: VaultScope & { id: string }): VaultReleaseRequestRecord | null {
    const row = this.database
      .prepare(
        "SELECT * FROM vault_release_requests WHERE id = ? AND owner_id = ? AND agent_id = ?",
      )
      .get(input.id, input.ownerId, input.agentId) as RequestRow | undefined;
    return row ? requestRecord(row) : null;
  }

  private listPendingRequests(
    input: VaultScope & { now: string },
  ): readonly VaultReleaseRequestRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM vault_release_requests
         WHERE owner_id = ? AND agent_id = ? AND status = 'pending' AND expires_at > ?
         ORDER BY created_at, id`,
      )
      .all(input.ownerId, input.agentId, input.now) as RequestRow[];
    return Object.freeze(rows.map(requestRecord));
  }

  private decideRequest(input: DecideInput): VaultReleaseRequestRecord | null {
    this.assertDiskHeadroom();
    return this.database.transaction(() => this.close(input))();
  }

  private expireOverdue(input: VaultScope & { now: string }): readonly string[] {
    const overdue = this.database
      .prepare(
        `SELECT id, nonce FROM vault_release_requests
         WHERE owner_id = ? AND agent_id = ? AND status = 'pending' AND expires_at <= ?
         ORDER BY id`,
      )
      .all(input.ownerId, input.agentId, input.now) as { id: string; nonce: string }[];
    if (overdue.length === 0) return Object.freeze([]);
    this.assertDiskHeadroom();
    return this.database.transaction(() =>
      Object.freeze(
        overdue
          .filter((row) =>
            this.close({
              ...input,
              id: row.id,
              nonce: row.nonce,
              status: "expired",
              deviceId: null,
              usage: "expired",
            }),
          )
          .map((row) => row.id),
      ),
    )();
  }

  private close(input: DecideInput): VaultReleaseRequestRecord | null {
    const changed = this.database
      .prepare(
        `UPDATE vault_release_requests SET status = ?, decided_at = ?, device_id = ?
         WHERE id = ? AND owner_id = ? AND agent_id = ? AND nonce = ? AND status = 'pending'
           AND (? = 'expired' OR expires_at > ?)`,
      )
      .run(
        input.status,
        input.now,
        input.deviceId,
        input.id,
        input.ownerId,
        input.agentId,
        input.nonce,
        input.status,
        input.now,
      );
    if (changed.changes !== 1) return null;
    const closed = this.readRequest(input);
    if (!closed) return null;
    this.insertUsage({
      ownerId: input.ownerId,
      agentId: input.agentId,
      entries: closed.itemIds.map((itemId) => ({
        requestId: closed.id,
        itemId,
        origin: closed.origin,
        outcome: input.usage,
        at: input.now,
      })),
    });
    return closed;
  }

  private recordUsage(input: UsageInput): void {
    this.assertDiskHeadroom();
    this.database.transaction(() => this.insertUsage(input))();
  }

  private insertUsage(input: UsageInput): void {
    const insert = this.database.prepare(
      `INSERT INTO vault_usage (owner_id, agent_id, request_id, item_id, origin, outcome, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of input.entries)
      insert.run(
        input.ownerId,
        input.agentId,
        entry.requestId,
        entry.itemId,
        entry.origin,
        entry.outcome,
        entry.at,
      );
  }

  private listUsage(
    input: VaultScope & { itemId: string | null; limit: number },
  ): readonly VaultUsageListed[] {
    const rows = this.database
      .prepare(
        `SELECT u.request_id, u.item_id, u.origin, u.outcome, u.at, r.purpose
         FROM vault_usage u
         LEFT JOIN vault_release_requests r
           ON r.owner_id = u.owner_id AND r.agent_id = u.agent_id AND r.id = u.request_id
         WHERE u.owner_id = ? AND u.agent_id = ? AND (? IS NULL OR u.item_id = ?)
         ORDER BY u.sequence DESC LIMIT ?`,
      )
      .all(input.ownerId, input.agentId, input.itemId, input.itemId, input.limit) as {
      request_id: string;
      item_id: string;
      origin: string;
      outcome: VaultUsageRecord["outcome"];
      at: string;
      purpose: string | null;
    }[];
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          requestId: row.request_id,
          itemId: row.item_id,
          origin: row.origin,
          outcome: row.outcome,
          at: row.at,
          purpose: row.purpose,
        }),
      ),
    );
  }
}
