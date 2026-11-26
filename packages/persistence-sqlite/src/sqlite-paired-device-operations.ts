import type {
  NonceRecordResult,
  OwnerPasskey,
  PairedDevice,
  PairedDeviceScope,
  PairedDeviceStorePort,
  SignInDeviceResult,
} from "@himawari-agent/application";
import type Database from "better-sqlite3";
import { disablePushForRevokedDevices } from "./sqlite-apple-push-operations.ts";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Input<TName extends keyof PairedDeviceStorePort> = Parameters<PairedDeviceStorePort[TName]>[0];

const deviceColumns = `id, owner_id AS ownerId, agent_id AS agentId, revision, kind, name,
  release_channel AS releaseChannel, device_public_key AS devicePublicKey,
  confirm_public_key AS confirmPublicKey, status, supported_actions AS supportedActions,
  web_device_id AS webDeviceId, web_session_id AS webSessionId, paired_at AS pairedAt, confirmed_at AS confirmedAt,
  revoked_at AS revokedAt, last_seen_at AS lastSeenAt`;

export const INTERNAL_SESSION_NEVER_RECENTLY_AUTHENTICATED = "1970-01-01T00:00:00.000Z";

type DeviceRow = Omit<PairedDevice, "supportedActions"> & { readonly supportedActions: string };

const passkeyColumns = `credential_id AS credentialId, owner_id AS ownerId, agent_id AS agentId,
  public_key AS publicKey, sign_count AS signCount, transports, backed_up AS backedUp,
  created_at AS createdAt, last_used_at AS lastUsedAt`;

type PasskeyRow = Omit<OwnerPasskey, "transports" | "backedUp"> & {
  readonly transports: string;
  readonly backedUp: number;
};

