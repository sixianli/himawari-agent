import {
  buildDeviceTestRequest,
  type DeviceTestRequestInput,
  generateDeviceTestKeyPair,
} from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";
import {
  DEVICE_SIGNATURE_ERROR_CODES,
  type DeviceSignatureError,
  publicKeyFromSpkiBase64,
  verifyDeviceRequest,
} from "@himawari-agent/platform-node";

const deviceId = "dev_0123456789abcdef0123";
const origin = "https://himawari.example";
const device = generateDeviceTestKeyPair();
const confirm = generateDeviceTestKeyPair();
const other = generateDeviceTestKeyPair();
const NOW = new Date("2026-11-11T10:00:00Z");
const nowSeconds = Math.floor(NOW.getTime() / 1000);

async function verify(
  overrides: Partial<DeviceTestRequestInput>,
  options: {
    requireConfirm?: boolean;
    tamperBody?: string;
    tamperQuery?: string;
    noBody?: boolean;
  } = {},
) {
  const built = buildDeviceTestRequest({
    method: "POST",
    origin,
    path: "/api/device/v1/messages",
    query: "a=1",
    ...(options.noBody ? {} : { body: '{"text":"hi"}' }),
    deviceId,
    deviceKey: device.privateKey,
    createdAtSeconds: nowSeconds,
    ...overrides,
  });
  const url = new URL(built.url);
  return verifyDeviceRequest({
    request: {
      method: built.method,
      authority: built.headers["host"] as string,
      path: url.pathname,
      rawQuery: options.tamperQuery ?? url.search.slice(1),
      signatureInput: built.headers["signature-input"],
      signature: built.headers["signature"],
      contentDigest: built.headers["content-digest"],
      contentType: built.headers["content-type"],
      body: options.tamperBody ? Buffer.from(options.tamperBody) : (built.body ?? Buffer.alloc(0)),
    },
    expectedAuthority: "himawari.example",
    toleranceSeconds: 60,
    now: NOW,
    requireConfirm: options.requireConfirm ?? false,
    lookupKeys: async (id) =>
      id === deviceId
        ? {
            device: publicKeyFromSpkiBase64(device.publicKeySpkiBase64),
            confirm: publicKeyFromSpkiBase64(confirm.publicKeySpkiBase64),
          }
        : undefined,
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as DeviceSignatureError).code;
  }
  return "ACCEPTED";
}

describe("device request signature", () => {
  it("accepts a correctly signed request and reports device, nonce and confirmation", async () => {
    const result = await verify({});
    expect(result.deviceId).toBe(deviceId);
    expect(result.confirmed).toBe(false);
    expect(result.nonce).toHaveLength(22);
  });

  it("accepts a signed bodiless request", async () => {
    expect((await verify({ method: "GET", query: "after=3" }, { noBody: true })).deviceId).toBe(
      deviceId,
    );
  });

  it("rejects a changed body, a changed query, another host, and another path", async () => {
    expect(await codeOf(verify({}, { tamperBody: '{"text":"HI"}' }))).toBe(
      DEVICE_SIGNATURE_ERROR_CODES.DIGEST_MISMATCH,
    );
    expect(await codeOf(verify({}, { tamperQuery: "a=2" }))).toBe(
      DEVICE_SIGNATURE_ERROR_CODES.SIGNATURE_INVALID,
    );
    expect(await codeOf(verify({ signedAuthority: "evil.example" }))).toBe(
      DEVICE_SIGNATURE_ERROR_CODES.SIGNATURE_INVALID,
    );
    expect(await codeOf(verify({ signedPath: "/api/device/v1/config" }))).toBe(
      DEVICE_SIGNATURE_ERROR_CODES.SIGNATURE_INVALID,
    );
  });

  it("rejects a body digest header that covers other bytes", async () => {
    expect(await codeOf(verify({ signedBody: '{"text":"other"}' }))).toBe(
      DEVICE_SIGNATURE_ERROR_CODES.SIGNATURE_INVALID,
    );
  });

  it("rejects signatures outside the tolerance and reports the server time", async () => {
    for (const created of [nowSeconds - 61, nowSeconds + 61]) {
      try {
        await verify({ createdAtSeconds: created });
        expect.unreachable();
      } catch (error) {
        expect((error as DeviceSignatureError).code).toBe(DEVICE_SIGNATURE_ERROR_CODES.CLOCK_SKEW);
        expect((error as DeviceSignatureError).serverTime).toBe(NOW.toISOString());
      }
    }
    expect((await verify({ createdAtSeconds: nowSeconds - 60 })).deviceId).toBe(deviceId);
  });

  it("rejects an unknown device, a wrong key, and a missing signature", async () => {
    expect(await codeOf(verify({ deviceId: "dev_unknown0123456789abc" }))).toBe(
      DEVICE_SIGNATURE_ERROR_CODES.KEY_UNKNOWN,
    );
    expect(await codeOf(verify({ deviceKey: other.privateKey }))).toBe(
      DEVICE_SIGNATURE_ERROR_CODES.SIGNATURE_INVALID,
    );
    const built = buildDeviceTestRequest({
      method: "GET",
      origin,
      path: "/api/device/v1/config",
      deviceId,
      deviceKey: device.privateKey,
    });
    expect(
      await codeOf(
        verifyDeviceRequest({
          request: {
            method: "GET",
            authority: "himawari.example",
            path: "/api/device/v1/config",
            rawQuery: "",
            signatureInput: undefined,
            signature: built.headers["signature"],
            contentDigest: undefined,
            contentType: undefined,
            body: Buffer.alloc(0),
          },
          expectedAuthority: "himawari.example",
          toleranceSeconds: 60,
          now: NOW,
          lookupKeys: async () => undefined,
        }),
      ),
    ).toBe(DEVICE_SIGNATURE_ERROR_CODES.SIGNATURE_MISSING);
  });

  it("requires the confirmation key when asked and rejects a device-key-only request", async () => {
    expect(await codeOf(verify({}, { requireConfirm: true }))).toBe(
      DEVICE_SIGNATURE_ERROR_CODES.CONFIRM_REQUIRED,
    );
    const confirmed = await verify({ confirmKey: confirm.privateKey }, { requireConfirm: true });
    expect(confirmed.confirmed).toBe(true);
    expect(await codeOf(verify({ confirmKey: other.privateKey }, { requireConfirm: true }))).toBe(
      DEVICE_SIGNATURE_ERROR_CODES.SIGNATURE_INVALID,
    );
  });

  it("rejects a confirmation signature made with the device key under the confirm label", async () => {
    expect(await codeOf(verify({ confirmKey: device.privateKey }, { requireConfirm: true }))).toBe(
      DEVICE_SIGNATURE_ERROR_CODES.SIGNATURE_INVALID,
    );
  });

  it("rejects public keys that are not P-256", () => {
    expect(() => publicKeyFromSpkiBase64("AAAA")).toThrow();
  });
});
