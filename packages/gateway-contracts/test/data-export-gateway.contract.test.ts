import { describe, expect, it } from "vitest";

import { ContractValidationError, gatewayV2MessageSchema } from "../src/index.ts";
import { fixture } from "./gateway-v2.fixture.ts";

const exportId = "data-export:AAAAAAAAAAAAAAAAAAAAAA";
const result = {
  downloadPath: `/api/data-export/v1/archive?exportId=${encodeURIComponent(exportId)}`,
  fileName: "himawari-export-2026-11-12.zip",
  sizeBytes: 22,
  sha256: "0".repeat(64),
  memories: 0,
  rules: 0,
  withheld: 0,
  expiresAt: "2026-11-12T00:10:00.000Z",
};

const progress = { textsRead: 2, textsTotal: 5 };

function rejects(message: Record<string, unknown>) {
  expect(() => gatewayV2MessageSchema.parse(message)).toThrow(ContractValidationError);
}

const snapshot = (overrides: Record<string, unknown>) =>
  fixture("snapshot", "data.export.status.snapshot", {
    exportId,
    state: "ready",
    startedAt: "2026-11-12T00:00:00.000Z",
    finishedAt: "2026-11-12T00:00:01.000Z",
    failureCode: null,
    progress: null,
    result,
    generatedAt: "2026-11-12T00:00:02.000Z",
    ...overrides,
  });

describe("data export gateway messages", () => {
  it("accepts every state, with and without a result", () => {
    for (const state of ["running", "ready", "failed", "cancelled", "expired"])
      gatewayV2MessageSchema.parse(snapshot({ state, result: null }));
    expect(gatewayV2MessageSchema.parse(snapshot({})).type).toBe("data.export.status.snapshot");
  });

  it("accepts real progress while running", () => {
    gatewayV2MessageSchema.parse(snapshot({ state: "running", result: null, progress }));
    gatewayV2MessageSchema.parse(
      snapshot({
        state: "running",
        result: null,
        progress: { textsRead: 5, textsTotal: 5 },
      }),
    );
  });

  it.each([
    ["progress after the export is ready", { progress }],
    ["progress on a cancelled export", { state: "cancelled", result: null, progress }],
    [
      "more texts read than the total",
      { state: "running", result: null, progress: { ...progress, textsRead: 6 } },
    ],
    [
      "an unknown total",
      { state: "running", result: null, progress: { ...progress, textsTotal: null } },
    ],
    [
      "a percentage instead of counts",
      { state: "running", result: null, progress: { ...progress, percent: 40 } },
    ],
  ])("rejects a snapshot with %s", (_name, overrides) => {
    rejects(snapshot(overrides));
  });

  it("accepts a cancel command for one export and rejects it without a valid id", () => {
    gatewayV2MessageSchema.parse(fixture("command", "data.export.cancel", { exportId }));
    rejects(fixture("command", "data.export.cancel", {}));
    rejects(fixture("command", "data.export.cancel", { exportId: "not-an-id" }));
    rejects(fixture("command", "data.export.cancel", { exportId, reason: "slow" }));
  });

  it.each([
    ["without the prefix", "AAAAAAAAAAAAAAAAAAAAAA"],
    ["too short", "data-export:AAAAAAAAAAAAAAAAAAAAA"],
    ["with a character outside base64url", "data-export:AAAAAAAAAAAAAAAAAAAAA+"],
  ])("rejects an export id %s", (_name, badId) => {
    rejects(fixture("query", "data.export.status.read", { exportId: badId }));
    rejects(snapshot({ exportId: badId }));
  });

  it.each([
    ["an unknown state", { state: "done" }],
    ["an uppercase digest", { result: { ...result, sha256: "A".repeat(64) } }],
    ["a short digest", { result: { ...result, sha256: "0".repeat(63) } }],
    ["an empty archive", { result: { ...result, sizeBytes: 0 } }],
    ["a negative count", { result: { ...result, memories: -1 } }],
    ["a result without expiry", { result: { ...result, expiresAt: undefined } }],
    ["an extra field", { extra: true }],
    [
      "a download path for another export",
      {
        result: {
          ...result,
          downloadPath: `/api/data-export/v1/archive?exportId=${encodeURIComponent("data-export:BAAAAAAAAAAAAAAAAAAAAA")}`,
        },
      },
    ],
    [
      "an absolute download url",
      { result: { ...result, downloadPath: `https://evil.example${result.downloadPath}` } },
    ],
    [
      "a download path with the id only in a fragment",
      { result: { ...result, downloadPath: `/api/data-export/v1/archive#?exportId=${exportId}` } },
    ],
    [
      "a download path without the export id",
      { result: { ...result, downloadPath: "/api/data-export/v1/archive" } },
    ],
  ])("rejects a snapshot with %s", (_name, overrides) => {
    rejects(snapshot(overrides));
  });

  it("rejects a start command that carries a payload field", () => {
    rejects(fixture("command", "data.export.start", { format: "zip" }));
  });
});
