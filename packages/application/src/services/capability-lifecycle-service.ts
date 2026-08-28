import type {
  CapabilityArtifactVerifierPort,
  CapabilityDeclaration,
  CapabilityExecutionHandleStorePort,
  CapabilityManifest,
  CapabilityRegistryRecord,
  CapabilityRegistryStorePort,
  CapabilityRuntimeQualification,
  CapabilityRuntimeQualifierPort,
  CapabilityUpdateAssessment,
} from "../ports/capabilities.js";
import { capabilityLifecycleHasActiveAuthority } from "../ports/capabilities.js";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import type { ClockPort } from "../ports/system.js";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length && values.every(Boolean);
}

function manifestFrom(declaration: CapabilityDeclaration): CapabilityManifest {
  const manifest = declaration as CapabilityManifest;
  validateCapabilityManifest(manifest);
  return manifest;
}

export function validateCapabilityManifest(manifest: CapabilityManifest): void {
  const runtimeValid =
    (manifest.runtime.kind === "pi_tool" && manifest.source.type === "tool") ||
    (manifest.runtime.kind === "pi_resource" &&
      (manifest.source.type === "skill" || manifest.source.type === "package") &&
      manifest.runtime.additionalResourcePaths.length > 0 &&
      unique(manifest.runtime.additionalResourcePaths)) ||
    (manifest.runtime.kind === "mcp" &&
      manifest.source.type === "mcp" &&
      manifest.runtime.serverIdentity.length > 0 &&
      manifest.runtime.transport.length > 0 &&
      manifest.runtime.mappedResources.length > 0 &&
      unique(manifest.runtime.mappedResources)) ||
    (manifest.runtime.kind === "program" &&
      manifest.source.type === "program" &&
      manifest.runtime.argv.length > 0 &&
      manifest.runtime.argv.every(Boolean) &&
      manifest.runtime.workdirRef.length > 0 &&
      manifest.runtime.filesystem.includes(manifest.runtime.workdirRef) &&
      unique(manifest.runtime.environmentKeys) &&
      unique(manifest.runtime.subprocesses) &&
      unique(manifest.runtime.network) &&
      unique(manifest.runtime.filesystem) &&
      manifest.runtime.network.every((scope) => manifest.scopes.network.includes(scope)) &&
      manifest.runtime.filesystem.every((scope) => manifest.scopes.filesystem.includes(scope))) ||
    ((manifest.runtime.kind === "remote_api" || manifest.runtime.kind === "adapter") &&
      (manifest.source.type === "remote_api" || manifest.source.type === "adapter") &&
      manifest.runtime.endpointIdentity.length > 0 &&
      manifest.runtime.protectedReferenceOnly === true);
  const executableArtifact = ["package", "mcp", "program"].includes(manifest.source.type);
  const signatureValid =
    manifest.artifact.signatureStatus === "verified"
      ? manifest.artifact.signerRef !== null
      : manifest.artifact.signatureStatus === "not_applicable" && !executableArtifact;
  if (
    manifest.manifestVersion !== "capability.v2" ||
    !manifest.ref ||
    !manifest.displayName ||
    !manifest.sourceIdentity ||
    !manifest.source.locator ||
    !EXACT_VERSION.test(manifest.version) ||
    !SHA256.test(manifest.integrity) ||
    manifest.artifact.digest !== manifest.integrity ||
    !signatureValid ||
    manifest.operations.length === 0 ||
    !unique(manifest.operations) ||
    !unique(manifest.permissionRefs) ||
    !unique(manifest.scopes.dataClassifications) ||
    !unique(manifest.scopes.network) ||
    !unique(manifest.scopes.filesystem) ||
    !unique(manifest.scopes.secrets) ||
    manifest.cost.maxMicrosPerInvocation < 0 ||
    !Number.isSafeInteger(manifest.cost.maxMicrosPerInvocation) ||
    !unique(manifest.contractCompatibility) ||
    !runtimeValid
  ) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      `Capability ${manifest.ref || "<missing>"} manifest is not verifiable`,
    );
  }
}

function semanticMajor(version: string): number {
  return Number(version.split(".", 1)[0]);
}

function additions(
  current: readonly string[],
  candidate: readonly string[],
  label: string,
): string[] {
  return candidate.filter((value) => !current.includes(value)).map((value) => `${label}:${value}`);
}

