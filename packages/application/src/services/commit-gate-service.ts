import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type CommitExecutionHandle,
  type CommitPreview,
  type HostFileDigestPort,
  type WorkspacePlatformPort,
  type WorkspaceStatePort,
} from "../ports/index.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";

export class CommitGateService {
  readonly #dependencies: {
    readonly platform: WorkspacePlatformPort;
    readonly state: WorkspaceStatePort;
    readonly digest: HostFileDigestPort;
    readonly clock: ClockPort;
    readonly ids: IdGeneratorPort;
  };

  constructor(dependencies: {
    readonly platform: WorkspacePlatformPort;
    readonly state: WorkspaceStatePort;
    readonly digest: HostFileDigestPort;
    readonly clock: ClockPort;
    readonly ids: IdGeneratorPort;
  }) {
    this.#dependencies = dependencies;
  }

  async prepare(input: {
    readonly workspaceId: string;
    readonly taskChangeSetRevision: number;
    readonly validationResultRefs: readonly string[];
    readonly message: string;
    readonly expiresAt: string;
  }): Promise<CommitPreview> {
    const state = await this.#dependencies.platform.inspectCommitState(input.workspaceId);
    if (
      !state.head ||
      state.stagedFiles.length === 0 ||
      input.message.trim().length === 0 ||
      input.expiresAt <= this.#dependencies.clock.now()
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Commit preview is incomplete",
      );
    const basis = {
      ...state,
      workspaceId: input.workspaceId,
      taskChangeSetRevision: input.taskChangeSetRevision,
      validationResultRefs: [...input.validationResultRefs],
      message: input.message.trim(),
      expiresAt: input.expiresAt,
    };
    const preview: CommitPreview = Object.freeze({
      id: this.#dependencies.ids.next("commit-preview"),
      revision: 1,
      ...basis,
      canonicalHash: this.#dependencies.digest.digestCanonical(JSON.stringify(basis)),
      status: "prepared",
    });
    return this.#dependencies.state.saveCommitPreview(preview, null);
  }

  async commit(input: {
    readonly handle: CommitExecutionHandle;
    readonly authorityFence: number;
  }): Promise<{
    readonly commit: string;
    readonly parent: string;
    readonly remainingDirtyRefs: readonly string[];
  }> {
    const existing = await this.#dependencies.state.readCommitOperation(input.handle.operationId);
    if (existing?.resultRef) return parseResult(existing.resultRef);
    const preview = await this.#dependencies.state.readCommitPreview(input.handle.previewId);
    if (
      !preview ||
      preview.status !== "prepared" ||
      preview.canonicalHash !== input.handle.previewHash ||
      input.handle.maxUses !== 1 ||
      input.handle.authorityFence !== input.authorityFence ||
      input.handle.expiresAt <= this.#dependencies.clock.now()
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Commit Handle is stale or out of scope",
      );
    const current = await this.#dependencies.platform.inspectCommitState(preview.workspaceId);
    if (
      current.head !== preview.head ||
      current.indexTree !== preview.indexTree ||
      current.stagedDiffDigest !== preview.stagedDiffDigest ||
      current.hooksDigest !== preview.hooksDigest ||
      current.configurationDigest !== preview.configurationDigest
    ) {
      await this.#dependencies.state.saveCommitPreview(
        Object.freeze({ ...preview, revision: preview.revision + 1, status: "invalidated" }),
        preview.revision,
      );
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        "HEAD, index, hooks, configuration, or preview changed",
      );
    }
    const admitted = await this.#dependencies.state.createCommitOperation({
      operationId: input.handle.operationId,
      previewId: preview.id,
    });
    if (admitted.replayed && admitted.resultRef) return parseResult(admitted.resultRef);
    await this.#dependencies.state.saveCommitPreview(
      Object.freeze({ ...preview, revision: preview.revision + 1, status: "committing" }),
      preview.revision,
    );
    try {
      const result = await this.#dependencies.platform.commit({
        workspaceId: preview.workspaceId,
        message: preview.message,
        operationId: input.handle.operationId,
      });
      const resultRef = JSON.stringify(result);
      await this.#dependencies.state.finishCommitOperation({
        operationId: input.handle.operationId,
        resultRef,
      });
      const currentPreview = await this.#dependencies.state.readCommitPreview(preview.id);
      if (currentPreview)
        await this.#dependencies.state.saveCommitPreview(
          Object.freeze({
            ...currentPreview,
            revision: currentPreview.revision + 1,
            status: "confirmed_succeeded",
          }),
          currentPreview.revision,
        );
      return result;
    } catch {
      const reconciled = await this.#dependencies.platform.reconcileCommit({
        workspaceId: preview.workspaceId,
        expectedParent: preview.head,
        operationId: input.handle.operationId,
      });
      if (reconciled.commit && reconciled.parent === preview.head) {
        const result = {
          commit: reconciled.commit,
          parent: reconciled.parent,
          remainingDirtyRefs: preview.remainingDirtyRefs,
        };
        await this.#dependencies.state.finishCommitOperation({
          operationId: input.handle.operationId,
          resultRef: JSON.stringify(result),
        });
        return result;
      }
      throw new ApplicationPortError(
        PORT_ERROR_CODES.PROVIDER_FAILURE,
        "Commit result is unknown; automatic retry is forbidden",
      );
    }
  }
}

function parseResult(value: string): {
  commit: string;
  parent: string;
  remainingDirtyRefs: readonly string[];
} {
  return JSON.parse(value) as {
    commit: string;
    parent: string;
    remainingDirtyRefs: readonly string[];
  };
}
