import { createHash, randomBytes, randomInt } from "node:crypto";
import { constants } from "node:fs";
import { chown, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  type OwnerPasskey,
  PAIRED_DEVICE_KINDS,
  PAIRED_DEVICE_RELEASE_CHANNELS,
  type PairedDevice,
  type PairedDeviceKind,
  type PairedDeviceReleaseChannel,
  type PairedDeviceScope,
  type PairedDeviceStorePort,
} from "@himawari-agent/application";
import { normalizeDeviceName } from "@himawari-agent/gateway-contracts";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { publicKeyFromSpkiBase64 } from "./device-request-signature.js";
import { PAIRED_DEVICE_ERROR_CODES, PairedDeviceError } from "./paired-device-service.js";

export const SETUP_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const SETUP_CODE_LENGTH = 8;
export const SETUP_CODE_GROUP_SIZE = 4;
export const SETUP_CODE_DEFAULT_MINUTES = 15;
export const SETUP_CODE_MAXIMUM_MINUTES = 24 * 60;
export const SETUP_CODE_WRONG_ATTEMPTS = 5;
export const SETUP_CODE_LOCK_SECONDS = 15 * 60;
export const SIGN_IN_FLOW_SECONDS = 5 * 60;
export const SIGN_IN_FLOW_MAXIMUM_OPEN = 32;

const SETUP_CODE_DIRECTORY = "sign-in";
const SETUP_CODE_FILE = "setup-code.json";
const SPKI_PATTERN = /^[A-Za-z0-9+/]{80,200}={0,2}$/u;
const FLOW_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const SETUP_CODE_FILE_BYTES = 1024;

export interface SetupCodeRecord {
  readonly codeHash: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface SetupCodeSource {
  read(): Promise<SetupCodeRecord | undefined>;
  discard(codeHash: string): Promise<void>;
}

export function hashSetupCode(code: string): string {
  return createHash("sha256").update(`himawari-setup-code-v1\n${code}`).digest("hex");
}

export function normalizeSetupCode(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const code = value.replace(/[\s-]/gu, "").toUpperCase();
  if (code.length !== SETUP_CODE_LENGTH) return undefined;
  return [...code].every((character) => SETUP_CODE_ALPHABET.includes(character)) ? code : undefined;
}

export function generateSetupCode(): string {
  let code = "";
  for (let index = 0; index < SETUP_CODE_LENGTH; index += 1)
    code += SETUP_CODE_ALPHABET[randomInt(SETUP_CODE_ALPHABET.length)];
  return code;
}

export function displaySetupCode(code: string): string {
  const groups: string[] = [];
  for (let index = 0; index < code.length; index += SETUP_CODE_GROUP_SIZE)
    groups.push(code.slice(index, index + SETUP_CODE_GROUP_SIZE));
  return groups.join("-");
}

function setupCodePath(stateRoot: string): string {
  return path.join(stateRoot, SETUP_CODE_DIRECTORY, SETUP_CODE_FILE);
}

function validRecord(value: unknown): value is SetupCodeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const time = (key: string) =>
    typeof record[key] === "string" &&
    Number.isFinite(Date.parse(record[key] as string)) &&
    new Date(record[key] as string).toISOString() === record[key];
  return (
    typeof record["codeHash"] === "string" &&
    /^[0-9a-f]{64}$/u.test(record["codeHash"]) &&
    typeof record["ownerId"] === "string" &&
    typeof record["agentId"] === "string" &&
    time("createdAt") &&
    time("expiresAt")
  );
}

export class FileSetupCodeSource implements SetupCodeSource {
  readonly #file: string;

  constructor(stateRoot: string) {
    this.#file = setupCodePath(stateRoot);
  }

