import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type HostDirectoryGrant,
  type HostFileDigestPort,
  type HostFilePlatformPort,
  type HostFileStatePort,
  type HostTrashRecord,
  type PreparedFileOperation,
} from "../ports/index.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";

export class FileOperationService {
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
      id: this.#ids.next("file-operation"),
      revision: 1,
      ...basis,
      canonicalHash: this.#digest.digestCanonical(JSON.stringify(basis)),
      status: "prepared",
    });
    return this.#state.savePrepared(operation, null);
  }

  async executeWrite(input: {
    readonly operationId: string;
    readonly expectedHash: string;
    readonly candidateBytes: Uint8Array;
  }): Promise<PreparedFileOperation> {
    const operation = await this.#requiredPrepared(input.operationId);
    const grant = await this.#usableGrant(operation.grantId, operation.operation);
    if (
      operation.status !== "prepared" ||
      operation.canonicalHash !== input.expectedHash ||
      operation.expiresAt <= this.#clock.now() ||
      this.#digest.digest(input.candidateBytes) !== operation.candidateDigest
    ) {
      this.#reject("Prepared file operation changed or expired");
    }
    const current = await this.#platform.inspect(grant, operation.relativePath);
    if (
      operation.targetIdentity &&
      (!current || identityKey(current) !== identityKey(operation.targetIdentity))
    ) {
      await this.#invalidate(operation);
      this.#conflict("File identity changed after prepare");
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

  async trash(input: {
    readonly grantId: string;
    readonly relativePath: string;
  }): Promise<HostTrashRecord> {
    const grant = await this.#usableGrant(input.grantId, "trash");
    const identity = await this.#requiredIdentity(grant, input.relativePath);
    const digest = this.#digest.digest(
      await this.#platform.read(grant, input.relativePath, 16 * 1024 * 1024),
    );
    const trashed = await this.#platform.trash(grant, input.relativePath, identity);
    const record: HostTrashRecord = Object.freeze({
      id: this.#ids.next("host-trash"),
      hostId: this.#hostId,
      grantId: grant.id,
      originalRelativePath: normalizeRelativePath(input.relativePath),
      trashRelativePath: trashed.trashRelativePath,
      originalIdentity: identity,
      digest,
      trashedAt: this.#clock.now(),
      retentionObservation: "owner_controlled_no_automatic_product_expiry",
      status: "trashed",
    });
    return this.#state.saveTrash(record);
  }

  async restore(trashId: string): Promise<HostTrashRecord> {
    const record = await this.#state.readTrash(trashId);
    if (!record || record.status !== "trashed" || record.hostId !== this.#hostId)
      this.#reject("Trash record unavailable");
    const grant = await this.#usableGrant(record.grantId, "restore");
    if (await this.#platform.inspect(grant, record.originalRelativePath))
      this.#conflict("Restore target already exists");
    const restored = await this.#platform.restore(
      grant,
      record.trashRelativePath,
      record.originalRelativePath,
    );
    if (
      this.#digest.digest(
        await this.#platform.read(grant, record.originalRelativePath, 16 * 1024 * 1024),
      ) !== record.digest ||
      restored.device !== record.originalIdentity.device
    ) {
      this.#reject("Restored file verification failed");
    }
    return this.#state.saveTrash(Object.freeze({ ...record, status: "restored" }));
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
