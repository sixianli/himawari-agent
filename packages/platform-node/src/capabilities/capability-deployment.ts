// biome-ignore-all lint/complexity/useLiteralKeys: untrusted JSON remains index-signature typed until validated
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import {
  type CapabilityDeploymentConfiguration,
  type CapabilityManifest,
  type CapabilityRegistryRecord,
  type CapabilityResourceCeiling,
  type CapabilityRuntimeContract,
  type CapabilityRuntimeQualification,
  validateCapabilityManifest,
} from "@himawari-agent/application";
import {
  type SandboxHostBinding,
  sandboxHostBindingSchema,
  sandboxRuntimeQualificationSchema,
} from "@himawari-agent/execution-contracts";
import type {
  CapabilityHostIsolationBinding,
  CapabilityRuntimeBindingPort,
  CapabilityEndpointBinding as RuntimeEndpointBinding,
  CapabilityEndpointOperationBinding as RuntimeEndpointOperationBinding,
  CapabilityProcessBinding as RuntimeProcessBinding,
} from "./isolation.js";

export const CAPABILITY_DEPLOYMENT_SCHEMA_VERSION = "capability-deployment.v1" as const;
export const CAPABILITY_DEPLOYMENT_MAX_BYTES = 8 * 1024 * 1024;
export const CAPABILITY_DEPLOYMENT_MAX_QUALIFICATION_AGE_MS = 5 * 60 * 1_000;

export const CAPABILITY_DEPLOYMENT_ERROR_CODES = Object.freeze({
  PATH_UNSAFE: "CAPABILITY_DEPLOYMENT_PATH_UNSAFE",
  FILE_UNSAFE: "CAPABILITY_DEPLOYMENT_FILE_UNSAFE",
  TOO_LARGE: "CAPABILITY_DEPLOYMENT_TOO_LARGE",
  READ_FAILED: "CAPABILITY_DEPLOYMENT_READ_FAILED",
  DIGEST_MISMATCH: "CAPABILITY_DEPLOYMENT_DIGEST_MISMATCH",
  INVALID_JSON: "CAPABILITY_DEPLOYMENT_INVALID_JSON",
  UNKNOWN_FIELD: "CAPABILITY_DEPLOYMENT_UNKNOWN_FIELD",
  INVALID_VALUE: "CAPABILITY_DEPLOYMENT_INVALID_VALUE",
  EMPTY: "CAPABILITY_DEPLOYMENT_EMPTY",
  DUPLICATE_CAPABILITY: "CAPABILITY_DEPLOYMENT_DUPLICATE_CAPABILITY",
  PLATFORM_MISMATCH: "CAPABILITY_DEPLOYMENT_PLATFORM_MISMATCH",
  QUALIFICATION_INVALID: "CAPABILITY_DEPLOYMENT_QUALIFICATION_INVALID",
  QUALIFICATION_STALE: "CAPABILITY_DEPLOYMENT_QUALIFICATION_STALE",
  BINDING_MISMATCH: "CAPABILITY_DEPLOYMENT_BINDING_MISMATCH",
  RUNTIME_UNSUPPORTED: "CAPABILITY_DEPLOYMENT_RUNTIME_UNSUPPORTED",
  MANIFEST_INVALID: "CAPABILITY_DEPLOYMENT_MANIFEST_INVALID",
} as const);

export type CapabilityDeploymentErrorCode =
  (typeof CAPABILITY_DEPLOYMENT_ERROR_CODES)[keyof typeof CAPABILITY_DEPLOYMENT_ERROR_CODES];

export class CapabilityDeploymentError extends Error {
  readonly code: CapabilityDeploymentErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: CapabilityDeploymentErrorCode,
    message: string,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "CapabilityDeploymentError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export type CapabilityDeploymentBinding =
  | { readonly kind: "sandbox"; readonly value: SandboxHostBinding }
  | {
      readonly kind: "process";
      readonly value: RuntimeProcessBinding;
    }
  | {
      readonly kind: "endpoint";
      readonly value: RuntimeEndpointBinding;
    };

export interface CapabilityDeploymentEntry {
  readonly manifest: CapabilityManifest;
  readonly qualification: CapabilityRuntimeQualification;
  readonly binding: CapabilityDeploymentBinding;
}

export interface CapabilityDeploymentSnapshot {
  readonly schemaVersion: typeof CAPABILITY_DEPLOYMENT_SCHEMA_VERSION;
  readonly capabilities: readonly CapabilityDeploymentEntry[];
  /** Required by the production composition for Linux process runtimes. */
  readonly hostIsolation?: CapabilityHostIsolationBinding;
}

export interface CapabilityDeploymentAdapter {
  /** Shape-compatible with the Worker’s boot-scoped RegisteredWorkerAdapter. */
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly operations: readonly string[];
  readonly artifactDigest: string;
  readonly runtimeKind: CapabilityRuntimeContract["kind"];
}

export interface LoadedCapabilityDeployment {
  readonly snapshotPath: string;
  readonly snapshotDigest: string;
  readonly snapshot: CapabilityDeploymentSnapshot;
  readonly manifests: readonly CapabilityManifest[];
  readonly records: readonly CapabilityRegistryRecord[];
  readonly adapters: readonly CapabilityDeploymentAdapter[];
  readonly bindings: CapabilityRuntimeBindingPort;
  readonly hostIsolation?: CapabilityHostIsolationBinding;
}

export interface CapabilityDeploymentSnapshotLoaderOptions
  extends CapabilityDeploymentConfiguration {
  readonly platform?: NodeJS.Platform;
  readonly maximumBytes?: number;
  readonly now?: () => string;
  readonly maximumQualificationAgeMs?: number;
}

const DATA_CLASSIFICATIONS = ["public", "private", "sensitive", "restricted"] as const;
const SOURCE_TYPES = [
  "builtin",
  "tool",
  "skill",
  "package",
  "mcp",
  "program",
  "remote_api",
  "adapter",
] as const;
const ISOLATIONS = ["trusted_process", "worker", "sandbox", "remote"] as const;
const SIGNATURE_STATUSES = ["verified", "not_applicable", "invalid", "unknown"] as const;
const HEALTH_STATUSES = ["healthy", "degraded", "unhealthy", "unknown"] as const;
const CAPABILITY_RUNTIME_KINDS = [
  "pi_tool",
  "pi_resource",
  "mcp",
  "program",
  "remote_api",
  "adapter",
] as const;
const PI_BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const CEILING_FIELDS = [
  "maxWallTimeMs",
  "maxCpuTimeMs",
  "maxMemoryBytes",
  "maxOutputBytes",
  "maxProgressEvents",
] as const;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(
  code: CapabilityDeploymentErrorCode,
  field: string,
  reason: string,
): CapabilityDeploymentError {
  return new CapabilityDeploymentError(code, "Capability deployment snapshot is invalid", {
    field,
    reason,
  });
}

function invalid(field: string, reason: string): CapabilityDeploymentError {
  return failure(CAPABILITY_DEPLOYMENT_ERROR_CODES.INVALID_VALUE, field, reason);
}

function record(value: unknown, field: string): JsonRecord {
  if (!isRecord(value)) throw invalid(field, "must be an object");
  return value;
}

function rejectUnknown(value: JsonRecord, allowed: readonly string[], field: string): void {
  const allowedFields = new Set(allowed);
  const unknown = Object.keys(value)
    .filter((key) => !allowedFields.has(key))
    .sort();
  if (unknown.length > 0) {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.UNKNOWN_FIELD,
      `${field}.${unknown[0]}`,
      "is unsupported",
    );
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalid(field, "must be non-empty");
  return value;
}

function stableReference(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(result)) {
    throw invalid(field, "must be a stable reference");
  }
  return result;
}

