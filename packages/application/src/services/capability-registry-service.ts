import type {
  CapabilityDeclaration,
  CapabilityExecutionHandle,
  CapabilityExecutionHandleStorePort,
  CapabilityRegistryRecord,
  CapabilityRegistryStorePort,
  IssueCapabilityExecutionHandleInput,
} from "../ports/capabilities.js";
import { PORT_ERROR_CODES, ApplicationPortError } from "../ports/common.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function uniqueNonEmpty(values: readonly string[]): boolean {
  return values.length > 0 && new Set(values).size === values.length && values.every(Boolean);
}

function validateDeclaration(declaration: CapabilityDeclaration): void {
  if (
    !declaration.ref ||
    !declaration.displayName ||
    !EXACT_VERSION.test(declaration.version) ||
    !SHA256.test(declaration.integrity) ||
    !declaration.source.locator ||
    !uniqueNonEmpty(declaration.operations) ||
    new Set(declaration.permissionRefs).size !== declaration.permissionRefs.length
  ) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      `Capability ${declaration.ref || "<missing>"} is not pinned and verifiable`,
      { capabilityRef: declaration.ref || "<missing>" },
    );
  }
}

function addsPermissions(current: CapabilityDeclaration, pending: CapabilityDeclaration): boolean {
  return (
    pending.operations.some((operation) => !current.operations.includes(operation)) ||
    pending.permissionRefs.some((permission) => !current.permissionRefs.includes(permission))
  );
}

export interface CapabilityRegistryServiceDependencies {
  readonly store: CapabilityRegistryStorePort & CapabilityExecutionHandleStorePort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
}

export class CapabilityRegistryService {
  private readonly dependencies: CapabilityRegistryServiceDependencies;

  constructor(dependencies: CapabilityRegistryServiceDependencies) {
    this.dependencies = dependencies;
  }

  async discover(declaration: CapabilityDeclaration): Promise<CapabilityRegistryRecord> {
    validateDeclaration(declaration);
    const now = this.dependencies.clock.now();
    return this.dependencies.store.create({
      ref: declaration.ref,
      revision: 1,
      lifecycle: "discovered",
      declaration,
      pendingDeclaration: null,
      permissionExpansion: false,
      approvalRefs: [],
      discoveredAt: now,
      updatedAt: now,
    });
  }

  async proposeInstallation(capabilityRef: string): Promise<CapabilityRegistryRecord> {
    return this.transition(capabilityRef, ["discovered"], "installation_proposed");
  }

  async approveInstallation(
    capabilityRef: string,
    approvalRef: string,
  ): Promise<CapabilityRegistryRecord> {
    if (!approvalRef) return this.invalidApproval(capabilityRef);
    return this.transition(
      capabilityRef,
      ["installation_proposed"],
      "installation_approved",
      approvalRef,
    );
  }