function removals(
  current: readonly string[],
  candidate: readonly string[],
  label: string,
): string[] {
  return current.filter((value) => !candidate.includes(value)).map((value) => `${label}:${value}`);
}

function runtimeDiff(
  current: CapabilityManifest,
  candidate: CapabilityManifest,
): {
  readonly executableIdentityChanged: boolean;
  readonly expansions: readonly string[];
  readonly contractions: readonly string[];
} {
  if (current.runtime.kind !== candidate.runtime.kind) {
    return {
      executableIdentityChanged: true,
      expansions: [`runtime:${candidate.runtime.kind}`],
      contractions: [`runtime:${current.runtime.kind}`],
    };
  }
  const expansions: string[] = [];
  const contractions: string[] = [];
  let executableIdentityChanged = false;
  switch (current.runtime.kind) {
    case "pi_tool": {
      if (
        candidate.runtime.kind !== "pi_tool" ||
        current.runtime.piBuiltinDefinition !== candidate.runtime.piBuiltinDefinition
      ) {
        executableIdentityChanged = true;
      }
      break;
    }
    case "pi_resource": {
      if (candidate.runtime.kind !== "pi_resource") break;
      expansions.push(
        ...additions(
          current.runtime.additionalResourcePaths,
          candidate.runtime.additionalResourcePaths,
          "resource-path",
        ),
      );
      contractions.push(
        ...removals(
          current.runtime.additionalResourcePaths,
          candidate.runtime.additionalResourcePaths,
          "resource-path",
        ),
      );
      break;
    }
    case "mcp": {
      if (candidate.runtime.kind !== "mcp") break;
      executableIdentityChanged =
        current.runtime.serverIdentity !== candidate.runtime.serverIdentity ||
        current.runtime.transport !== candidate.runtime.transport;
      expansions.push(
        ...additions(
          current.runtime.mappedResources,
          candidate.runtime.mappedResources,
          "mcp-resource",
        ),
      );
      contractions.push(
        ...removals(
          current.runtime.mappedResources,
          candidate.runtime.mappedResources,
          "mcp-resource",
        ),
      );
      break;
    }
    case "program": {
      if (candidate.runtime.kind !== "program") break;
      executableIdentityChanged =
        current.runtime.argv[0] !== candidate.runtime.argv[0] ||
        current.runtime.workdirRef !== candidate.runtime.workdirRef;
      expansions.push(
        ...additions(current.runtime.environmentKeys, candidate.runtime.environmentKeys, "env"),
        ...additions(current.runtime.subprocesses, candidate.runtime.subprocesses, "subprocess"),
      );
      contractions.push(
        ...removals(current.runtime.environmentKeys, candidate.runtime.environmentKeys, "env"),
        ...removals(current.runtime.subprocesses, candidate.runtime.subprocesses, "subprocess"),
      );
      if (current.runtime.stdin === "none" && candidate.runtime.stdin !== "none") {
        expansions.push("stdin:protected_payload");
      }
      if (current.runtime.stdout === "none" && candidate.runtime.stdout !== "none") {
        expansions.push("stdout:protected_payload");
      }
      break;
    }
    case "remote_api":
    case "adapter": {
      if (candidate.runtime.kind !== current.runtime.kind) break;
      executableIdentityChanged =
        current.runtime.endpointIdentity !== candidate.runtime.endpointIdentity;
      break;
    }
  }
  return { executableIdentityChanged, expansions, contractions };
}