function sha256(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^sha256:[a-f0-9]{64}$/.test(result) || /^sha256:0{64}$/.test(result)) {
    throw invalid(field, "must be a lowercase sha256 reference");
  }
  return result;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw invalid(field, "must be boolean");
  return value;
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalid(field, `must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], field: string): T {
  const match = values.find((entry) => entry === value);
  if (match === undefined) throw invalid(field, "has an unsupported value");
  return match;
}

function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field);
}

function nullableReference(value: unknown, field: string): string | null {
  return value === null ? null : stableReference(value, field);
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field);
  if (Number.isNaN(Date.parse(result))) throw invalid(field, "must be a valid timestamp");
  return result;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : timestamp(value, field);
}

function strings(value: unknown, field: string, nonEmpty: boolean): readonly string[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw invalid(field, nonEmpty ? "must be a non-empty array" : "must be an array");
  }
  const result = value.map((entry, index) => text(entry, `${field}[${index}]`));
  if (new Set(result).size !== result.length) throw invalid(field, "must not contain duplicates");
  return Object.freeze(result);
}

function references(value: unknown, field: string, nonEmpty: boolean): readonly string[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw invalid(field, nonEmpty ? "must be a non-empty array" : "must be an array");
  }
  const result = value.map((entry, index) => stableReference(entry, `${field}[${index}]`));
  if (new Set(result).size !== result.length) throw invalid(field, "must not contain duplicates");
  return Object.freeze(result);
}

function normalizedAbsolutePath(value: unknown, field: string): string {
  const result = text(value, field);
  if (!path.isAbsolute(result) || path.normalize(result) !== result) {
    throw invalid(field, "must be a normalized absolute path");
  }
  return result;
}

function snapshotPath(value: unknown): string {
  const result = text(value, "snapshotPath");
  if (!path.isAbsolute(result) || path.normalize(result) !== result) {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.PATH_UNSAFE,
      "snapshotPath",
      "must be a normalized absolute path",
    );
  }
  return result;
}

function stringMap(value: unknown, field: string): Readonly<Record<string, string>> {
  const input = record(value, field);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (key.length === 0 || key === "__proto__" || key === "constructor" || key === "prototype") {
      throw invalid(`${field}.${key}`, "has an unsafe key");
    }
    if (typeof entry !== "string") throw invalid(`${field}.${key}`, "must be a string");
    result[key] = entry;
  }
  return Object.freeze(result);
}

function parseSource(value: unknown, field: string): CapabilityManifest["source"] {
  const input = record(value, field);
  rejectUnknown(input, ["type", "locator"], field);
  return Object.freeze({
    type: oneOf(input["type"], SOURCE_TYPES, `${field}.type`),
    locator: text(input["locator"], `${field}.locator`),
  });
}

function parseArtifact(value: unknown, field: string): CapabilityManifest["artifact"] {
  const input = record(value, field);
  rejectUnknown(input, ["digest", "signatureStatus", "signerRef", "rollbackArtifactRef"], field);
  return Object.freeze({
    digest: sha256(input["digest"], `${field}.digest`),
    signatureStatus: oneOf(
      input["signatureStatus"],
      SIGNATURE_STATUSES,
      `${field}.signatureStatus`,
    ),
    signerRef: nullableReference(input["signerRef"], `${field}.signerRef`),
    rollbackArtifactRef: nullableReference(
      input["rollbackArtifactRef"],
      `${field}.rollbackArtifactRef`,
    ),
  });
}

function parseScopes(value: unknown, field: string): CapabilityManifest["scopes"] {
  const input = record(value, field);
  rejectUnknown(input, ["dataClassifications", "network", "filesystem", "secrets"], field);
  const classifications = input["dataClassifications"];
  if (!Array.isArray(classifications) || classifications.length === 0) {
    throw invalid(`${field}.dataClassifications`, "must be a non-empty array");
  }
  const dataClassifications = classifications.map((entry, index) =>
    oneOf(entry, DATA_CLASSIFICATIONS, `${field}.dataClassifications[${index}]`),
  );
  if (new Set(dataClassifications).size !== dataClassifications.length) {
    throw invalid(`${field}.dataClassifications`, "must not contain duplicates");
  }
  return Object.freeze({
    dataClassifications: Object.freeze(dataClassifications),
    network: strings(input["network"], `${field}.network`, false),
    filesystem: references(input["filesystem"], `${field}.filesystem`, false),
    secrets: references(input["secrets"], `${field}.secrets`, false),
  });
}

function parseRuntime(value: unknown, field: string): CapabilityRuntimeContract {
  const input = record(value, field);
  const kind = oneOf(input["kind"], CAPABILITY_RUNTIME_KINDS, `${field}.kind`);
  switch (kind) {
    case "pi_tool":
      rejectUnknown(input, ["kind", "piBuiltinDefinition"], field);
      return Object.freeze({
        kind,
        piBuiltinDefinition: oneOf(
          input["piBuiltinDefinition"],
          PI_BUILTINS,
          `${field}.piBuiltinDefinition`,
        ),
      });
    case "pi_resource":
      rejectUnknown(input, ["kind", "additionalResourcePaths"], field);
      return Object.freeze({
        kind,
        additionalResourcePaths: strings(
          input["additionalResourcePaths"],
          `${field}.additionalResourcePaths`,
          true,
        ),
      });
    case "mcp":
      rejectUnknown(input, ["kind", "serverIdentity", "transport", "mappedResources"], field);
      return Object.freeze({
        kind,
        serverIdentity: text(input["serverIdentity"], `${field}.serverIdentity`),
        transport: text(input["transport"], `${field}.transport`),
        mappedResources: strings(input["mappedResources"], `${field}.mappedResources`, true),
      });
    case "program":
      rejectUnknown(
        input,
        [
          "kind",
          "argv",
          "environmentKeys",
          "workdirRef",
          "stdin",
          "stdout",
          "subprocesses",
          "network",
          "filesystem",
        ],
        field,
      );
      return Object.freeze({
        kind,
        argv: strings(input["argv"], `${field}.argv`, true),
        environmentKeys: strings(input["environmentKeys"], `${field}.environmentKeys`, false),
        workdirRef: stableReference(input["workdirRef"], `${field}.workdirRef`),
        stdin: oneOf(input["stdin"], ["none", "protected_payload"], `${field}.stdin`),
        stdout: oneOf(input["stdout"], ["none", "protected_payload"], `${field}.stdout`),
        subprocesses: strings(input["subprocesses"], `${field}.subprocesses`, false),
        network: strings(input["network"], `${field}.network`, false),
        filesystem: references(input["filesystem"], `${field}.filesystem`, false),
      });
    case "remote_api":
    case "adapter":
      rejectUnknown(input, ["kind", "endpointIdentity", "protectedReferenceOnly"], field);
      if (input["protectedReferenceOnly"] !== true) {
        throw invalid(`${field}.protectedReferenceOnly`, "must be true");
      }
      return Object.freeze({
        kind,
        endpointIdentity: text(input["endpointIdentity"], `${field}.endpointIdentity`),
        protectedReferenceOnly: true,
      });
  }
}

function parseManifest(value: unknown, field: string): CapabilityManifest {
  const input = record(value, field);
  rejectUnknown(
    input,
    [
      "manifestVersion",
      "ref",
      "displayName",
      "version",
      "source",
      "sourceIdentity",
      "integrity",
      "artifact",
      "operations",
      "permissionRefs",
      "isolation",
      "scopes",
      "cost",
      "health",
      "reviewedBy",
      "reviewedAt",
      "contractCompatibility",
      "runtime",
    ],
    field,
  );
  if (input["manifestVersion"] !== "capability.v2") {
    throw invalid(`${field}.manifestVersion`, "is unsupported");
  }
  const cost = record(input["cost"], `${field}.cost`);
  rejectUnknown(cost, ["currency", "maxMicrosPerInvocation"], `${field}.cost`);
  const health = record(input["health"], `${field}.health`);
  rejectUnknown(health, ["status", "checkedAt"], `${field}.health`);
  const manifest: CapabilityManifest = {
    manifestVersion: "capability.v2",
    ref: stableReference(input["ref"], `${field}.ref`),
    displayName: text(input["displayName"], `${field}.displayName`),
    version: stableReference(input["version"], `${field}.version`),
    source: parseSource(input["source"], `${field}.source`),
    sourceIdentity: text(input["sourceIdentity"], `${field}.sourceIdentity`),
    integrity: sha256(input["integrity"], `${field}.integrity`),
    artifact: parseArtifact(input["artifact"], `${field}.artifact`),
    operations: references(input["operations"], `${field}.operations`, true),
    permissionRefs: references(input["permissionRefs"], `${field}.permissionRefs`, false),
    isolation: oneOf(input["isolation"], ISOLATIONS, `${field}.isolation`),
    scopes: parseScopes(input["scopes"], `${field}.scopes`),
    cost: Object.freeze({
      currency: text(cost["currency"], `${field}.cost.currency`),
      maxMicrosPerInvocation: integer(
        cost["maxMicrosPerInvocation"],
        `${field}.cost.maxMicrosPerInvocation`,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
    }),
    health: Object.freeze({
      status: oneOf(health["status"], HEALTH_STATUSES, `${field}.health.status`),
      checkedAt: nullableTimestamp(health["checkedAt"], `${field}.health.checkedAt`),
    }),
    reviewedBy: nullableText(input["reviewedBy"], `${field}.reviewedBy`),
    reviewedAt: nullableTimestamp(input["reviewedAt"], `${field}.reviewedAt`),
    contractCompatibility: strings(
      input["contractCompatibility"],
      `${field}.contractCompatibility`,
      true,
    ),
    runtime: parseRuntime(input["runtime"], `${field}.runtime`),
  };
  try {
    validateCapabilityManifest(manifest);
  } catch {
    throw failure(CAPABILITY_DEPLOYMENT_ERROR_CODES.MANIFEST_INVALID, field, "is not verifiable");
  }
  return deepFreeze(manifest);
}

function parseQualification(
  value: unknown,
  manifest: CapabilityManifest,
  platform: CapabilityRuntimeQualification["platform"],
  nowMs: number,
  maximumAgeMs: number,
  field: string,
): CapabilityRuntimeQualification {
  const input = record(value, field);
  rejectUnknown(
    input,
    [
      "qualificationVersion",
      "sandbox",
      "platform",
      "runtimeIdentity",
      "productionSuitable",
      "artifactDigest",
      "enforcement",
      "reasonCodes",
      "checkedAt",
    ],
    field,
  );
  if (input["qualificationVersion"] !== "capability-runtime-qualification.v1") {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.QUALIFICATION_INVALID,
      `${field}.qualificationVersion`,
      "is unsupported",
    );
  }
  const qualificationPlatform = oneOf(
    input["platform"],
    ["darwin", "linux", "other"],
    `${field}.platform`,
  );
  if (qualificationPlatform !== platform) {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.PLATFORM_MISMATCH,
      `${field}.platform`,
      "does not match the current platform",
    );
  }
  if (input["productionSuitable"] !== true) {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.QUALIFICATION_INVALID,
      `${field}.productionSuitable`,
      "must be true",
    );
  }
  if (input["artifactDigest"] !== manifest.integrity) {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.QUALIFICATION_INVALID,
      `${field}.artifactDigest`,
      "must match the manifest integrity",
    );
  }
  const enforcement = record(input["enforcement"], `${field}.enforcement`);
  rejectUnknown(
    enforcement,
    ["filesystem", "network", "processes", "secrets", "resourceCeilings", "termination"],
    `${field}.enforcement`,
  );
  const checkedEnforcement = {
    filesystem: boolean(enforcement["filesystem"], `${field}.enforcement.filesystem`),
    network: boolean(enforcement["network"], `${field}.enforcement.network`),
    processes: boolean(enforcement["processes"], `${field}.enforcement.processes`),
    secrets: boolean(enforcement["secrets"], `${field}.enforcement.secrets`),
    resourceCeilings: boolean(
      enforcement["resourceCeilings"],
      `${field}.enforcement.resourceCeilings`,
    ),
    termination: boolean(enforcement["termination"], `${field}.enforcement.termination`),
  };
  const sandbox =
    input["sandbox"] === undefined
      ? undefined
      : sandboxRuntimeQualificationSchema.parse(input["sandbox"]);
  if (
    sandbox &&
    (sandbox.platform !== qualificationPlatform ||
      input["runtimeIdentity"] !== `srt:${sandbox.srtVersion}` ||
      checkedEnforcement.resourceCeilings !== false ||
      checkedEnforcement.termination !== (sandbox.platform === "linux"))
  ) {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.QUALIFICATION_INVALID,
      field,
      "sandbox evidence conflicts with enforcement claims",
    );
  }
  const requiredControls = sandbox
    ? [
        checkedEnforcement.filesystem,
        checkedEnforcement.network,
        checkedEnforcement.processes,
        checkedEnforcement.secrets,
      ]
    : Object.values(checkedEnforcement);
  if (requiredControls.some((value) => value !== true)) {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.QUALIFICATION_INVALID,
      `${field}.enforcement`,
      "all controls must be enforced",
    );
  }
  const checkedAt = timestamp(input["checkedAt"], `${field}.checkedAt`);
  const checkedAtMs = Date.parse(checkedAt);
  if (checkedAtMs > nowMs) {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.QUALIFICATION_INVALID,
      `${field}.checkedAt`,
      "must not be in the future",
    );
  }
  if (nowMs - checkedAtMs > maximumAgeMs) {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.QUALIFICATION_STALE,
      `${field}.checkedAt`,
      "is too old for the current deployment",
    );
  }
  const qualification: CapabilityRuntimeQualification = {
    qualificationVersion: "capability-runtime-qualification.v1",
    ...(sandbox ? { sandbox } : {}),
    platform: qualificationPlatform,
    runtimeIdentity: text(input["runtimeIdentity"], `${field}.runtimeIdentity`),
    productionSuitable: true,
    artifactDigest: manifest.integrity,
    enforcement: {
      filesystem: checkedEnforcement["filesystem"],
      network: checkedEnforcement["network"],
      processes: checkedEnforcement["processes"],
      secrets: checkedEnforcement["secrets"],
      resourceCeilings: checkedEnforcement["resourceCeilings"],
      termination: checkedEnforcement["termination"],
    },
    reasonCodes: strings(input["reasonCodes"], `${field}.reasonCodes`, false),
    checkedAt,
  };
  return deepFreeze(qualification);
}

function parseCeiling(value: unknown, field: string): CapabilityResourceCeiling {
  const input = record(value, field);
  rejectUnknown(input, CEILING_FIELDS, field);
  return Object.freeze({
    maxWallTimeMs: integer(
      input["maxWallTimeMs"],
      `${field}.maxWallTimeMs`,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    maxCpuTimeMs: integer(
      input["maxCpuTimeMs"],
      `${field}.maxCpuTimeMs`,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    maxMemoryBytes: integer(
      input["maxMemoryBytes"],
      `${field}.maxMemoryBytes`,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    maxOutputBytes: integer(
      input["maxOutputBytes"],
      `${field}.maxOutputBytes`,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    maxProgressEvents: integer(
      input["maxProgressEvents"],
      `${field}.maxProgressEvents`,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  });
}

function parseFilesystem(
  value: unknown,
  field: string,
): readonly RuntimeProcessBinding["filesystem"][number][] {
  if (!Array.isArray(value)) throw invalid(field, "must be an array");
  const result = value.map((entry, index) => {
    const itemField = `${field}[${index}]`;
    const input = record(entry, itemField);
    rejectUnknown(input, ["scopeRef", "hostPath", "sandboxPath", "access"], itemField);
    return Object.freeze({
      scopeRef: stableReference(input["scopeRef"], `${itemField}.scopeRef`),
      hostPath: normalizedAbsolutePath(input["hostPath"], `${itemField}.hostPath`),
      sandboxPath: normalizedAbsolutePath(input["sandboxPath"], `${itemField}.sandboxPath`),
      access: oneOf(input["access"], ["read", "read_write"], `${itemField}.access`),
    });
  });
  const scopes = result.map((entry) => entry.scopeRef);
  const paths = result.map((entry) => entry.sandboxPath);
  if (new Set(scopes).size !== scopes.length || new Set(paths).size !== paths.length) {
    throw invalid(field, "must not contain duplicate scope or sandbox paths");
  }
  return Object.freeze(result);
}

function parseProcessBinding(value: unknown, field: string): RuntimeProcessBinding {
  const input = record(value, field);
  rejectUnknown(
    input,
    [
      "capabilityRef",
      "capabilityVersion",
      "artifactDigest",
      "runtimeRoot",
      "command",
      "workdirRef",
      "sandboxWorkdir",
      "environment",
      "availableExecutables",
      "resourceLimitExecutable",
      "filesystem",
      "maximumResourceCeiling",
      "mcpServerIdentity",
      "mcpServerName",
      "mcpServerVersion",
      "mcpOperationMap",
    ],
    field,
  );
  const resourceLimitExecutable = record(
    input["resourceLimitExecutable"],
    `${field}.resourceLimitExecutable`,
  );
  rejectUnknown(
    resourceLimitExecutable,
    ["sandboxPath", "sha256"],
    `${field}.resourceLimitExecutable`,
  );
  return Object.freeze({
    capabilityRef: stableReference(input["capabilityRef"], `${field}.capabilityRef`),
    capabilityVersion: stableReference(input["capabilityVersion"], `${field}.capabilityVersion`),
    artifactDigest: sha256(input["artifactDigest"], `${field}.artifactDigest`),
    runtimeRoot: normalizedAbsolutePath(input["runtimeRoot"], `${field}.runtimeRoot`),
    command: normalizedAbsolutePath(input["command"], `${field}.command`),
    workdirRef: stableReference(input["workdirRef"], `${field}.workdirRef`),
    sandboxWorkdir: normalizedAbsolutePath(input["sandboxWorkdir"], `${field}.sandboxWorkdir`),
    environment: stringMap(input["environment"], `${field}.environment`),
    availableExecutables: Object.freeze(
      strings(input["availableExecutables"], `${field}.availableExecutables`, true).map(
        (entry, index) => normalizedAbsolutePath(entry, `${field}.availableExecutables[${index}]`),
      ),
    ),
    resourceLimitExecutable: Object.freeze({
      sandboxPath: normalizedAbsolutePath(
        resourceLimitExecutable["sandboxPath"],
        `${field}.resourceLimitExecutable.sandboxPath`,
      ),
      sha256: sha256(resourceLimitExecutable["sha256"], `${field}.resourceLimitExecutable.sha256`),
    }),
    filesystem: parseFilesystem(input["filesystem"], `${field}.filesystem`),
    maximumResourceCeiling: parseCeiling(
      input["maximumResourceCeiling"],
      `${field}.maximumResourceCeiling`,
    ),
    mcpServerIdentity: nullableText(input["mcpServerIdentity"], `${field}.mcpServerIdentity`),
    mcpServerName: nullableText(input["mcpServerName"], `${field}.mcpServerName`),
    mcpServerVersion: nullableText(input["mcpServerVersion"], `${field}.mcpServerVersion`),
    mcpOperationMap: stringMap(input["mcpOperationMap"], `${field}.mcpOperationMap`),
  });
}

function parseEndpointOperation(value: unknown, field: string): RuntimeEndpointOperationBinding {
  const input = record(value, field);
  rejectUnknown(input, ["method", "path", "secretHeaders"], field);
  const endpointPath = text(input["path"], `${field}.path`);
  if (!endpointPath.startsWith("/") || endpointPath.startsWith("//")) {
    throw invalid(`${field}.path`, "must be an absolute non-network path");
  }
  return Object.freeze({
    method: oneOf(input["method"], HTTP_METHODS, `${field}.method`),
    path: endpointPath,
    secretHeaders: stringMap(input["secretHeaders"], `${field}.secretHeaders`),
  });
}

function parseEndpointOperations(
  value: unknown,
  field: string,
): Readonly<Record<string, RuntimeEndpointOperationBinding>> {
  const input = record(value, field);
  const result: Record<string, RuntimeEndpointOperationBinding> = {};
  for (const [operation, entry] of Object.entries(input)) {
    result[stableReference(operation, `${field}.${operation}`)] = parseEndpointOperation(
      entry,
      `${field}.${operation}`,
    );
  }
  return Object.freeze(result);
}

function parseEndpointBinding(value: unknown, field: string): RuntimeEndpointBinding {
  const input = record(value, field);
  rejectUnknown(
    input,
    [
      "endpointIdentity",
      "artifactDigest",
      "url",
      "allowedMethods",
      "operations",
      "productionSuitable",
      "allowLoopbackQualification",
    ],
    field,
  );
  const endpointUrl = text(input["url"], `${field}.url`);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(endpointUrl);
  } catch {
    throw invalid(`${field}.url`, "must be an absolute URL");
  }
  if (parsedUrl.protocol !== "https:") {
    throw invalid(`${field}.url`, "must use HTTPS");
  }
  const allowedMethodsInput = input["allowedMethods"];
  if (!Array.isArray(allowedMethodsInput) || allowedMethodsInput.length === 0) {
    throw invalid(`${field}.allowedMethods`, "must be a non-empty array");
  }
  const allowedMethods = allowedMethodsInput.map((entry, index) =>
    oneOf(entry, HTTP_METHODS, `${field}.allowedMethods[${index}]`),
  );
  if (new Set(allowedMethods).size !== allowedMethods.length) {
    throw invalid(`${field}.allowedMethods`, "must not contain duplicates");
  }
  return Object.freeze({
    endpointIdentity: stableReference(input["endpointIdentity"], `${field}.endpointIdentity`),
    artifactDigest: sha256(input["artifactDigest"], `${field}.artifactDigest`),
    url: endpointUrl,
    allowedMethods: Object.freeze(allowedMethods),
    operations: parseEndpointOperations(input["operations"], `${field}.operations`),
    productionSuitable: boolean(input["productionSuitable"], `${field}.productionSuitable`),
    allowLoopbackQualification: boolean(
      input["allowLoopbackQualification"],
      `${field}.allowLoopbackQualification`,
    ),
  });
}

function parseHostExecutable(value: unknown, field: string) {
  const input = record(value, field);
  rejectUnknown(input, ["hostPath", "sha256"], field);
  return Object.freeze({
    hostPath: normalizedAbsolutePath(input["hostPath"], `${field}.hostPath`),
    sha256: sha256(input["sha256"], `${field}.sha256`),
  });
}

function parseHostIsolation(value: unknown, field: string): CapabilityHostIsolationBinding {
  const input = record(value, field);
  rejectUnknown(input, ["kind", "bwrap", "prlimit"], field);
  if (input["kind"] !== "linux-bwrap-prlimit.v1") {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.INVALID_VALUE,
      `${field}.kind`,
      "is unsupported",
    );
  }
  return deepFreeze({
    kind: "linux-bwrap-prlimit.v1" as const,
    bwrap: parseHostExecutable(input["bwrap"], `${field}.bwrap`),
    prlimit: parseHostExecutable(input["prlimit"], `${field}.prlimit`),
  });
}

function parseBinding(
  value: unknown,
  manifest: CapabilityManifest,
  field: string,
): CapabilityDeploymentBinding {
  const input = record(value, field);
  rejectUnknown(input, ["kind", "value"], field);
  const kind = oneOf(input["kind"], ["process", "endpoint", "sandbox"], `${field}.kind`);
  if (
    (manifest.runtime.kind === "program" || manifest.runtime.kind === "mcp") &&
    kind !== "process" &&
    kind !== "sandbox"
  ) {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.BINDING_MISMATCH,
      `${field}.kind`,
      "must be process for this runtime",
    );
  }
  if (
    (manifest.runtime.kind === "remote_api" || manifest.runtime.kind === "adapter") &&
    kind !== "endpoint"
  ) {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.BINDING_MISMATCH,
      `${field}.kind`,
      "must be endpoint for this runtime",
    );
  }
  if (manifest.runtime.kind === "pi_tool" || manifest.runtime.kind === "pi_resource") {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.RUNTIME_UNSUPPORTED,
      "manifest.runtime.kind",
      "has no Node binding",
    );
  }
  if (kind === "sandbox") {
    const binding = sandboxHostBindingSchema.parse(input["value"]);
    if (
      manifest.runtime.kind !== "program" ||
      binding.capabilityRef !== manifest.ref ||
      binding.capabilityVersion !== manifest.version ||
      binding.artifactDigest !== manifest.integrity
    )
      throw failure(
        CAPABILITY_DEPLOYMENT_ERROR_CODES.BINDING_MISMATCH,
        field,
        "sandbox binding must match a program manifest",
      );
    return deepFreeze({ kind, value: binding });
  }
  if (kind === "process") {
    const binding = parseProcessBinding(input["value"], `${field}.value`);
    if (
      binding.capabilityRef !== manifest.ref ||
      binding.capabilityVersion !== manifest.version ||
      binding.artifactDigest !== manifest.integrity
    ) {
      throw failure(
        CAPABILITY_DEPLOYMENT_ERROR_CODES.BINDING_MISMATCH,
        field,
        "does not match manifest identity",
      );
    }
    validateProcessBinding(binding, manifest, field);
    return deepFreeze({ kind, value: binding });
  }
  const binding = parseEndpointBinding(input["value"], `${field}.value`);
  if (binding.artifactDigest !== manifest.integrity) {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.BINDING_MISMATCH,
      field,
      "does not match manifest identity",
    );
  }
  validateEndpointBinding(binding, manifest, field);
  return deepFreeze({ kind, value: binding });
}

function equalSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function validateProcessBinding(
  binding: RuntimeProcessBinding,
  manifest: CapabilityManifest,
  field: string,
): void {
  if (manifest.runtime.kind !== "program" && manifest.runtime.kind !== "mcp") {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.BINDING_MISMATCH,
      field,
      "runtime kind is not process-bound",
    );
  }
  if (manifest.runtime.kind === "program") {
    const expectedExecutables = [manifest.runtime.argv[0] ?? "", ...manifest.runtime.subprocesses];
    if (
      binding.command !== manifest.runtime.argv[0] ||
      binding.workdirRef !== manifest.runtime.workdirRef ||
      !equalSet(binding.availableExecutables, expectedExecutables) ||
      !equalSet(Object.keys(binding.environment), manifest.runtime.environmentKeys) ||
      binding.mcpServerIdentity !== null ||
      binding.mcpServerName !== null ||
      binding.mcpServerVersion !== null ||
      Object.keys(binding.mcpOperationMap).length !== 0
    ) {
      throw failure(
        CAPABILITY_DEPLOYMENT_ERROR_CODES.BINDING_MISMATCH,
        field,
        "does not match program runtime",
      );
    }
  } else {
    const runtime = manifest.runtime;
    if (runtime.kind !== "mcp") {
      throw failure(
        CAPABILITY_DEPLOYMENT_ERROR_CODES.BINDING_MISMATCH,
        field,
        "runtime kind is not MCP-bound",
      );
    }
    const mapped = Object.entries(binding.mcpOperationMap);
    if (
      binding.mcpServerIdentity !== runtime.serverIdentity ||
      binding.mcpServerName === null ||
      binding.mcpServerVersion === null ||
      mapped.length !== manifest.operations.length ||
      manifest.operations.some(
        (operation) =>
          !binding.mcpOperationMap[operation] ||
          !runtime.mappedResources.includes(`tool:${binding.mcpOperationMap[operation]}`),
      )
    ) {
      throw failure(
        CAPABILITY_DEPLOYMENT_ERROR_CODES.BINDING_MISMATCH,
        field,
        "does not match MCP runtime",
      );
    }
  }
  if (
    !equalSet(
      binding.filesystem.map((entry) => entry.scopeRef),
      manifest.scopes.filesystem,
    ) ||
    binding.filesystem.some((entry) => !entry.sandboxPath.startsWith("/"))
  ) {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.BINDING_MISMATCH,
      field,
      "does not cover manifest filesystem scopes",
    );
  }
}

function validateEndpointBinding(
  binding: RuntimeEndpointBinding,
  manifest: CapabilityManifest,
  field: string,
): void {
  if (manifest.runtime.kind !== "remote_api" && manifest.runtime.kind !== "adapter") {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.BINDING_MISMATCH,
      field,
      "runtime kind is not endpoint-bound",
    );
  }
  if (
    binding.endpointIdentity !== manifest.runtime.endpointIdentity ||
    binding.productionSuitable !== true ||
    Object.keys(binding.operations).length !== manifest.operations.length ||
    manifest.operations.some((operation) => {
      const operationBinding = binding.operations[operation];
      return (
        operationBinding === undefined ||
        !binding.allowedMethods.includes(operationBinding.method) ||
        Object.keys(operationBinding.secretHeaders).some(
          (secretRef) => !manifest.scopes.secrets.includes(secretRef),
        )
      );
    })
  ) {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.BINDING_MISMATCH,
      field,
      "does not match endpoint runtime",
    );
  }
}

function parseEntry(
  value: unknown,
  platform: CapabilityRuntimeQualification["platform"],
  nowMs: number,
  maximumQualificationAgeMs: number,
  index: number,
): CapabilityDeploymentEntry {
  const field = `capabilities[${index}]`;
  const input = record(value, field);
  rejectUnknown(input, ["manifest", "qualification", "binding"], field);
  const manifest = parseManifest(input["manifest"], `${field}.manifest`);
  const qualification = parseQualification(
    input["qualification"],
    manifest,
    platform,
    nowMs,
    maximumQualificationAgeMs,
    `${field}.qualification`,
  );
  const binding = parseBinding(input["binding"], manifest, `${field}.binding`);
  const sandbox = qualification.sandbox;
  if (binding.kind === "sandbox") {
    if (
      !sandbox ||
      sandbox.hostId !== binding.value.hostId ||
      sandbox.profileRef !== binding.value.profileRef ||
      sandbox.runtimeDigest !== binding.value.runtimeDigest ||
      sandbox.runnerDigest !== binding.value.runner.sha256
    )
      throw failure(
        CAPABILITY_DEPLOYMENT_ERROR_CODES.QUALIFICATION_INVALID,
        field,
        "sandbox qualification must match the host binding",
      );
  } else if (sandbox) {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.QUALIFICATION_INVALID,
      field,
      "sandbox evidence cannot qualify a legacy binding",
    );
  }
  return deepFreeze({ manifest, qualification, binding });
}

function parseSnapshot(
  value: unknown,
  platform: CapabilityRuntimeQualification["platform"],
  nowMs: number,
  maximumQualificationAgeMs: number,
): CapabilityDeploymentSnapshot {
  const input = record(value, "snapshot");
  rejectUnknown(input, ["schemaVersion", "capabilities", "hostIsolation"], "snapshot");
  if (input["schemaVersion"] !== CAPABILITY_DEPLOYMENT_SCHEMA_VERSION) {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.INVALID_VALUE,
      "snapshot.schemaVersion",
      "is unsupported",
    );
  }
  if (!Array.isArray(input["capabilities"]) || input["capabilities"].length === 0) {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.EMPTY,
      "snapshot.capabilities",
      "must be non-empty",
    );
  }
  const capabilities = input["capabilities"].map((entry, index) =>
    parseEntry(entry, platform, nowMs, maximumQualificationAgeMs, index),
  );
  const refs = capabilities.map((entry) => `${entry.manifest.ref}@${entry.manifest.version}`);
  if (
    new Set(refs).size !== refs.length ||
    new Set(capabilities.map((entry) => entry.manifest.ref)).size !== capabilities.length
  ) {
    throw failure(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.DUPLICATE_CAPABILITY,
      "snapshot.capabilities",
      "must not contain duplicate identities",
    );
  }
  const hostIsolation =
    input["hostIsolation"] === undefined
      ? undefined
      : parseHostIsolation(input["hostIsolation"], "snapshot.hostIsolation");
  return deepFreeze({
    schemaVersion: CAPABILITY_DEPLOYMENT_SCHEMA_VERSION,
    capabilities,
    ...(hostIsolation === undefined ? {} : { hostIsolation }),
  });
}

function registryRecord(
  manifest: CapabilityManifest,
  qualification: CapabilityRuntimeQualification,
): CapabilityRegistryRecord {
  const discoveredAt = qualification.checkedAt;
  return deepFreeze({
    ref: manifest.ref,
    revision: 1,
    lifecycle: "active",
    declaration: manifest,
    pendingDeclaration: null,
    permissionExpansion: false,
    runtimeQualification: qualification,
    pendingUpdateAssessment: null,
    rollbackDeclaration: null,
    rollbackQualification: null,
    lastVersionTransition: null,
    approvalRefs: Object.freeze([]),
    discoveredAt,
    updatedAt: discoveredAt,
  });
}

function adapter(manifest: CapabilityManifest): CapabilityDeploymentAdapter {
  return deepFreeze({
    capabilityId: manifest.ref,
    capabilityVersion: manifest.version,
    artifactDigest: manifest.integrity,
    runtimeKind: manifest.runtime.kind,
    operations: manifest.operations,
  });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
  } else if (isRecord(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

function platformName(value: NodeJS.Platform): CapabilityRuntimeQualification["platform"] {
  return value === "darwin" || value === "linux" ? value : "other";
}

function sameMetadata(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    Number(left.dev) === Number(right.dev) &&
    Number(left.ino) === Number(right.ino) &&
    Number(left.mode) === Number(right.mode) &&
    Number(left.size) === Number(right.size) &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function ownedRegularFile(info: Awaited<ReturnType<typeof lstat>>): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return (
    info.isFile() &&
    !info.isSymbolicLink() &&
    (Number(info.mode) & 0o7077) === 0 &&
    uid !== undefined &&
    Number(info.uid) === uid
  );
}

async function readSnapshotBytes(snapshotPath: string, maximumBytes: number): Promise<Uint8Array> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(snapshotPath);
  } catch {
    throw new CapabilityDeploymentError(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.FILE_UNSAFE,
      "Capability deployment snapshot file is unsafe",
    );
  }
  if (!ownedRegularFile(before)) {
    throw new CapabilityDeploymentError(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.FILE_UNSAFE,
      "Capability deployment snapshot file is unsafe",
    );
  }
  if (Number(before.size) > maximumBytes) {
    throw new CapabilityDeploymentError(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.TOO_LARGE,
      "Capability deployment snapshot is too large",
    );
  }
  let descriptor: Awaited<ReturnType<typeof open>> | undefined;
  try {
    descriptor = await open(snapshotPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await descriptor.stat();
    if (!ownedRegularFile(opened) || !sameMetadata(before, opened)) {
      throw new CapabilityDeploymentError(
        CAPABILITY_DEPLOYMENT_ERROR_CODES.FILE_UNSAFE,
        "Capability deployment snapshot file changed during open",
      );
    }
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await descriptor.read(buffer, offset, buffer.length - offset, null);
      offset += result.bytesRead;
      if (result.bytesRead === 0) break;
    }
    const after = await descriptor.stat();
    if (offset > maximumBytes || !sameMetadata(before, after)) {
      throw new CapabilityDeploymentError(
        offset > maximumBytes
          ? CAPABILITY_DEPLOYMENT_ERROR_CODES.TOO_LARGE
          : CAPABILITY_DEPLOYMENT_ERROR_CODES.FILE_UNSAFE,
        "Capability deployment snapshot changed while reading",
      );
    }
    return new Uint8Array(buffer.subarray(0, offset));
  } catch (error) {
    if (error instanceof CapabilityDeploymentError) throw error;
    throw new CapabilityDeploymentError(
      CAPABILITY_DEPLOYMENT_ERROR_CODES.READ_FAILED,
      "Capability deployment snapshot could not be read",
    );
  } finally {
    await descriptor?.close().catch(() => undefined);
  }
}

class SnapshotCapabilityRuntimeBindingPort implements CapabilityRuntimeBindingPort {
  readonly #entries: ReadonlyMap<string, CapabilityDeploymentEntry>;

  constructor(entries: readonly CapabilityDeploymentEntry[]) {
    this.#entries = new Map(
      entries.map((entry) => [`${entry.manifest.ref}@${entry.manifest.version}`, entry] as const),
    );
  }

  async resolveProcess(manifest: CapabilityManifest): Promise<RuntimeProcessBinding | undefined> {
    const entry = this.#entries.get(`${manifest.ref}@${manifest.version}`);
    if (
      !entry ||
      entry.manifest.integrity !== manifest.integrity ||
      entry.binding.kind !== "process"
    ) {
      return undefined;
    }
    return entry.binding.value;
  }

  async resolveEndpoint(manifest: CapabilityManifest): Promise<RuntimeEndpointBinding | undefined> {
    const entry = this.#entries.get(`${manifest.ref}@${manifest.version}`);
    if (
      !entry ||
      entry.manifest.integrity !== manifest.integrity ||
      entry.binding.kind !== "endpoint"
    ) {
      return undefined;
    }
    return entry.binding.value;
  }
}

export class CapabilityDeploymentSnapshotLoader {
  readonly #snapshotPath: string;
  readonly #expectedSha256: string;
  readonly #platform: CapabilityRuntimeQualification["platform"];
  readonly #maximumBytes: number;
  readonly #now: () => string;
  readonly #maximumQualificationAgeMs: number;

  constructor(options: CapabilityDeploymentSnapshotLoaderOptions) {
    this.#snapshotPath = snapshotPath(options.snapshotPath);
    this.#expectedSha256 = sha256(options.sha256, "sha256");
    this.#platform = platformName(options.platform ?? process.platform);
    const maximumBytes = options.maximumBytes ?? CAPABILITY_DEPLOYMENT_MAX_BYTES;
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > CAPABILITY_DEPLOYMENT_MAX_BYTES
    ) {
      throw invalid(
        "maximumBytes",
        `must be an integer from 1 to ${CAPABILITY_DEPLOYMENT_MAX_BYTES}`,
      );
    }
    this.#maximumBytes = maximumBytes;
    this.#now = options.now ?? (() => new Date().toISOString());
    const maximumQualificationAgeMs =
      options.maximumQualificationAgeMs ?? CAPABILITY_DEPLOYMENT_MAX_QUALIFICATION_AGE_MS;
    if (!Number.isSafeInteger(maximumQualificationAgeMs) || maximumQualificationAgeMs < 1) {
      throw invalid("maximumQualificationAgeMs", "must be a positive safe integer");
    }
    this.#maximumQualificationAgeMs = maximumQualificationAgeMs;
  }

  async load(): Promise<LoadedCapabilityDeployment> {
    const bytes = await readSnapshotBytes(this.#snapshotPath, this.#maximumBytes);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== this.#expectedSha256) {
      throw new CapabilityDeploymentError(
        CAPABILITY_DEPLOYMENT_ERROR_CODES.DIGEST_MISMATCH,
        "Capability deployment snapshot digest does not match",
      );
    }
    let parsed: unknown;
    try {
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      parsed = JSON.parse(source);
    } catch {
      throw new CapabilityDeploymentError(
        CAPABILITY_DEPLOYMENT_ERROR_CODES.INVALID_JSON,
        "Capability deployment snapshot is not valid UTF-8 JSON",
      );
    }
    const nowValue = this.#now();
    const nowMs = Date.parse(nowValue);
    if (Number.isNaN(nowMs)) {
      throw invalid("now", "must be a valid timestamp");
    }
    const snapshot = parseSnapshot(parsed, this.#platform, nowMs, this.#maximumQualificationAgeMs);
    const manifests = Object.freeze(snapshot.capabilities.map((entry) => entry.manifest));
    const records = Object.freeze(
      snapshot.capabilities.map((entry) => registryRecord(entry.manifest, entry.qualification)),
    );
    const adapters = Object.freeze(snapshot.capabilities.map((entry) => adapter(entry.manifest)));
    const bindings = Object.freeze(new SnapshotCapabilityRuntimeBindingPort(snapshot.capabilities));
    return Object.freeze({
      snapshotPath: this.#snapshotPath,
      snapshotDigest: digest,
      snapshot,
      manifests,
      records,
      adapters,
      bindings,
      ...(snapshot.hostIsolation === undefined ? {} : { hostIsolation: snapshot.hostIsolation }),
    });
  }
}

export function loadCapabilityDeploymentSnapshot(
  options: CapabilityDeploymentSnapshotLoaderOptions,
): Promise<LoadedCapabilityDeployment> {
  return new CapabilityDeploymentSnapshotLoader(options).load();
}
