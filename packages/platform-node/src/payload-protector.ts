import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes as secureRandomBytes,
} from "node:crypto";
import type {
  PayloadProtectionRequest,
  PayloadProtectorPort,
  PayloadRecord,
  PayloadRewrapRequest,
  PayloadUnprotectionRequest,
} from "@himawari-agent/application";
import type { HostSecretMaterialSource } from "./host-secret-source.js";

export const PAYLOAD_ALGORITHM = "aes-256-gcm-envelope-v1" as const;

export function assertProductionPayloadAlgorithm(
  algorithm: string,
): asserts algorithm is typeof PAYLOAD_ALGORITHM {
  if (algorithm !== PAYLOAD_ALGORITHM) {
    throw new PayloadIntegrityError(
      PAYLOAD_INTEGRITY_ERROR_CODES.UNSUPPORTED_ALGORITHM,
      "Configured Payload algorithm is not permitted in production",
      { algorithm },
    );
  }
}

export const PAYLOAD_INTEGRITY_ERROR_CODES = Object.freeze({
  UNSUPPORTED_ALGORITHM: "PAYLOAD_UNSUPPORTED_ALGORITHM",
  INVALID_ENVELOPE: "PAYLOAD_INVALID_ENVELOPE",
  AUTHENTICATION_FAILED: "PAYLOAD_AUTHENTICATION_FAILED",
  DIGEST_MISMATCH: "PAYLOAD_DIGEST_MISMATCH",
  KEY_UNAVAILABLE: "PAYLOAD_KEY_UNAVAILABLE",
} as const);

export type PayloadIntegrityErrorCode =
  (typeof PAYLOAD_INTEGRITY_ERROR_CODES)[keyof typeof PAYLOAD_INTEGRITY_ERROR_CODES];

export class PayloadIntegrityError extends Error {
  readonly code: PayloadIntegrityErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: PayloadIntegrityErrorCode,
    message: string,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "PayloadIntegrityError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface PayloadProtectorKeyDescriptor {
  readonly keyRef: string;
  readonly kekVersion: string;
  readonly dekVersion: string;
}

export interface EnvelopePayloadProtectorOptions {
  readonly keys: HostSecretMaterialSource;
  readonly activeKey: PayloadProtectorKeyDescriptor;
  readonly randomBytes?: (length: number) => Uint8Array;
}

interface EncryptionResult {
  readonly ciphertext: Uint8Array;
  readonly authenticationTag: Uint8Array;
}

function sha256(input: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

function encode(input: Uint8Array): string {
  return Buffer.from(input).toString("base64url");
}

function decode(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, "base64url"));
}

function canonicalPayloadAad(input: {
  readonly ownerId: string;
  readonly agentId: string;
  readonly ref: string;
  readonly classification: string;
  readonly contentType: string;
}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schema: PAYLOAD_ALGORITHM,
      ownerId: input.ownerId,
      agentId: input.agentId,
      payloadRef: input.ref,
      classification: input.classification,
      contentType: input.contentType,
    }),
  );
}

function canonicalWrapAad(input: {
  readonly payloadRef: string;
  readonly keyRef: string;
  readonly kekVersion: string;
  readonly dekVersion: string;
}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schema: `${PAYLOAD_ALGORITHM}.dek-wrap`,
      payloadRef: input.payloadRef,
      keyRef: input.keyRef,
      kekVersion: input.kekVersion,
      dekVersion: input.dekVersion,
    }),
  );
}

function encrypt(
  plaintext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
): EncryptionResult {
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Object.freeze({
    ciphertext: new Uint8Array(ciphertext),
    authenticationTag: new Uint8Array(cipher.getAuthTag()),
  });
}

function decrypt(
  ciphertext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  authenticationTag: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(authenticationTag);
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch {
    throw new PayloadIntegrityError(
      PAYLOAD_INTEGRITY_ERROR_CODES.AUTHENTICATION_FAILED,
      "Payload authentication failed",
    );
  }
}

