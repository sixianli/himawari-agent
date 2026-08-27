import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PayloadRecord, PayloadStorePort } from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  CIPHERTEXT_STORE_ERROR_CODES,
  ContentAddressedCiphertextStore,
  EnvelopePayloadProtector,
  HOST_SECRET_ERROR_CODES,
  HybridPayloadStore,
  InMemoryDevelopmentSecretSource,
  PAYLOAD_ALGORITHM,
  PAYLOAD_INTEGRITY_ERROR_CODES,
  RestrictedProviderSecretSource,
  RestrictedSecretFileSource,
  assertProductionPayloadAlgorithm,
  assertProductionSecretSource,
} from "../src/index.js";

const OWNER_ID = createOwnerId("owner-payload-test");
const AGENT_ID = createAgentId("agent-payload-test");
const KEY_V1 = Uint8Array.from({ length: 32 }, (_, index) => index);
const KEY_V2 = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function request(plaintext = "Himawari payload known answer") {
  return {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    ref: "payload-known-answer",
    dataClassification: "sensitive" as const,
    contentType: "text/plain; charset=utf-8",
    plaintext: new TextEncoder().encode(plaintext),
    createdAt: "2026-08-26T00:00:00.000Z",
  };
}

function deterministicRandom(): (length: number) => Uint8Array {
  let call = 0;
  return (length) => {
    const offset = [0xa0, 0x10, 0x20][call++] ?? 0x30;
    return Uint8Array.from({ length }, (_, index) => (offset + index) & 0xff);
  };
}

function protector(randomBytes?: (length: number) => Uint8Array): EnvelopePayloadProtector {
  return new EnvelopePayloadProtector({
    keys: new InMemoryDevelopmentSecretSource({
      "payload-kek@v1": KEY_V1,
      "payload-kek@v2": KEY_V2,
    }),
    activeKey: { keyRef: "payload-kek", kekVersion: "v1", dekVersion: "dek-v1" },
    ...(randomBytes ? { randomBytes } : {}),
  });
}

class MemoryMetadataStore implements PayloadStorePort {
  readonly records = new Map<string, PayloadRecord>();

  async put(payload: PayloadRecord): Promise<void> {
    this.records.set(payload.ref, structuredClone(payload));
  }

  async get(ref: string): Promise<PayloadRecord | undefined> {
    const payload = this.records.get(ref);
    return payload ? structuredClone(payload) : undefined;
  }

  async delete(ref: string): Promise<boolean> {
    return this.records.delete(ref);
  }
}

