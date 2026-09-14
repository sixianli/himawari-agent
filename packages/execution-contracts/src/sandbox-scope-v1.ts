import { sandboxNetworkDomainSchema } from "./sandbox-host-binding-v1.ts";
import {
  array,
  enumeration,
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
  parentRequestId: machineString,
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
    authorizationRef: machineString,
    operations: array(
      enumeration(["read", "create", "update", "move", "trash", "restore", "permanent_delete"]),
    ),
  }),
  networkAuthorizationRef: nullable(machineString),
  expiresAt: timestamp,
});

export type SandboxScope = InferSchema<typeof sandboxScopeSchema>;

/** Resolved by Agent authority for this invocation; contains no host paths. */
export const resolvedSandboxScopeSchema = object({
  scope: sandboxScopeSchema,
  allowedDomains: array(sandboxNetworkDomainSchema),
});
export type ResolvedSandboxScope = InferSchema<typeof resolvedSandboxScopeSchema>;