function requireMetadata(payload: PayloadRecord): Required<PayloadRecord["encryption"]> {
  const metadata = payload.encryption;
  if (
    metadata.algorithm !== PAYLOAD_ALGORITHM ||
    !metadata.keyRef ||
    !metadata.kekVersion ||
    !metadata.dekVersion ||
    !metadata.nonce ||
    !metadata.authenticationTag ||
    !metadata.wrappedDek ||
    !metadata.wrapNonce ||
    !metadata.wrapAuthenticationTag ||
    !metadata.aadDigest ||
    !metadata.ciphertextDigest
  ) {
    throw new PayloadIntegrityError(
      metadata.algorithm === PAYLOAD_ALGORITHM
        ? PAYLOAD_INTEGRITY_ERROR_CODES.INVALID_ENVELOPE
        : PAYLOAD_INTEGRITY_ERROR_CODES.UNSUPPORTED_ALGORITHM,
      "Payload envelope metadata is incomplete or unsupported",
      { payloadRef: payload.ref, algorithm: metadata.algorithm },
    );
  }
  return metadata as Required<PayloadRecord["encryption"]>;
}

export class EnvelopePayloadProtector implements PayloadProtectorPort {
  readonly #keys: HostSecretMaterialSource;
  readonly #activeKey: PayloadProtectorKeyDescriptor;
  readonly #randomBytes: (length: number) => Uint8Array;

  constructor(options: EnvelopePayloadProtectorOptions) {
    this.#keys = options.keys;
    this.#activeKey = Object.freeze({ ...options.activeKey });
    this.#randomBytes = options.randomBytes ?? ((length) => secureRandomBytes(length));
  }

  async protect(request: PayloadProtectionRequest): Promise<PayloadRecord> {
    const aad = canonicalPayloadAad({
      ownerId: request.ownerId,
      agentId: request.agentId,
      ref: request.ref,
      classification: request.dataClassification,
      contentType: request.contentType,
    });
    const dek = this.#secureRandom(32);
    const nonce = this.#secureRandom(12);
    const payloadEncryption = encrypt(request.plaintext, dek, nonce, aad);
    const wrapped = await this.#wrapDek(dek, request.ref, this.#activeKey);

    return Object.freeze({
      ref: request.ref,
      dataClassification: request.dataClassification,
      contentType: request.contentType,
      ciphertext: payloadEncryption.ciphertext,
      encryption: Object.freeze({
        algorithm: PAYLOAD_ALGORITHM,
        keyRef: this.#activeKey.keyRef,
        kekVersion: this.#activeKey.kekVersion,
        dekVersion: this.#activeKey.dekVersion,
        nonce: encode(nonce),
        authenticationTag: encode(payloadEncryption.authenticationTag),
        wrappedDek: encode(wrapped.ciphertext),
        wrapNonce: encode(wrapped.nonce),
        wrapAuthenticationTag: encode(wrapped.authenticationTag),
        aadDigest: sha256(aad),
        ciphertextDigest: sha256(payloadEncryption.ciphertext),
      }),
      storage: Object.freeze({ kind: "inline" as const }),
      contentDigest: sha256(request.plaintext),
      createdAt: request.createdAt,
    });
  }

  async unprotect(request: PayloadUnprotectionRequest): Promise<Uint8Array> {
    const metadata = requireMetadata(request.payload);
    const aad = canonicalPayloadAad({
      ownerId: request.ownerId,
      agentId: request.agentId,
      ref: request.payload.ref,
      classification: request.payload.dataClassification,
      contentType: request.payload.contentType,
    });
    if (sha256(aad) !== metadata.aadDigest) {
      throw new PayloadIntegrityError(
        PAYLOAD_INTEGRITY_ERROR_CODES.AUTHENTICATION_FAILED,
        "Payload scope does not match its authenticated envelope",
        { payloadRef: request.payload.ref },
      );
    }
    if (sha256(request.payload.ciphertext) !== metadata.ciphertextDigest) {
      throw new PayloadIntegrityError(
        PAYLOAD_INTEGRITY_ERROR_CODES.DIGEST_MISMATCH,
        "Payload ciphertext digest does not match",
        { payloadRef: request.payload.ref },
      );
    }

    const dek = await this.#unwrapDek(request.payload.ref, metadata);
    const plaintext = decrypt(
      request.payload.ciphertext,
      dek,
      decode(metadata.nonce),
      decode(metadata.authenticationTag),
      aad,
    );
    if (sha256(plaintext) !== request.payload.contentDigest) {
      throw new PayloadIntegrityError(
        PAYLOAD_INTEGRITY_ERROR_CODES.DIGEST_MISMATCH,
        "Payload plaintext digest does not match",
        { payloadRef: request.payload.ref },
      );
    }
    return plaintext;
  }

