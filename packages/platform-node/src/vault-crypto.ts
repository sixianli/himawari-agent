import { createDecipheriv, randomBytes } from "node:crypto";
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import {
  VAULT_RELEASE_INFO,
  type VaultCryptoPort,
  type VaultEphemeralKey,
} from "@himawari-agent/application";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function vaultCipherSuite(): CipherSuite {
  return new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function openVaultAesGcm(
  key: Uint8Array,
  combined: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  if (key.length !== 32 || combined.length < NONCE_BYTES + TAG_BYTES)
    throw new Error("VAULT_CIPHERTEXT_INVALID");
  const nonce = combined.subarray(0, NONCE_BYTES);
  const tag = combined.subarray(combined.length - TAG_BYTES);
  const body = combined.subarray(NONCE_BYTES, combined.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export class NodeVaultCrypto implements VaultCryptoPort {
  readonly #suite = vaultCipherSuite();
  readonly #info = new TextEncoder().encode(VAULT_RELEASE_INFO);

  async createEphemeral(): Promise<VaultEphemeralKey> {
    const pair = await this.#suite.kem.generateKeyPair();
    const publicKey = Buffer.from(
      await this.#suite.kem.serializePublicKey(pair.publicKey),
    ).toString("base64");
    let privateKey: typeof pair.privateKey | undefined = pair.privateKey;
    const suite = this.#suite;
    const info = this.#info;
    return Object.freeze({
      publicKey,
      async open(sealed: { readonly enc: string; readonly ciphertext: string }, aad: Uint8Array) {
        if (!privateKey) throw new Error("VAULT_EPHEMERAL_DISPOSED");
        const recipient = await suite.createRecipientContext({
          recipientKey: privateKey,
          enc: toArrayBuffer(Buffer.from(sealed.enc, "base64")),
          info: toArrayBuffer(info),
        });
        return new Uint8Array(
          await recipient.open(
            toArrayBuffer(Buffer.from(sealed.ciphertext, "base64")),
            toArrayBuffer(aad),
          ),
        );
      },
      dispose() {
        privateKey = undefined;
      },
    });
  }

  decryptField(itemKey: Uint8Array, ciphertext: string, aad: Uint8Array): Uint8Array {
    return openVaultAesGcm(itemKey, Buffer.from(ciphertext, "base64"), aad);
  }

  randomToken(bytes: number): string {
    return randomBytes(bytes).toString("base64url");
  }
}
