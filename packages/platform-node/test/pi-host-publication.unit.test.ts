import { sandboxScopeSchema } from "@himawari-agent/execution-contracts";
import { describe, expect, it } from "vitest";
import { type PiHostPublicationInput, publishPreparedPiOperation } from "../src/index.js";

const scope = sandboxScopeSchema.parse({
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
  operation: "move_directory",
  authorizationRef: "authority",
  modelRef: "model",
  profileRef: "authorized-project.v1",
  directoryGrant: {
    ref: "directory",
    revision: 1,
    canonicalRootId: "1:1",
    authorizationRef: "authority",
    operations: ["read"],
  },
  networkAuthorizationRef: null,
  expiresAt: "2999-01-01T00:00:00.000Z",
  directoryMove: {
    schemaVersion: "sandbox-directory-move.v1",
    sourceRelativePath: "reports",
    destinationRelativePath: "archive",
    sourceIdentity: { device: "1", inode: "2" },
    sourceLineage: [
      { device: "1", inode: "1" },
      { device: "1", inode: "2" },
    ],
    destinationLineage: [{ device: "1", inode: "1" }],
  },
});

const outcome = (input: PiHostPublicationInput): Promise<string> =>
  publishPreparedPiOperation(input).then(
    () => "resolved",
    (error: Error) => error.message,
  );

describe("[R2-T9] prepared host publication request", () => {
  it("reaches the directory move operation whether or not fitOutput is a function", async () => {
    const without = await outcome({
      hostId: "host",
      tool: "move_directory",
      executionMode: "foreground",
      scope,
      workspace: "/workspace",
      privateDirectory: "/job",
      commandPath: "/usr/bin",
      maxOutputBytes: 65536,
      parametersJson: JSON.stringify({ path: "reports", destination: "archive" }),
    });
    const withFunction = await outcome({
      hostId: "host",
      tool: "move_directory",
      executionMode: "foreground",
      scope,
      workspace: "/workspace",
      privateDirectory: "/job",
      commandPath: "/usr/bin",
      maxOutputBytes: 65536,
      parametersJson: JSON.stringify({ path: "reports", destination: "archive" }),
      fitOutput: (json: string) => json,
    });
    expect(without).toBe("HOST_DIRECTORY_MOVE_DENIED");
    expect(withFunction).toBe(without);
  });
});
