import { createHash } from "node:crypto";
import { PI_RUNNER_CONTRACT, PI_WRITE_VERIFIER } from "@himawari-agent/execution-contracts";
import { describe, expect, it } from "vitest";
import { verifyPiWriteEvidence } from "../src/files/pi-write-evidence.js";
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
