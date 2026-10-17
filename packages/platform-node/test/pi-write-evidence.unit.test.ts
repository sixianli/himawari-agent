import { createHash } from "node:crypto";
import {
  PI_FIXED_FILE_CONTRACT,
  PI_RUNNER_CONTRACT,
  PI_WRITE_VERIFIER,
} from "@himawari-agent/execution-contracts";
import { describe, expect, it } from "vitest";
import { verifiedPiWriteFailure, verifyPiWriteEvidence } from "../src/files/pi-write-evidence.js";
const parameters = { path: "note.txt", content: "hello" };
const plan = {
  operation: "write",
  identity: { toolCallId: "call" },
  operationContract: {
    ...PI_RUNNER_CONTRACT,
    kind: "verified_effect" as const,
    verifierRef: PI_WRITE_VERIFIER.ref,
    verifierVersion: PI_WRITE_VERIFIER.version,
    targetRef: PI_WRITE_VERIFIER.targetRef,
  },
};
const scope = { directoryGrant: { ref: "grant", revision: 1 } };
const output = () => ({
  schemaVersion: "pi-result.v1",
  tool: "write",
  isError: false,
  source: {
    workspace: "/workspace",
    toolCallId: "call",
    directoryGrantRef: "grant",
    directoryGrantRevision: 1,
    parameters,
  },
  verifiedWrite: {
    path: "/workspace/note.txt",
    contentDigest: createHash("sha256").update("hello").digest("hex"),
    byteLength: 5,
  },
});
const verify = (value: unknown) =>
  verifyPiWriteEvidence({
    bytes: Buffer.from(JSON.stringify(value)),
    parameters,
    plan,
    scope,
    workspace: "/workspace",
  });
describe("persisted Pi write evidence", () => {
  it("accepts the bounded proof associated with the exact admitted call and content", () =>
    expect(() => verify(output())).not.toThrow());
  it.each([
    "absent",
    "different-content",
    "different-path",
    "different-call",
    "different-grant",
    "different-input",
    "error",
  ])("rejects %s without converting it to a confirmed effect", (kind) => {
    const result = output();
    if (kind === "absent") Reflect.deleteProperty(result, "verifiedWrite");
    if (kind === "different-content") result.verifiedWrite.contentDigest = "0".repeat(64);
    if (kind === "different-path") result.verifiedWrite.path = "/workspace/other.txt";
    if (kind === "different-call") result.source.toolCallId = "other";
    if (kind === "different-grant") result.source.directoryGrantRevision = 2;
    if (kind === "different-input") result.source.parameters = { ...parameters, content: "other" };
    if (kind === "error") result.isError = true;
    expect(() => verify(result)).toThrow("PI_WRITE_EVIDENCE_INVALID");
  });
  const notWritten = () => ({
    ...output(),
    tool: "write",
    isError: true,
    verifiedWrite: null,
    writeNotStarted: true,
    content: [{ type: "text", text: "Could not find the exact text in note.txt." }],
  });
  it("[R2-T14] accepts a failure the runner reports before the commit as verified no write", () => {
    expect(verify(notWritten())).toBe("not_written");
    expect(
      verifiedPiWriteFailure({
        bytes: Buffer.from(JSON.stringify(notWritten())),
        parameters,
        plan,
        scope,
        workspace: "/workspace",
      }),
    ).toBe("not_written");
  });
  it.each([
    "with-proof",
    "not-error",
    "flag-not-true",
    "different-call",
    "different-input",
    "different-tool",
    "fixed-file-contract",
  ])("[R2-T14] rejects a not-written claim %s", (kind) => {
    const result: Record<string, unknown> & { source: Record<string, unknown> } = notWritten();
    let checkedPlan: Parameters<typeof verifyPiWriteEvidence>[0]["plan"] = plan;
    if (kind === "with-proof") result["verifiedWrite"] = output().verifiedWrite;
    if (kind === "not-error") result["isError"] = false;
    if (kind === "flag-not-true") result["writeNotStarted"] = "true";
    if (kind === "different-call") result.source["toolCallId"] = "other";
    if (kind === "different-input") result.source["parameters"] = { ...parameters, content: "x" };
    if (kind === "different-tool") result["tool"] = "edit";
    if (kind === "fixed-file-contract")
      checkedPlan = {
        ...plan,
        operationContract: { ...plan.operationContract, ...PI_FIXED_FILE_CONTRACT },
      };
    const input = {
      bytes: Buffer.from(JSON.stringify(result)),
      parameters,
      plan: checkedPlan,
      scope,
      workspace: "/workspace",
    };
    expect(() => verifyPiWriteEvidence(input)).toThrow("PI_WRITE_EVIDENCE_INVALID");
    expect(verifiedPiWriteFailure(input)).toBeNull();
  });
  it("[R2-T14] does not report a successful write as a write failure", () =>
    expect(
      verifiedPiWriteFailure({
        bytes: Buffer.from(JSON.stringify(output())),
        parameters,
        plan,
        scope,
        workspace: "/workspace",
      }),
    ).toBeNull());
  it("rejects an unimplemented verifier even when the runner exited normally", () =>
    expect(() =>
      verifyPiWriteEvidence({
        bytes: Buffer.from(JSON.stringify(output())),
        parameters,
        plan: { ...plan, operationContract: { ...plan.operationContract, verifierRef: "unknown" } },
        scope,
      }),
    ).toThrow());
});
