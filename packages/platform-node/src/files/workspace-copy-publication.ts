import { createHash } from "node:crypto";
import type {
  HostDirectoryGrant,
  HostFilePublication,
  HostFileStatePort,
  HostTrashRecord,
  PreparedFileOperation,
} from "@himawari-agent/application";
import {
  ApplicationPortError,
  FileOperationService,
  PORT_ERROR_CODES,
} from "@himawari-agent/application";
import { type SandboxScope, sandboxScopeSchema } from "@himawari-agent/execution-contracts";
import { ConstrainedHostFileSystem } from "./constrained-file-system.js";
import { createPrivatePublicationRecords } from "./pi-file-publication.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export interface WorkspaceCopySaveSnapshot {
  readonly operation: PreparedFileOperation;
  readonly dependencies: readonly PreparedFileOperation[];
  readonly candidate: HostFilePublication | null;
}
/** Uses the existing per-file algorithms and durable fixed-runner receipt format.
 * Only the host stages this snapshot. It is never accepted from tool arguments. */
export async function readWorkspaceCopySaveSnapshot(input: {
  scope: SandboxScope;
  workspace: string;
}) {
  const scope = sandboxScopeSchema.parse(input.scope);
  const save = scope.copySave;
  if (!save || scope.operation !== "save_copy") throw new Error("COPY_SAVE_SCOPE_REQUIRED");
  const grant: HostDirectoryGrant = {
    id: scope.directoryGrant.ref,
    revision: scope.directoryGrant.revision,
    hostId: scope.hostId,
    canonicalRootId: scope.directoryGrant.canonicalRootId,
    displayPath: input.workspace,
    operations: scope.directoryGrant.operations,
    authorizationRef: scope.directoryGrant.authorizationRef,
    expiresAt: scope.expiresAt,
    revokedAt: null,
    dataClassification: "private",
    disclosure: "worker",
    pathPolicy: "same_filesystem_no_links",
    mountPolicy: "fixed_device",
  };
  const platform = new ConstrainedHostFileSystem();
  const bytes = await platform.readPublication(grant, save.snapshot);
  if (hash(bytes) !== save.snapshotDigest) throw new Error("COPY_SAVE_SNAPSHOT_CHANGED");
  const snapshot = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as WorkspaceCopySaveSnapshot;
  const op = snapshot.operation;
  if (
    !op ||
    op.id !== save.operationId ||
    op.canonicalHash !== save.canonicalHash ||
    op.grantId !== grant.id ||
    op.status !== "prepared" ||
    op.copyAuthority?.grantRevision !== grant.revision ||
    op.copyAuthority.canonicalRootId !== grant.canonicalRootId ||
    !["create", "update", "move", "trash"].includes(op.operation) ||
    !grant.operations.includes(op.operation)
  )
    throw new Error("COPY_SAVE_OPERATION_CHANGED");
  return { snapshot, grant, platform };
}

