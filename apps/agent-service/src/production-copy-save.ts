import { createHash } from "node:crypto";
import type { HostDirectoryGrant, PreparedFileOperation } from "@himawari-agent/application";
import {
  type SandboxHostBinding,
  type SandboxScope,
  sandboxScopeSchema,
} from "@himawari-agent/execution-contracts";
import {
  ConstrainedHostFileSystem,
  resolveSandboxFileScope,
  type WorkspaceCopySaveSnapshot,
} from "@himawari-agent/platform-node";

/** Freeze one selected change before admission; no source target is changed here. */
export async function prepareProductionCopySave(input: {
  readonly scope: SandboxScope;
  readonly now: string;
  readonly binding: SandboxHostBinding;
  readonly grant: HostDirectoryGrant;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly readPrepared: (id: string) => Promise<PreparedFileOperation | undefined>;
  readonly readBytes: (ref: string) => Promise<Uint8Array>;
}) {
  const args = input.parameters;
  if (
    typeof args["operationId"] !== "string" ||
    typeof args["expectedHash"] !== "string" ||
    Object.keys(args).some((key) => !["operationId", "expectedHash"].includes(key))
  )
    throw new Error("COPY_SAVE_INPUT_INVALID");
  const operation = await input.readPrepared(args["operationId"]);
  if (
    !operation ||
    operation.canonicalHash !== args["expectedHash"] ||
    operation.grantId !== input.grant.id ||
    operation.status !== "prepared" ||
    operation.expiresAt <= input.now ||
    operation.copyAuthority?.grantRevision !== input.grant.revision ||
    operation.copyAuthority.canonicalRootId !== input.grant.canonicalRootId ||
    !["create", "update", "move", "trash"].includes(operation.operation) ||
    !input.grant.operations.includes(operation.operation)
  )
    throw new Error("COPY_SAVE_OPERATION_UNAVAILABLE");
  const dependencies: PreparedFileOperation[] = [];
  for (const ref of new Set(
    (operation.copyDependencies ?? []).flatMap((item) =>
      item.priorOperationRef ? [item.priorOperationRef] : [],
    ),
  )) {
    const prior = await input.readPrepared(ref);
    if (!prior || prior.status !== "verified" || prior.grantId !== operation.grantId)
      throw new Error("COPY_SAVE_DEPENDENCY_PENDING");
    dependencies.push(prior);
  }
  const scope = sandboxScopeSchema.parse({
    ...input.scope,
    directoryGrant: { ...input.scope.directoryGrant, operations: ["read", operation.operation] },
  });
  const paths = [
    ...new Set([
      operation.relativePath,
      ...(operation.destinationRelativePath ? [operation.destinationRelativePath] : []),
      ...(operation.copyDependencies ?? []).map((item) => item.path),
    ]),
  ];
  const targets = [];
  for (const relativePath of paths)
    targets.push(
      (
        await resolveSandboxFileScope({
          binding: input.binding,
          scope,
          relativePath,
          access: "write",
        })
      ).target,
    );
  const platform = new ConstrainedHostFileSystem();
  let candidate = null;
  if (operation.operation === "create" || operation.operation === "update") {
    if (!operation.candidatePayloadRef) throw new Error("COPY_SAVE_CONTENT_REQUIRED");
    const bytes = await input.readBytes(operation.candidatePayloadRef);
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== operation.candidateDigest)
      throw new Error("COPY_SAVE_CONTENT_CHANGED");
    candidate = await platform.stagePublication(
      input.grant,
      bytes,
      operation.targetIdentity ? operation.targetIdentity.mode & 0o777 : 0o600,
    );
  }
  const snapshot: WorkspaceCopySaveSnapshot = { operation, dependencies, candidate };
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const frozen = sandboxScopeSchema.parse({
    ...scope,
    copySave: {
      operationId: operation.id,
      canonicalHash: operation.canonicalHash,
      snapshot: await platform.stagePublication(input.grant, bytes),
      snapshotDigest: createHash("sha256").update(bytes).digest("hex"),
      targets,
    },
  });
  if (Buffer.byteLength(JSON.stringify(frozen)) > 96 * 1024)
    throw new Error("COPY_SAVE_SCOPE_LIMIT");
  return frozen;
}

