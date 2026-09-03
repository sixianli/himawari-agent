import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type WorkspaceFileObservation,
  type WorkspaceControlledWrite,
  type WorkspacePlatformPort,
  type WorkspaceSnapshot,
  type WorkspaceStatePort,
} from "../ports/index.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";

export class WorkspaceService {
  readonly #dependencies: {
    readonly platform: WorkspacePlatformPort;
    readonly state: WorkspaceStatePort;
    readonly clock: ClockPort;
    readonly ids: IdGeneratorPort;
  };

  constructor(dependencies: {
    readonly platform: WorkspacePlatformPort;
    readonly state: WorkspaceStatePort;
    readonly clock: ClockPort;
    readonly ids: IdGeneratorPort;
  }) {
    this.#dependencies = dependencies;
  }

  async snapshot(input: {
    readonly workspaceId: string;
    readonly hostId: string;
    readonly root: string;
    readonly previousSnapshotId?: string;
    readonly controlledWritePaths?: readonly string[];
    readonly controlledWrites?: readonly WorkspaceControlledWrite[];
    readonly treatNewUncontrolledAsConcurrent?: boolean;
  }): Promise<WorkspaceSnapshot> {
    const observed = await this.#dependencies.platform.snapshot(input);
    const previous = input.previousSnapshotId
      ? await this.#dependencies.state.readSnapshot(input.previousSnapshotId)
      : undefined;
    if (
      input.previousSnapshotId &&
      (!previous ||
        previous.workspaceId !== input.workspaceId ||
        previous.hostId !== input.hostId ||
        previous.rootIdentity !== observed.rootIdentity ||
        previous.head !== observed.head)
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        "Workspace baseline is missing or changed",
      );
    const previousFiles = new Map(previous?.files.map((file) => [file.path, file]));
    const controlledWritePaths = new Set(input.controlledWritePaths ?? []);
    const controlledWrites = new Map(
      (input.controlledWrites ?? []).map((write) => [write.path, write]),
    );
    const files = observed.files.map((file): WorkspaceFileObservation => {
      const prior = previousFiles.get(file.path);
      if (!previous) return Object.freeze({ ...file, owner: "owner" });
      const evidence = controlledWrites.get(file.path);
      const controlled =
        controlledWritePaths.has(file.path) &&
        evidence &&
        evidence.beforeDigest === (prior?.worktreeDigest ?? null) &&
        evidence.afterDigest === file.worktreeDigest &&
        file.indexDigest === (prior?.indexDigest ?? null);
      // A path that already held Owner changes stays Owner-owned, even after a controlled write.
      if (prior && prior.state !== "clean" && prior.owner === "owner")
        return Object.freeze({ ...file, owner: "owner" });
      if (controlled && (!prior || prior.state === "clean" || prior.owner === "task"))
        return Object.freeze({
          ...file,
          owner: "task",
          taskWrite: { ...evidence, beforeSnapshotId: previous.id },
        });
      const changed =
        !prior ||
        prior.indexDigest !== file.indexDigest ||
        prior.worktreeDigest !== file.worktreeDigest;
      return Object.freeze({
        ...file,
        owner: changed ? "concurrent_unowned" : prior.owner,
        ...(!changed && prior.taskWrite ? { taskWrite: prior.taskWrite } : {}),
      });
    });
    const snapshot: WorkspaceSnapshot = Object.freeze({
      ...observed,
      id: this.#dependencies.ids.next("workspace-snapshot"),
      revision: 1,
      files: Object.freeze(files),
      taskChangeSetRevision: (previous?.taskChangeSetRevision ?? 0) + 1,
      capturedAt: this.#dependencies.clock.now(),
    });
    return this.#dependencies.state.saveSnapshot(snapshot);
  }

  async reconcileControlledCommand(input: {
    readonly workspaceId: string;
    readonly hostId: string;
    readonly root: string;
    readonly previousSnapshotId: string;
    readonly expectedWritePaths: readonly string[];
    readonly controlledWrites: readonly WorkspaceControlledWrite[];
  }): Promise<WorkspaceSnapshot> {
    const expected = [...new Set(input.expectedWritePaths)].sort();
    if (expected.length === 0)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "A controlled command must freeze its expected write scope",
      );
    const before = await this.#dependencies.state.readSnapshot(input.previousSnapshotId);
    if (!before)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        "Previous workspace snapshot missing",
      );
    const beforeFiles = new Map(before.files.map((file) => [file.path, file]));
    const snapshot = await this.snapshot({
      workspaceId: input.workspaceId,
      hostId: input.hostId,
      root: input.root,
      previousSnapshotId: input.previousSnapshotId,
      controlledWritePaths: expected,
      controlledWrites: input.controlledWrites,
      treatNewUncontrolledAsConcurrent: true,
    });
    const expanded = snapshot.files
      .filter((file) => {
        const previous = beforeFiles.get(file.path);
        return (
          (file.owner !== "task" || !expected.includes(file.path)) &&
          (!previous ||
            previous.indexDigest !== file.indexDigest ||
            previous.worktreeDigest !== file.worktreeDigest)
        );
      })
      .map(({ path }) => path)
      .sort();
    if (expanded.length > 0)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        "Command changed paths outside its frozen scope",
        { snapshotId: snapshot.id, paths: expanded.join(",") },
      );
    return snapshot;
  }

  assertTaskOwned(snapshot: WorkspaceSnapshot, paths: readonly string[]): void {
    const observations = new Map(snapshot.files.map((file) => [file.path, file]));
    const unsafe = paths.filter((path) => {
      const file = observations.get(path);
      return (
        file?.owner !== "task" ||
        !file.taskWrite ||
        file.taskWrite.afterDigest !== file.worktreeDigest
      );
    });
    if (unsafe.length > 0)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        "Workspace change set overlaps Owner or concurrent changes",
        { paths: unsafe.join(",") },
      );
  }

  async stageTaskChanges(input: {
    readonly snapshotId: string;
    readonly paths: readonly string[];
  }): Promise<{
    readonly stagingRef: string;
    readonly indexTree: string;
    readonly stagedFiles: readonly string[];
  }> {
    const snapshot = await this.#dependencies.state.readSnapshot(input.snapshotId);
    if (!snapshot || snapshot.repositoryKind !== "git" || !snapshot.head)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "A Git workspace snapshot with a concrete HEAD is required",
      );
    const uniquePaths = [...new Set(input.paths)].sort();
    if (uniquePaths.length === 0)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "At least one task-owned path is required for staging",
      );
    this.assertTaskOwned(snapshot, uniquePaths);
    const observations = new Map(snapshot.files.map((file) => [file.path, file]));
    return this.#dependencies.platform.stageTaskChanges({
      workspaceId: snapshot.workspaceId,
      expectedHead: snapshot.head,
      files: uniquePaths.map((path) => {
        const observation = observations.get(path);
        if (!observation)
          throw new ApplicationPortError(
            PORT_ERROR_CODES.CONFLICT,
            "Task-owned path disappeared before staging",
            { path },
          );
        return observation;
      }),
    });
  }
}
