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
    readonly stagingRef: string;
    readonly taskChangeSetRevision: number;
    readonly validationResultRefs: readonly string[];
    readonly message: string;
    readonly expiresAt: string;
  }): Promise<CommitPreview> {
    const state = await this.#dependencies.platform.inspectCommitState(
      input.workspaceId,
      input.stagingRef,
    );
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
      stagingRef: input.stagingRef,
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
    const preview = await this.#dependencies.state.readCommitPreview(input.handle.previewId);
    if (
      !preview ||
      (existing && existing.previewId !== preview.id) ||
      preview.canonicalHash !== input.handle.previewHash ||
      input.handle.maxUses !== 1 ||
      input.handle.authorityFence !== input.authorityFence ||
      !input.handle.recentAuthenticationRef.trim()
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Commit Handle is stale or out of scope",
      );
    if (existing?.resultRef) return parseResult(existing.resultRef);
    if (existing && ["committing", "unknown"].includes(preview.status)) {
      const recovered = await this.#dependencies.platform.reconcileCommit({
        workspaceId: preview.workspaceId,
        stagingRef: preview.stagingRef,
        expectedParent: preview.head,
        operationId: input.handle.operationId,
      });
      if (recovered.commit && recovered.parent === preview.head)
        return this.#recordResult(preview.id, input.handle.operationId, {
          commit: recovered.commit,
          parent: recovered.parent,
          remainingDirtyRefs: recovered.remainingDirtyRefs,
        });
      throw new ApplicationPortError(
        PORT_ERROR_CODES.PROVIDER_FAILURE,
        "Commit result is unknown; automatic retry is forbidden",
      );
    }
    if (
      preview.status !== "prepared" ||
      input.handle.expiresAt <= this.#dependencies.clock.now() ||
      preview.expiresAt <= this.#dependencies.clock.now()
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Commit Handle is stale or out of scope",
      );
    const current = await this.#dependencies.platform.inspectCommitState(
      preview.workspaceId,
      preview.stagingRef,
    );
    if (
      current.head !== preview.head ||
      current.indexTree !== preview.indexTree ||
      current.ownerIndexDigest !== preview.ownerIndexDigest ||
      current.branch !== preview.branch ||
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
        stagingRef: preview.stagingRef,
        message: preview.message,
        operationId: input.handle.operationId,
        expectedHead: preview.head,
        expectedBranch: preview.branch,
        expectedIndexTree: preview.indexTree,
        expectedOwnerIndexDigest: preview.ownerIndexDigest,
        expectedHooksDigest: preview.hooksDigest,
        expectedConfigurationDigest: preview.configurationDigest,
      });
      return await this.#recordResult(preview.id, input.handle.operationId, result);
    } catch {
      const reconciled = await this.#dependencies.platform.reconcileCommit({
        workspaceId: preview.workspaceId,
        expectedParent: preview.head,
        operationId: input.handle.operationId,
        stagingRef: preview.stagingRef,
      });
      if (reconciled.commit && reconciled.parent === preview.head) {
        const result = {
          commit: reconciled.commit,
          parent: reconciled.parent,
          remainingDirtyRefs: reconciled.remainingDirtyRefs,
        };
        return this.#recordResult(preview.id, input.handle.operationId, result);
      }
      throw new ApplicationPortError(
        PORT_ERROR_CODES.PROVIDER_FAILURE,
        "Commit result is unknown; automatic retry is forbidden",
      );
    }
  }

  async #recordResult(
    previewId: string,
    operationId: string,
    result: Awaited<ReturnType<WorkspacePlatformPort["commit"]>>,
  ) {
    await this.#dependencies.state.finishCommitOperation({
      operationId,
      resultRef: JSON.stringify(result),
    });
    const current = await this.#dependencies.state.readCommitPreview(previewId);
    if (current && current.status !== "confirmed_succeeded")
      await this.#dependencies.state.saveCommitPreview(
        Object.freeze({
          ...current,
          revision: current.revision + 1,
          status: "confirmed_succeeded",
        }),
        current.revision,
      );
    return result;
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
