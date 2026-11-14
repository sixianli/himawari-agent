import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type DeviceConfiguration,
  type GatewayAuthenticationContext,
  PAIRED_DEVICE_KINDS,
  PAIRED_DEVICE_RELEASE_CHANNELS,
  PAIRING_CODE_LIFETIME_MILLISECONDS,
  type PairedDevice,
  type PairedDeviceKind,
  type PairedDeviceReleaseChannel,
  type PairedDeviceScope,
  type PairedDeviceStorePort,
  type SessionDeviceStatePort,
} from "@himawari-agent/application";
import { normalizeDeviceName } from "@himawari-agent/gateway-contracts";
import {
  DEVICE_SIGNATURE_ERROR_CODES,
  DeviceSignatureError,
  type DeviceSignedRequest,
  publicKeyFromSpkiBase64,
  verifyDeviceRequest,
} from "./device-request-signature.js";

export const PAIRED_DEVICE_ERROR_CODES = Object.freeze({
  PAIRING_REQUEST_INVALID: "DEVICE_PAIRING_REQUEST_INVALID",
  PAIRING_CODE_INVALID: "DEVICE_PAIRING_CODE_INVALID",
  PAIRING_CODE_EXPIRED: "DEVICE_PAIRING_CODE_EXPIRED",
  PAIRING_CODE_USED: "DEVICE_PAIRING_CODE_USED",
  DEVICE_PENDING: "DEVICE_PENDING",
  DEVICE_REVOKED: "DEVICE_REVOKED",
  OWNER_INACTIVE: "DEVICE_OWNER_INACTIVE",
  NONCE_REPLAYED: "DEVICE_NONCE_REPLAYED",
  NONCE_STORE_FULL: "DEVICE_NONCE_STORE_FULL",
  STREAM_LIMIT: "DEVICE_STREAM_LIMIT",
  PATH_NOT_ALLOWED: "DEVICE_PATH_NOT_ALLOWED",
  BODY_TOO_LARGE: "DEVICE_BODY_TOO_LARGE",
  CHALLENGE_INVALID: "DEVICE_CHALLENGE_INVALID",
} as const);

export type PairedDeviceErrorCode =
  (typeof PAIRED_DEVICE_ERROR_CODES)[keyof typeof PAIRED_DEVICE_ERROR_CODES];

export class PairedDeviceError extends Error {
  readonly code: PairedDeviceErrorCode;
  readonly statusCode: number;
  readonly details: Readonly<Record<string, number>>;

