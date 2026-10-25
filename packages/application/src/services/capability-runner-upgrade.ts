import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
  CapabilityManifest,
  CapabilityRegistryRecord,
  CapabilityRuntimeQualification,
} from "../ports/capabilities.js";
import { canonicalAuthorizationSnapshot } from "./action-intent-snapshot.js";
import { validateCapabilityManifest } from "./capability-lifecycle-service.js";

export const CAPABILITY_RUNNER_UPGRADE_PLAN_SCHEMA = "capability-runner-upgrade-plan.v1" as const;

export interface CapabilityRunnerUpgradeCandidate {
  readonly prior: CapabilityRegistryRecord | undefined;
  readonly manifest: CapabilityManifest;
  readonly qualification: CapabilityRuntimeQualification;
  readonly runtimeRoot: string | null;
}

export interface CapabilityRunnerUpgrade {
  readonly prior: CapabilityRegistryRecord;
  readonly manifest: CapabilityManifest;
  readonly qualification: CapabilityRuntimeQualification;
  readonly fromRuntimeRoot: string | null;
  readonly toRuntimeRoot: string | null;
}

export type CapabilityRunnerUpgradeDecision =
  | { readonly kind: "current"; readonly ref: string }
  | { readonly kind: "upgrade"; readonly ref: string; readonly upgrade: CapabilityRunnerUpgrade }
  | { readonly kind: "review_required"; readonly ref: string }
  | { readonly kind: "not_registered"; readonly ref: string };

export interface CapabilityRunnerUpgradePlan {
  readonly planDigest: string;
  readonly decisions: readonly CapabilityRunnerUpgradeDecision[];
}

function digest(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalAuthorizationSnapshot(value))));
}

function withoutHealthTime(manifest: CapabilityManifest): unknown {
  return { ...manifest, health: { ...manifest.health, checkedAt: null } };
}

function installationIndependent(manifest: CapabilityManifest): unknown {
  return {
    ...manifest,
    integrity: null,
    artifact: { ...manifest.artifact, digest: null },
    source: { ...manifest.source, locator: null },
    health: { ...manifest.health, checkedAt: null },
    reviewedAt: null,
    runtime:
      manifest.runtime.kind === "program"
        ? { ...manifest.runtime, argv: manifest.runtime.argv.slice(2) }
        : manifest.runtime,
  };
}

function registeredManifest(record: CapabilityRegistryRecord): CapabilityManifest | undefined {
  if (record.lifecycle !== "active" || !("manifestVersion" in record.declaration)) return undefined;
  const manifest = record.declaration as CapabilityManifest;
  try {
    validateCapabilityManifest(manifest);
    return manifest;
  } catch {
    return undefined;
  }
}

function previousRuntimeRoot(
  previous: CapabilityManifest,
  next: CapabilityManifest,
  runtimeRoot: string | null,
): { readonly root: string | null } | undefined {
  if (previous.runtime.kind !== "program" || next.runtime.kind !== "program") {
    return previous.runtime.kind === next.runtime.kind ? { root: null } : undefined;
  }
  const before = previous.runtime.argv;
  const after = next.runtime.argv;
  if (before.length !== after.length) return undefined;
  let root: string | null = null;
  for (const [index, value] of after.slice(0, 2).entries()) {
    const old = before[index];
    if (runtimeRoot === null || !value.startsWith(`${runtimeRoot}/`)) {
      if (old !== value) return undefined;
      continue;
    }
    const relative = value.slice(runtimeRoot.length);
    if (old === undefined || !old.endsWith(relative)) return undefined;
    const prefix = old.slice(0, old.length - relative.length);
    if (!prefix.startsWith("/") || (root !== null && root !== prefix)) return undefined;
    root = prefix;
  }
  return { root };
}

function decide(candidate: CapabilityRunnerUpgradeCandidate): CapabilityRunnerUpgradeDecision {
  const ref = candidate.manifest.ref;
  if (!candidate.prior) return { kind: "not_registered", ref };
  const previous = registeredManifest(candidate.prior);
  if (!previous) return { kind: "review_required", ref };
  validateCapabilityManifest(candidate.manifest);
  if (
    canonicalAuthorizationSnapshot(withoutHealthTime(previous)) ===
    canonicalAuthorizationSnapshot(withoutHealthTime(candidate.manifest))
  )
    return { kind: "current", ref };
  const installation = previousRuntimeRoot(previous, candidate.manifest, candidate.runtimeRoot);
  if (
    !installation ||
    canonicalAuthorizationSnapshot(installationIndependent(previous)) !==
      canonicalAuthorizationSnapshot(installationIndependent(candidate.manifest))
  )
    return { kind: "review_required", ref };
  return {
    kind: "upgrade",
    ref,
    upgrade: {
      prior: candidate.prior,
      manifest: candidate.manifest,
      qualification: candidate.qualification,
      fromRuntimeRoot: installation.root,
      toRuntimeRoot: candidate.runtimeRoot,
    },
  };
}

export function planCapabilityRunnerUpgrade(input: {
  readonly ownerId: string;
  readonly agentId: string;
  readonly deploymentId: string;
  readonly candidates: readonly CapabilityRunnerUpgradeCandidate[];
}): CapabilityRunnerUpgradePlan {
  const decisions = input.candidates.map(decide);
  const upgrades = decisions.flatMap((decision) =>
    decision.kind === "upgrade" ? [decision.upgrade] : [],
  );
  return {
    planDigest: `sha256:${digest({
      schema: CAPABILITY_RUNNER_UPGRADE_PLAN_SCHEMA,
      ownerId: input.ownerId,
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      upgrades: upgrades.map((upgrade) => ({
        ref: upgrade.prior.ref,
        priorRevision: upgrade.prior.revision,
        priorRecordSha256: digest(upgrade.prior),
        declaration: withoutHealthTime(upgrade.manifest),
        qualification: { ...upgrade.qualification, checkedAt: null },
      })),
    })}`,
    decisions,
  };
}

export function upgradedCapabilityRecord(
  upgrade: CapabilityRunnerUpgrade,
  upgradedAt: string,
): CapabilityRegistryRecord {
  return {
    ...upgrade.prior,
    revision: upgrade.prior.revision + 1,
    lifecycle: "active",
    declaration: upgrade.manifest,
    pendingDeclaration: null,
    permissionExpansion: false,
    runtimeQualification: upgrade.qualification,
    pendingUpdateAssessment: null,
    rollbackDeclaration: upgrade.prior.declaration,
    rollbackQualification: upgrade.prior.runtimeQualification,
    lastVersionTransition: {
      fromVersion: upgrade.prior.declaration.version,
      toVersion: upgrade.manifest.version,
      outcome: "activated",
      occurredAt: upgradedAt,
      qualification: upgrade.qualification,
      externalEffectsRolledBack: false,
      productStateRolledBack: false,
    },
    updatedAt: upgradedAt,
  };
}
