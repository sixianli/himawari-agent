import { describe, expect, it } from "vitest";

import { ContractValidationError, gatewayV2MessageSchema } from "../src/index.ts";
import { fixture } from "./gateway-v2.fixture.ts";

const deviceId = "dev_AAAAAAAAAAAAAAAAAAAAAA";

function rejects(message: Record<string, unknown>) {
  expect(() => gatewayV2MessageSchema.parse(message)).toThrow(ContractValidationError);
}

describe("device management gateway messages", () => {
  it.each([
    ["wrong prefix", "device_AAAAAAAAAAAAAAAAAAAAAA"],
    ["short", "dev_AAAA"],
    ["long", "dev_AAAAAAAAAAAAAAAAAAAAAAA"],
    ["bad character", "dev_AAAAAAAAAAAAAAAAAAAA+A"],
  ])("rejects a device id that is %s", (_name, badId) => {
    for (const type of ["device.revoke"])
      rejects(fixture("command", type, { deviceId: badId, expectedRevision: 0 }));
    rejects(
      fixture("command", "device.rename", { deviceId: badId, expectedRevision: 0, name: "x" }),
    );
  });

  it("rejects negative or fractional expected revisions", () => {
    rejects(fixture("command", "device.revoke", { deviceId, expectedRevision: -1 }));
    rejects(fixture("command", "device.revoke", { deviceId, expectedRevision: 1.5 }));
    rejects(fixture("command", "device.revoke", { deviceId }));
  });

  it("trims device names and bounds them to 1-64 characters", () => {
    const parsed = gatewayV2MessageSchema.parse(
      fixture("command", "device.rename", { deviceId, expectedRevision: 1, name: "  书房 Mac  " }),
    );
    expect(
      parsed.kind === "command" && parsed.type === "device.rename" && parsed.payload.name,
    ).toBe("书房 Mac");
    gatewayV2MessageSchema.parse(
      fixture("command", "device.rename", { deviceId, expectedRevision: 1, name: "a".repeat(64) }),
    );
    gatewayV2MessageSchema.parse(
      fixture("command", "device.rename", { deviceId, expectedRevision: 1, name: "😀".repeat(64) }),
    );
    for (const name of [
      "",
      "   ",
      "a".repeat(65),
      "😀".repeat(65),
      "a\nb",
      "a\u202eb",
      "a\u200bb",
      "a\u0085b",
    ])
      rejects(fixture("command", "device.rename", { deviceId, expectedRevision: 1, name }));
  });

  it("rejects extra payload fields on every device command", () => {
    for (const type of ["device.revoke"])
      rejects(fixture("command", type, { deviceId, expectedRevision: 0, extra: 1 }));
    rejects(
      fixture("command", "device.rename", { deviceId, expectedRevision: 0, name: "x", extra: 1 }),
    );
    rejects(fixture("query", "device.list.read", { extra: 1 }));
  });

  describe("device.list.snapshot", () => {
    const device = {
      id: deviceId,
      revision: 0,
      kind: "mac",
      name: "Mac",
      releaseChannel: "direct",
      status: "pending",
      pairedAt: "2026-11-12T03:00:00.000Z",
      lastSeenAt: null,
    };
    const snapshot = (overrides: Record<string, unknown>) =>
      fixture("snapshot", "device.list.snapshot", {
        devices: [device],
        limits: [],
        generatedAt: "2026-11-12T03:00:00.000Z",
        ...overrides,
      });

    it("accepts every release channel", () => {
      for (const releaseChannel of ["direct", "testflight", "app_store", "mac_direct"])
        gatewayV2MessageSchema.parse(snapshot({ devices: [{ ...device, releaseChannel }] }));
    });

    it("accepts an empty device list", () => {
      gatewayV2MessageSchema.parse(snapshot({ devices: [] }));
      gatewayV2MessageSchema.parse(snapshot({}));
    });

    it.each([
      ["unknown kind", { devices: [{ ...device, kind: "tablet" }] }],
      ["unknown status", { devices: [{ ...device, status: "lost" }] }],
      ["unknown release channel", { devices: [{ ...device, releaseChannel: "beta" }] }],
      ["a pairing number", { devices: [{ ...device, pairingNumber: "123456" }] }],
      ["unknown limit key", { limits: [{ key: "device.unknown", unit: "bytes", value: 1 }] }],
      ["negative limit", { limits: [{ key: "device.nonce.retained", unit: "count", value: -1 }] }],
      ["a pairing", { pairing: null }],
    ])("rejects %s", (_name, overrides) => {
      rejects(snapshot(overrides));
    });
  });

  describe("server.status.snapshot", () => {
    const status = (overrides: Record<string, unknown>) =>
      fixture("snapshot", "server.status.snapshot", {
        live: true,
        ready: true,
        status: "healthy",
        dependencies: [],
        release: null,
        disk: null,
        generatedAt: "2026-11-12T03:00:00.000Z",
        ...overrides,
      });

    it("accepts every overall and dependency status", () => {
      for (const overall of ["healthy", "degraded", "not_ready", "not_live"])
        gatewayV2MessageSchema.parse(status({ status: overall }));
      for (const dependencyStatus of ["healthy", "degraded", "blocked", "unavailable"])
        gatewayV2MessageSchema.parse(
          status({
            dependencies: [
              { name: "sqlite", required: false, status: dependencyStatus, reasonCode: null },
            ],
          }),
        );
    });

    it.each([
      ["unknown overall status", { status: "ok" }],
      [
        "unknown dependency status",
        { dependencies: [{ name: "sqlite", required: true, status: "ok", reasonCode: null }] },
      ],
      [
        "dependency without reasonCode",
        { dependencies: [{ name: "sqlite", required: true, status: "healthy" }] },
      ],
      ["missing live", { live: undefined }],
      ["release without a commit hash", { release: { commit: "main", installedAt: null } }],
      ["disk with no size", { disk: { availableBytes: 0, totalBytes: 0 } }],
    ])("rejects %s", (_name, overrides) => {
      rejects(status(overrides));
    });
  });
});