  constructor(
    code: PairedDeviceErrorCode,
    statusCode: number,
    details: Readonly<Record<string, number>> = {},
  ) {
    super(code);
    this.name = "PairedDeviceError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export interface PairedDeviceOwnerDirectory {
  ownerOf(deviceId: string): Promise<PairedDeviceScope | undefined>;
}

export interface PairedDeviceServiceOptions {
  readonly store: PairedDeviceStorePort;
  readonly sessions: SessionDeviceStatePort;
  readonly configuration: () => DeviceConfiguration;
  readonly ownerActive: (scope: PairedDeviceScope) => Promise<boolean>;
  readonly owners?: PairedDeviceOwnerDirectory;
  readonly ownerSubject?: (scope: PairedDeviceScope) => Promise<string | undefined>;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Buffer;
  readonly onWarning?: (warning: PairedDeviceWarning) => void;
}

export interface PairedDeviceWarning {
  readonly event: "device.nonce_store_full";
  readonly deviceId: string;
  readonly retained: number;
}

const WARNING_INTERVAL_MILLISECONDS = 60_000;

export interface AuthenticatedDeviceRequest {
  readonly device: PairedDevice;
  readonly confirmed: boolean;
  readonly authentication: GatewayAuthenticationContext;
}

const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const SPKI_PATTERN = /^[A-Za-z0-9+/]{80,200}={0,2}$/u;

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function sha256Ref(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

const CHALLENGE_RANDOM_BYTES = 12;
const CHALLENGE_MAC_BYTES = 18;
const CHALLENGE_BYTES = 4 + CHALLENGE_RANDOM_BYTES + CHALLENGE_MAC_BYTES;

function canonicalSpki(value: string): string {
  return publicKeyFromSpkiBase64(value).export({ format: "der", type: "spki" }).toString("base64");
}

export class PairedDeviceService {
  readonly #options: PairedDeviceServiceOptions;
  readonly #warnedAt = new Map<string, number>();
  readonly #owners: PairedDeviceOwnerDirectory;
  readonly #challengeKey: Buffer;

  constructor(options: PairedDeviceServiceOptions) {
    this.#options = options;
    this.#challengeKey = (options.randomBytes ?? randomBytes)(32);
    this.#owners = options.owners ?? {
      ownerOf: async (deviceId) => {
        const device = await options.store.readDevice(deviceId);
        return device ? { ownerId: device.ownerId, agentId: device.agentId } : undefined;
      },
    };
  }

  #now(): Date {
    return (this.#options.now ?? (() => new Date()))();
  }

  #random(size: number): Buffer {
    return (this.#options.randomBytes ?? randomBytes)(size);
  }

  async startPairing(
    scope: PairedDeviceScope & { readonly sessionId: string },
  ): Promise<{ readonly code: string; readonly expiresAt: string }> {
    return this.startPairingWithCode({
      ...scope,
      code: this.#random(16).toString("base64url"),
    });
  }

  async startPairingWithCode(
    input: PairedDeviceScope & { readonly sessionId: string; readonly code: string },
  ): Promise<{ readonly code: string; readonly expiresAt: string }> {
    if (!PAIRING_CODE_PATTERN.test(input.code) || !/[AQgw]$/u.test(input.code))
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.PAIRING_REQUEST_INVALID, 400);
    const { code } = input;
    const scope = input;
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_LIFETIME_MILLISECONDS).toISOString();
    const created = await this.#options.store.createPairingCode({
      ownerId: scope.ownerId,
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      codeHash: hashCode(code),
      now: now.toISOString(),
      expiresAt,
    });
    return Object.freeze({ code, expiresAt: created.expiresAt });
  }

  async pair(
    body: unknown,
  ): Promise<{ readonly device: PairedDevice; readonly replayed: boolean }> {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.PAIRING_REQUEST_INVALID, 400);
    const input = body as Record<string, unknown>;
    const keys = [
      "pairingCode",
      "kind",
      "name",
      "releaseChannel",
      "devicePublicKey",
      "confirmPublicKey",
    ];
    const name = normalizeDeviceName(input["name"]);
    if (
      !hasOnlyKeys(input, keys) ||
      typeof input["pairingCode"] !== "string" ||
      !PAIRING_CODE_PATTERN.test(input["pairingCode"]) ||
      !(PAIRED_DEVICE_KINDS as readonly unknown[]).includes(input["kind"]) ||
      !(PAIRED_DEVICE_RELEASE_CHANNELS as readonly unknown[]).includes(input["releaseChannel"]) ||
      name === null ||
      typeof input["devicePublicKey"] !== "string" ||
      typeof input["confirmPublicKey"] !== "string" ||
      !SPKI_PATTERN.test(input["devicePublicKey"]) ||
      !SPKI_PATTERN.test(input["confirmPublicKey"]) ||
      input["devicePublicKey"] === input["confirmPublicKey"]
    )
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.PAIRING_REQUEST_INVALID, 400);
    let devicePublicKey: string;
    let confirmPublicKey: string;
    try {
      devicePublicKey = canonicalSpki(input["devicePublicKey"]);
      confirmPublicKey = canonicalSpki(input["confirmPublicKey"]);
    } catch {
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.PAIRING_REQUEST_INVALID, 400);
    }
    if (devicePublicKey === confirmPublicKey)
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.PAIRING_REQUEST_INVALID, 400);
    const result = await this.#options.store.redeemPairingCode({
      codeHash: hashCode(input["pairingCode"]),
      now: this.#now().toISOString(),
      device: {
        id: `dev_${this.#random(16).toString("base64url")}`,
        kind: input["kind"] as PairedDeviceKind,
        name,
        releaseChannel: input["releaseChannel"] as PairedDeviceReleaseChannel,
        devicePublicKey,
        confirmPublicKey,
      },
    });
    switch (result.kind) {
      case "paired":
        return { device: result.device, replayed: false };
      case "replayed":
        if (result.device.status === "revoked")
          throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.DEVICE_REVOKED, 403);
        return { device: result.device, replayed: true };
      case "code_expired":
        throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.PAIRING_CODE_EXPIRED, 410, {
          pairingCodeTtlSeconds: PAIRING_CODE_LIFETIME_MILLISECONDS / 1000,
        });
      case "code_used":
        throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.PAIRING_CODE_USED, 409);
      default:
        throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.PAIRING_CODE_INVALID, 404);
    }
  }

  openPairing(scope: PairedDeviceScope): Promise<{ readonly expiresAt: string } | undefined> {
    return this.#options.store.readOpenPairingCode({ ...scope, now: this.#now().toISOString() });
  }

  list(scope: PairedDeviceScope): Promise<readonly PairedDevice[]> {
    return this.#options.store.listDevices(scope);
  }

  confirm(
    scope: PairedDeviceScope & { readonly deviceId: string; readonly expectedRevision: number },
  ): Promise<PairedDevice> {
    return this.#options.store.confirmDevice({
      ...scope,
      now: this.#now().toISOString(),
      webDeviceId: `device:${this.#random(16).toString("hex")}`,
      webSessionId: `session:${this.#random(16).toString("hex")}`,
      webAuthenticationRef: sha256Ref(this.#random(32).toString("base64url")),
    });
  }

  rename(
    scope: PairedDeviceScope & {
      readonly deviceId: string;
      readonly expectedRevision: number;
      readonly name: string;
    },
  ): Promise<PairedDevice> {
    const name = normalizeDeviceName(scope.name);
    if (name === null)
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.PAIRING_REQUEST_INVALID, 400);
    return this.#options.store.renameDevice({ ...scope, name });
  }

  async revoke(
    scope: PairedDeviceScope & { readonly deviceId: string; readonly expectedRevision: number },
  ): Promise<PairedDevice> {
    const device = await this.#options.store.revokeDevice({
      ...scope,
      now: this.#now().toISOString(),
    });
    this.#warnedAt.delete(device.id);
    return device;
  }

  #challengeMac(deviceId: string, head: Buffer): Buffer {
    return createHmac("sha256", this.#challengeKey)
      .update(deviceId)
      .update("\n")
      .update(head)
      .digest()
      .subarray(0, CHALLENGE_MAC_BYTES);
  }

  issueConfirmChallenge(deviceId: string): {
    readonly challenge: string;
    readonly expiresAt: string;
  } {
    const now = this.#now();
    const expiresAtSeconds =
      Math.floor(now.getTime() / 1000) + this.#options.configuration().signatureToleranceSeconds;
    const head = Buffer.alloc(4 + CHALLENGE_RANDOM_BYTES);
    head.writeUInt32BE(expiresAtSeconds, 0);
    this.#random(CHALLENGE_RANDOM_BYTES).copy(head, 4);
    return Object.freeze({
      challenge: Buffer.concat([head, this.#challengeMac(deviceId, head)]).toString("base64url"),
      expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    });
  }

  #challengeValid(deviceId: string, challenge: string, now: Date): boolean {
    const bytes = Buffer.from(challenge, "base64url");
    if (bytes.length !== CHALLENGE_BYTES || bytes.toString("base64url") !== challenge) return false;
    const head = bytes.subarray(0, 4 + CHALLENGE_RANDOM_BYTES);
    const mac = bytes.subarray(4 + CHALLENGE_RANDOM_BYTES);
    if (!timingSafeEqual(mac, this.#challengeMac(deviceId, head))) return false;
    return Math.floor(now.getTime() / 1000) <= head.readUInt32BE(0);
  }

  async authenticate(input: {
    readonly request: DeviceSignedRequest;
    readonly expectedAuthority: string;
    readonly requireConfirm?: boolean;
  }): Promise<AuthenticatedDeviceRequest> {
    const configuration = this.#options.configuration();
    const now = this.#now();
    let device: PairedDevice | undefined;
    const verified = await verifyDeviceRequest({
      request: input.request,
      expectedAuthority: input.expectedAuthority,
      toleranceSeconds: configuration.signatureToleranceSeconds,
      now,
      requireConfirm: input.requireConfirm ?? false,
      lookupKeys: async (deviceId) => {
        const scope = await this.#owners.ownerOf(deviceId);
        if (!scope) return undefined;
        if (!(await this.#options.ownerActive(scope)))
          throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.OWNER_INACTIVE, 403);
        device = await this.#options.store.readDevice(deviceId);
        if (!device || device.ownerId !== scope.ownerId || device.agentId !== scope.agentId)
          return undefined;
        return {
          device: publicKeyFromSpkiBase64(device.devicePublicKey),
          confirm: publicKeyFromSpkiBase64(device.confirmPublicKey),
        };
      },
    });
    const current = device as PairedDevice | undefined;
    if (!current) throw new DeviceSignatureError(DEVICE_SIGNATURE_ERROR_CODES.KEY_UNKNOWN);
    if (verified.confirmed && !this.#challengeValid(current.id, verified.nonce, now))
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.CHALLENGE_INVALID, 401);
    if (current.status === "revoked")
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.DEVICE_REVOKED, 403);
    if (current.status !== "active" || current.webSessionId === null)
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.DEVICE_PENDING, 403);
    const nonce = await this.#options.store.recordNonce({
      deviceId: current.id,
      nonce: verified.nonce,
      now: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + 2 * configuration.signatureToleranceSeconds * 1000,
      ).toISOString(),
      maximumRetained: configuration.limits["device.nonce.retained"],
    });
    if (nonce === "replayed")
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.NONCE_REPLAYED, 401);
    if (nonce === "full") {
      const warned = this.#warnedAt.get(current.id);
      if (warned === undefined || now.getTime() - warned >= WARNING_INTERVAL_MILLISECONDS) {
        this.#warnedAt.set(current.id, now.getTime());
        this.#options.onWarning?.({
          event: "device.nonce_store_full",
          deviceId: current.id,
          retained: configuration.limits["device.nonce.retained"],
        });
      }
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.NONCE_STORE_FULL, 429);
    }
    const session = await this.#options.sessions.readSession(
      current.webSessionId as Parameters<SessionDeviceStatePort["readSession"]>[0],
    );
    if (!session || session.status !== "active" || session.ownerId !== current.ownerId)
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.DEVICE_REVOKED, 403);
    await this.#options.store.touchDevice({ deviceId: current.id, now: now.toISOString() });
    const authentication: GatewayAuthenticationContext = {
      subjectId: current.ownerId,
      ownerId: current.ownerId,
      deviceId: session.deviceId,
      authenticatedAt: now.toISOString(),
      authenticationRef: session.authenticationRef,
      sessionId: session.id,
    };
    const externalSubjectRef = verified.confirmed
      ? await this.#options.ownerSubject?.({ ownerId: current.ownerId, agentId: current.agentId })
      : undefined;
    return Object.freeze({
      device: current,
      confirmed: verified.confirmed,
      authentication: Object.freeze(
        externalSubjectRef
          ? {
              ...authentication,
              recentAuthenticationEvidence: Object.freeze({
                source: "device_confirmation_key" as const,
                externalSubjectRef,
                ownerId: session.ownerId,
                deviceId: session.deviceId,
                authenticationRef: session.authenticationRef,
                authenticatedAt: now.toISOString(),
                expiresAt: new Date(
                  now.getTime() + configuration.signatureToleranceSeconds * 1000,
                ).toISOString(),
              }),
            }
          : authentication,
      ),
    });
  }

  async stillActive(deviceId: string): Promise<boolean> {
    const device = await this.#options.store.readDevice(deviceId);
    if (!device || device.status !== "active" || device.webSessionId === null) return false;
    if (!(await this.#options.ownerActive({ ownerId: device.ownerId, agentId: device.agentId })))
      return false;
    const session = await this.#options.sessions.readSession(
      device.webSessionId as Parameters<SessionDeviceStatePort["readSession"]>[0],
    );
    return session?.status === "active" && session.ownerId === device.ownerId;
  }
}
