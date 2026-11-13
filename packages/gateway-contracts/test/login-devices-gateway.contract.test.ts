import { describe, expect, it } from "vitest";

import { ContractValidationError, gatewayV2MessageSchema } from "../src/index.ts";
import { fixture } from "./gateway-v2.fixture.ts";

const device = {
  deviceId: "device-01",
  label: "Andy 的 iPhone",
  firstSeenAt: "2026-11-01T00:00:00.000Z",
  lastSeenAt: "2026-11-12T03:00:00.000Z",
  current: false,
};

function rejects(message: Record<string, unknown>) {
  expect(() => gatewayV2MessageSchema.parse(message)).toThrow(ContractValidationError);
}

describe("login devices gateway messages", () => {
  it("accepts an empty list and a revoke without recent authentication", () => {
    gatewayV2MessageSchema.parse(
      fixture("snapshot", "login.devices.snapshot", {
        devices: [],
        generatedAt: "2026-11-12T03:06:30.000Z",
      }),
    );
    gatewayV2MessageSchema.parse(
      fixture("command", "login.device.revoke", {
        deviceId: "device-01",
        recentAuthenticationRef: null,
      }),
    );
  });

  it.each([
    ["a label with a control character", { label: "a\u0007b" }],
    ["a label over 80 characters", { label: "a".repeat(81) }],
    ["a missing current flag", { current: undefined }],
    ["a bad timestamp", { lastSeenAt: "yesterday" }],
    ["an extra field", { status: "revoked" }],
  ])("rejects a device with %s", (_name, overrides) => {
    rejects(
      fixture("snapshot", "login.devices.snapshot", {
        devices: [{ ...device, ...overrides }],
        generatedAt: "2026-11-12T03:06:30.000Z",
      }),
    );
  });

  it.each([
    ["no device", { recentAuthenticationRef: null }],
    ["a device id with spaces", { deviceId: "device 01", recentAuthenticationRef: null }],
    ["no recent authentication field", { deviceId: "device-01" }],
    ["an extra field", { deviceId: "device-01", recentAuthenticationRef: null, all: true }],
  ])("rejects a revoke with %s", (_name, payload) => {
    rejects(fixture("command", "login.device.revoke", payload));
  });

  it("accepts revoking every other device with or without recent authentication", () => {
    for (const recentAuthenticationRef of ["auth-ref-01", null])
      gatewayV2MessageSchema.parse(
        fixture("command", "login.devices.revoke_others", { recentAuthenticationRef }),
      );
  });

  it.each([
    ["no recent authentication field", {}],
    ["a device id", { deviceId: "device-01", recentAuthenticationRef: null }],
    ["a ref with spaces", { recentAuthenticationRef: "auth ref" }],
  ])("rejects revoking every other device with %s", (_name, payload) => {
    rejects(fixture("command", "login.devices.revoke_others", payload));
  });

  it("rejects a query with a payload", () => {
    rejects(fixture("query", "login.devices.read", { all: true }));
  });
});
