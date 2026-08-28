import type {
  CapabilityExecutionHandleStorePort,
  CapabilityManifest,
  CapabilityRegistryRecord,
  CapabilityRegistryStorePort,
} from "../ports/capabilities.js";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import type { ClockPort } from "../ports/system.js";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export function validateCapabilityManifest(manifest: CapabilityManifest): void {
  const runtimeValid =
    (manifest.runtime.kind === "pi_tool" && manifest.source.type === "tool") ||
    (manifest.runtime.kind === "pi_resource" &&
      (manifest.source.type === "skill" || manifest.source.type === "package") &&
      manifest.runtime.additionalResourcePaths.length > 0) ||
    (manifest.runtime.kind === "mcp" &&
      manifest.source.type === "mcp" &&
      manifest.runtime.serverIdentity.length > 0 &&
      manifest.runtime.mappedResources.length > 0) ||
    (manifest.runtime.kind === "program" &&
      manifest.source.type === "program" &&
      manifest.runtime.argv.length > 0 &&
      manifest.runtime.workdirRef.length > 0 &&
      manifest.runtime.network.every((scope) => manifest.scopes.network.includes(scope)) &&
      manifest.runtime.filesystem.every((scope) => manifest.scopes.filesystem.includes(scope))) ||
    ((manifest.runtime.kind === "remote_api" || manifest.runtime.kind === "adapter") &&
      (manifest.source.type === "remote_api" || manifest.source.type === "adapter") &&
      manifest.runtime.protectedReferenceOnly === true);
  if (
    manifest.manifestVersion !== "capability.v2" ||
    !manifest.ref ||
    !manifest.sourceIdentity ||
    !manifest.source.locator ||
    !EXACT_VERSION.test(manifest.version) ||
    !SHA256.test(manifest.integrity) ||
    manifest.artifact.digest !== manifest.integrity ||
    manifest.artifact.signatureStatus === "invalid" ||
    manifest.artifact.signatureStatus === "unknown" ||
    manifest.operations.length === 0 ||
    new Set(manifest.operations).size !== manifest.operations.length ||
    manifest.cost.maxMicrosPerInvocation < 0 ||
    !runtimeValid
  ) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      `Capability ${manifest.ref || "<missing>"} manifest is not verifiable`,
    );
  }
}

export class CapabilityLifecycleService {
  private readonly dependencies: {
    readonly store: CapabilityRegistryStorePort & CapabilityExecutionHandleStorePort;
    readonly clock: ClockPort;
  };

  constructor(dependencies: {
    readonly store: CapabilityRegistryStorePort & CapabilityExecutionHandleStorePort;
    readonly clock: ClockPort;
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
    const manifest = current.declaration as CapabilityManifest;
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
    const manifest = current.declaration as CapabilityManifest;
    if (
      current.lifecycle !== "installation_approved" ||
      !manifest.reviewedBy ||
      !manifest.reviewedAt ||
      manifest.health.status !== "healthy"
    )
      return this.invalid(current, "active");
    return this.save(current, { lifecycle: "active" });
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
      .filter(({ lifecycle }) => lifecycle === "active")
      .map(({ declaration }) => declaration as CapabilityManifest)
      .filter((manifest) => manifest.health.status === "healthy" && manifest.reviewedBy !== null);
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
