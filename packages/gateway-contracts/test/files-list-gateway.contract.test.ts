import { describe, expect, it } from "vitest";

import { ContractValidationError, gatewayV2MessageSchema } from "../src/index.ts";
import { fixture } from "./gateway-v2.fixture.ts";

const file = {
  fileId: "thread-artifact:01",
  threadId: "thread-1",
  threadTitle: null,
  name: "report.pdf",
  kind: "pdf",
  origin: "uploaded",
  mediaType: "application/pdf",
  sizeBytes: 0,
  version: 1,
  createdAt: "2026-11-12T03:00:00.000Z",
  deleted: false,
  contentPath: null,
};

const query = (overrides: Record<string, unknown>) =>
  fixture("query", "files.list.read", {
    kind: null,
    origin: null,
    before: null,
    limit: 1,
    ...overrides,
  });

const snapshot = (overrides: Record<string, unknown>) =>
  fixture("snapshot", "files.list.snapshot", {
    files: [file],
    nextCursor: null,
    generatedAt: "2026-11-12T03:06:30.000Z",
    ...overrides,
  });

function rejects(message: Record<string, unknown>) {
  expect(() => gatewayV2MessageSchema.parse(message)).toThrow(ContractValidationError);
}

describe("files list gateway messages", () => {
  it("accepts every filter, an empty file and an empty page", () => {
    expect(gatewayV2MessageSchema.parse(query({ limit: 100 })).type).toBe("files.list.read");
    for (const kind of ["document", "code", "web", "image", "pdf", "data", "other"])
      gatewayV2MessageSchema.parse(query({ kind }));
    for (const origin of ["uploaded", "generated"]) gatewayV2MessageSchema.parse(query({ origin }));
    gatewayV2MessageSchema.parse(snapshot({}));
    gatewayV2MessageSchema.parse(snapshot({ files: [], nextCursor: "abc_-1" }));
    gatewayV2MessageSchema.parse(
      snapshot({
        files: [
          {
            ...file,
            contentPath: `/api/files/v1/content/${encodeURIComponent(":".repeat(128))}`,
          },
        ],
      }),
    );
    gatewayV2MessageSchema.parse(
      snapshot({ files: [{ ...file, contentPath: `/${"a".repeat(511)}` }] }),
    );
    gatewayV2MessageSchema.parse(
      snapshot({ files: [{ ...file, threadTitle: `周${"五".repeat(255)}` }] }),
    );
  });

  it.each([
    ["no limit", { limit: undefined }],
    ["a zero limit", { limit: 0 }],
    ["a limit over 100", { limit: 101 }],
    ["an unknown kind", { kind: "video" }],
    ["an unknown origin", { origin: "copied" }],
    ["a cursor with padding", { before: "abc=" }],
    ["an empty cursor", { before: "" }],
    ["a cursor over 512 characters", { before: "a".repeat(513) }],
    ["a thread filter", { threadId: "thread-1" }],
  ])("rejects a query with %s", (_name, overrides) => {
    rejects(query(overrides));
  });

  it.each([
    ["a name with a control character", { name: "a\u0007b" }],
    ["an empty name", { name: "" }],
    ["a negative size", { sizeBytes: -1 }],
    ["version zero", { version: 0 }],
    ["an unknown origin", { origin: "copied" }],
    ["a missing deleted flag", { deleted: undefined }],
    ["an extra field", { path: "secret/report.pdf" }],
    ["a content path over 512 characters", { contentPath: `/${"a".repeat(512)}` }],
    ["a thread title over 256 characters", { threadTitle: "a".repeat(257) }],
    ["a thread title with a control character", { threadTitle: "a\nb" }],
    ["a missing thread title", { threadTitle: undefined }],
  ])("rejects a file with %s", (_name, overrides) => {
    rejects(snapshot({ files: [{ ...file, ...overrides }] }));
  });
});