/** Dependency stability is an exclusive coordination claim, never additional write authority. */
export async function resolveProductionCopySaveClaims(input: {
  scope: SandboxScope;
  binding: SandboxHostBinding;
}) {
  if (!input.scope.copySave) throw new Error("COPY_SAVE_SCOPE_REQUIRED");
  const claims = [];
  for (const target of input.scope.copySave.targets) {
    const current = await resolveSandboxFileScope({
      ...input,
      relativePath: target.relativePath,
      access: "write",
    });
    if (JSON.stringify(current.target) !== JSON.stringify(target))
      throw new Error("COPY_SAVE_BASELINE_CHANGED");
    claims.push({
      ...current.claim,
      ...(current.claim.file ? { file: { ...current.claim.file, atomicPublish: false } } : {}),
    });
  }
  return claims;
}

/** Import original runner checkpoints in revision order. Reconciliation never
 * invokes the file mutator and cannot roll back a later user edit. */
export async function importProductionCopySave(input: {
  readonly scope: SandboxScope;
  readonly workspace: string;
  readonly privateDirectory: string;
  readonly repository: import("@himawari-agent/persistence-sqlite").SqliteProductStateRepository;
  readonly authority: import("@himawari-agent/application").AuthorityFence;
  readonly now: string;
  readonly recover?: boolean;
}) {
  const { createWorkspaceCopyPublication } = await import("@himawari-agent/platform-node");
  const journal = await createWorkspaceCopyPublication(input);
  let recoveryFailure: unknown;
  if (input.recover)
    try {
      await journal.recover();
    } catch (error) {
      recoveryFailure = error;
    }
  for (const update of journal.updates()) {
    for (const [kind, value] of [
      ["file-operation", update.operation],
      ...(update.trash ? [["host-trash", update.trash] as const] : []),
    ] as const) {
      const key = `host-workspace:${kind}:${value.id}`;
      const current = await input.repository.readScopedState(
        input.scope.ownerId as Parameters<
          import("@himawari-agent/persistence-sqlite").SqliteProductStateRepository["readScopedState"]
        >[0],
        input.scope.agentId as Parameters<
          import("@himawari-agent/persistence-sqlite").SqliteProductStateRepository["readScopedState"]
        >[1],
        key,
      );
      if (kind === "file-operation") {
        const prior = current?.value as unknown as PreparedFileOperation | undefined;
        if (!prior || prior.canonicalHash !== update.operation.canonicalHash)
          throw new Error("COPY_SAVE_IMPORT_CHANGED");
        if (prior.revision >= update.operation.revision) continue;
        if (update.operation.revision !== prior.revision + 1)
          throw new Error("COPY_SAVE_IMPORT_GAP");
      } else if (current) continue;
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([key, value]))
        .digest("hex");
      await input.repository.commitStateAndEvents({
        command: {
          ownerId: input.scope.ownerId as Parameters<
            import("@himawari-agent/persistence-sqlite").SqliteProductStateRepository["readScopedState"]
          >[0],
          agentId: input.scope.agentId as Parameters<
            import("@himawari-agent/persistence-sqlite").SqliteProductStateRepository["readScopedState"]
          >[1],
          authority: input.authority,
          commandType: "workspace.copy.result",
          idempotencyKey:
            `copy-save:${fingerprint}` as import("@himawari-agent/application").IdempotentAgentCommand["idempotencyKey"],
          commandFingerprint: fingerprint,
        },
        state: {
          key,
          expectedRevision: current?.revision ?? null,
          value: JSON.parse(JSON.stringify(value)),
        },
        events: [],
        resultRef: key,
        committedAt: input.now,
      });
    }
  }
  if (recoveryFailure) throw recoveryFailure;
  return journal.retained();
}
