import { describe, expect, it } from "vitest";
import { ContractValidationError, piContainerRunnerInputSchema } from "../src/index.ts";

const input = {
  schemaVersion: "pi-container-runner.v1",
  tool: "read",
  toolCallId: "call-1",
  hostId: "host-1",
  canonicalRootId: "root-1",
  workspace: "/workspaces/root-1",
  grantRef: "grant-1",
  grantRevision: 1,
  authorizationRef: "authorization-1",
  access: "read",
  expiresAt: "2026-09-26T11:00:00.000Z",
  maxOutputBytes: 65536,
  parametersJson: JSON.stringify({ path: "src/app.ts" }),
};

describe("Pi container runner input", () => {
  it("accepts the Pi tools inside one mounted directory", () => {
    for (const tool of ["read", "bash", "find", "grep", "ls"])
      expect(piContainerRunnerInputSchema.parse({ ...input, tool })).toEqual({ ...input, tool });
    for (const tool of ["write", "edit"]) {
      const value = { ...input, tool, access: "write" };
      expect(piContainerRunnerInputSchema.parse(value)).toEqual(value);
    }
  });

  it.each([
    ["a workspace outside the mount root", { workspace: "/project/root-1" }],
    ["a workspace below the mounted directory", { workspace: "/workspaces/root-1/src" }],
    ["a workspace of another directory", { workspace: "/workspaces/root-2" }],
    ["a write through a read grant", { tool: "write" }],
    ["an edit through a read grant", { tool: "edit" }],
    ["the host copy save", { tool: "save_copy", access: "write" }],
    ["the host directory move", { tool: "move_directory", access: "write" }],
    ["oversized parameters", { parametersJson: "x".repeat(49153) }],
    ["an unbounded output", { maxOutputBytes: 0 }],
    ["an unknown field", { runtimeRoot: "/opt/himawari" }],
  ])("rejects %s", (_case, overrides) => {
    expect(() => piContainerRunnerInputSchema.parse({ ...input, ...overrides })).toThrow(
      ContractValidationError,
    );
  });
});
