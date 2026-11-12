import {
  type ClockPort,
  HOST_DIRECTORY_GRANT_STATE_PREFIX,
  type HostDirectoryGrant,
  hostDirectoryGrantStateKey,
  type ProductConfiguration,
  type StateRecord,
  type ThreadArtifactChangesPort,
} from "@himawari-agent/application";
import type { GatewayV2Query, GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
import { THREAD_ARTIFACT_SKIPPED_DIRECTORIES } from "./production-thread-artifacts.js";
import {
  workspaceIncompleteFolderKey,
  workspaceIncompleteThreadKey,
} from "./production-workspace-change-marks.js";

export const PRODUCTION_WORKSPACE_CHANGES_OPERATIONS = Object.freeze([
  "workspace.changes.read",
  "workspace.folders.read",
] as const);

export const WORKSPACE_FOLDER_LIST_LIMIT = 200;

export interface ProductionWorkspaceChangesControlOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId" | "runPolicy">;
  readonly changes: ThreadArtifactChangesPort;
  readonly readState: (key: string) => Promise<StateRecord | undefined>;
  readonly listState: (prefix: string, limit: number) => Promise<readonly StateRecord[]>;
  readonly displayPath: () => Promise<string | null>;
  readonly clock: ClockPort;
}

export class ProductionWorkspaceChangesControl {
  readonly #options: ProductionWorkspaceChangesControlOptions;

  constructor(options: ProductionWorkspaceChangesControlOptions) {
    this.#options = options;
  }

  async #folders(
    query: Extract<GatewayV2Query, { type: "workspace.folders.read" }>,
  ): Promise<GatewayV2Snapshot> {
    const now = this.#options.clock.now();
    const records = await this.#options.listState(
      HOST_DIRECTORY_GRANT_STATE_PREFIX,
      WORKSPACE_FOLDER_LIST_LIMIT + 1,
    );
    const folders = records.slice(0, WORKSPACE_FOLDER_LIST_LIMIT).flatMap((record) => {
      const grant = record.value as unknown as Partial<HostDirectoryGrant>;
      return typeof grant.id === "string" &&
        record.key === hostDirectoryGrantStateKey(grant.id) &&
        typeof grant.hostId === "string" &&
        typeof grant.displayPath === "string" &&
        typeof grant.expiresAt === "string" &&
        Array.isArray(grant.operations) &&
        (grant.revokedAt ?? null) === null &&
        Date.parse(grant.expiresAt) > Date.parse(now)
        ? [
            {
              grantId: grant.id,
              hostId: grant.hostId,
              displayPath: grant.displayPath,
              operations: [...grant.operations],
              expiresAt: grant.expiresAt,
            },
          ]
        : [];
    });
    return {
      ...query,
      kind: "snapshot",
      type: "workspace.folders.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        folders,
        truncated: records.length > WORKSPACE_FOLDER_LIST_LIMIT,
        generatedAt: now,
      },
    };
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type === "workspace.folders.read") return this.#folders(query);
    if (query.type !== "workspace.changes.read")
      throw new Error("WORKSPACE_CHANGES_OPERATION_NOT_INSTALLED");
    const { grantId, threadId, afterPath, limit } = query.payload;
    const { ownerId, agentId, runPolicy } = this.#options.configuration;
    const matched = runPolicy?.coding?.grantId === grantId;
    const page = matched
      ? await this.#options.changes.changedFiles({ ownerId, agentId, threadId, afterPath, limit })
      : { items: [], nextAfterPath: null, fileCount: 0 };
    const copy =
      matched && threadId !== null
        ? (await this.#options.readState(`workspace-copy-selection:${threadId}`))?.value[
            "workspaceRef"
          ]
        : null;
    const incomplete =
      matched &&
      (await this.#options.readState(
        threadId === null
          ? workspaceIncompleteFolderKey(grantId)
          : workspaceIncompleteThreadKey(grantId, threadId),
      )) !== undefined;
    return {
      ...query,
      kind: "snapshot",
      type: "workspace.changes.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        grantId,
        grantMatched: matched,
        displayPath: matched ? await this.#options.displayPath() : null,
        threadId,
        recording: typeof copy === "string" ? "copy" : "direct",
        fileCount: page.fileCount,
        incomplete,
        skippedDirectories: [...THREAD_ARTIFACT_SKIPPED_DIRECTORIES],
        items: page.items.map((item) => ({
          path: item.path,
          state: item.deletedAt === null ? "changed" : "deleted",
          source: item.source,
          threadId: item.threadId,
          versions: item.versions,
          changedAt: item.changedAt,
          deletedAt: item.deletedAt,
        })),
        nextAfterPath: page.nextAfterPath,
        generatedAt: this.#options.clock.now(),
      },
    };
  }
}
