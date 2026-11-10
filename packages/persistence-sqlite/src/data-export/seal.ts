import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { canonicalJson, type JsonValue } from "./canonical.js";

export const SEAL_MAGIC = "HIMAWARI-SEAL-1";
const SCRYPT_COST = 32768;
const SCRYPT_BLOCK = 8;
const SCRYPT_PARALLEL = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAXIMUM_MEMORY = 128 * 1024 * 1024;

export const SEAL_ERROR_CODES = Object.freeze({
  PASSPHRASE_REQUIRED: "DATA_EXPORT_SEAL_PASSPHRASE_REQUIRED",
  UNREADABLE: "DATA_EXPORT_SEAL_UNREADABLE",
  AUTHENTICATION_FAILED: "DATA_EXPORT_SEAL_AUTHENTICATION_FAILED",
} as const);

export class SealError extends Error {
  readonly code: (typeof SEAL_ERROR_CODES)[keyof typeof SEAL_ERROR_CODES];
  constructor(code: SealError["code"]) {
    super(code);
    this.name = "SealError";
    this.code = code;
  }
}

function deriveKey(passphrase: string, salt: Uint8Array, cost: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(passphrase.normalize("NFKC"), "utf8"),
      salt,
      KEY_BYTES,
      { N: cost, r: SCRYPT_BLOCK, p: SCRYPT_PARALLEL, maxmem: MAXIMUM_MEMORY },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export async function sealJson(passphrase: string, value: JsonValue): Promise<Uint8Array> {
  if (passphrase.length === 0) throw new SealError(SEAL_ERROR_CODES.PASSPHRASE_REQUIRED);
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const header = `${canonicalJson({
    cipher: "aes-256-gcm",
    kdf: "scrypt",
    magic: SEAL_MAGIC,
    n: SCRYPT_COST,
    nonce: nonce.toString("base64"),
    p: SCRYPT_PARALLEL,
    r: SCRYPT_BLOCK,
    salt: salt.toString("base64"),
  })}\n`;
  const key = await deriveKey(passphrase, salt, SCRYPT_COST);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(header, "utf8"));
  const body = Buffer.concat([cipher.update(canonicalJson(value), "utf8"), cipher.final()]);
  return new Uint8Array(Buffer.concat([Buffer.from(header, "utf8"), body, cipher.getAuthTag()]));
}

interface SealHeader {
  readonly magic: string;
  readonly kdf: string;
  readonly cipher: string;
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly salt: string;
  readonly nonce: string;
}

export async function unsealJson(passphrase: string, sealed: Uint8Array): Promise<JsonValue> {
  if (passphrase.length === 0) throw new SealError(SEAL_ERROR_CODES.PASSPHRASE_REQUIRED);
  const bytes = Buffer.from(sealed);
  const headerEnd = bytes.indexOf(0x0a);
  if (headerEnd < 0 || bytes.length < headerEnd + 1 + TAG_BYTES)
    throw new SealError(SEAL_ERROR_CODES.UNREADABLE);
  const headerBytes = bytes.subarray(0, headerEnd + 1);
  let header: SealHeader;
  try {
    header = JSON.parse(headerBytes.toString("utf8")) as SealHeader;
  } catch {
    throw new SealError(SEAL_ERROR_CODES.UNREADABLE);
  }
  if (
    header.magic !== SEAL_MAGIC ||
    header.kdf !== "scrypt" ||
    header.cipher !== "aes-256-gcm" ||
    header.n !== SCRYPT_COST ||
    header.r !== SCRYPT_BLOCK ||
    header.p !== SCRYPT_PARALLEL ||
    typeof header.salt !== "string" ||
    typeof header.nonce !== "string"
  )
    throw new SealError(SEAL_ERROR_CODES.UNREADABLE);
  const salt = Buffer.from(header.salt, "base64");
  const nonce = Buffer.from(header.nonce, "base64");
  if (salt.length !== SALT_BYTES || nonce.length !== NONCE_BYTES)
    throw new SealError(SEAL_ERROR_CODES.UNREADABLE);
  const body = bytes.subarray(headerEnd + 1, bytes.length - TAG_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  const key = await deriveKey(passphrase, salt, header.n);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(headerBytes);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    return JSON.parse(plain) as JsonValue;
  } catch {
    throw new SealError(SEAL_ERROR_CODES.AUTHENTICATION_FAILED);
  }
}
