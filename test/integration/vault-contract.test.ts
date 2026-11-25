import { createHmac, hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  VAULT_PATTERNS,
  VAULT_RELEASE_INFO,
  vaultFieldAad,
  vaultFieldsValid,
  vaultKind,
  vaultName,
  vaultOrigin,
  vaultReleaseAad,
} from "@himawari-agent/application";
import { openVaultAesGcm, vaultCipherSuite } from "@himawari-agent/platform-node";
import { totpCode, vaultManifestBytes } from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";

const FIXTURE = "clients/apple/Tests/HimawariCoreTests/Fixtures/vault-contract.json";

interface Fixture {
  readonly itemId: { accept: string[]; reject: string[] };
  readonly requestId: { accept: string[]; reject: string[] };
  readonly nonce: { accept: string[]; reject: string[] };
  readonly origin: { accept: [string, string][]; reject: string[] };
  readonly name: { accept: string[]; reject: string[] };
  readonly fields: { accept: [string, string[]][]; reject: [string, string[]][] };
  readonly vector: {
    readonly masterKey: string;
    readonly itemKey: string;
    readonly item: {
      id: string;
      name: string;
      kind: "login";
      origins: string[];
      fields: string[];
      version: number;
      backgroundAllowed: boolean;
      wrappedKey: string;
      ciphertexts: Record<string, string>;
    };
    readonly values: Record<string, string>;
    readonly manifest: { version: number; signature: string; bytes: string };
  };
  readonly totp: { readonly seed: string; readonly codes: [number, string][] };
  readonly phoneVector: {
    readonly masterKey: string;
    readonly ephemeralPrivateKey: string;
    readonly requestId: string;
    readonly item: Fixture["vector"]["item"];
    readonly values: Record<string, string>;
    readonly release: { readonly enc: string; readonly ciphertext: string };
    readonly totpAt59: string;
    readonly manifest: { version: number; signature: string };
  };
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;

function derive(master: Buffer, info: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", master, Buffer.from("himawari-vault-v1"), Buffer.from(info), 32),
  );
}

describe("[vault-contract] the server and the phone apply the same rule to every new value", () => {
  it.each(fixture.itemId.accept)("accepts item id %s", (value) =>
    expect(VAULT_PATTERNS.itemId.test(value)).toBe(true),
  );
  it.each(fixture.itemId.reject)("rejects item id %j", (value) =>
    expect(VAULT_PATTERNS.itemId.test(value)).toBe(false),
  );
  it.each(fixture.requestId.accept)("accepts request id %s", (value) =>
    expect(VAULT_PATTERNS.requestId.test(value)).toBe(true),
  );
  it.each(fixture.requestId.reject)("rejects request id %j", (value) =>
    expect(VAULT_PATTERNS.requestId.test(value)).toBe(false),
  );
  it.each(fixture.nonce.accept)("accepts nonce %s", (value) =>
    expect(VAULT_PATTERNS.nonce.test(value)).toBe(true),
  );
  it.each(fixture.nonce.reject)("rejects nonce %j", (value) =>
    expect(VAULT_PATTERNS.nonce.test(value)).toBe(false),
  );
  it.each(fixture.origin.accept)("normalizes origin %s to %s", (value, normalized) =>
    expect(vaultOrigin(value)).toBe(normalized),
  );
  it.each(fixture.origin.reject)("rejects origin %j", (value) =>
    expect(vaultOrigin(value)).toBeUndefined(),
  );
  it.each(fixture.name.accept)("accepts name %s", (value) => expect(vaultName(value)).toBe(value));
  it.each(fixture.name.reject)("rejects name %j", (value) =>
    expect(vaultName(value)).toBeUndefined(),
  );
  it.each(fixture.fields.accept)("accepts %s fields %j", (kind, fields) => {
    const parsed = vaultKind(kind);
    expect(parsed !== undefined && vaultFieldsValid(parsed, fields)).toBe(true);
  });
  it.each(fixture.fields.reject)("rejects %s fields %j", (kind, fields) => {
    const parsed = vaultKind(kind);
    expect(parsed !== undefined && vaultFieldsValid(parsed, fields)).toBe(false);
  });

  it("opens the shared ciphertext vector with the server code and the field binding", () => {
    const { vector } = fixture;
    const itemKey = Buffer.from(vector.itemKey, "base64");
    for (const field of ["password", "username"]) {
      const opened = openVaultAesGcm(
        itemKey,
        Buffer.from(vector.item.ciphertexts[field] as string, "base64"),
        vaultFieldAad(vector.item.id, field, vector.item.version),
      );
      expect(Buffer.from(opened).toString("utf8")).toBe(vector.values[field]);
    }
    expect(() =>
      openVaultAesGcm(
        itemKey,
        Buffer.from(vector.item.ciphertexts["password"] as string, "base64"),
        vaultFieldAad(vector.item.id, "username", vector.item.version),
      ),
    ).toThrow();
    expect(() =>
      openVaultAesGcm(
        itemKey,
        Buffer.from(vector.item.ciphertexts["totp"] as string, "base64"),
        vaultFieldAad(vector.item.id, "totp", vector.item.version),
      ),
    ).toThrow();
  });

  it("recomputes the manifest bytes and tag the phone signs", () => {
    const { vector } = fixture;
    const bytes = vaultManifestBytes(vector.manifest.version, [vector.item]);
    expect(bytes.toString("utf8")).toBe(vector.manifest.bytes);
    const tag = createHmac("sha256", derive(Buffer.from(vector.masterKey, "base64"), "manifest"))
      .update(bytes)
      .digest("base64");
    expect(tag).toBe(vector.manifest.signature);
  });

  it.each(fixture.totp.codes)("computes the RFC 6238 two-step code at %i as %s", (at, code) =>
    expect(totpCode(fixture.totp.seed, at)).toBe(code),
  );

  it("opens a release, the fields and the manifest the phone code produced", async () => {
    const { phoneVector: vector } = fixture;
    const suite = vaultCipherSuite();
    const privateKey = await suite.kem.deserializePrivateKey(
      arrayBuffer(Buffer.from(vector.ephemeralPrivateKey, "base64")),
    );
    const recipient = await suite.createRecipientContext({
      recipientKey: privateKey,
      enc: arrayBuffer(Buffer.from(vector.release.enc, "base64")),
      info: arrayBuffer(Buffer.from(VAULT_RELEASE_INFO, "utf8")),
    });
    const plain = await recipient.open(
      arrayBuffer(Buffer.from(vector.release.ciphertext, "base64")),
      arrayBuffer(vaultReleaseAad(vector.requestId, vector.item.id, vector.item.version)),
    );
    const payload = JSON.parse(Buffer.from(plain).toString("utf8")) as {
      itemKey: string;
      totp: { at: number; code: string }[];
    };
    expect(payload.totp[0]).toEqual({ at: 59, code: vector.totpAt59 });
    const itemKey = Buffer.from(payload.itemKey, "base64");
    for (const field of ["password", "username"]) {
      const opened = openVaultAesGcm(
        itemKey,
        Buffer.from(vector.item.ciphertexts[field] as string, "base64"),
        vaultFieldAad(vector.item.id, field, vector.item.version),
      );
      expect(Buffer.from(opened).toString("utf8")).toBe(vector.values[field]);
    }
    const tag = createHmac("sha256", derive(Buffer.from(vector.masterKey, "base64"), "manifest"))
      .update(vaultManifestBytes(vector.manifest.version, [vector.item]))
      .digest("base64");
    expect(tag).toBe(vector.manifest.signature);
  });
});
