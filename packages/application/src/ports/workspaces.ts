import type { PayloadRef } from "./common.js";

export interface WorkspaceFileObservation {
  readonly path: string;
  readonly indexDigest: string | null;
  readonly worktreeDigest: string | null;
  readonly state: "clean" | "staged" | "unstaged" | "staged_and_unstaged" | "untracked";
  readonly owner: "owner" | "task" | "concurrent_unowned";
  readonly hunkFingerprints: readonly string[];
}

export interface WorkspaceSnapshot {
  readonly id: string;
  readonly revision: number;
  readonly workspaceId: string;
  readonly hostId: string;
  readonly rootIdentity: string;
  readonly repositoryKind: "git" | "non_git";
  readonly branch: string | null;
  readonly head: string | null;
  readonly upstreamObservation: string | null;
  readonly detached: boolean;
  readonly unborn: boolean;
  readonly files: readonly WorkspaceFileObservation[];
  readonly submoduleRefs: readonly string[];
  readonly worktreeRefs: readonly string[];
  readonly nestedRepositoryRefs: readonly string[];
  readonly taskChangeSetRevision: number;
  readonly capturedAt: string;
}

export interface CommandProfile {
  readonly id: string;
  readonly revision: number;
  readonly workspaceId: string;
  readonly argvPattern: readonly string[];
  readonly workdir: string;
  readonly environmentNames: readonly string[];
  readonly fileScopes: readonly string[];
  readonly network: "none" | "declared";
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly scriptDigest: string | null;
  readonly scriptSource: string | null;
  readonly authorizationRef: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface CommandObservation {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdoutRef: PayloadRef;
  readonly stderrRef: PayloadRef;
  readonly fileObservationRefs: readonly string[];
  readonly networkObservationRefs: readonly string[];
}

export interface CommitPreview {
  readonly id: string;
  readonly revision: number;
  readonly workspaceId: string;
  readonly taskChangeSetRevision: number;
  readonly branch: string | null;
  readonly head: string;
  readonly indexTree: string;
  readonly stagedDiffRef: PayloadRef;
  readonly stagedDiffDigest: string;
  readonly stagedFiles: readonly string[];
  readonly validationResultRefs: readonly string[];
  readonly message: string;
  readonly remainingDirtyRefs: readonly string[];
  readonly hooksDigest: string;
  readonly configurationDigest: string;
  readonly canonicalHash: string;
  readonly expiresAt: string;
  readonly status: "prepared" | "committing" | "confirmed_succeeded" | "unknown" | "invalidated";
}

export interface CommitExecutionHandle {
  readonly ref: string;
  readonly previewId: string;
  readonly previewHash: string;
  readonly operationId: string;
  readonly recentAuthenticationRef: string;
  readonly authorityFence: number;
  readonly expiresAt: string;
  readonly maxUses: 1;
}

export interface WorkspacePlatformPort {
  snapshot(input: {
    readonly workspaceId: string;
    readonly hostId: string;
    readonly root: string;
  }): Promise<Omit<WorkspaceSnapshot, "id" | "revision" | "taskChangeSetRevision" | "capturedAt">>;
  inspectCommitState(workspaceId: string): Promise<{
    readonly branch: string | null;
    readonly head: string;
    readonly indexTree: string;
    readonly stagedDiffRef: PayloadRef;
    readonly stagedDiffDigest: string;
    readonly stagedFiles: readonly string[];
    readonly remainingDirtyRefs: readonly string[];
    readonly hooksDigest: string;
    readonly configurationDigest: string;
  }>;
  commit(input: {
    readonly workspaceId: string;
    readonly message: string;
    readonly operationId: string;
  }): Promise<{
    readonly commit: string;
    readonly parent: string;
    readonly remainingDirtyRefs: readonly string[];
  }>;
  reconcileCommit(input: {
    readonly workspaceId: string;
    readonly expectedParent: string;
    readonly operationId: string;
  }): Promise<{ readonly commit: string | null; readonly parent: string | null }>;
}

export interface WorkspaceStatePort {
  saveSnapshot(snapshot: WorkspaceSnapshot): Promise<WorkspaceSnapshot>;
  readSnapshot(snapshotId: string): Promise<WorkspaceSnapshot | undefined>;
  saveCommitPreview(
    preview: CommitPreview,
    expectedRevision: number | null,
  ): Promise<CommitPreview>;
  readCommitPreview(previewId: string): Promise<CommitPreview | undefined>;
  readCommitOperation(
    operationId: string,
  ): Promise<{ readonly previewId: string; readonly resultRef: string | null } | undefined>;
  createCommitOperation(input: {
    readonly operationId: string;
    readonly previewId: string;
  }): Promise<{ readonly replayed: boolean; readonly resultRef: string | null }>;
  finishCommitOperation(input: {
    readonly operationId: string;
    readonly resultRef: string;
  }): Promise<void>;
}
