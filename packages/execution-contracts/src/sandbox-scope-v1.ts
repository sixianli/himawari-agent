import {
  type InferSchema,
  integer,
  literal,
  machineString,
  nullable,
  object,
  timestamp,
} from "./validation.ts";

/** Protected product scope metadata. Paths and platform policy are resolved on
 * the bound host, never supplied by model-side tool arguments. */
export const sandboxScopeSchema = object({
  schemaVersion: literal("sandbox-scope.v1"),
  ownerId: machineString,
  agentId: machineString,
  threadId: nullable(machineString),
  runId: machineString,
  toolCallId: machineString,
  parentToolCallId: nullable(machineString),
  hostId: machineString,
  handleRef: machineString,
  inputRef: machineString,
  operation: machineString,
  authorizationRef: machineString,
  modelRef: machineString,
  profileRef: machineString,
  directoryGrant: object({
    ref: machineString,
    revision: integer(1),
    canonicalRootId: machineString,
  }),
  networkAuthorizationRef: nullable(machineString),
  expiresAt: timestamp,
});

export type SandboxScope = InferSchema<typeof sandboxScopeSchema>;