describe("EnvelopePayloadProtector", () => {
  it("forbids the deterministic XOR algorithm in production configuration", () => {
    expect(() => assertProductionPayloadAlgorithm("test-xor-v1")).toThrowError(
      expect.objectContaining({ code: PAYLOAD_INTEGRITY_ERROR_CODES.UNSUPPORTED_ALGORITHM }),
    );
    expect(() => assertProductionPayloadAlgorithm(PAYLOAD_ALGORITHM)).not.toThrow();
  });

  it("matches the frozen AES-256-GCM envelope known answer", async () => {
    const protectedPayload = await protector(deterministicRandom()).protect(request());

    expect(protectedPayload.encryption).toMatchObject({
      algorithm: PAYLOAD_ALGORITHM,
      keyRef: "payload-kek",
      kekVersion: "v1",
      dekVersion: "dek-v1",
      nonce: "EBESExQVFhcYGRob",
      wrapNonce: "ICEiIyQlJicoKSor",
      authenticationTag: "NiRfeZAYTbHrkKMxHgetVA",
      wrappedDek: "cpsE08g9vKmy1ehlbbVaVmD4Xi8zNdVZ1E_WqfU34LY",
      wrapAuthenticationTag: "GoQirhdHT3P5mO5uuh2kfg",
      aadDigest: "sha256:3dd68cc3d29904e52294856e109ff7321598630bfb57b51ec7c96a3976f4a0a6",
      ciphertextDigest: "sha256:fcec2d59ee0ef4575367ae6bfb9a8ebeec1a604359d9cf528340fcfd31c0becc",
    });
    expect(Buffer.from(protectedPayload.ciphertext).toString("hex")).toBe(
      "dcdf186fa926c7dbba090d68f55cddd0d33972a0989193a337e87449f5",
    );
    expect(protectedPayload.contentDigest).toBe(
      "sha256:2d56f588dbba88150ab90fa9b03b311e7015c3d1d955088f94c9b059c68d3863",
    );
    await expect(
      protector().unprotect({ ownerId: OWNER_ID, agentId: AGENT_ID, payload: protectedPayload }),
    ).resolves.toEqual(request().plaintext);
  });

  it("uses unique nonces and round-trips arbitrary payloads", async () => {
    const instance = protector();
    const nonces = new Set<string>();
    for (let index = 0; index < 64; index += 1) {
      const input = request(`payload-${index}-${"x".repeat(index)}`);
      const payload = await instance.protect({ ...input, ref: `payload-property-${index}` });
      expect(nonces.has(payload.encryption.nonce ?? "")).toBe(false);
      nonces.add(payload.encryption.nonce ?? "");
      await expect(
        instance.unprotect({ ownerId: OWNER_ID, agentId: AGENT_ID, payload }),
      ).resolves.toEqual(input.plaintext);
    }
  });

  it("rejects ciphertext, tag, digest, and AAD tampering", async () => {
    const instance = protector();
    const payload = await instance.protect(request());
    const changedCiphertext = new Uint8Array(payload.ciphertext);
    changedCiphertext[0] = (changedCiphertext[0] ?? 0) ^ 0xff;

    await expect(
      instance.unprotect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        payload: { ...payload, ciphertext: changedCiphertext },
      }),
    ).rejects.toMatchObject({ code: PAYLOAD_INTEGRITY_ERROR_CODES.DIGEST_MISMATCH });
    await expect(
      instance.unprotect({
        ownerId: createOwnerId("owner-wrong"),
        agentId: AGENT_ID,
        payload,
      }),
    ).rejects.toMatchObject({ code: PAYLOAD_INTEGRITY_ERROR_CODES.AUTHENTICATION_FAILED });
    await expect(
      instance.unprotect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        payload: { ...payload, contentDigest: "sha256:bad" },
      }),
    ).rejects.toMatchObject({ code: PAYLOAD_INTEGRITY_ERROR_CODES.DIGEST_MISMATCH });
  });

  it("rewraps the DEK for a new KEK without changing ciphertext", async () => {
    const instance = protector();
    const payload = await instance.protect(request());
    const rotated = await instance.rewrap({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      payload,
      targetKeyRef: "payload-kek",
      targetKekVersion: "v2",
    });

    expect(rotated.ciphertext).toEqual(payload.ciphertext);
    expect(rotated.encryption).toMatchObject({ kekVersion: "v2", dekVersion: "dek-v1" });
    expect(rotated.encryption.wrappedDek).not.toBe(payload.encryption.wrappedDek);
    await expect(
      instance.unprotect({ ownerId: OWNER_ID, agentId: AGENT_ID, payload: rotated }),
    ).resolves.toEqual(request().plaintext);
    await expect(
      instance.rewrap({
        ownerId: createOwnerId("owner-wrong"),
        agentId: AGENT_ID,
        payload,
        targetKeyRef: "payload-kek",
        targetKekVersion: "v2",
      }),
    ).rejects.toMatchObject({ code: PAYLOAD_INTEGRITY_ERROR_CODES.AUTHENTICATION_FAILED });
  });
});