  async read(): Promise<SetupCodeRecord | undefined> {
    let text: string;
    try {
      const info = await lstat(this.#file);
      if (!info.isFile() || info.size > SETUP_CODE_FILE_BYTES) return undefined;
      text = await readFile(this.#file, {
        encoding: "utf8",
        flag: constants.O_RDONLY | constants.O_NOFOLLOW,
      });
    } catch {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return validRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async discard(codeHash: string): Promise<void> {
    const current = await this.read();
    if (current?.codeHash === codeHash) await rm(this.#file, { force: true });
  }
}

export async function writeSetupCode(input: {
  readonly stateRoot: string;
  readonly scope: PairedDeviceScope;
  readonly code: string;
  readonly now: Date;
  readonly minutes: number;
}): Promise<SetupCodeRecord> {
  const root = await lstat(input.stateRoot);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error("SETUP_CODE_STATE_ROOT_INVALID");
  const uid = process.getuid?.();
  if (uid !== undefined && uid !== 0 && uid !== root.uid) throw new Error("SETUP_CODE_WRONG_USER");
  const directory = path.join(input.stateRoot, SETUP_CODE_DIRECTORY);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error("SETUP_CODE_DIRECTORY_INVALID");
  if (uid === 0) await chown(directory, root.uid, root.gid);
  const record: SetupCodeRecord = {
    codeHash: hashSetupCode(input.code),
    ownerId: input.scope.ownerId,
    agentId: input.scope.agentId,
    createdAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + input.minutes * 60_000).toISOString(),
  };
  const temporary = path.join(directory, `.${randomBytes(8).toString("hex")}.tmp`);
  const file = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(record));
    await file.sync();
  } finally {
    await file.close();
  }
  if (uid === 0) await chown(temporary, root.uid, root.gid);
  await rename(temporary, setupCodePath(input.stateRoot));
  return record;
}

interface DeviceFields {
  readonly kind: PairedDeviceKind;
  readonly name: string;
  readonly releaseChannel: PairedDeviceReleaseChannel;
  readonly devicePublicKey: string;
  readonly confirmPublicKey: string;
}

interface OpenFlow {
  readonly kind: "setup" | "sign-in";
  readonly challenge: string;
  readonly device: DeviceFields;
  readonly codeHash: string | null;
  readonly expiresAt: number;
}

export interface DeviceSignInServiceOptions {
  readonly scope: PairedDeviceScope;
  readonly store: PairedDeviceStorePort;
  readonly publicOrigin: URL;
  readonly setupCodes: SetupCodeSource;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Buffer;
  readonly onSignedIn?: (device: PairedDevice) => void;
}

function canonicalSpki(value: string): string {
  return publicKeyFromSpkiBase64(value).export({ format: "der", type: "spki" }).toString("base64");
}

function invalidRequest(): never {
  throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.PAIRING_REQUEST_INVALID, 400);
}

function sha256Ref(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function parseSignInDevice(value: unknown): DeviceFields {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidRequest();
  const input = value as Record<string, unknown>;
  const keys = ["kind", "name", "releaseChannel", "devicePublicKey", "confirmPublicKey"];
  const name = normalizeDeviceName(input["name"]);
  if (
    Object.keys(input).some((key) => !keys.includes(key)) ||
    !(PAIRED_DEVICE_KINDS as readonly unknown[]).includes(input["kind"]) ||
    !(PAIRED_DEVICE_RELEASE_CHANNELS as readonly unknown[]).includes(input["releaseChannel"]) ||
    name === null ||
    typeof input["devicePublicKey"] !== "string" ||
    typeof input["confirmPublicKey"] !== "string" ||
    !SPKI_PATTERN.test(input["devicePublicKey"]) ||
    !SPKI_PATTERN.test(input["confirmPublicKey"])
  )
    return invalidRequest();
  let devicePublicKey: string;
  let confirmPublicKey: string;
  try {
    devicePublicKey = canonicalSpki(input["devicePublicKey"]);
    confirmPublicKey = canonicalSpki(input["confirmPublicKey"]);
  } catch {
    return invalidRequest();
  }
  if (devicePublicKey === confirmPublicKey) return invalidRequest();
  return {
    kind: input["kind"] as PairedDeviceKind,
    name,
    releaseChannel: input["releaseChannel"] as PairedDeviceReleaseChannel,
    devicePublicKey,
    confirmPublicKey,
  };
}

function only(body: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(body).some((key) => !keys.includes(key))) invalidRequest();
}

export class DeviceSignInService {
  readonly #options: DeviceSignInServiceOptions;
  readonly #flows = new Map<string, OpenFlow>();
  #wrongAttempts = 0;
  #lockedUntil = 0;

  constructor(options: DeviceSignInServiceOptions) {
    this.#options = options;
  }

  #now(): Date {
    return (this.#options.now ?? (() => new Date()))();
  }

  #random(size: number): Buffer {
    return (this.#options.randomBytes ?? randomBytes)(size);
  }

