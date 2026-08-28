import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type CommitPreview,
  type HostDirectoryGrant,
  type HostFileStatePort,
  type HostTrashRecord,
  type JsonObject,
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
