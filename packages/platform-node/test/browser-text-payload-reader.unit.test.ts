import type { PayloadProtectorPort, PayloadStorePort } from "@himawari-agent/application";
import { describe, expect, it, vi } from "vitest";
import { BrowserTextPayloadReader } from "../src/browser-text-payload-reader.js";

const authentication = {
  subjectId: "owner-01",
  ownerId: "owner-01",
  deviceId: "device-01",
  authenticatedAt: "2026-08-28T00:00:00.000Z",
  authenticationRef: "session-01",
};

const record = {
  ref: "payload-private-01",
  dataClassification: "private" as const,
  contentType: "text/plain",
  ciphertext: new Uint8Array([1, 2, 3]),
  encryption: {
    algorithm: "AES-256-GCM" as const,
    keyRef: "payload-key-01",
    kekVersion: "v1",
    nonce: "nonce-01",
    authTag: "tag-01",
  },
  contentDigest: "digest-01",
  createdAt: "2026-08-28T00:00:00.000Z",
};

function store(payload = record): PayloadStorePort {
  return {
    put: vi.fn(),
    get: vi.fn(async () => payload),
    delete: vi.fn(),
  };
}

function protector(plaintext: Uint8Array): PayloadProtectorPort {
  return {
    protect: vi.fn(),
    rewrap: vi.fn(),
    unprotect: vi.fn(async () => plaintext),
  };
}

describe("browser text Payload reader", () => {
  it("unprotects one scoped UTF-8 text Payload without exposing ciphertext metadata", async () => {
    const payloads = vi.fn(() => store());
    const reader = new BrowserTextPayloadReader({
      payloads,
      protector: protector(new TextEncoder().encode("私人正文")),
    });
    const result = await reader.read({
      authentication,
      agentId: "agent-01",
      payloadRef: "payload-private-01",
    });

    expect(payloads).toHaveBeenCalledWith("owner-01", "agent-01");
    expect(result).toEqual({
      content: "私人正文",
      dataClassification: "private",
      contentType: "text/plain",
    });
    expect(JSON.stringify(result)).not.toContain("ciphertext");
  });

  it("rejects missing, non-text, invalid UTF-8, and oversized Payloads", async () => {
    const missing = new BrowserTextPayloadReader({
      payloads: () => ({ put: vi.fn(), get: vi.fn(), delete: vi.fn() }),
      protector: protector(new Uint8Array()),
    });
    await expect(
      missing.read({ authentication, agentId: "agent-01", payloadRef: "payload-missing" }),
    ).rejects.toMatchObject({ code: "PORT_NOT_FOUND" });

    const nonText = new BrowserTextPayloadReader({
      payloads: () => store({ ...record, contentType: "application/octet-stream" }),
      protector: protector(new Uint8Array()),
    });
    await expect(
      nonText.read({ authentication, agentId: "agent-01", payloadRef: record.ref }),
    ).rejects.toMatchObject({ code: "PORT_NOT_FOUND" });

    const invalid = new BrowserTextPayloadReader({
      payloads: () => store(),
      protector: protector(new Uint8Array([0xff])),
    });
    await expect(
      invalid.read({ authentication, agentId: "agent-01", payloadRef: record.ref }),
    ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });

    const oversized = new BrowserTextPayloadReader({
      payloads: () => store(),
      protector: protector(new Uint8Array(5)),
      maximumPlaintextBytes: 4,
    });
    await expect(
      oversized.read({ authentication, agentId: "agent-01", payloadRef: record.ref }),
    ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
  });
});
