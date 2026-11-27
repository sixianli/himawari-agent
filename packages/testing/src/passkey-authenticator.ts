import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

type CborValue = number | string | Uint8Array | ReadonlyMap<number | string, CborValue>;

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) {
    const head = Buffer.alloc(3);
    head[0] = (major << 5) | 25;
    head.writeUInt16BE(length, 1);
    return head;
  }
  const head = Buffer.alloc(5);
  head[0] = (major << 5) | 26;
  head.writeUInt32BE(length, 1);
  return head;
}

export function encodeCbor(value: CborValue): Buffer {
  if (typeof value === "number") return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([cborHead(2, value.length), value]);
  const parts: Buffer[] = [cborHead(5, value.size)];
  for (const [key, entry] of value) parts.push(encodeCbor(key), encodeCbor(entry));
  return Buffer.concat(parts);
}

export interface PasskeyCreationOptions {
  readonly challenge: string;
  readonly rp: { readonly id?: string };
}

export interface PasskeyRequestOptions {
  readonly challenge: string;
  readonly rpId?: string;
}

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_BACKUP_ELIGIBLE = 0x08;
const FLAG_BACKED_UP = 0x10;
const FLAG_ATTESTED = 0x40;

export class SoftwarePasskey {
  readonly credentialId: string;
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  readonly #origin: string;
  #counter = 0;
  userVerified = true;

  constructor(origin: string) {
    this.#origin = origin;
    this.credentialId = randomBytes(16).toString("base64url");
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.#privateKey = pair.privateKey;
    this.#publicKey = pair.publicKey;
  }

  #clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8");
  }

  #authenticatorData(rpId: string, attested: boolean): Buffer {
    const flags =
      FLAG_USER_PRESENT |
      (this.userVerified ? FLAG_USER_VERIFIED : 0) |
      FLAG_BACKUP_ELIGIBLE |
      FLAG_BACKED_UP |
      (attested ? FLAG_ATTESTED : 0);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.#counter);
    const head = Buffer.concat([
      createHash("sha256").update(rpId).digest(),
      Buffer.from([flags]),
      counter,
    ]);
    if (!attested) return head;
    const jwk = this.#publicKey.export({ format: "jwk" });
    const coseKey = encodeCbor(
      new Map<number, CborValue>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x as string, "base64url")],
        [-3, Buffer.from(jwk.y as string, "base64url")],
      ]),
    );
    const id = Buffer.from(this.credentialId, "base64url");
    const length = Buffer.alloc(2);
    length.writeUInt16BE(id.length);
    return Buffer.concat([head, Buffer.alloc(16), length, id, coseKey]);
  }

  create(options: PasskeyCreationOptions, origin = this.#origin) {
    const rpId = options.rp.id ?? new URL(origin).hostname;
    const clientDataJSON = this.#clientData("webauthn.create", options.challenge, origin);
    const attestationObject = encodeCbor(
      new Map<string, CborValue>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", this.#authenticatorData(rpId, true)],
      ]),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        attestationObject: attestationObject.toString("base64url"),
        transports: ["internal", "hybrid"],
      },
      clientExtensionResults: {},
    };
  }

  get(options: PasskeyRequestOptions, origin = this.#origin) {
    const rpId = options.rpId ?? new URL(origin).hostname;
    this.#counter += 1;
    const clientDataJSON = this.#clientData("webauthn.get", options.challenge, origin);
    const authenticatorData = this.#authenticatorData(rpId, false);
    const signature = sign(
      "sha256",
      Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]),
      this.#privateKey,
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authenticatorData.toString("base64url"),
        signature: signature.toString("base64url"),
      },
      clientExtensionResults: {},
    };
  }
}
