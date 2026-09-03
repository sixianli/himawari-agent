import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type CommitPreview,
  type HostDirectoryGrant,
  type HostFileStatePort,
  type HostDirectoryProjectionRecord,
  type HostWorkspaceProjectionPort,
  type HostWorkspaceProjectionRecord,
  type HostTrashRecord,
  type JsonObject,
  type PermanentDeletionPlan,
  type PreparedFileOperation,
  type StateStorePort,
  type WorkspaceSnapshot,
  type WorkspaceStatePort,
} from "../ports/index.js";

export class DurableHostWorkspaceStateAdapter implements HostFileStatePort, WorkspaceStatePort {
  readonly #state: StateStorePort;

  constructor(state: StateStorePort) {
    this.#state = state;
  }

  saveGrant(value: HostDirectoryGrant, expectedRevision: number | null) {
    return this.#save("directory-grant", value.id, value, expectedRevision);
  }
  readGrant(id: string) {
    return this.#read<HostDirectoryGrant>("directory-grant", id);
  }
  savePrepared(value: PreparedFileOperation, expectedRevision: number | null) {
    return this.#save("file-operation", value.id, value, expectedRevision);
  }
  readPrepared(id: string) {
    return this.#read<PreparedFileOperation>("file-operation", id);
  }
  async saveTrash(value: HostTrashRecord) {
    const current = await this.#state.read(key("host-trash", value.id));
    await this.#state.compareAndSet({
      key: key("host-trash", value.id),
      expectedRevision: current?.revision ?? null,
      value: json(value),
    });
    return value;
  }
  readTrash(id: string) {
    return this.#read<HostTrashRecord>("host-trash", id);
  }
  saveDeletionPlan(value: PermanentDeletionPlan, expectedRevision: number | null) {
    return this.#save("permanent-deletion", value.id, value, expectedRevision);
  }
  readDeletionPlan(id: string) {
    return this.#read<PermanentDeletionPlan>("permanent-deletion", id);
  }
  async saveSnapshot(value: WorkspaceSnapshot) {
    await this.#state.compareAndSet({
      key: key("workspace-snapshot", value.id),
      expectedRevision: null,
      value: json(value),
    });
    return value;
  }
  readSnapshot(id: string) {
    return this.#read<WorkspaceSnapshot>("workspace-snapshot", id);
  }
  saveCommitPreview(value: CommitPreview, expectedRevision: number | null) {
    return this.#save("commit-preview", value.id, value, expectedRevision);
  }
  readCommitPreview(id: string) {
    return this.#read<CommitPreview>("commit-preview", id);
  }
  async readCommitOperation(operationId: string) {
    return this.#read<{ readonly previewId: string; readonly resultRef: string | null }>(
      "commit-operation",
      operationId,
    );
  }
  async createCommitOperation(input: { readonly operationId: string; readonly previewId: string }) {
    const stateKey = key("commit-operation", input.operationId);
    const current = await this.#state.read(stateKey);
    if (current) {
      const value = current.value as {
        readonly previewId: string;
        readonly resultRef: string | null;
      };
      if (value.previewId !== input.previewId)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.CONFLICT,
          "Commit operation identity collision",
        );
      return { replayed: true, resultRef: value.resultRef };
    }
    await this.#state.compareAndSet({
      key: stateKey,
      expectedRevision: null,
      value: { previewId: input.previewId, resultRef: null },
    });
    return { replayed: false, resultRef: null };
  }
  async finishCommitOperation(input: { readonly operationId: string; readonly resultRef: string }) {
    const stateKey = key("commit-operation", input.operationId);
    const current = await this.#state.read(stateKey);
    if (!current)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Commit operation missing");
    const { resultRef } = current.value;
    if (resultRef !== null) {
      if (resultRef !== input.resultRef)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.CONFLICT,
          "Commit operation result cannot change",
        );
      return;
    }
    await this.#state.compareAndSet({
      key: stateKey,
      expectedRevision: current.revision,
      value: { ...current.value, resultRef: input.resultRef },
    });
  }

  async #save<TValue>(
    kind: string,
    id: string,
    value: TValue,
    expectedRevision: number | null,
  ): Promise<TValue> {
    await this.#state.compareAndSet({ key: key(kind, id), expectedRevision, value: json(value) });
    return value;
  }
  async #read<TValue>(kind: string, id: string): Promise<TValue | undefined> {
    return (await this.#state.read(key(kind, id)))?.value as TValue | undefined;
  }
}

