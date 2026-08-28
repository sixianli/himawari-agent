import {
  createAgentId,
  createDeploymentId,
  createOwnerId,
  createRunId,
  createThreadId,
  type ProductAuthorityFence,
} from "@himawari-agent/domain";
import type { CanonicalScope, CanonicalSliceRecord } from "./v02-canonical-contract.js";

export type V02PlatformProfile = "hermes-linux" | "macos-local";

export interface V02EvidenceRecord {
  readonly schemaVersion: "himawari.v0.2.evidence.v1";
  readonly candidateRevision: string;
  readonly artifactDigest: string;
  readonly configurationDigest: string;
  readonly platformProfile: V02PlatformProfile;
  readonly command: string;
  readonly exitStatus: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly result: "failed" | "passed";
  readonly logRefs: readonly string[];
  readonly screenshotRefs: readonly string[];
  readonly evidenceDigest: string;
}

export interface V02Fixture {
  readonly scope: CanonicalScope;
  readonly records: readonly CanonicalSliceRecord[];
  readonly resourceRefs: Readonly<{
    memory: string;
    task: string;
    approval: string;
    grant: string;
    github: string;
    web: string;
    file: string;
    calendar: string;
    worker: string;
    migration: string;
  }>;
  readonly profiles: Readonly<{
    platforms: readonly V02PlatformProfile[];
    browsers: readonly ["chromium", "webkit"];
    timeZone: "Asia/Tokyo";
    modelRoles: readonly ["primary", "fallback"];
    budgetMicros: number;
    disk: Readonly<{ warningBytes: number; writeRestrictedBytes: number }>;
    faultPoints: readonly string[];
  }>;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;

export function createV02Fixture(): V02Fixture {
  const ownerId = createOwnerId("owner-v02-fixture");
  const agentId = createAgentId("agent-v02-fixture");
  const threadId = createThreadId("thread-v02-fixture");
  const runId = createRunId("run-v02-fixture");
  const authority: ProductAuthorityFence = {
    deploymentId: createDeploymentId("deployment-v02-fixture"),
    authorityEpoch: 4,
    fencingToken: 9,
  };
  const scope: CanonicalScope = {
    ownerId,
    agentId,
    threadId,
    runId,
    traceId: "trace-v02-fixture",
    authority,
  };
  const kinds = [
    "message",
    "memory",
    "task",
    "approval",
    "grant",
    "result",
    "inbox",
    "trace",
    "browser",
    "calendar",
    "worker",
    "adapter",
  ] as const;
  return Object.freeze({
    scope,
    records: Object.freeze(
      kinds.map((kind) => ({
        kind,
        id: `${kind}-v02-fixture`,
        ...scope,
        authorityWriter: "product" as const,
        ...(kind === "browser" ? { browserSessionId: "browser-session-local" } : {}),
        ...(kind === "calendar" ? { providerRowId: "calendar-provider-row" } : {}),
        ...(kind === "adapter" ? { adapterLocalId: "adapter-local-row" } : {}),
      })),
    ),
    resourceRefs: Object.freeze({
      memory: "memory-v02-fixture",
      task: "task-v02-fixture",
      approval: "approval-v02-fixture",
      grant: "grant-v02-fixture",
      github: "github-monitor-v02-fixture",
      web: "web-session-v02-fixture",
      file: "resource-file-v02-fixture",
      calendar: "calendar-v02-fixture",
      worker: "worker-v02-fixture",
      migration: "transfer-v02-fixture",
    }),
    profiles: Object.freeze({
      platforms: Object.freeze(["macos-local", "hermes-linux"] as const),
      browsers: Object.freeze(["chromium", "webkit"] as const),
      timeZone: "Asia/Tokyo",
      modelRoles: Object.freeze(["primary", "fallback"] as const),
      budgetMicros: 250_000,
      disk: Object.freeze({ warningBytes: 1_073_741_824, writeRestrictedBytes: 268_435_456 }),
      faultPoints: Object.freeze([
        "before_authority_commit",
        "after_state_before_outbox",
        "after_external_execute_before_reconcile",
        "before_migration_activation",
      ]),
    }),
  });
}

export function assertV02EvidenceRecord(record: V02EvidenceRecord): void {
  if (!REVISION_PATTERN.test(record.candidateRevision)) {
    throw new Error("Evidence candidate revision must be an exact 40-character Git revision");
  }
  for (const [field, digest] of [
    ["artifactDigest", record.artifactDigest],
    ["configurationDigest", record.configurationDigest],
    ["evidenceDigest", record.evidenceDigest],
  ] as const) {
    if (!SHA256_PATTERN.test(digest)) throw new Error(`${field} must be an exact SHA-256 digest`);
  }
  if (
    !Number.isSafeInteger(record.exitStatus) ||
    Number.isNaN(Date.parse(record.startedAt)) ||
    Number.isNaN(Date.parse(record.finishedAt)) ||
    Date.parse(record.finishedAt) < Date.parse(record.startedAt)
  ) {
    throw new Error("Evidence command status and time interval must be valid");
  }
  if ((record.result === "passed") !== (record.exitStatus === 0)) {
    throw new Error("Evidence result must agree with command exit status");
  }
}

export function mergeV02Evidence(
  records: readonly V02EvidenceRecord[],
): readonly V02EvidenceRecord[] {
  const first = records[0];
  if (!first) throw new Error("Evidence merge requires at least one record");
  records.forEach(assertV02EvidenceRecord);
  for (const record of records.slice(1)) {
    if (
      record.schemaVersion !== first.schemaVersion ||
      record.candidateRevision !== first.candidateRevision ||
      record.artifactDigest !== first.artifactDigest ||
      record.configurationDigest !== first.configurationDigest ||
      record.platformProfile !== first.platformProfile
    ) {
      throw new Error(
        "Evidence from different candidate, schema, artifact, configuration, or platform cannot be merged",
      );
    }
  }
  return Object.freeze([...records]);
}
