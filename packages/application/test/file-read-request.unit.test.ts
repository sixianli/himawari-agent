import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import type { RuntimeToolInvocation } from "../src/ports/intelligence.js";
import {
  fileReadRequestDescriptor,
  validateFileReadRequest,
} from "../src/services/file-read-request.js";

const schema = new Ajv({ strict: true }).compile(fileReadRequestDescriptor().parameters);
const valid = { hostRef: "mac-book", path: "/test/中文.txt", maximumBytes: 4096 };
function invocation(args: RuntimeToolInvocation["arguments"]): RuntimeToolInvocation {
  return {
    runId: "run:file-request" as RuntimeToolInvocation["runId"],
    toolCallId: "call:file-request",
    capabilityRef: "host.file.read",
    capabilityHandleRef: null,
    arguments: args,
    dataClassification: "private",
  };
}

describe("file read request contract", () => {
  it.each([
    valid,
    { ...valid, maximumBytes: 1 },
    { ...valid, maximumBytes: 65536 },
    // Syntax validation must preserve unresolved paths, never infer directory authority.
    { ...valid, path: "/allowed/../outside.txt" },
    { ...valid, path: "/test/a b.txt" },
  ])("accepts intent without resolving or authorizing the target %j", (args) => {
    expect(schema(args)).toBe(true);
    expect(validateFileReadRequest(invocation(args))).toBe(true);
  });

  it.each([
    { ...valid, hostRef: "mac\n" },
    { ...valid, hostRef: "x".repeat(129) },
    { ...valid, hostRef: "" },
    { ...valid, path: "/file\n" },
    { ...valid, path: "/file\u0000" },
    { ...valid, path: "/file\u007f" },
    { ...valid, path: "file.txt" },
    { ...valid, path: "~/file.txt" },
    { ...valid, path: "/" },
    { ...valid, path: `/${"a".repeat(4096)}` },
    { ...valid, maximumBytes: 65537 },
    { ...valid, maximumBytes: 0 },
    { ...valid, maximumBytes: 1.5 },
    { ...valid, maximumBytes: "4096" },
    { ...valid, approved: true },
    { ...valid, capabilityHandleRef: "forged" },
    { hostRef: valid.hostRef, path: valid.path },
  ])("rejects invalid intent at both schema and product boundaries %j", (args) => {
    expect(schema(args)).toBe(false);
    expect(validateFileReadRequest(invocation(args))).toBe(false);
  });

  it("does not accept another capability or a supplied Handle as a file request", () => {
    expect(validateFileReadRequest({ ...invocation(valid), capabilityRef: "shell" })).toBe(false);
    expect(validateFileReadRequest({ ...invocation(valid), capabilityHandleRef: "forged" })).toBe(
      false,
    );
  });
});
