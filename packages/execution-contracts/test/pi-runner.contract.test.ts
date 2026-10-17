import { describe, expect, it } from "vitest";
import {
  PI_COPY_SAVE_CONTRACT,
  PI_DIRECTORY_MOVE_CONTRACT,
  PI_FIXED_FILE_CONTRACT,
  PI_PREPARED_FILE_CONTRACT,
  PI_RUNNER_CONTRACT,
  PI_WRITE_VERIFIER,
  piRunnerInputSchema,
  sandboxExecutionScopeSchema,
  sandboxOperationBindingsSchema,
  sandboxScopeSchema,
  srtTaskEnvironmentSession,
} from "../src/index.ts";

const input = {
  schemaVersion: "pi-runner.v1",
  workerInstanceId: "worker",
  tool: "read",
  workspace: "/project",
  runtimeRoot: "/installation",
  privateDirectory: "/private/job",
  maxOutputBytes: 4096,
  parametersJson: JSON.stringify({ path: "file.txt", authorizationRef: "untrusted" }),
  scope: {
    schemaVersion: "sandbox-scope.v1",
    ownerId: "owner",
    agentId: "agent",
    threadId: "thread",
    runId: "run",
    toolCallId: "call",
    parentToolCallId: null,
    parentRequestId: "request",
    hostId: "host",
    handleRef: "handle",
    inputRef: "input",
    operation: "read",
    authorizationRef: "trusted",
    modelRef: "model",
    profileRef: "authorized-project.v1",
    directoryGrant: {
      ref: "directory",
      revision: 1,
      canonicalRootId: "123:456",
      authorizationRef: "trusted",
      operations: ["read"],
    },
    networkAuthorizationRef: null,
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
};
describe("Pi runner protected input", () => {
  it("keeps model parameters separate from trusted scope", () => {
    const parsed = piRunnerInputSchema.parse(input);
    expect(parsed.executionMode).toBe("foreground");
    expect(parsed.scope.authorizationRef).toBe("trusted");
    expect(JSON.parse(parsed.parametersJson).authorizationRef).toBe("untrusted");
  });
  it.each([
    { tool: "exec" },
    { executionMode: "background" },
    { executionMode: "unmanaged" },
    { workspace: "/" },
    { workspace: "/project/../other" },
    { workspace: "/project\nother" },
    { scope: undefined },
    { command: "untrusted" },
    { maxOutputBytes: 0 },
    { parametersJson: "x".repeat(49153) },
  ])("rejects malformed envelope %j", (change) => {
    expect(() => piRunnerInputSchema.parse({ ...input, ...change })).toThrow();
  });
});

it("retains a host-frozen file version inside protected scope", () => {
  const fileTarget = {
    schemaVersion: "sandbox-file-target.v1",
    relativePath: "notes/file.txt",
    lineage: [
      { device: "1", inode: "2" },
      { device: "1", inode: "4" },
    ],
    before: { device: "1", inode: "3", contentDigest: "a".repeat(64) },
  };
  const envelope = { ...input, scope: { ...input.scope, fileTarget } };
  expect(piRunnerInputSchema.parse(envelope).scope.fileTarget).toEqual(fileTarget);
  for (const changed of [
    { ...fileTarget, relativePath: "../escape" },
    { ...fileTarget, lineage: [] },
    { ...fileTarget, before: { ...fileTarget.before, contentDigest: "forged" } },
  ])
    expect(() =>
      piRunnerInputSchema.parse({ ...envelope, scope: { ...input.scope, fileTarget: changed } }),
    ).toThrow();
});

it("keeps private network scopes distinct from directory and Pi file scopes", () => {
  const scope = {
    ...input.scope,
    schemaVersion: "sandbox-scope.v2",
    directoryGrant: null,
    networkAuthorizationRef: "trusted",
  };
  expect(sandboxExecutionScopeSchema.parse(scope).directoryGrant).toBeNull();
  expect(() => sandboxScopeSchema.parse(scope)).toThrow();
  expect(() => piRunnerInputSchema.parse({ ...input, scope })).toThrow();
  for (const changed of [
    { ...scope, directoryGrant: input.scope.directoryGrant },
    { ...scope, networkAuthorizationRef: null },
    { ...scope, fileTarget: {} },
  ])
    expect(() => sandboxExecutionScopeSchema.parse(changed)).toThrow();
});
it("requires an explicit foreground network-only deployment contract for private scope", () => {
  const binding = {
    operation: "web_search",
    mode: "foreground",
    contract: { kind: "network_only", ref: "search", version: "1" },
    backendRef: "srt",
    scopeSource: "private_temp",
    directoryOperations: [],
    network: "grant_targets",
  };
  expect(sandboxOperationBindingsSchema.parse([binding])).toEqual([binding]);
  for (const changed of [
    { ...binding, directoryOperations: ["read"] },
    { ...binding, scopeSource: "grant_targets" },
    { ...binding, network: "disabled" },
    { ...binding, mode: "background" },
    { ...binding, contract: { ...binding.contract, kind: "fixed_read" } },
  ])
    expect(() => sandboxOperationBindingsSchema.parse([changed])).toThrow();
});

it("keeps optional copy authority separate from source writes and fixed-file targets", () => {
  const scope = {
    ...input.scope,
    operation: "bash",
    workspaceCopy: {
      canonicalRootId: "workspace-copy:fixture",
      canonicalPath: "/private/workspace-copies/copy-abc/source",
      device: "1",
      inode: "2",
    },
  };
  expect(sandboxScopeSchema.parse(scope).workspaceCopy?.inode).toBe("2");
  expect(() => sandboxScopeSchema.parse({ ...scope, operation: "write" })).toThrow();
  expect(() =>
    sandboxScopeSchema.parse({
      ...scope,
      directoryGrant: { ...scope.directoryGrant, operations: ["read", "update"] },
    }),
  ).toThrow();
  expect(() => sandboxScopeSchema.parse({ ...scope, fileTarget: {} })).toThrow();
});

describe("[R2-P2] SRT task-environment session kind", () => {
  const command = { ...PI_RUNNER_CONTRACT, kind: "command" } as const;
  const write = {
    ...PI_RUNNER_CONTRACT,
    kind: "verified_effect",
    verifierRef: PI_WRITE_VERIFIER.ref,
    verifierVersion: PI_WRITE_VERIFIER.version,
    targetRef: PI_WRITE_VERIFIER.targetRef,
  } as const;
  const plan = (
    operation: string,
    operationContract: Parameters<typeof srtTaskEnvironmentSession>[0]["operationContract"],
    mode: "foreground" | "background" | "service" = "foreground",
  ) => ({ operation, operationContract, mode });

  it("[R2-P2] places foreground version-1 bash in the command session", () => {
    expect(srtTaskEnvironmentSession(plan("bash", command))).toBe("command");
  });

  it("[R2-P2] places foreground version-1 write and edit in the file-write session", () => {
    expect(srtTaskEnvironmentSession(plan("write", write))).toBe("file_write");
    expect(srtTaskEnvironmentSession(plan("edit", write))).toBe("file_write");
  });

  it.each([
    ["background bash", plan("bash", { ...PI_RUNNER_CONTRACT, kind: "task_start" }, "background")],
    [
      "a bash service",
      plan(
        "bash",
        { ...PI_RUNNER_CONTRACT, kind: "service_start", readinessProbeRef: "probe" },
        "service",
      ),
    ],
    ["a version-1 read", plan("read", { ...PI_RUNNER_CONTRACT, kind: "fixed_read" })],
    ["a fixed-file write", plan("write", { ...write, ...PI_FIXED_FILE_CONTRACT })],
    ["a prepared-file edit", plan("edit", { ...write, ...PI_PREPARED_FILE_CONTRACT })],
    ["a directory move", plan("move_directory", { ...write, ...PI_DIRECTORY_MOVE_CONTRACT })],
    ["a copy save", plan("save_copy", { ...write, ...PI_COPY_SAVE_CONTRACT })],
    ["bash under another contract", plan("bash", { ...command, ref: "other-tool" })],
    ["a write declared as a command", plan("write", command)],
    ["bash declared as a verified effect", plan("bash", write)],
    ["a write with another verifier", plan("write", { ...write, verifierRef: "host-copy-save" })],
  ])("[R2-P2] keeps %s out of task-environment sessions", (_case, input) => {
    expect(srtTaskEnvironmentSession(input)).toBeNull();
  });
});
