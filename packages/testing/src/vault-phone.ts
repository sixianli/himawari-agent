import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";

const FORMAT = "himawari-vault-v1";

export interface VaultPhoneItemSpec {
  readonly name: string;
  readonly kind: "login" | "api_key";
  readonly origins: readonly string[];
  readonly values: Readonly<Record<string, string>>;
  readonly backgroundAllowed?: boolean;
}

export interface VaultPhoneUploadedItem {
  readonly id: string;
  readonly name: string;
  readonly kind: "login" | "api_key";
  readonly origins: readonly string[];
  readonly fields: readonly string[];
  readonly version: number;
  readonly backgroundAllowed: boolean;
  readonly wrappedKey: string;
  readonly ciphertexts: Readonly<Record<string, string>>;
}

export interface VaultPhoneChange {
  readonly expectedManifestVersion: number;
  readonly manifest: { readonly version: number; readonly signature: string };
  readonly upserts: readonly VaultPhoneUploadedItem[];
  readonly deletes: readonly string[];
  readonly rotation: boolean;
}

export interface VaultPhonePendingRequest {
  readonly id: string;
  readonly nonce: string;
  readonly itemIds: readonly string[];
  readonly itemVersions: readonly number[];
  readonly origin: string;
  readonly pageVersion: string | null;
  readonly ephemeralPublicKey: string;
  readonly expiresAt: string;
}

const PHONE_ONLY = new Set(["totp"]);

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function vaultAesGcmSeal(key: Uint8Array, plaintext: Uint8Array, aad: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64");
}

function derive(master: Uint8Array, info: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", master, Buffer.from(FORMAT, "utf8"), Buffer.from(info, "utf8"), 32),
  );
}

export function vaultItemId(): string {
  return `vi_${randomBytes(16).toString("base64url")}`;
}

export function vaultManifestBytes(
  version: number,
  items: readonly VaultPhoneUploadedItem[],
): Buffer {
  const lines = [...items]
    .sort((left, right) => (left.id < right.id ? -1 : 1))
    .map((item) =>
      [
        item.id,
        Buffer.from(item.name, "utf8").toString("base64"),
        item.kind,
        [...item.origins].sort().join(","),
        [...item.fields].sort().join(","),
        String(item.version),
        item.backgroundAllowed ? "1" : "0",
      ].join("\t"),
    );
  return Buffer.from([`${FORMAT} manifest`, `version ${version}`, ...lines].join("\n"), "utf8");
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(text: string): Buffer {
  let buffer = 0;
  let bits = 0;
  const output: number[] = [];
  for (const character of text.toUpperCase().replace(/[=\s-]/gu, "")) {
    const value = BASE32.indexOf(character);
    if (value < 0) throw new Error("VAULT_TEST_PHONE_TOTP_SEED");
    buffer = ((buffer << 5) | value) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
    }
  }
  return Buffer.from(output);
}

export function totpCode(seed: string, at: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30)));
  const digest = createHmac("sha1", base32Decode(seed)).update(counter).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, "0");
}

export class VaultTestPhone {
  #master: Buffer;
  readonly #items = new Map<
    string,
    { upload: VaultPhoneUploadedItem; itemKey: Buffer; values: Record<string, string> }
  >();
  #manifestVersion = 0;
  readonly #suite = new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });

  constructor(master: Buffer = randomBytes(32)) {
    this.#master = master;
  }

  get manifestVersion(): number {
    return this.#manifestVersion;
  }