  async proposeUpdate(
    capabilityRef: string,
    declaration: CapabilityDeclaration,
  ): Promise<CapabilityRegistryRecord> {
    validateDeclaration(declaration);
    const current = await this.requireRecord(capabilityRef);
    if (current.lifecycle !== "active" || declaration.ref !== capabilityRef) {
      return this.invalidTransition(current, "update_proposed");
    }
    if (declaration.version === current.declaration.version) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Capability ${capabilityRef} update must pin a new version`,
        { capabilityRef },
      );
    }
    return this.save(current, {
      lifecycle: "update_proposed",
      pendingDeclaration: declaration,
      permissionExpansion: addsPermissions(current.declaration, declaration),
    });
  }

  async approveUpdate(
    capabilityRef: string,
    approvalRef: string,
  ): Promise<CapabilityRegistryRecord> {
    if (!approvalRef) return this.invalidApproval(capabilityRef);
    return this.transition(capabilityRef, ["update_proposed"], "update_approved", approvalRef);
  }

  async activate(capabilityRef: string): Promise<CapabilityRegistryRecord> {
    const current = await this.requireRecord(capabilityRef);
    if (current.lifecycle === "installation_approved") {
      return this.save(current, { lifecycle: "active" });
    }
    if (current.lifecycle === "update_approved" && current.pendingDeclaration) {
      return this.save(current, {
        lifecycle: "active",
        declaration: current.pendingDeclaration,
        pendingDeclaration: null,
        permissionExpansion: false,
      });
    }
    return this.invalidTransition(current, "active");
  }

  async disable(capabilityRef: string): Promise<CapabilityRegistryRecord> {
    return this.transition(capabilityRef, ["active"], "disabled");
  }

  async uninstall(capabilityRef: string): Promise<CapabilityRegistryRecord> {
    return this.transition(capabilityRef, ["disabled"], "uninstalled");
  }

  async issueExecutionHandle(
    input: IssueCapabilityExecutionHandleInput,
  ): Promise<CapabilityExecutionHandle> {
    const record = await this.requireRecord(input.capabilityRef);
    const now = this.dependencies.clock.now();
    if (record.lifecycle !== "active") {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Capability ${input.capabilityRef} is not active`,
        { capabilityRef: input.capabilityRef },
      );
    }
    if (
      input.permission.executionScope.capabilityRef !== input.capabilityRef ||
      !input.permission.executionScope.operations.includes(input.operation) ||
      !record.declaration.operations.includes(input.operation) ||
      input.expiresAt <= now ||
      input.inputRefs.length === 0
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        `Permission does not authorize a handle for ${input.capabilityRef}`,
        { capabilityRef: input.capabilityRef },
      );
    }
    for (const secret of input.secretRefs) {
      if (!record.declaration.permissionRefs.includes(`secret:${secret.secretRef}`)) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          `Capability ${input.capabilityRef} did not declare secret ${secret.secretRef}`,
          { capabilityRef: input.capabilityRef, secretRef: secret.secretRef },
        );
      }
    }

    return this.dependencies.store.createExecutionHandle({
      ref: this.dependencies.ids.next("capability-handle"),
      ownerId: input.ownerId,
      agentId: input.agentId,
      runId: input.runId,
      capabilityRef: input.capabilityRef,
      capabilityVersion: record.declaration.version,
      authorization: input.permission.basis,
      operations: [input.operation],
      inputRefs: [...input.inputRefs],
      delegatedContextRefs: [...input.delegatedContextRefs],
      secretRefs: [...input.secretRefs],
      maxDataClassification: input.permission.executionScope.maxDataClassification,
      issuedAt: now,
      expiresAt: input.expiresAt,
      revokedAt: null,
    });
  }

  async requireUsableExecutionHandle(handleRef: string): Promise<CapabilityExecutionHandle> {
    const handle = await this.dependencies.store.getExecutionHandle(handleRef);
    if (!handle) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Capability handle ${handleRef} not found`,
        { handleRef },
      );
    }
    const record = await this.requireRecord(handle.capabilityRef);
    if (
      handle.revokedAt !== null ||
      this.dependencies.clock.now() >= handle.expiresAt ||
      record.lifecycle !== "active" ||
      record.declaration.version !== handle.capabilityVersion
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.HANDLE_REVOKED,
        `Capability handle ${handleRef} is no longer usable`,
        { handleRef },
      );
    }
    return handle;
  }

  private async transition(
    capabilityRef: string,
    allowed: readonly CapabilityRegistryRecord["lifecycle"][],
    lifecycle: CapabilityRegistryRecord["lifecycle"],
    approvalRef?: string,
  ): Promise<CapabilityRegistryRecord> {
    const current = await this.requireRecord(capabilityRef);
    if (!allowed.includes(current.lifecycle)) return this.invalidTransition(current, lifecycle);
    return this.save(current, {
      lifecycle,
      ...(approvalRef ? { approvalRefs: [...current.approvalRefs, approvalRef] } : {}),
    });
  }

  private async save(
    current: CapabilityRegistryRecord,
    patch: Partial<CapabilityRegistryRecord>,
  ): Promise<CapabilityRegistryRecord> {
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

  private async requireRecord(capabilityRef: string): Promise<CapabilityRegistryRecord> {
    const record = await this.dependencies.store.get(capabilityRef);
    if (!record) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Capability ${capabilityRef} not found`,
        { capabilityRef },
      );
    }
    return record;
  }

  private invalidApproval(capabilityRef: string): never {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      `Capability ${capabilityRef} requires an approval reference`,
      { capabilityRef },
    );
  }

  private invalidTransition(
    current: CapabilityRegistryRecord,
    requested: CapabilityRegistryRecord["lifecycle"],
  ): never {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      `Capability ${current.ref} cannot move from ${current.lifecycle} to ${requested}`,
      { capabilityRef: current.ref, current: current.lifecycle, requested },
    );
  }
}
