import { sandboxNetworkDomainSchema } from "./sandbox-host-binding-v1.ts";
import {
  array,
  ContractValidationError,
  type Schema,
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
const sandboxScopeShape = object({
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

const relativeFilePath: Schema<string> = {
  parse(value, path = "$") {
    if (
      typeof value !== "string" ||
      value.length > 4096 ||
      value
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            part === ".git" ||
            part === ".env" ||
            part.startsWith(".himawari-"),
        ) ||
      Array.from(value).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new ContractValidationError(path, "invalid relative file target");
    return value;
  },
};
const digest: Schema<string> = {
  parse(value, path = "$") {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
      throw new ContractValidationError(path, "invalid file version digest");
    return value;
  },
};
const fileTargetShape = object({
  schemaVersion: literal("sandbox-file-target.v1"),
  relativePath: relativeFilePath,
  lineage: array(object({ device: machineString, inode: machineString })),
  before: nullable(object({ device: machineString, inode: machineString, contentDigest: digest })),
});
export type SandboxFileTarget = InferSchema<typeof fileTargetShape> & {
  readonly missingParents?: number;
};
export const sandboxFileTargetSchema: Schema<SandboxFileTarget> = {
  parse(value, path = "$") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ContractValidationError(path, "invalid file target");
    const { missingParents, ...base } = value as Record<string, unknown>;
    const absent = missingParents === undefined ? 0 : integer(1, 255).parse(missingParents, path);
    const result = fileTargetShape.parse(base, path);
    if (
      result.lineage.length + absent !== result.relativePath.split("/").length ||
      (absent > 0 && result.before !== null) ||
      result.lineage.length === 0 ||
      result.lineage.length > 256 ||
      new Set(result.lineage.map((item) => `${item.device}:${item.inode}`)).size !==
        result.lineage.length
    )
      throw new ContractValidationError(path, "invalid file parent lineage");
    return Object.freeze({ ...result, ...(absent ? { missingParents: absent } : {}) });
  },
};
export type SandboxScope = InferSchema<typeof sandboxScopeShape> & {
  readonly fileTarget?: SandboxFileTarget;
};
/** An additive field is emitted only for the versioned fixed-file contract.
 * Old strict readers reject it; missing metadata never enables narrower access. */
export const sandboxScopeSchema: Schema<SandboxScope> = {
  parse(value, path = "$") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ContractValidationError(path, "invalid sandbox scope");
    const { fileTarget, ...base } = value as Record<string, unknown>;
    const scope = sandboxScopeShape.parse(base, path);
    return Object.freeze({
      ...scope,
      ...(fileTarget === undefined
        ? {}
        : { fileTarget: sandboxFileTargetSchema.parse(fileTarget, `${path}.fileTarget`) }),
    });
  },
};

/** Resolved by Agent authority for this invocation; contains no host paths. */
export const resolvedSandboxScopeSchema = object({
  scope: sandboxScopeSchema,
  allowedDomains: array(sandboxNetworkDomainSchema),
});
export type ResolvedSandboxScope = InferSchema<typeof resolvedSandboxScopeSchema>;