  #seal(
    id: string,
    spec: VaultPhoneItemSpec,
    version: number,
    itemKey: Buffer,
  ): VaultPhoneUploadedItem {
    const fields = Object.keys(spec.values).sort();
    const ciphertexts: Record<string, string> = {};
    for (const field of fields) {
      const key = PHONE_ONLY.has(field) ? derive(this.#master, `phone-only|${id}`) : itemKey;
      ciphertexts[field] = vaultAesGcmSeal(
        key,
        Buffer.from(spec.values[field] as string, "utf8"),
        `${FORMAT}|field|${id}|${field}|${version}`,
      );
    }
    return Object.freeze({
      id,
      name: spec.name,
      kind: spec.kind,
      origins: [...spec.origins].sort(),
      fields,
      version,
      backgroundAllowed: spec.backgroundAllowed ?? false,
      wrappedKey: vaultAesGcmSeal(
        derive(this.#master, "item-key"),
        itemKey,
        `${FORMAT}|item-key|${id}|${version}`,
      ),
      ciphertexts: Object.freeze(ciphertexts),
    });
  }

  #change(
    upserts: VaultPhoneUploadedItem[],
    deletes: string[],
    rotation: boolean,
  ): VaultPhoneChange {
    const expected = this.#manifestVersion;
    const version = expected + 1;
    const items = [...this.#items.values()].map((entry) => entry.upload);
    const signature = createHmac("sha256", derive(this.#master, "manifest"))
      .update(vaultManifestBytes(version, items))
      .digest("base64");
    this.#manifestVersion = version;
    return {
      expectedManifestVersion: expected,
      manifest: { version, signature },
      upserts,
      deletes,
      rotation,
    };
  }

  add(spec: VaultPhoneItemSpec): { readonly id: string; readonly change: VaultPhoneChange } {
    const id = vaultItemId();
    const itemKey = randomBytes(32);
    const upload = this.#seal(id, spec, 1, itemKey);
    this.#items.set(id, { upload, itemKey, values: { ...spec.values } });
    return { id, change: this.#change([upload], [], false) };
  }

  remove(id: string): VaultPhoneChange {
    this.#items.delete(id);
    return this.#change([], [id], false);
  }

  rotate(): VaultPhoneChange {
    this.#master = randomBytes(32);
    const upserts: VaultPhoneUploadedItem[] = [];
    for (const [id, entry] of this.#items) {
      const itemKey = randomBytes(32);
      const upload = this.#seal(
        id,
        {
          name: entry.upload.name,
          kind: entry.upload.kind,
          origins: entry.upload.origins,
          values: entry.values,
          backgroundAllowed: entry.upload.backgroundAllowed,
        },
        entry.upload.version + 1,
        itemKey,
      );
      this.#items.set(id, { upload, itemKey, values: entry.values });
      upserts.push(upload);
    }
    return this.#change(upserts, [], true);
  }

  manifestSignatureValid(
    version: number,
    items: readonly VaultPhoneUploadedItem[],
    signature: string,
  ): boolean {
    const expected = createHmac("sha256", derive(this.#master, "manifest"))
      .update(vaultManifestBytes(version, items))
      .digest("base64");
    return version >= this.#manifestVersion && expected === signature;
  }

  async approval(input: {
    readonly request: VaultPhonePendingRequest;
    readonly deviceId: string;
    readonly now?: number;
    readonly overrideItemKey?: Buffer;
  }): Promise<Record<string, unknown>> {
    const { request } = input;
    const sealed = [];
    for (const [index, itemId] of request.itemIds.entries()) {
      const entry = this.#items.get(itemId);
      if (!entry) throw new Error("VAULT_TEST_PHONE_UNKNOWN_ITEM");
      if (!entry.upload.origins.includes(request.origin))
        throw new Error("VAULT_TEST_PHONE_ORIGIN");
      const version = request.itemVersions[index] as number;
      const at = Math.floor((input.now ?? Date.now()) / 30_000) * 30;
      const seed = entry.values["totp"];
      const payload = {
        itemKey: (input.overrideItemKey ?? entry.itemKey).toString("base64"),
        ...(seed === undefined
          ? {}
          : {
              totp: [0, 30, 60, 90].map((offset) => ({
                at: at + offset,
                code: totpCode(seed, at + offset),
              })),
            }),
      };
      const sender = await this.#suite.createSenderContext({
        recipientPublicKey: await this.#suite.kem.deserializePublicKey(
          toArrayBuffer(Buffer.from(request.ephemeralPublicKey, "base64")),
        ),
        info: toArrayBuffer(Buffer.from(`${FORMAT} release`, "utf8")),
      });
      const ciphertext = await sender.seal(
        toArrayBuffer(Buffer.from(JSON.stringify(payload), "utf8")),
        toArrayBuffer(Buffer.from(`${FORMAT}|release|${request.id}|${itemId}|${version}`, "utf8")),
      );
      sealed.push({
        itemId,
        enc: Buffer.from(sender.enc).toString("base64"),
        ciphertext: Buffer.from(ciphertext).toString("base64"),
      });
    }
    return {
      requestId: request.id,
      nonce: request.nonce,
      deviceId: input.deviceId,
      itemIds: request.itemIds,
      itemVersions: request.itemVersions,
      origin: request.origin,
      pageVersion: request.pageVersion,
      ephemeralPublicKey: request.ephemeralPublicKey,
      expiresAt: request.expiresAt,
      sealed,
    };
  }

  fingerprint(): string {
    return createHash("sha256").update(this.#master).digest("hex").slice(0, 16);
  }
}

export function vaultCanaryForms(canary: string): readonly string[] {
  const bytes = Buffer.from(canary, "utf8");
  return Object.freeze([
    canary,
    bytes.toString("base64").replace(/=+$/u, ""),
    bytes.toString("base64url"),
    bytes.toString("hex"),
    bytes.toString("hex").toUpperCase(),
    encodeURIComponent(canary),
    JSON.stringify(canary).slice(1, -1),
  ]);
}

export function findVaultCanary(haystack: string | Uint8Array, canary: string): string | undefined {
  const text = typeof haystack === "string" ? haystack : Buffer.from(haystack).toString("latin1");
  const utf8 = typeof haystack === "string" ? haystack : Buffer.from(haystack).toString("utf8");
  for (const form of vaultCanaryForms(canary)) {
    const latin = Buffer.from(form, "utf8").toString("latin1");
    if (text.includes(latin) || utf8.includes(form)) return form;
  }
  return undefined;
}
