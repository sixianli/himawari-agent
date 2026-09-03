import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type HostDirectoryGrant,
  type HostFileDigestPort,
  type HostFilePlatformPort,
  type HostFileStatePort,
  type HostTrashRecord,
  type PermanentDeletionPlan,
  type PreparedFileOperation,
} from "../ports/index.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";

export class FileOperationService {
  static readonly MINIMUM_WRITE_RESERVE_BYTES = 64 * 1024 * 1024;
  readonly #state: HostFileStatePort;
  readonly #platform: HostFilePlatformPort;
  readonly #digest: HostFileDigestPort;
  readonly #clock: ClockPort;
  readonly #ids: IdGeneratorPort;
  readonly #hostId: string;

  constructor(input: {
    readonly state: HostFileStatePort;
    readonly platform: HostFilePlatformPort;
    readonly digest: HostFileDigestPort;
    readonly clock: ClockPort;
    readonly ids: IdGeneratorPort;
    readonly hostId: string;
  }) {
    this.#state = input.state;
    this.#platform = input.platform;
    this.#digest = input.digest;
    this.#clock = input.clock;
    this.#ids = input.ids;
    this.#hostId = input.hostId;
  }

  async grant(input: Omit<HostDirectoryGrant, "id" | "revision" | "canonicalRootId">) {
    if (
      input.hostId !== this.#hostId ||
      input.operations.length === 0 ||
      input.expiresAt <= this.#clock.now()
    ) {
      this.#reject("Directory Grant is not usable on this host");
    }
    const root = await this.#platform.inspectRoot(input.displayPath);
    const grant: HostDirectoryGrant = Object.freeze({
      ...input,
      id: this.#ids.next("directory-grant"),
      revision: 1,
      canonicalRootId: identityKey(root),
    });
    return this.#state.saveGrant(grant, null);
  }