export function assessCapabilityUpdate(
  current: CapabilityManifest,
  candidate: CapabilityManifest,
  allowAutomaticCompatibleUpdate: boolean,
): CapabilityUpdateAssessment {
  validateCapabilityManifest(current);
  validateCapabilityManifest(candidate);
  if (current.ref !== candidate.ref || current.version === candidate.version) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      `Capability ${current.ref} update must retain identity and pin a new version`,
    );
  }
  const sourceIdentityChanged =
    current.sourceIdentity !== candidate.sourceIdentity ||
    current.source.type !== candidate.source.type;
  const integrityChanged = current.integrity !== candidate.integrity;
  const semanticMajorChanged = semanticMajor(current.version) !== semanticMajor(candidate.version);
  const runtimeKindChanged = current.runtime.kind !== candidate.runtime.kind;
  const runtime = runtimeDiff(current, candidate);
  const executableCodeChanged =
    integrityChanged && ["package", "mcp", "program"].includes(candidate.source.type);
  const expansions = [
    ...additions(current.operations, candidate.operations, "operation"),
    ...additions(current.permissionRefs, candidate.permissionRefs, "permission"),
    ...additions(
      current.scopes.dataClassifications,
      candidate.scopes.dataClassifications,
      "classification",
    ),
    ...additions(current.scopes.network, candidate.scopes.network, "network"),
    ...additions(current.scopes.filesystem, candidate.scopes.filesystem, "filesystem"),
    ...additions(current.scopes.secrets, candidate.scopes.secrets, "secret"),
    ...runtime.expansions,
  ];
  const contractions = [
    ...removals(current.operations, candidate.operations, "operation"),
    ...removals(current.permissionRefs, candidate.permissionRefs, "permission"),
    ...removals(
      current.scopes.dataClassifications,
      candidate.scopes.dataClassifications,
      "classification",
    ),
    ...removals(current.scopes.network, candidate.scopes.network, "network"),
    ...removals(current.scopes.filesystem, candidate.scopes.filesystem, "filesystem"),
    ...removals(current.scopes.secrets, candidate.scopes.secrets, "secret"),
    ...runtime.contractions,
  ];
  if (
    candidate.cost.currency !== current.cost.currency ||
    candidate.cost.maxMicrosPerInvocation > current.cost.maxMicrosPerInvocation
  ) {
    expansions.push("cost");
  } else if (candidate.cost.maxMicrosPerInvocation < current.cost.maxMicrosPerInvocation) {
    contractions.push("cost");
  }
  if (candidate.isolation !== current.isolation)
    expansions.push(`isolation:${candidate.isolation}`);
  const compatibilityPreserved = current.contractCompatibility.every((contract) =>
    candidate.contractCompatibility.includes(contract),
  );
  const automatic =
    allowAutomaticCompatibleUpdate &&
    !sourceIdentityChanged &&
    !runtimeKindChanged &&
    !runtime.executableIdentityChanged &&
    !executableCodeChanged &&
    expansions.length === 0 &&
    compatibilityPreserved &&
    candidate.artifact.signatureStatus === current.artifact.signatureStatus &&
    candidate.artifact.signerRef === current.artifact.signerRef;
  const reasonCodes = [
    ...(sourceIdentityChanged ? ["CAPABILITY_UPDATE_SOURCE_CHANGED"] : []),
    ...(semanticMajorChanged ? ["CAPABILITY_UPDATE_MAJOR_CHANGED"] : []),
    ...(runtimeKindChanged ? ["CAPABILITY_UPDATE_RUNTIME_KIND_CHANGED"] : []),
    ...(runtime.executableIdentityChanged ? ["CAPABILITY_UPDATE_EXECUTABLE_CHANGED"] : []),
    ...(executableCodeChanged ? ["CAPABILITY_UPDATE_EXECUTABLE_CODE_CHANGED"] : []),
    ...(candidate.artifact.signerRef !== current.artifact.signerRef
      ? ["CAPABILITY_UPDATE_SIGNER_CHANGED"]
      : []),
    ...(!compatibilityPreserved ? ["CAPABILITY_UPDATE_INCOMPATIBLE"] : []),
    ...expansions.map((scope) => `CAPABILITY_UPDATE_EXPANSION:${scope}`),
    ...(!allowAutomaticCompatibleUpdate ? ["CAPABILITY_UPDATE_OWNER_APPROVAL_REQUIRED"] : []),
  ];
  const critical =
    sourceIdentityChanged ||
    semanticMajorChanged ||
    runtimeKindChanged ||
    runtime.executableIdentityChanged ||
    executableCodeChanged ||
    expansions.some((scope) =>
      /^(permission|network|filesystem|secret|classification|isolation|subprocess|runtime):/.test(
        scope,
      ),
    );
  return Object.freeze({
    assessmentVersion: "capability-update-assessment.v1",
    fromVersion: current.version,
    toVersion: candidate.version,
    disposition: automatic ? "automatic" : "approval_required",
    risk: automatic ? "LOW" : critical ? "CRITICAL" : "HIGH",
    sourceIdentityChanged,
    integrityChanged,
    semanticMajorChanged,
    runtimeKindChanged,
    executableIdentityChanged: runtime.executableIdentityChanged,
    executableCodeChanged,
    expansions: Object.freeze([...new Set(expansions)].sort()),
    contractions: Object.freeze([...new Set(contractions)].sort()),
    compatibilityPreserved,
    reasonCodes: Object.freeze([...new Set(reasonCodes)].sort()),
  });
}

