import type {
  NonceRecordResult,
  PairedDevice,
  PairedDeviceScope,
  PairedDeviceStorePort,
  PairingRedeemResult,
} from "@himawari-agent/application";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Input<TName extends keyof PairedDeviceStorePort> = Parameters<PairedDeviceStorePort[TName]>[0];

const deviceColumns = `id, owner_id AS ownerId, agent_id AS agentId, revision, kind, name,
  release_channel AS releaseChannel, device_public_key AS devicePublicKey,
  confirm_public_key AS confirmPublicKey, status, supported_actions AS supportedActions,
  web_device_id AS webDeviceId, web_session_id AS webSessionId, paired_at AS pairedAt, confirmed_at AS confirmedAt,
  revoked_at AS revokedAt, last_seen_at AS lastSeenAt`;

export const INTERNAL_SESSION_NEVER_RECENTLY_AUTHENTICATED = "1970-01-01T00:00:00.000Z";

type DeviceRow = Omit<PairedDevice, "supportedActions"> & { readonly supportedActions: string };

function toDevice(row: DeviceRow): PairedDevice {
  return Object.freeze({
    ...row,
    supportedActions: Object.freeze(JSON.parse(row.supportedActions) as string[]),
  });
}

function validTime(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export class SqlitePairedDeviceOperations {
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
      case "pairedDevices.createPairingCode":
        return this.createPairingCode(payload as Input<"createPairingCode">);
      case "pairedDevices.redeemPairingCode":
        return this.redeemPairingCode(payload as Input<"redeemPairingCode">);
      case "pairedDevices.readDevice":
        return this.readDevice(payload as string);
      case "pairedDevices.listDevices":
        return this.listDevices(payload as PairedDeviceScope);
      case "pairedDevices.readOpenPairingCode":
        return this.readOpenPairingCode(payload as Input<"readOpenPairingCode">);
      case "pairedDevices.confirmDevice":
        return this.confirmDevice(payload as Input<"confirmDevice">);
      case "pairedDevices.renameDevice":
        return this.renameDevice(payload as Input<"renameDevice">);
      case "pairedDevices.revokeDevice":
        return this.revokeDevice(payload as Input<"revokeDevice">);
      case "pairedDevices.recordNonce":
        return this.recordNonce(payload as Input<"recordNonce">);
      case "pairedDevices.touchDevice":
        return this.touchDevice(payload as Input<"touchDevice">);
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown paired device operation ${operation}`);
    }
  }

  private time(value: string): string {
    if (!validTime(value)) this.fail("PORT_INVALID_OPERATION", "Paired device time is invalid");
    return value;
  }

  private createPairingCode(input: Input<"createPairingCode">): { readonly expiresAt: string } {
    this.assertDiskHeadroom();
    const now = this.time(input.now);
    const expiresAt = this.time(input.expiresAt);
    if (!/^[0-9a-f]{64}$/u.test(input.codeHash) || expiresAt <= now)
      this.fail("PORT_INVALID_OPERATION", "Pairing code is invalid");
    return this.database.transaction(() => {
      const open = this.database
        .prepare(
          `SELECT expires_at AS expiresAt FROM device_pairing_codes
            WHERE code_hash = ? AND owner_id = ? AND agent_id = ? AND session_id = ?
              AND used_at IS NULL AND expires_at > ?`,
        )
        .get(input.codeHash, input.ownerId, input.agentId, input.sessionId, now) as
        | { expiresAt: string }
        | undefined;
      if (open) return { expiresAt: open.expiresAt };
      this.database
        .prepare(
          `DELETE FROM device_pairing_codes
            WHERE expires_at <= ? OR used_at IS NOT NULL OR (owner_id = ? AND agent_id = ?)`,
        )
        .run(now, input.ownerId, input.agentId);
      this.database
        .prepare(
          `INSERT INTO device_pairing_codes
             (code_hash, owner_id, agent_id, session_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.codeHash, input.ownerId, input.agentId, input.sessionId, now, expiresAt);
      return { expiresAt };
    })();
  }

  private redeemPairingCode(input: Input<"redeemPairingCode">): PairingRedeemResult {
    this.assertDiskHeadroom();
    const now = this.time(input.now);
    return this.database.transaction((): PairingRedeemResult => {
      const code = this.database
        .prepare(
          `SELECT owner_id AS ownerId, agent_id AS agentId, expires_at AS expiresAt,
                  used_at AS usedAt, device_id AS deviceId
             FROM device_pairing_codes WHERE code_hash = ?`,
        )
        .get(input.codeHash) as
        | {
            ownerId: string;
            agentId: string;
            expiresAt: string;
            usedAt: string | null;
            deviceId: string | null;
          }
        | undefined;
      if (!code) return { kind: "code_invalid" };
      if (code.usedAt !== null) {
        const redeemed = code.deviceId ? this.readDevice(code.deviceId) : undefined;
        return redeemed &&
          redeemed.devicePublicKey === input.device.devicePublicKey &&
          redeemed.confirmPublicKey === input.device.confirmPublicKey
          ? { kind: "replayed", device: redeemed }
          : { kind: "code_used" };
      }
      if (code.expiresAt <= now) return { kind: "code_expired" };
      const device = input.device;
      this.database
        .prepare(
          `INSERT INTO paired_devices
             (id, owner_id, agent_id, revision, kind, name, release_channel, device_public_key,
              confirm_public_key, status, supported_actions, paired_at)
           VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, 'pending', '[]', ?)`,
        )
        .run(
          device.id,
          code.ownerId,
          code.agentId,
          device.kind,
          device.name,
          device.releaseChannel,
          device.devicePublicKey,
          device.confirmPublicKey,
          now,
        );
      this.database
        .prepare("UPDATE device_pairing_codes SET used_at = ?, device_id = ? WHERE code_hash = ?")
        .run(now, device.id, input.codeHash);
      return { kind: "paired", device: this.requireDevice(device.id) };
    })();
  }

  private readOpenPairingCode(
    input: Input<"readOpenPairingCode">,
  ): { readonly expiresAt: string } | undefined {
    const now = this.time(input.now);
    const row = this.database
      .prepare(
        `SELECT expires_at AS expiresAt FROM device_pairing_codes
          WHERE owner_id = ? AND agent_id = ? AND used_at IS NULL AND expires_at > ?
          ORDER BY expires_at DESC LIMIT 1`,
      )
      .get(input.ownerId, input.agentId, now) as { expiresAt: string } | undefined;
    return row ? { expiresAt: row.expiresAt } : undefined;
  }

  private readDevice(deviceId: string): PairedDevice | undefined {
    const row = this.database
      .prepare(`SELECT ${deviceColumns} FROM paired_devices WHERE id = ?`)
      .get(deviceId) as DeviceRow | undefined;
    return row ? toDevice(row) : undefined;
  }

  private requireDevice(deviceId: string): PairedDevice {
    const device = this.readDevice(deviceId);
    if (!device) return this.fail("PORT_NOT_FOUND", "Paired device was not found");
    return device;
  }

  private listDevices(input: PairedDeviceScope): readonly PairedDevice[] {
    return (
      this.database
        .prepare(
          `SELECT ${deviceColumns} FROM paired_devices
            WHERE owner_id = ? AND agent_id = ?
            ORDER BY paired_at DESC, id`,
        )
        .all(input.ownerId, input.agentId) as DeviceRow[]
    ).map(toDevice);
  }

  private scoped(
    input: PairedDeviceScope & { readonly deviceId: string; readonly expectedRevision?: number },
  ): PairedDevice {
    const device = this.readDevice(input.deviceId);
    if (!device || device.ownerId !== input.ownerId || device.agentId !== input.agentId)
      return this.fail("PORT_NOT_FOUND", "Paired device was not found");
    if (input.expectedRevision !== undefined && device.revision !== input.expectedRevision)
      return this.fail("PORT_CONFLICT", "Paired device changed");
    return device;
  }

  private confirmDevice(input: Input<"confirmDevice">): PairedDevice {
    this.assertDiskHeadroom();
    const now = this.time(input.now);
    if (!/^sha256:[0-9a-f]{64}$/u.test(input.webAuthenticationRef))
      this.fail("PORT_INVALID_OPERATION", "Paired device session reference is invalid");
    return this.database.transaction(() => {
      const device = this.scoped(input);
      if (device.status !== "pending")
        return this.fail("PORT_CONFLICT", "Only a pending device can be confirmed");
      this.database
        .prepare(
          `INSERT INTO devices (id, owner_id, revision, label, status, first_seen_at, last_seen_at)
           VALUES (?, ?, 0, ?, 'active', ?, ?)`,
        )
        .run(input.webDeviceId, device.ownerId, device.name, now, now);
      this.database
        .prepare(
          `INSERT INTO product_sessions
             (id, owner_id, device_id, revision, authentication_ref, status,
              first_authenticated_at, last_active_at, recent_authenticated_at, revoked_at)
           VALUES (?, ?, ?, 0, ?, 'active', ?, ?, ?, NULL)`,
        )
        .run(
          input.webSessionId,
          device.ownerId,
          input.webDeviceId,
          input.webAuthenticationRef,
          now,
          now,
          INTERNAL_SESSION_NEVER_RECENTLY_AUTHENTICATED,
        );
      this.database
        .prepare(
          `UPDATE paired_devices
              SET status = 'active', confirmed_at = ?, web_device_id = ?, web_session_id = ?,
                  revision = revision + 1
            WHERE id = ?`,
        )
        .run(now, input.webDeviceId, input.webSessionId, device.id);
      return this.requireDevice(device.id);
    })();
  }

  private renameDevice(input: Input<"renameDevice">): PairedDevice {
    const name = input.name.trim();
    if (name.length === 0 || [...name].length > 64)
      this.fail("PORT_INVALID_OPERATION", "Paired device name is invalid");
    return this.database.transaction(() => {
      const device = this.scoped(input);
      if (device.status === "revoked")
        return this.fail("PORT_CONFLICT", "A revoked device cannot be renamed");
      this.database
        .prepare("UPDATE paired_devices SET name = ?, revision = revision + 1 WHERE id = ?")
        .run(name, device.id);
      if (device.webDeviceId)
        this.database
          .prepare("UPDATE devices SET label = ?, revision = revision + 1 WHERE id = ?")
          .run(name, device.webDeviceId);
      return this.requireDevice(device.id);
    })();
  }

  private revokeDevice(input: Input<"revokeDevice">): PairedDevice {
    const now = this.time(input.now);
    return this.database.transaction(() => {
      const device = this.scoped(input);
      if (device.status === "revoked") return device;
      this.database
        .prepare(
          `UPDATE paired_devices SET status = 'revoked', revoked_at = ?, revision = revision + 1
            WHERE id = ?`,
        )
        .run(now, device.id);
      this.database.prepare("DELETE FROM device_request_nonces WHERE device_id = ?").run(device.id);
      this.database.prepare("DELETE FROM device_upload_grants WHERE device_id = ?").run(device.id);
      if (device.webDeviceId !== null) {
        this.database
          .prepare(
            `UPDATE product_sessions
                SET status = 'revoked', revoked_at = ?, revision = revision + 1
              WHERE device_id = ? AND status = 'active'`,
          )
          .run(now, device.webDeviceId);
        this.database
          .prepare(
            `UPDATE devices SET status = 'revoked', revision = revision + 1
              WHERE id = ? AND status = 'active'`,
          )
          .run(device.webDeviceId);
      }
      return this.requireDevice(device.id);
    })();
  }

  private recordNonce(input: Input<"recordNonce">): NonceRecordResult {
    const now = this.time(input.now);
    const expiresAt = this.time(input.expiresAt);
    if (!Number.isSafeInteger(input.maximumRetained) || input.maximumRetained < 1)
      this.fail("PORT_INVALID_OPERATION", "Nonce limit is invalid");
    return this.database.transaction((): NonceRecordResult => {
      this.database
        .prepare("DELETE FROM device_request_nonces WHERE device_id = ? AND expires_at <= ?")
        .run(input.deviceId, now);
      const seen = this.database
        .prepare("SELECT 1 FROM device_request_nonces WHERE device_id = ? AND nonce = ?")
        .get(input.deviceId, input.nonce);
      if (seen) return "replayed";
      const { count } = this.database
        .prepare("SELECT COUNT(*) AS count FROM device_request_nonces WHERE device_id = ?")
        .get(input.deviceId) as { count: number };
      if (count >= input.maximumRetained) return "full";
      this.database
        .prepare(
          "INSERT INTO device_request_nonces (device_id, nonce, expires_at) VALUES (?, ?, ?)",
        )
        .run(input.deviceId, input.nonce, expiresAt);
      return "accepted";
    })();
  }

  private touchDevice(input: Input<"touchDevice">): void {
    const now = this.time(input.now);
    this.database
      .prepare(
        `UPDATE paired_devices SET last_seen_at = ?
          WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`,
      )
      .run(now, input.deviceId, now);
  }
}