export async function createWorkspaceCopyPublication(input: {
  readonly scope: SandboxScope;
  readonly workspace: string;
  readonly privateDirectory: string;
}) {
  const { snapshot, grant, platform } = await readWorkspaceCopySaveSnapshot(input);
  const names = Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => [`state${i}`, `copy-save-state-${i}.json`]),
  );
  const records = createPrivatePublicationRecords({
    privateDirectory: input.privateDirectory,
    bindingDigest: hash(JSON.stringify([input.scope, input.workspace])),
    names,
    maximumBytes: 2 * 1024 * 1024,
  });
  let operation = snapshot.operation;
  let trash: HostTrashRecord | undefined;
  let sequence = 0;
  let conflict = false;
  const updates: {
    operation: PreparedFileOperation;
    trash?: HostTrashRecord;
    conflict?: boolean;
  }[] = [];
  for (; sequence < 16; sequence++) {
    const retained = (await records.read(`state${sequence}`)) as
      | { operation: PreparedFileOperation; trash?: HostTrashRecord; conflict?: boolean }
      | undefined;
    if (!retained) break;
    if (
      retained.operation.id !== operation.id ||
      retained.operation.canonicalHash !== operation.canonicalHash ||
      retained.operation.revision < operation.revision
    )
      throw new Error("COPY_SAVE_RECORD_CHANGED");
    updates.push(retained);
    operation = retained.operation;
    trash = retained.trash;
    conflict = retained.conflict === true;
  }
  const persist = async () => {
    if (sequence >= 16) throw new Error("COPY_SAVE_RECORD_LIMIT");
    const update = {
      operation,
      ...(trash ? { trash } : {}),
      ...(conflict ? { conflict: true } : {}),
    };
    await records.write(`state${sequence++}`, update);
    updates.push(update);
  };
  const denied = async (): Promise<never> => {
    throw new Error("COPY_SAVE_STATE_DENIED");
  };
  const state: HostFileStatePort = {
    readGrant: async (id) => (id === grant.id ? grant : undefined),
    saveGrant: denied,
    readDeletionPlan: denied,
    saveDeletionPlan: denied,
    readPrepared: async (id) =>
      id === operation.id ? operation : snapshot.dependencies.find((item) => item.id === id),
    savePrepared: async (value, expected) => {
      if (
        value.id !== operation.id ||
        expected !== operation.revision ||
        value.revision !== expected + 1 ||
        value.canonicalHash !== operation.canonicalHash
      )
        return denied();
      operation = value;
      await persist();
      return operation;
    },
    readTrash: async (id) => (id === operation.id ? trash : undefined),
    saveTrash: async (value) => {
      if (value.id !== operation.id) return denied();
      trash = value;
      await persist();
      return value;
    },
  };
  const service = new FileOperationService({
    state,
    platform,
    hostId: grant.hostId,
    digest: {
      digest: (value) => `sha256:${hash(value)}`,
      digestCanonical: (value) => `sha256:${hash(value)}`,
    },
    clock: { now: () => new Date().toISOString() },
    ids: {
      next: () => {
        throw new Error("COPY_SAVE_ID_UNAVAILABLE");
      },
    },
  });
  return {
    async execute() {
      // A reopened runner must not turn uncertain prior effects into a second write.
      if (sequence) throw new Error("COPY_SAVE_ALREADY_STARTED");
      await persist();
      const request = { operationId: operation.id, expectedHash: operation.canonicalHash };
      if (operation.operation === "move") await service.executeMove(request);
      else if (operation.operation === "trash") await service.executeTrash(request);
      else {
        if (!snapshot.candidate) throw new Error("COPY_SAVE_CONTENT_REQUIRED");
        await service.executeWrite({
          ...request,
          candidateBytes: await platform.readPublication(grant, snapshot.candidate),
          preparedPublication: snapshot.candidate,
        });
      }
      return {
        operationId: operation.id,
        canonicalHash: operation.canonicalHash,
        status: operation.status,
        revision: operation.revision,
      };
    },
    async recover() {
      if (operation.status !== "executing" || conflict) return;
      const same = (
        identity: { device: string; inode: string } | undefined,
        expected: { device: string; inode: string } | null | undefined,
      ) =>
        identity &&
        expected &&
        identity.device === expected.device &&
        identity.inode === expected.inode;
      const source = await platform.inspect(grant, operation.relativePath);
      if (operation.operation === "create" || operation.operation === "update") {
        if (!operation.publication) return;
        // Recover only this publication's inode. Never call create/replace again.
        const identity = await platform.recoverPublication(
          grant,
          operation.relativePath,
          operation.publication,
        );
        if (
          `sha256:${hash(await platform.read(grant, operation.relativePath, operation.sizeBytes + 1, identity))}` !==
          operation.candidateDigest
        )
          throw new Error("COPY_SAVE_RECOVERY_CHANGED");
      } else {
        if (source || !operation.targetIdentity) return;
        const target =
          operation.operation === "move"
            ? operation.destinationRelativePath
            : `.himawari-trash/${hash(operation.id)}.trash`;
        if (!target) throw new Error("COPY_SAVE_RECOVERY_CHANGED");
        const identity = await platform.inspect(grant, target);
        if (
          !same(identity, operation.targetIdentity) ||
          `sha256:${hash(await platform.read(grant, target, 16 * 1024 * 1024, identity))}` !==
            operation.previousDigest
        )
          throw new Error("COPY_SAVE_RECOVERY_CHANGED");
        if (operation.operation === "trash" && !trash) {
          if (!operation.previousDigest) throw new Error("COPY_SAVE_RECOVERY_CHANGED");
          await state.saveTrash({
            id: operation.id,
            hostId: grant.hostId,
            grantId: grant.id,
            originalRelativePath: operation.relativePath,
            trashRelativePath: target,
            originalIdentity: operation.targetIdentity,
            digest: operation.previousDigest,
            trashedAt: new Date().toISOString(),
            retentionObservation: "owner_controlled_no_automatic_product_expiry",
            status: "trashed",
          });
        }
      }
      await state.savePrepared(
        { ...operation, revision: operation.revision + 1, status: "verified" },
        operation.revision,
      );
    },
    async conflicted(error: unknown) {
      if (
        !(error instanceof ApplicationPortError) ||
        error.code !== PORT_ERROR_CODES.CONFLICT ||
        !["prepared", "invalidated"].includes(operation.status) ||
        !sequence
      )
        throw error;
      conflict = true;
      await persist();
      return {
        operationId: operation.id,
        canonicalHash: operation.canonicalHash,
        status: "not_started",
        revision: operation.revision,
      };
    },
    updates() {
      return structuredClone(updates);
    },
    retained() {
      return sequence
        ? { operation, ...(trash ? { trash } : {}), ...(conflict ? { conflict: true } : {}) }
        : undefined;
    },
  };
}