function toPasskey(row: PasskeyRow): OwnerPasskey {
  return Object.freeze({
    ...row,
    transports: Object.freeze(JSON.parse(row.transports) as string[]),
    backedUp: row.backedUp === 1,
  });
}

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

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
      case "pairedDevices.listPasskeys":
        return this.listPasskeys(payload as PairedDeviceScope);
      case "pairedDevices.readPasskey":
        return this.readPasskey(payload as string);
      case "pairedDevices.signInDevice":
        return this.signInDevice(payload as Input<"signInDevice">);
      case "pairedDevices.readDevice":
        return this.readDevice(payload as string);
      case "pairedDevices.listDevices":
        return this.listDevices(payload as PairedDeviceScope);
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

  private listPasskeys(input: PairedDeviceScope): readonly OwnerPasskey[] {
    return (
      this.database
        .prepare(
          `SELECT ${passkeyColumns} FROM owner_passkeys
            WHERE owner_id = ? AND agent_id = ? ORDER BY created_at, credential_id`,
        )
        .all(input.ownerId, input.agentId) as PasskeyRow[]
    ).map(toPasskey);
  }

  private readPasskey(credentialId: string): OwnerPasskey | undefined {
    const row = this.database
      .prepare(`SELECT ${passkeyColumns} FROM owner_passkeys WHERE credential_id = ?`)
      .get(credentialId) as PasskeyRow | undefined;
    return row ? toPasskey(row) : undefined;
  }

  private signInDevice(input: Input<"signInDevice">): SignInDeviceResult {
    this.assertDiskHeadroom();
    const now = this.time(input.now);
    const { device, passkey } = input;
    if (
      !BASE64URL.test(passkey.credentialId) ||
      !Number.isSafeInteger(passkey.signCount) ||
      passkey.signCount < 0 ||
      !/^sha256:[0-9a-f]{64}$/u.test(device.webAuthenticationRef) ||
      (passkey.kind === "created" &&
        (!/^[0-9a-f]{64}$/u.test(passkey.setupCodeHash) || !BASE64URL.test(passkey.publicKey)))
    )
      this.fail("PORT_INVALID_OPERATION", "Sign-in input is invalid");
    return this.database.transaction((): SignInDeviceResult => {
      const existing = this.readPasskey(passkey.credentialId);
      if (passkey.kind === "created") {
        if (existing) return { kind: "passkey_exists" };
        if (
          this.database
            .prepare("SELECT 1 FROM sign_in_setup_code_uses WHERE code_hash = ?")
            .get(passkey.setupCodeHash)
        )
          return { kind: "setup_code_used" };
        this.database
          .prepare(
            `INSERT INTO owner_passkeys
               (credential_id, owner_id, agent_id, public_key, sign_count, transports, backed_up,
                created_at, last_used_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            passkey.credentialId,
            input.ownerId,
            input.agentId,
            passkey.publicKey,
            passkey.signCount,
            JSON.stringify(passkey.transports),
            passkey.backedUp ? 1 : 0,
            now,
            now,
          );
        this.database
          .prepare(
            `INSERT INTO sign_in_setup_code_uses (code_hash, owner_id, agent_id, credential_id, used_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(passkey.setupCodeHash, input.ownerId, input.agentId, passkey.credentialId, now);
      } else {
        if (!existing || existing.ownerId !== input.ownerId || existing.agentId !== input.agentId)
          return { kind: "passkey_unknown" };
        this.database
          .prepare(
            `UPDATE owner_passkeys SET sign_count = ?, backed_up = ?, last_used_at = ?
              WHERE credential_id = ?`,
          )
          .run(passkey.signCount, passkey.backedUp ? 1 : 0, now, passkey.credentialId);
      }
      this.database
        .prepare(
          `INSERT INTO devices (id, owner_id, revision, label, status, first_seen_at, last_seen_at)
           VALUES (?, ?, 0, ?, 'active', ?, ?)`,
        )
        .run(device.webDeviceId, input.ownerId, device.name, now, now);
      this.database
        .prepare(
          `INSERT INTO product_sessions
             (id, owner_id, device_id, revision, authentication_ref, status,
              first_authenticated_at, last_active_at, recent_authenticated_at, revoked_at)
           VALUES (?, ?, ?, 0, ?, 'active', ?, ?, ?, NULL)`,
        )
        .run(
          device.webSessionId,
          input.ownerId,
          device.webDeviceId,
          device.webAuthenticationRef,
          now,
          now,
          INTERNAL_SESSION_NEVER_RECENTLY_AUTHENTICATED,
        );
      this.database
        .prepare(
          `INSERT INTO paired_devices
             (id, owner_id, agent_id, revision, kind, name, release_channel, device_public_key,
              confirm_public_key, status, supported_actions, web_device_id, web_session_id,
              paired_at, confirmed_at)
           VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, 'active', '[]', ?, ?, ?, ?)`,
        )
        .run(
          device.id,
          input.ownerId,
          input.agentId,
          device.kind,
          device.name,
          device.releaseChannel,
          device.devicePublicKey,
          device.confirmPublicKey,
          device.webDeviceId,
          device.webSessionId,
          now,
          now,
        );
      return { kind: "signed_in", device: this.requireDevice(device.id) };
    })();
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
      disablePushForRevokedDevices(this.database, [device.id], now);
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
      const inserted = this.database
        .prepare(
          `INSERT INTO device_request_nonces (device_id, nonce, expires_at)
           SELECT ?, ?, ?
            WHERE (SELECT COUNT(*) FROM device_request_nonces WHERE device_id = ?) < ?
           ON CONFLICT (device_id, nonce) DO NOTHING`,
        )
        .run(input.deviceId, input.nonce, expiresAt, input.deviceId, input.maximumRetained);
      if (inserted.changes === 1) return "accepted";
      const seen = this.database
        .prepare("SELECT 1 FROM device_request_nonces WHERE device_id = ? AND nonce = ?")
        .get(input.deviceId, input.nonce);
      return seen ? "replayed" : "full";
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
