import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type WorkspaceFileObservation,
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
  }): Promise<WorkspaceSnapshot> {
    const observed = await this.#dependencies.platform.snapshot(input);
    const previous = input.previousSnapshotId
      ? await this.#dependencies.state.readSnapshot(input.previousSnapshotId)
      : undefined;
    const previousFiles = new Map(previous?.files.map((file) => [file.path, file]));
    const files = observed.files.map((file): WorkspaceFileObservation => {
      const prior = previousFiles.get(file.path);
      if (!prior)
        return Object.freeze({ ...file, owner: file.state === "clean" ? "task" : "owner" });
      const changed =
        prior.indexDigest !== file.indexDigest || prior.worktreeDigest !== file.worktreeDigest;
      return Object.freeze({
        ...file,
        owner: changed && prior.owner !== "task" ? "concurrent_unowned" : prior.owner,
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

  assertTaskOwned(snapshot: WorkspaceSnapshot, paths: readonly string[]): void {
    const observations = new Map(snapshot.files.map((file) => [file.path, file]));
    const unsafe = paths.filter((path) => observations.get(path)?.owner !== "task");
    if (unsafe.length > 0)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        "Workspace change set overlaps Owner or concurrent changes",
        { paths: unsafe.join(",") },
      );
  }
}