  get #rpId(): string {
    return this.#options.publicOrigin.hostname;
  }

  publicInfo() {
    return {
      rpId: this.#rpId,
      setupCode: {
        length: SETUP_CODE_LENGTH,
        groupSize: SETUP_CODE_GROUP_SIZE,
        alphabet: SETUP_CODE_ALPHABET,
      },
    };
  }

  #userId(): Uint8Array {
    return createHash("sha256")
      .update(
        `himawari-owner-passkey-v1\n${this.#options.scope.ownerId}\n${this.#options.scope.agentId}`,
      )
      .digest();
  }

  #open(flow: Omit<OpenFlow, "expiresAt">): string {
    const now = this.#now().getTime();
    for (const [id, open] of this.#flows) if (open.expiresAt <= now) this.#flows.delete(id);
    while (this.#flows.size >= SIGN_IN_FLOW_MAXIMUM_OPEN) {
      const oldest = this.#flows.keys().next().value;
      if (oldest === undefined) break;
      this.#flows.delete(oldest);
    }
    const flowId = this.#random(16).toString("base64url");
    this.#flows.set(flowId, { ...flow, expiresAt: now + SIGN_IN_FLOW_SECONDS * 1000 });
    return flowId;
  }

  #take(kind: OpenFlow["kind"], flowId: unknown): OpenFlow {
    if (typeof flowId !== "string" || !FLOW_ID_PATTERN.test(flowId)) return invalidRequest();
    const flow = this.#flows.get(flowId);
    this.#flows.delete(flowId);
    if (!flow || flow.kind !== kind || flow.expiresAt <= this.#now().getTime())
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.SIGN_IN_FLOW_EXPIRED, 410);
    return flow;
  }

  async #activeSetupCode(): Promise<SetupCodeRecord | undefined> {
    const record = await this.#options.setupCodes.read();
    if (
      !record ||
      record.ownerId !== this.#options.scope.ownerId ||
      record.agentId !== this.#options.scope.agentId ||
      Date.parse(record.expiresAt) <= this.#now().getTime()
    )
      return undefined;
    return record;
  }

  async #checkSetupCode(value: unknown): Promise<string> {
    const now = this.#now().getTime();
    if (this.#lockedUntil > now)
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.SETUP_CODE_ATTEMPTS, 429, {
        retryAfterSeconds: Math.ceil((this.#lockedUntil - now) / 1000),
      });
    const code = normalizeSetupCode(value);
    if (typeof value !== "string") return invalidRequest();
    const record = await this.#activeSetupCode();
    if (!record) throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.SETUP_CODE_EXPIRED, 410);
    if (code === undefined || hashSetupCode(code) !== record.codeHash) {
      this.#wrongAttempts += 1;
      if (this.#wrongAttempts >= SETUP_CODE_WRONG_ATTEMPTS) {
        this.#wrongAttempts = 0;
        this.#lockedUntil = now + SETUP_CODE_LOCK_SECONDS * 1000;
        throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.SETUP_CODE_ATTEMPTS, 429, {
          retryAfterSeconds: SETUP_CODE_LOCK_SECONDS,
        });
      }
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.SETUP_CODE_INVALID, 401);
    }
    this.#wrongAttempts = 0;
    return record.codeHash;
  }

  async setupOptions(body: Record<string, unknown>) {
    only(body, ["setupCode", "device"]);
    const device = parseSignInDevice(body["device"]);
    const codeHash = await this.#checkSetupCode(body["setupCode"]);
    const passkeys = await this.#options.store.listPasskeys(this.#options.scope);
    const publicKey = await generateRegistrationOptions({
      rpName: "Himawari",
      rpID: this.#rpId,
      userName: `Himawari · ${this.#rpId}`,
      userDisplayName: "Himawari",
      userID: this.#userId() as Uint8Array<ArrayBuffer>,
      challenge: this.#random(32) as Uint8Array<ArrayBuffer>,
      timeout: SIGN_IN_FLOW_SECONDS * 1000,
      attestationType: "none",
      excludeCredentials: passkeys.map((passkey) => ({
        id: passkey.credentialId,
        transports: [...passkey.transports],
      })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    const flowId = this.#open({ kind: "setup", challenge: publicKey.challenge, device, codeHash });
    return { flowId, publicKey };
  }

  async setupFinish(body: Record<string, unknown>): Promise<PairedDevice> {
    only(body, ["flowId", "credential"]);
    const flow = this.#take("setup", body["flowId"]);
    const record = await this.#activeSetupCode();
    if (!record || record.codeHash !== flow.codeHash)
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.SETUP_CODE_EXPIRED, 410);
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response: body["credential"] as RegistrationResponseJSON,
        expectedChallenge: flow.challenge,
        expectedOrigin: this.#options.publicOrigin.origin,
        expectedRPID: this.#rpId,
        requireUserVerification: true,
      });
    } catch {
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.PASSKEY_REJECTED, 401);
    }
    if (!verification.verified)
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.PASSKEY_REJECTED, 401);
    const { credential, credentialBackedUp } = verification.registrationInfo;
    const result = await this.#options.store.signInDevice({
      ...this.#options.scope,
      now: this.#now().toISOString(),
      passkey: {
        kind: "created",
        setupCodeHash: record.codeHash,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        signCount: credential.counter,
        transports: credential.transports ?? [],
        backedUp: credentialBackedUp,
      },
      device: this.#newDevice(flow.device),
    });
    if (result.kind === "setup_code_used")
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.SETUP_CODE_EXPIRED, 410);
    if (result.kind !== "signed_in")
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.PASSKEY_REJECTED, 401);
    await this.#options.setupCodes.discard(record.codeHash).catch(() => undefined);
    this.#options.onSignedIn?.(result.device);
    return result.device;
  }

  async signInOptions(body: Record<string, unknown>) {
    only(body, ["device"]);
    const device = parseSignInDevice(body["device"]);
    const publicKey = await generateAuthenticationOptions({
      rpID: this.#rpId,
      challenge: this.#random(32) as Uint8Array<ArrayBuffer>,
      timeout: SIGN_IN_FLOW_SECONDS * 1000,
      userVerification: "required",
      allowCredentials: [],
    });
    const flowId = this.#open({
      kind: "sign-in",
      challenge: publicKey.challenge,
      device,
      codeHash: null,
    });
    return { flowId, publicKey };
  }

  async signInFinish(body: Record<string, unknown>): Promise<PairedDevice> {
    only(body, ["flowId", "credential"]);
    const flow = this.#take("sign-in", body["flowId"]);
    const response = body["credential"] as AuthenticationResponseJSON;
    const credentialId =
      response && typeof response === "object" && typeof response.id === "string"
        ? response.id
        : undefined;
    if (!credentialId || !/^[A-Za-z0-9_-]{16,1366}$/u.test(credentialId))
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.PASSKEY_REJECTED, 401);
    const passkey = await this.#options.store.readPasskey(credentialId);
    if (!this.#owned(passkey))
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.PASSKEY_REJECTED, 401);
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: flow.challenge,
        expectedOrigin: this.#options.publicOrigin.origin,
        expectedRPID: this.#rpId,
        credential: {
          id: passkey.credentialId,
          publicKey: Buffer.from(passkey.publicKey, "base64url") as Uint8Array<ArrayBuffer>,
          counter: passkey.signCount,
          transports: [...passkey.transports] as never,
        },
        requireUserVerification: true,
      });
    } catch {
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.PASSKEY_REJECTED, 401);
    }
    if (!verification.verified)
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.PASSKEY_REJECTED, 401);
    const result = await this.#options.store.signInDevice({
      ...this.#options.scope,
      now: this.#now().toISOString(),
      passkey: {
        kind: "used",
        credentialId: passkey.credentialId,
        signCount: verification.authenticationInfo.newCounter,
        backedUp: verification.authenticationInfo.credentialBackedUp,
      },
      device: this.#newDevice(flow.device),
    });
    if (result.kind !== "signed_in")
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.PASSKEY_REJECTED, 401);
    this.#options.onSignedIn?.(result.device);
    return result.device;
  }

  async firstPasskeyAt(): Promise<string | null> {
    const passkeys = await this.#options.store.listPasskeys(this.#options.scope);
    return passkeys[0]?.createdAt ?? null;
  }

  #owned(passkey: OwnerPasskey | undefined): passkey is OwnerPasskey {
    return (
      passkey !== undefined &&
      passkey.ownerId === this.#options.scope.ownerId &&
      passkey.agentId === this.#options.scope.agentId
    );
  }

  #newDevice(device: DeviceFields) {
    return {
      ...device,
      id: `dev_${this.#random(16).toString("base64url")}`,
      webDeviceId: `device:${this.#random(16).toString("hex")}`,
      webSessionId: `session:${this.#random(16).toString("hex")}`,
      webAuthenticationRef: sha256Ref(this.#random(32).toString("base64url")),
    };
  }
}