  async prepareWrite(input: {
    readonly operationId?: string;
    readonly grantId: string;
    readonly operation: "create" | "update";
    readonly relativePath: string;
    readonly candidatePayloadRef: string;
    readonly candidateBytes: Uint8Array;
    readonly redactedDiffRef: string | null;
    readonly expiresAt: string;
  }): Promise<PreparedFileOperation> {
    const grant = await this.#usableGrant(input.grantId, input.operation);
    const current = await this.#platform.inspect(grant, input.relativePath);
    if (input.operation === "create" && current)
      this.#conflict("Exclusive create target already exists");
    if (input.operation === "update" && !current) this.#conflict("Update target is missing");
    const previousDigest = current
      ? this.#digest.digest(await this.#platform.read(grant, input.relativePath, 16 * 1024 * 1024))
      : null;
    const candidateDigest = this.#digest.digest(input.candidateBytes);
    const basis = {
      grantId: grant.id,
      operation: input.operation,
      relativePath: normalizeRelativePath(input.relativePath),
      destinationRelativePath: null,
      sourceRecordRef: null,
      targetIdentity: current ?? null,
      previousDigest,
      candidatePayloadRef: input.candidatePayloadRef,
      candidateDigest,
      redactedDiffRef: input.redactedDiffRef,
      sizeBytes: input.candidateBytes.byteLength,
      recoveryStrategy: current ? ("verified_backup" as const) : ("exclusive_create" as const),
      expiresAt: input.expiresAt,
    };
    if (basis.expiresAt <= this.#clock.now()) this.#reject("Prepared file operation is expired");
    const operation: PreparedFileOperation = Object.freeze({
      id: input.operationId ?? this.#ids.next("file-operation"),
      revision: 1,
      ...basis,
      canonicalHash: this.#digest.digestCanonical(JSON.stringify(basis)),
      status: "prepared",
    });
    return this.#savePreparedOnce(operation);
  }

  async executeWrite(input: {
    readonly operationId: string;
    readonly expectedHash: string;
    readonly candidateBytes: Uint8Array;
  }): Promise<PreparedFileOperation> {
    let operation = await this.#requiredPrepared(input.operationId);
    if (
      operation.canonicalHash !== input.expectedHash ||
      this.#digest.digest(input.candidateBytes) !== operation.candidateDigest
    ) {
      this.#reject("Prepared file operation changed");
    }
    if (operation.status === "verified") return operation;
    if (operation.expiresAt <= this.#clock.now()) this.#reject("Prepared file operation expired");
    const grant = await this.#usableGrant(operation.grantId, operation.operation);
    if (operation.status !== "prepared" && operation.status !== "executing")
      this.#reject("Prepared file operation is not recoverable");
    const storage = await this.#platform.storageObservation(grant);
    if (
      storage.availableBytes <
      operation.sizeBytes + FileOperationService.MINIMUM_WRITE_RESERVE_BYTES
    ) {
      this.#reject(
        "Storage reserve reached; write is blocked while read and recovery remain available",
      );
    }
    const current = await this.#platform.inspect(grant, operation.relativePath);
    if (operation.status === "executing" && current && operation.candidateDigest) {
      const currentDigest = this.#digest.digest(
        await this.#platform.read(grant, operation.relativePath, operation.sizeBytes + 1),
      );
      if (currentDigest === operation.candidateDigest) {
        return this.#state.savePrepared(
          Object.freeze({ ...operation, revision: operation.revision + 1, status: "verified" }),
          operation.revision,
        );
      }
    }
    if (
      operation.targetIdentity &&
      (!current || identityKey(current) !== identityKey(operation.targetIdentity))
    ) {
      await this.#invalidate(operation);
      this.#conflict("File identity changed after prepare");
    }
    if (operation.status === "prepared") {
      operation = await this.#state.savePrepared(
        Object.freeze({ ...operation, revision: operation.revision + 1, status: "executing" }),
        operation.revision,
      );
    }
    const identity = operation.targetIdentity
      ? await this.#platform.replaceAtomic(
          grant,
          operation.relativePath,
          operation.targetIdentity,
          input.candidateBytes,
        )
      : await this.#platform.createExclusive(grant, operation.relativePath, input.candidateBytes);
    const verified = await this.#platform.read(
      grant,
      operation.relativePath,
      operation.sizeBytes + 1,
    );
    if (
      identityKey(await this.#requiredIdentity(grant, operation.relativePath)) !==
        identityKey(identity) ||
      this.#digest.digest(verified) !== operation.candidateDigest
    ) {
      this.#reject("File write verification failed");
    }
    return this.#state.savePrepared(
      Object.freeze({ ...operation, revision: operation.revision + 1, status: "verified" }),
      operation.revision,
    );
  }

  async prepareMove(input: {
    readonly operationId?: string;
    readonly grantId: string;
    readonly sourceRelativePath: string;
    readonly destinationRelativePath: string;
    readonly expiresAt: string;
  }): Promise<PreparedFileOperation> {
    const grant = await this.#usableGrant(input.grantId, "move");
    const sourceRelativePath = normalizeRelativePath(input.sourceRelativePath);
    const destinationRelativePath = normalizeRelativePath(input.destinationRelativePath);
    const source = await this.#requiredIdentity(grant, sourceRelativePath);
    if (await this.#platform.inspect(grant, destinationRelativePath))
      this.#conflict("Move destination already exists");
    const previousDigest = this.#digest.digest(
      await this.#platform.read(grant, sourceRelativePath, 16 * 1024 * 1024),
    );
    const basis = {
      grantId: grant.id,
      operation: "move" as const,
      relativePath: sourceRelativePath,
      destinationRelativePath,
      sourceRecordRef: null,
      targetIdentity: source,
      previousDigest,
      candidatePayloadRef: null,
      candidateDigest: null,
      redactedDiffRef: null,
      sizeBytes: source.sizeBytes,
      recoveryStrategy: "verified_backup" as const,
      expiresAt: input.expiresAt,
    };
    if (basis.expiresAt <= this.#clock.now()) this.#reject("Prepared move is expired");
    const operation: PreparedFileOperation = Object.freeze({
      id: input.operationId ?? this.#ids.next("file-operation"),
      revision: 1,
      ...basis,
      canonicalHash: this.#digest.digestCanonical(JSON.stringify(basis)),
      status: "prepared",
    });
    return this.#savePreparedOnce(operation);
  }

  async executeMove(input: {
    readonly operationId: string;
    readonly expectedHash: string;
  }): Promise<PreparedFileOperation> {
    let operation = await this.#requiredPrepared(input.operationId);
    if (
      operation.operation !== "move" ||
      !operation.destinationRelativePath ||
      !operation.targetIdentity ||
      operation.canonicalHash !== input.expectedHash
    ) {
      this.#reject("Prepared move changed");
    }
    if (operation.status === "verified") return operation;
    if (operation.expiresAt <= this.#clock.now()) this.#reject("Prepared move expired");
    if (operation.status !== "prepared" && operation.status !== "executing")
      this.#reject("Prepared move is not recoverable");
    const destinationRelativePath = operation.destinationRelativePath;
    const targetIdentity = operation.targetIdentity;
    const previousDigest = operation.previousDigest;
    const grant = await this.#usableGrant(operation.grantId, "move");
    const source = await this.#platform.inspect(grant, operation.relativePath);
    const destination = await this.#platform.inspect(grant, operation.destinationRelativePath);
    if (
      operation.status === "executing" &&
      !source &&
      destination &&
      identityKey(destination) === identityKey(operation.targetIdentity) &&
      this.#digest.digest(
        await this.#platform.read(grant, destinationRelativePath, 16 * 1024 * 1024),
      ) === previousDigest
    ) {
      return this.#state.savePrepared(
        Object.freeze({ ...operation, revision: operation.revision + 1, status: "verified" }),
        operation.revision,
      );
    }
    if (!source || identityKey(source) !== identityKey(operation.targetIdentity)) {
      await this.#invalidate(operation);
      this.#conflict("Move source identity changed after prepare");
    }
    if (destination) {
      await this.#invalidate(operation);
      this.#conflict("Move destination appeared after prepare");
    }
    if (operation.status === "prepared") {
      operation = await this.#state.savePrepared(
        Object.freeze({ ...operation, revision: operation.revision + 1, status: "executing" }),
        operation.revision,
      );
    }
    const moved = await this.#platform.move(
      grant,
      operation.relativePath,
      destinationRelativePath,
      targetIdentity,
    );
    if (
      (await this.#platform.inspect(grant, operation.relativePath)) ||
      identityKey(await this.#requiredIdentity(grant, destinationRelativePath)) !==
        identityKey(moved) ||
      this.#digest.digest(
        await this.#platform.read(grant, destinationRelativePath, 16 * 1024 * 1024),
      ) !== previousDigest
    ) {
      this.#reject("Move verification failed");
    }
    return this.#state.savePrepared(
      Object.freeze({ ...operation, revision: operation.revision + 1, status: "verified" }),
      operation.revision,
    );
  }

  async prepareTrash(input: {
    readonly operationId?: string;
    readonly grantId: string;
    readonly relativePath: string;
    readonly expiresAt: string;
  }): Promise<PreparedFileOperation> {
    const grant = await this.#usableGrant(input.grantId, "trash");
    const relativePath = normalizeRelativePath(input.relativePath);
    const identity = await this.#requiredIdentity(grant, relativePath);
    const previousDigest = this.#digest.digest(
      await this.#platform.read(grant, relativePath, 16 * 1024 * 1024),
    );
    const basis = {
      grantId: grant.id,
      operation: "trash" as const,
      relativePath,
      destinationRelativePath: null,
      sourceRecordRef: null,
      targetIdentity: identity,
      previousDigest,
      candidatePayloadRef: null,
      candidateDigest: null,
      redactedDiffRef: null,
      sizeBytes: identity.sizeBytes,
      recoveryStrategy: "controlled_trash" as const,
      expiresAt: input.expiresAt,
    };
    if (basis.expiresAt <= this.#clock.now()) this.#reject("Prepared Trash operation is expired");
    return this.#savePreparedOnce(
      Object.freeze({
        id: input.operationId ?? this.#ids.next("file-operation"),
        revision: 1,
        ...basis,
        canonicalHash: this.#digest.digestCanonical(JSON.stringify(basis)),
        status: "prepared",
      }),
    );
  }

  async executeTrash(input: {
    readonly operationId: string;
    readonly expectedHash: string;
  }): Promise<{ readonly operation: PreparedFileOperation; readonly record: HostTrashRecord }> {
    let operation = await this.#requiredPrepared(input.operationId);
    if (
      operation.operation !== "trash" ||
      !operation.targetIdentity ||
      !operation.previousDigest ||
      operation.canonicalHash !== input.expectedHash
    ) {
      this.#reject("Prepared Trash operation changed");
    }
    const recordId = operation.id;
    const existingRecord = await this.#state.readTrash(recordId);
    if (operation.status === "verified" && existingRecord)
      return Object.freeze({ operation, record: existingRecord });
    if (operation.expiresAt <= this.#clock.now()) this.#reject("Prepared Trash operation expired");
    if (operation.status !== "prepared" && operation.status !== "executing")
      this.#reject("Prepared Trash operation is not recoverable");
    const targetIdentity = operation.targetIdentity;
    const previousDigest = operation.previousDigest;
    const grant = await this.#usableGrant(operation.grantId, "trash");
    const current = await this.#platform.inspect(grant, operation.relativePath);
    if (
      operation.status === "prepared" &&
      (!current || identityKey(current) !== identityKey(operation.targetIdentity))
    ) {
      await this.#invalidate(operation);
      this.#conflict("Trash target identity changed after prepare");
    }
    if (operation.status === "prepared") {
      operation = await this.#state.savePrepared(
        Object.freeze({ ...operation, revision: operation.revision + 1, status: "executing" }),
        operation.revision,
      );
    }
    const trashed = await this.#platform.trash(
      grant,
      operation.relativePath,
      targetIdentity,
      operation.id,
    );
    const record: HostTrashRecord = Object.freeze({
      id: recordId,
      hostId: this.#hostId,
      grantId: grant.id,
      originalRelativePath: operation.relativePath,
      trashRelativePath: trashed.trashRelativePath,
      originalIdentity: targetIdentity,
      digest: previousDigest,
      trashedAt: this.#clock.now(),
      retentionObservation: "owner_controlled_no_automatic_product_expiry",
      status: "trashed",
    });
    const savedRecord = await this.#state.saveTrash(record);
    if (await this.#platform.inspect(grant, operation.relativePath))
      this.#reject("Trash verification failed");
    const verified = await this.#state.savePrepared(
      Object.freeze({ ...operation, revision: operation.revision + 1, status: "verified" }),
      operation.revision,
    );
    return Object.freeze({ operation: verified, record: savedRecord });
  }

  async prepareRestore(input: {
    readonly operationId?: string;
    readonly trashId: string;
    readonly expiresAt: string;
  }): Promise<PreparedFileOperation> {
    const trashId = input.trashId;
    const record = await this.#state.readTrash(trashId);
    if (!record || record.status !== "trashed" || record.hostId !== this.#hostId)
      this.#reject("Trash record unavailable");
    const grant = await this.#usableGrant(record.grantId, "restore");
    if (await this.#platform.inspect(grant, record.originalRelativePath))
      this.#conflict("Restore target already exists");
    const basis = {
      grantId: grant.id,
      operation: "restore" as const,
      relativePath: record.originalRelativePath,
      destinationRelativePath: record.trashRelativePath,
      sourceRecordRef: record.id,
      targetIdentity: record.originalIdentity,
      previousDigest: record.digest,
      candidatePayloadRef: null,
      candidateDigest: null,
      redactedDiffRef: null,
      sizeBytes: record.originalIdentity.sizeBytes,
      recoveryStrategy: "controlled_trash" as const,
      expiresAt: input.expiresAt,
    };
    if (basis.expiresAt <= this.#clock.now()) this.#reject("Prepared restore is expired");
    return this.#savePreparedOnce(
      Object.freeze({
        id: input.operationId ?? this.#ids.next("file-operation"),
        revision: 1,
        ...basis,
        canonicalHash: this.#digest.digestCanonical(JSON.stringify(basis)),
        status: "prepared",
      }),
    );
  }

  async executeRestore(input: {
    readonly operationId: string;
    readonly expectedHash: string;
  }): Promise<{ readonly operation: PreparedFileOperation; readonly record: HostTrashRecord }> {
    let operation = await this.#requiredPrepared(input.operationId);
    if (
      operation.operation !== "restore" ||
      !operation.sourceRecordRef ||
      !operation.destinationRelativePath ||
      !operation.previousDigest ||
      !operation.targetIdentity ||
      operation.canonicalHash !== input.expectedHash
    ) {
      this.#reject("Prepared restore changed");
    }
    const record = await this.#state.readTrash(operation.sourceRecordRef);
    if (!record || !["trashed", "restored"].includes(record.status))
      this.#reject("Trash record changed after prepare");
    if (operation.status === "verified" && record.status === "restored")
      return Object.freeze({ operation, record });
    if (operation.expiresAt <= this.#clock.now()) this.#reject("Prepared restore expired");
    if (operation.status !== "prepared" && operation.status !== "executing")
      this.#reject("Prepared restore is not recoverable");
    const destinationRelativePath = operation.destinationRelativePath;
    const targetIdentity = operation.targetIdentity;
    const previousDigest = operation.previousDigest;
    const grant = await this.#usableGrant(operation.grantId, "restore");
    if (
      operation.status === "prepared" &&
      (await this.#platform.inspect(grant, operation.relativePath))
    ) {
      await this.#invalidate(operation);
      this.#conflict("Restore target appeared after prepare");
    }
    if (operation.status === "prepared") {
      operation = await this.#state.savePrepared(
        Object.freeze({ ...operation, revision: operation.revision + 1, status: "executing" }),
        operation.revision,
      );
    }
    const restored = await this.#platform.restore(
      grant,
      destinationRelativePath,
      operation.relativePath,
      targetIdentity,
    );
    if (
      this.#digest.digest(
        await this.#platform.read(grant, operation.relativePath, 16 * 1024 * 1024),
      ) !== previousDigest ||
      restored.device !== record.originalIdentity.device
    ) {
      this.#reject("Restored file verification failed");
    }
    const savedRecord = await this.#state.saveTrash(
      Object.freeze({ ...record, status: "restored" }),
    );
    const verified = await this.#state.savePrepared(
      Object.freeze({ ...operation, revision: operation.revision + 1, status: "verified" }),
      operation.revision,
    );
    return Object.freeze({ operation: verified, record: savedRecord });
  }

  async trash(input: {
    readonly grantId: string;
    readonly relativePath: string;
  }): Promise<HostTrashRecord> {
    const prepared = await this.prepareTrash({
      ...input,
      expiresAt: new Date(new Date(this.#clock.now()).getTime() + 60_000).toISOString(),
    });
    return (
      await this.executeTrash({ operationId: prepared.id, expectedHash: prepared.canonicalHash })
    ).record;
  }

  async restore(trashId: string): Promise<HostTrashRecord> {
    const prepared = await this.prepareRestore({
      trashId,
      expiresAt: new Date(new Date(this.#clock.now()).getTime() + 60_000).toISOString(),
    });
    return (
      await this.executeRestore({ operationId: prepared.id, expectedHash: prepared.canonicalHash })
    ).record;
  }

  async preparePermanentDeletion(input: {
    readonly planId?: string;
    readonly grantId: string;
    readonly relativePath: string;
    readonly irreversibleScope: string;
    readonly expiresAt: string;
  }): Promise<PermanentDeletionPlan> {
    const grant = await this.#usableGrant(input.grantId, "permanent_delete");
    const rootRelativePath = normalizeRelativePath(input.relativePath);
    const targets = await this.#platform.inventoryDeletion(grant, rootRelativePath);
    if (targets.length === 0) this.#conflict("Permanent deletion target is missing");
    const basis = {
      grantId: grant.id,
      rootRelativePath,
      targets: [...targets],
      objectCount: targets.length,
      totalBytes: targets.reduce((total, target) => total + target.identity.sizeBytes, 0),
      irreversibleScope: input.irreversibleScope.trim(),
      risk: "critical" as const,
      expiresAt: input.expiresAt,
    };
    if (!basis.irreversibleScope || basis.expiresAt <= this.#clock.now())
      this.#reject("Permanent deletion plan is incomplete or expired");
    const plan: PermanentDeletionPlan = Object.freeze({
      id: input.planId ?? this.#ids.next("permanent-deletion"),
      revision: 1,
      ...basis,
      canonicalHash: this.#digest.digestCanonical(JSON.stringify(basis)),
      status: "prepared",
    });
    const existing = await this.#state.readDeletionPlan(plan.id);
    if (existing) {
      if (existing.canonicalHash !== plan.canonicalHash)
        this.#conflict("Permanent deletion identity was reused with a different plan");
      return existing;
    }
    return this.#state.saveDeletionPlan(plan, null);
  }

  async executePermanentDeletion(input: {
    readonly planId: string;
    readonly expectedHash: string;
    readonly recentAuthenticationRef: string;
  }): Promise<PermanentDeletionPlan> {
    let plan = await this.#state.readDeletionPlan(input.planId);
    if (
      !plan ||
      plan.canonicalHash !== input.expectedHash ||
      input.recentAuthenticationRef.trim().length === 0
    ) {
      this.#reject("Permanent deletion approval changed or is missing recent authentication");
    }
    if (plan.status === "verified") return plan;
    if (plan.expiresAt <= this.#clock.now()) this.#reject("Permanent deletion approval is expired");
    if (plan.status !== "prepared" && plan.status !== "deleting" && plan.status !== "unknown")
      this.#reject("Permanent deletion plan is not recoverable");
    const grant = await this.#usableGrant(plan.grantId, "permanent_delete");
    const currentTargets = await this.#platform.inventoryDeletion(grant, plan.rootRelativePath);
    const plannedByPath = new Map(plan.targets.map((target) => [target.relativePath, target]));
    const unexpected = currentTargets.filter((target) => {
      const planned = plannedByPath.get(target.relativePath);
      return (
        !planned ||
        planned.kind !== target.kind ||
        planned.digest !== target.digest ||
        identityKey(planned.identity) !== identityKey(target.identity)
      );
    });
    if (
      unexpected.length > 0 ||
      (plan.status === "prepared" && currentTargets.length !== plan.targets.length)
    ) {
      await this.#state.saveDeletionPlan(
        Object.freeze({ ...plan, revision: plan.revision + 1, status: "invalidated" }),
        plan.revision,
      );
      this.#conflict("Permanent deletion target set changed after prepare");
    }
    if (currentTargets.length === 0) {
      return this.#state.saveDeletionPlan(
        Object.freeze({ ...plan, revision: plan.revision + 1, status: "verified" }),
        plan.revision,
      );
    }
    if (plan.status !== "deleting") {
      plan = await this.#state.saveDeletionPlan(
        Object.freeze({ ...plan, revision: plan.revision + 1, status: "deleting" }),
        plan.revision,
      );
    }
    await this.#platform.deletePermanently(grant, plan.targets);
    if ((await this.#platform.inventoryDeletion(grant, plan.rootRelativePath)).length > 0) {
      await this.#state.saveDeletionPlan(
        Object.freeze({ ...plan, revision: plan.revision + 1, status: "unknown" }),
        plan.revision,
      );
      this.#reject("Permanent deletion readback is unknown");
    }
    return this.#state.saveDeletionPlan(
      Object.freeze({ ...plan, revision: plan.revision + 1, status: "verified" }),
      plan.revision,
    );
  }

  async #savePreparedOnce(operation: PreparedFileOperation): Promise<PreparedFileOperation> {
    const existing = await this.#state.readPrepared(operation.id);
    if (existing) {
      if (existing.canonicalHash !== operation.canonicalHash)
        this.#conflict("File operation identity was reused with different content");
      return existing;
    }
    return this.#state.savePrepared(operation, null);
  }

  async #usableGrant(grantId: string, operation: string): Promise<HostDirectoryGrant> {
    const grant = await this.#state.readGrant(grantId);
    if (
      !grant ||
      grant.hostId !== this.#hostId ||
      grant.revokedAt ||
      grant.expiresAt <= this.#clock.now() ||
      !grant.operations.includes(operation as never)
    ) {
      this.#reject("Directory Grant is revoked, expired, cross-host, or out of scope");
    }
    const root = await this.#platform.inspectRoot(grant.displayPath);
    if (identityKey(root) !== grant.canonicalRootId)
      this.#reject("Directory root identity changed");
    return grant;
  }

  async #requiredPrepared(operationId: string): Promise<PreparedFileOperation> {
    const operation = await this.#state.readPrepared(operationId);
    if (!operation)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "File operation missing");
    return operation;
  }

  async #requiredIdentity(grant: HostDirectoryGrant, relativePath: string) {
    const identity = await this.#platform.inspect(grant, relativePath);
    if (!identity)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "File target missing");
    return identity;
  }

  async #invalidate(operation: PreparedFileOperation): Promise<void> {
    await this.#state.savePrepared(
      Object.freeze({ ...operation, revision: operation.revision + 1, status: "invalidated" }),
      operation.revision,
    );
  }

  #reject(message: string): never {
    throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, message);
  }
  #conflict(message: string): never {
    throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, message);
  }
}

export function normalizeRelativePath(value: string): string {
  if (
    value.length === 0 ||
    value.length > 1024 ||
    value.startsWith("/") ||
    value.split(/[\\/]/).some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "Relative path is unsafe");
  }
  return value.replaceAll("\\", "/");
}

export function identityKey(identity: { readonly device: string; readonly inode: string }): string {
  return `${identity.device}:${identity.inode}`;
}