export interface CapabilityUpdatePolicy {
  readonly policyRef: string;
  readonly allowAutomaticCompatibleUpdates: boolean;
}

export class CapabilityLifecycleService {
  private readonly dependencies: {
    readonly store: CapabilityRegistryStorePort & CapabilityExecutionHandleStorePort;
    readonly clock: ClockPort;
    readonly artifacts: CapabilityArtifactVerifierPort;
    readonly runtime: CapabilityRuntimeQualifierPort;
  };

  constructor(dependencies: {
    readonly store: CapabilityRegistryStorePort & CapabilityExecutionHandleStorePort;
    readonly clock: ClockPort;
    readonly artifacts: CapabilityArtifactVerifierPort;
    readonly runtime: CapabilityRuntimeQualifierPort;
  }) {
    this.dependencies = dependencies;
  }

  async discover(manifest: CapabilityManifest): Promise<CapabilityRegistryRecord> {
    validateCapabilityManifest(manifest);
    const now = this.dependencies.clock.now();
    return this.dependencies.store.create({
      ref: manifest.ref,
      revision: 1,
      lifecycle: "discovered",
      declaration: Object.freeze(structuredClone(manifest)),
      pendingDeclaration: null,
      permissionExpansion: false,
      runtimeQualification: null,
      pendingUpdateAssessment: null,
      rollbackDeclaration: null,
      rollbackQualification: null,
      lastVersionTransition: null,
      approvalRefs: [],
      discoveredAt: now,
      updatedAt: now,
    });
  }

  reviewRequired(capabilityRef: string): Promise<CapabilityRegistryRecord> {
    return this.transition(capabilityRef, ["discovered"], "review_required");
  }

  async recordSourceReview(
    capabilityRef: string,
    input: { readonly reviewer: string; readonly reviewedAt: string },
  ): Promise<CapabilityRegistryRecord> {
    const current = await this.require(capabilityRef);
    if (current.lifecycle !== "review_required" || !input.reviewer || !input.reviewedAt) {
      return this.invalid(current, "installation_proposed");
    }
    const manifest = manifestFrom(current.declaration);
    return this.save(current, {
      declaration: Object.freeze({
        ...manifest,
        reviewedBy: input.reviewer,
        reviewedAt: input.reviewedAt,
      }),
      lifecycle: "installation_proposed",
    });
  }

