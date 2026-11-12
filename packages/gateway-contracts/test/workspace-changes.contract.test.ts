import { describe, expect, it } from "vitest";

import { ContractValidationError, gatewayV2MessageSchema } from "../src/index.ts";
import { fixture } from "./gateway-v2.fixture.ts";

const snapshot = (item: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
  fixture("snapshot", "workspace.changes.snapshot", {
    grantId: "grant-coding",
    grantMatched: true,
    displayPath: "/var/lib/himawari/workspace",
    threadId: null,
    recording: "direct",
    fileCount: 1,
    incomplete: false,
    skippedDirectories: [],
    items: [
      {
        path: "a.py",
        state: "changed",
        source: "bash",
        threadId: "thread-01",
        versions: 1,
        changedAt: "2026-11-12T03:06:30.000Z",
        deletedAt: null,
        ...item,
      },
    ],
    nextAfterPath: null,
    generatedAt: "2026-11-12T03:06:30.000Z",
    ...overrides,
  });

describe("[WC-8] workspace.changes.snapshot", () => {
  it("accepts a file-changing tool that does not exist yet", () => {
    expect(gatewayV2MessageSchema.parse(snapshot({ source: "apply_patch" })).type).toBe(
      "workspace.changes.snapshot",
    );
  });

  it.each([
    ["an unknown state", snapshot({ state: "created" })],
    ["a zero version count", snapshot({ versions: 0 })],
    ["an unknown recording mode", snapshot({}, { recording: "remote" })],
    ["a negative file count", snapshot({}, { fileCount: -1 })],
  ])("rejects %s", (_name, message) => {
    expect(() => gatewayV2MessageSchema.parse(message)).toThrow(ContractValidationError);
  });

  it("keeps an unknown folder apart from a folder with no changes", () => {
    const unknown = gatewayV2MessageSchema.parse(
      snapshot({}, { grantMatched: false, displayPath: null, fileCount: 0, items: [] }),
    );
    const empty = gatewayV2MessageSchema.parse(snapshot({}, { fileCount: 0, items: [] }));
    expect(unknown.payload).toMatchObject({ grantMatched: false, fileCount: 0 });
    expect(empty.payload).toMatchObject({ grantMatched: true, fileCount: 0 });
  });
});