  async rewrap(request: PayloadRewrapRequest): Promise<PayloadRecord> {
    const metadata = requireMetadata(request.payload);
    const aad = canonicalPayloadAad({
      ownerId: request.ownerId,
      agentId: request.agentId,
      ref: request.payload.ref,
      classification: request.payload.dataClassification,
      contentType: request.payload.contentType,
    });
    if (sha256(aad) !== metadata.aadDigest) {
      throw new PayloadIntegrityError(
        PAYLOAD_INTEGRITY_ERROR_CODES.AUTHENTICATION_FAILED,
        "Payload scope does not match its authenticated envelope",
        { payloadRef: request.payload.ref },
      );
    }
    const dek = await this.#unwrapDek(request.payload.ref, metadata);
    const target = Object.freeze({
      keyRef: request.targetKeyRef,
      kekVersion: request.targetKekVersion,
      dekVersion: metadata.dekVersion,
    });
    const wrapped = await this.#wrapDek(dek, request.payload.ref, target);
    return Object.freeze({
      ...request.payload,
      ciphertext: new Uint8Array(request.payload.ciphertext),
      encryption: Object.freeze({
        ...metadata,
        keyRef: target.keyRef,
        kekVersion: target.kekVersion,
        wrappedDek: encode(wrapped.ciphertext),
        wrapNonce: encode(wrapped.nonce),
        wrapAuthenticationTag: encode(wrapped.authenticationTag),
      }),
    });
  }

  #secureRandom(length: number): Uint8Array {
    const value = new Uint8Array(this.#randomBytes(length));
    if (value.byteLength !== length) {
      throw new PayloadIntegrityError(
        PAYLOAD_INTEGRITY_ERROR_CODES.INVALID_ENVELOPE,
        "Secure random source returned an unexpected number of bytes",
      );
    }
    return value;
  }

  async #wrapDek(
    dek: Uint8Array,
    payloadRef: string,
    descriptor: PayloadProtectorKeyDescriptor,
  ): Promise<EncryptionResult & { readonly nonce: Uint8Array }> {
    const nonce = this.#secureRandom(12);
    const aad = canonicalWrapAad({ payloadRef, ...descriptor });
    const kek = await this.#resolveKek(descriptor.keyRef, descriptor.kekVersion);
    return Object.freeze({ ...encrypt(dek, kek, nonce, aad), nonce });
  }

  async #unwrapDek(
    payloadRef: string,
    metadata: Required<PayloadRecord["encryption"]>,
  ): Promise<Uint8Array> {
    const kek = await this.#resolveKek(metadata.keyRef, metadata.kekVersion);
    return decrypt(
      decode(metadata.wrappedDek),
      kek,
      decode(metadata.wrapNonce),
      decode(metadata.wrapAuthenticationTag),
      canonicalWrapAad({
        payloadRef,
        keyRef: metadata.keyRef,
        kekVersion: metadata.kekVersion,
        dekVersion: metadata.dekVersion,
      }),
    );
  }

  async #resolveKek(keyRef: string, kekVersion: string): Promise<Uint8Array> {
    try {
      const key = await this.#keys.resolve(keyRef, kekVersion);
      if (key.byteLength !== 32) throw new Error("invalid key length");
      return key;
    } catch {
      throw new PayloadIntegrityError(
        PAYLOAD_INTEGRITY_ERROR_CODES.KEY_UNAVAILABLE,
        "Payload key material is unavailable",
        { keyRef, kekVersion },
      );
    }
  }
}