  approveInstallation(
    capabilityRef: string,
    approvalRef: string,
  ): Promise<CapabilityRegistryRecord> {
    if (!approvalRef)
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "Approval ref required");
    return this.transition(
      capabilityRef,
      ["installation_proposed"],
      "installation_approved",
      approvalRef,
    );
  }

  async activate(capabilityRef: string): Promise<CapabilityRegistryRecord> {
    const current = await this.require(capabilityRef);
    const manifest = manifestFrom(current.declaration);
    if (
      current.lifecycle !== "installation_approved" ||
      !manifest.reviewedBy ||
      !manifest.reviewedAt
    )
      return this.invalid(current, "active");
    const qualified = await this.qualify(manifest);
    return this.save(current, {
      lifecycle: "active",
      declaration: qualified.manifest,
      runtimeQualification: qualified.qualification,
    });
  }

  async proposeUpdate(
    capabilityRef: string,
    candidate: CapabilityManifest,
    policy: CapabilityUpdatePolicy,
  ): Promise<CapabilityRegistryRecord> {
    if (!policy.policyRef) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Update policy ref required",
      );
    }
    validateCapabilityManifest(candidate);
    const current = await this.require(capabilityRef);
    if (current.lifecycle !== "active" || candidate.ref !== capabilityRef) {
      return this.invalid(current, "update_proposed");
    }
    const active = manifestFrom(current.declaration);
    const reviewedCandidate = Object.freeze({
      ...candidate,
      reviewedBy:
        candidate.sourceIdentity === active.sourceIdentity
          ? (candidate.reviewedBy ?? active.reviewedBy)
          : candidate.reviewedBy,
      reviewedAt:
        candidate.sourceIdentity === active.sourceIdentity
          ? (candidate.reviewedAt ?? active.reviewedAt)
          : candidate.reviewedAt,
    });
    const assessment = assessCapabilityUpdate(
      active,
      reviewedCandidate,
      policy.allowAutomaticCompatibleUpdates,
    );
    const automatic = assessment.disposition === "automatic";
    return this.save(current, {
      lifecycle: automatic ? "update_approved" : "update_proposed",
      pendingDeclaration: reviewedCandidate,
      permissionExpansion: assessment.expansions.length > 0,
      pendingUpdateAssessment: assessment,
      ...(automatic ? { approvalRefs: [...current.approvalRefs, policy.policyRef] } : {}),
    });
  }

  async approveUpdate(
    capabilityRef: string,
    approvalRef: string,
  ): Promise<CapabilityRegistryRecord> {
    if (!approvalRef)
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "Approval ref required");
    const current = await this.require(capabilityRef);
    if (
      current.lifecycle !== "update_proposed" ||
      current.pendingUpdateAssessment?.disposition !== "approval_required"
    ) {
      return this.invalid(current, "update_approved");
    }
    return this.save(current, {
      lifecycle: "update_approved",
      approvalRefs: [...current.approvalRefs, approvalRef],
    });
  }

  async rejectUpdate(capabilityRef: string): Promise<CapabilityRegistryRecord> {
    const current = await this.require(capabilityRef);
    if (current.lifecycle !== "update_proposed" || !current.pendingDeclaration) {
      return this.invalid(current, "active");
    }
    const now = this.dependencies.clock.now();
    return this.save(current, {
      lifecycle: "active",
      pendingDeclaration: null,
      permissionExpansion: false,
      pendingUpdateAssessment: null,
      lastVersionTransition: {
        fromVersion: current.declaration.version,
        toVersion: current.pendingDeclaration.version,
        outcome: "rejected",
        occurredAt: now,
        qualification: current.runtimeQualification,
        externalEffectsRolledBack: false,
        productStateRolledBack: false,
      },
    });
  }

  async activateUpdate(capabilityRef: string): Promise<CapabilityRegistryRecord> {
    const current = await this.require(capabilityRef);
    if (
      current.lifecycle !== "update_approved" ||
      !current.pendingDeclaration ||
      !current.pendingUpdateAssessment ||
      !current.runtimeQualification
    ) {
      return this.invalid(current, "active");
    }
    const active = manifestFrom(current.declaration);
    const candidate = manifestFrom(current.pendingDeclaration);
    const rollbackArtifact = await this.dependencies.artifacts.verify(active);
    if (!rollbackArtifact.verified || rollbackArtifact.artifactDigest !== active.integrity) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        `Capability ${capabilityRef} rollback artifact is not verifiable`,
      );
    }
    const qualified = await this.qualify(candidate);
    if (!this.dependencies.store.switchCapabilityVersion) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Capability store cannot atomically switch version authority",
      );
    }
    const now = this.dependencies.clock.now();
    return this.dependencies.store.switchCapabilityVersion(
      {
        ...current,
        revision: current.revision + 1,
        lifecycle: "active",
        declaration: qualified.manifest,
        pendingDeclaration: null,
        permissionExpansion: false,
        runtimeQualification: qualified.qualification,
        pendingUpdateAssessment: null,
        rollbackDeclaration: active,
        rollbackQualification: current.runtimeQualification,
        lastVersionTransition: {
          fromVersion: active.version,
          toVersion: candidate.version,
          outcome: "activated",
          occurredAt: now,
          qualification: qualified.qualification,
          externalEffectsRolledBack: false,
          productStateRolledBack: false,
        },
        updatedAt: now,
      },
      current.revision,
      now,
    );
  }

  async rollback(capabilityRef: string): Promise<CapabilityRegistryRecord> {
    const current = await this.require(capabilityRef);
    if (
      current.lifecycle !== "active" ||
      !current.rollbackDeclaration ||
      !current.runtimeQualification
    ) {
      return this.invalid(current, "active");
    }
    if (!this.dependencies.store.switchCapabilityVersion) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Capability store cannot atomically roll back version authority",
      );
    }
    const active = manifestFrom(current.declaration);
    const rollback = manifestFrom(current.rollbackDeclaration);
    const qualified = await this.qualify(rollback);
    const now = this.dependencies.clock.now();
    return this.dependencies.store.switchCapabilityVersion(
      {
        ...current,
        revision: current.revision + 1,
        declaration: qualified.manifest,
        runtimeQualification: qualified.qualification,
        rollbackDeclaration: null,
        rollbackQualification: null,
        lastVersionTransition: {
          fromVersion: active.version,
          toVersion: rollback.version,
          outcome: "rolled_back",
          occurredAt: now,
          qualification: qualified.qualification,
          externalEffectsRolledBack: false,
          productStateRolledBack: false,
        },
        updatedAt: now,
      },
      current.revision,
      now,
    );
  }

  disable(capabilityRef: string): Promise<CapabilityRegistryRecord> {
    return this.invalidate(capabilityRef, "disabled", ["active"]);
  }

  revoke(capabilityRef: string): Promise<CapabilityRegistryRecord> {
    return this.invalidate(capabilityRef, "revoked", ["active", "disabled"]);
  }

  uninstall(capabilityRef: string): Promise<CapabilityRegistryRecord> {
    return this.invalidate(capabilityRef, "uninstalled", ["disabled", "revoked"]);
  }

  async authorizedManifests(): Promise<readonly CapabilityManifest[]> {
    const records = await this.dependencies.store.list();
    return records
      .filter(
        ({ lifecycle, runtimeQualification }) =>
          capabilityLifecycleHasActiveAuthority(lifecycle) &&
          runtimeQualification?.productionSuitable === true,
      )
      .map(({ declaration }) => manifestFrom(declaration))
      .filter((manifest) => manifest.health.status === "healthy" && manifest.reviewedBy !== null);
  }

  private async qualify(manifest: CapabilityManifest): Promise<{
    readonly manifest: CapabilityManifest;
    readonly qualification: CapabilityRuntimeQualification;
  }> {
    const artifact = await this.dependencies.artifacts.verify(manifest);
    if (!artifact.verified || artifact.artifactDigest !== manifest.integrity) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        `Capability ${manifest.ref} artifact verification failed`,
        { capabilityRef: manifest.ref },
      );
    }
    const qualification = await this.dependencies.runtime.qualify(manifest);
    if (
      !qualification.productionSuitable ||
      qualification.artifactDigest !== manifest.integrity ||
      Object.values(qualification.enforcement).some((enforced) => !enforced)
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        `Capability ${manifest.ref} runtime qualification failed`,
        { capabilityRef: manifest.ref, reasons: qualification.reasonCodes.join(",") },
      );
    }
    return Object.freeze({
      manifest: Object.freeze({
        ...manifest,
        health: { status: "healthy" as const, checkedAt: qualification.checkedAt },
      }),
      qualification: Object.freeze(structuredClone(qualification)),
    });
  }

  private async invalidate(
    capabilityRef: string,
    lifecycle: "disabled" | "revoked" | "uninstalled",
    allowed: readonly CapabilityRegistryRecord["lifecycle"][],
  ): Promise<CapabilityRegistryRecord> {
    const current = await this.require(capabilityRef);
    if (!allowed.includes(current.lifecycle)) return this.invalid(current, lifecycle);
    if (!this.dependencies.store.invalidateCapabilityAuthority) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Capability store cannot atomically invalidate dependent authority",
      );
    }
    const now = this.dependencies.clock.now();
    return this.dependencies.store.invalidateCapabilityAuthority(
      { ...current, lifecycle, revision: current.revision + 1, updatedAt: now },
      current.revision,
      now,
    );
  }

  private async transition(
    capabilityRef: string,
    allowed: readonly CapabilityRegistryRecord["lifecycle"][],
    lifecycle: CapabilityRegistryRecord["lifecycle"],
    approvalRef?: string,
  ): Promise<CapabilityRegistryRecord> {
    const current = await this.require(capabilityRef);
    if (!allowed.includes(current.lifecycle)) return this.invalid(current, lifecycle);
    return this.save(current, {
      lifecycle,
      ...(approvalRef ? { approvalRefs: [...current.approvalRefs, approvalRef] } : {}),
    });
  }

  private save(current: CapabilityRegistryRecord, patch: Partial<CapabilityRegistryRecord>) {
    return this.dependencies.store.save(
      {
        ...current,
        ...patch,
        revision: current.revision + 1,
        updatedAt: this.dependencies.clock.now(),
      },
      current.revision,
    );
  }

  private async require(capabilityRef: string): Promise<CapabilityRegistryRecord> {
    const current = await this.dependencies.store.get(capabilityRef);
    if (!current)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Capability ${capabilityRef} not found`,
      );
    return current;
  }

  private invalid(
    current: CapabilityRegistryRecord,
    requested: CapabilityRegistryRecord["lifecycle"],
  ): never {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      `Capability ${current.ref} cannot move from ${current.lifecycle} to ${requested}`,
    );
  }
}