describe("host secret sources", () => {
  it("loads only absolute, permission-restricted secret files", async () => {
    const root = path.join(tmpdir(), `himawari-secret-${crypto.randomUUID()}`);
    temporaryRoots.push(root);
    await mkdir(root, { mode: 0o700 });
    await writeFile(path.join(root, "payload-kek.v1"), Buffer.from(KEY_V1).toString("base64"), {
      mode: 0o600,
    });
    const source = new RestrictedSecretFileSource(root);
    assertProductionSecretSource(source);
    await expect(source.resolve("payload-kek", "v1")).resolves.toEqual(KEY_V1);

    await chmod(path.join(root, "payload-kek.v1"), 0o644);
    await expect(source.resolve("payload-kek", "v1")).rejects.toMatchObject({
      code: HOST_SECRET_ERROR_CODES.SOURCE_UNSAFE,
    });
  });

  it("loads opaque provider credentials without applying encryption-key decoding", async () => {
    const root = path.join(tmpdir(), `himawari-provider-secret-${crypto.randomUUID()}`);
    temporaryRoots.push(root);
    await mkdir(root, { mode: 0o700 });
    await writeFile(path.join(root, "openrouter-api-key.v1"), "opaque-provider-token-123456\n", {
      mode: 0o600,
    });
    const source = new RestrictedProviderSecretSource(root);
    assertProductionSecretSource(source);
    await expect(source.resolve("openrouter-api-key", "v1")).resolves.toBe(
      "opaque-provider-token-123456",
    );

    await chmod(path.join(root, "openrouter-api-key.v1"), 0o644);
    await expect(source.resolve("openrouter-api-key", "v1")).rejects.toMatchObject({
      code: HOST_SECRET_ERROR_CODES.SOURCE_UNSAFE,
    });
  });

  it("rejects in-memory and environment source kinds for production", () => {
    expect(() =>
      assertProductionSecretSource(
        new InMemoryDevelopmentSecretSource({ "payload-kek@v1": KEY_V1 }),
      ),
    ).toThrowError(expect.objectContaining({ code: HOST_SECRET_ERROR_CODES.SOURCE_UNSAFE }));
  });
});

describe("ContentAddressedCiphertextStore", () => {
  it("shares inline and file-backed ownership while detecting missing, corrupt, and orphan files", async () => {
    const root = path.join(tmpdir(), `himawari-ciphertext-${crypto.randomUUID()}`);
    temporaryRoots.push(root);
    const files = new ContentAddressedCiphertextStore(root);
    await files.initialize();
    const metadata = new MemoryMetadataStore();
    const store = new HybridPayloadStore({ metadata, files, fileThresholdBytes: 16 });
    const instance = protector();

    const inline = await instance.protect({ ...request("small"), ref: "payload-inline" });
    const external = await instance.protect({ ...request("x".repeat(64)), ref: "payload-file" });
    await store.put(inline);
    await store.put(external);
    expect(metadata.records.get("payload-inline")?.storage).toEqual({ kind: "inline" });
    const fileMetadata = metadata.records.get("payload-file");
    expect(fileMetadata?.storage?.kind).toBe("ciphertext_file");
    await expect(store.get("payload-file")).resolves.toMatchObject({
      ciphertext: external.ciphertext,
    });

    if (fileMetadata?.storage?.kind !== "ciphertext_file") throw new Error("missing file metadata");
    const absolutePath = path.join(root, fileMetadata.storage.relativePath);
    const original = await readFile(absolutePath);
    await writeFile(absolutePath, Buffer.from("tampered"));
    await expect(store.get("payload-file")).rejects.toMatchObject({
      code: CIPHERTEXT_STORE_ERROR_CODES.DIGEST_MISMATCH,
    });
    await writeFile(absolutePath, original, { mode: 0o600 });

    const orphan = await files.put(new TextEncoder().encode("orphan ciphertext"));
    const report = await files.inspect([fileMetadata.storage]);
    expect(report.orphans).toContain(orphan.relativePath);
    await rm(absolutePath);
    const missing = await files.inspect([fileMetadata.storage]);
    expect(missing.missing).toEqual([fileMetadata.storage.relativePath]);
  });
});