interface ProjectionIndex {
  readonly workspaces: readonly HostWorkspaceProjectionRecord[];
  readonly directories: readonly HostDirectoryProjectionRecord[];
}

export class DurableHostWorkspaceProjectionAdapter implements HostWorkspaceProjectionPort {
  readonly #state: StateStorePort;

  constructor(state: StateStorePort) {
    this.#state = state;
  }

  async readWorkspace(workspaceId: string) {
    return (await this.#read()).value.workspaces.find(({ workspaceId: id }) => id === workspaceId);
  }

  async listWorkspaces(
    ownerId: HostWorkspaceProjectionRecord["ownerId"],
    agentId: HostWorkspaceProjectionRecord["agentId"],
  ) {
    return Object.freeze(
      (await this.#read()).value.workspaces.filter(
        (record) => record.ownerId === ownerId && record.agentId === agentId,
      ),
    );
  }

  saveWorkspace(record: HostWorkspaceProjectionRecord, expectedRevision: number | null) {
    return this.#save("workspaces", record, expectedRevision);
  }

  async readDirectory(grantId: string) {
    return (await this.#read()).value.directories.find(({ grantId: id }) => id === grantId);
  }

  saveDirectory(record: HostDirectoryProjectionRecord, expectedRevision: number | null) {
    return this.#save("directories", record, expectedRevision);
  }

  async #save<
    TKind extends "workspaces" | "directories",
    TRecord extends TKind extends "workspaces"
      ? HostWorkspaceProjectionRecord
      : HostDirectoryProjectionRecord,
  >(kind: TKind, record: TRecord, expectedRevision: number | null): Promise<TRecord> {
    const identity = kind === "workspaces" ? "workspaceId" : "grantId";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#read();
      const values = [...current.value[kind]] as TRecord[];
      const index = values.findIndex(
        (value) => value[identity as keyof TRecord] === record[identity as keyof TRecord],
      );
      const previous = index < 0 ? undefined : values[index];
      if ((previous?.revision ?? null) !== expectedRevision)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.CONFLICT,
          "Host workspace projection revision changed",
        );
      if (record.revision !== (previous?.revision ?? 0) + 1)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.CONFLICT,
          "Host workspace projection revision is invalid",
        );
      if (index < 0) values.push(record);
      else values[index] = record;
      const next: ProjectionIndex = {
        ...current.value,
        [kind]: values,
      };
      try {
        await this.#state.compareAndSet({
          key: "host-workspace:projection:index",
          expectedRevision: current.revision,
          value: json(next),
        });
        return Object.freeze(record);
      } catch (error) {
        if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.CONFLICT)
          throw error;
      }
    }
    throw new ApplicationPortError(
      PORT_ERROR_CODES.CONFLICT,
      "Host workspace projection remained concurrent",
    );
  }

  async #read(): Promise<{ readonly revision: number | null; readonly value: ProjectionIndex }> {
    const current = await this.#state.read("host-workspace:projection:index");
    return {
      revision: current?.revision ?? null,
      value: current
        ? (current.value as unknown as ProjectionIndex)
        : { workspaces: Object.freeze([]), directories: Object.freeze([]) },
    };
  }
}

function key(kind: string, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "Host/workspace record ID is unsafe",
    );
  return `host-workspace:${kind}:${id}`;
}

function json(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
