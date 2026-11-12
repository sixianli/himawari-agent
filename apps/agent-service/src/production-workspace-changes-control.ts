import {
  type ClockPort,
  HOST_DIRECTORY_GRANT_STATE_PREFIX,
  type HostDirectoryGrant,
  hostDirectoryGrantStateKey,
  type ProductConfiguration,
  type StateRecord,
  type ThreadArtifactChangesPort,
} from "@himawari-agent/application";
import {
  type GatewayV2Query,
  type GatewayV2Snapshot,
  workspaceFolderSchema,
} from "@himawari-agent/gateway-contracts";
import { THREAD_ARTIFACT_SKIPPED_DIRECTORIES } from "./production-thread-artifacts.js";
import {
  workspaceIncompleteFolderPrefix,
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
  readonly listState: (
    prefix: string,
    limit: number,
    afterKey: string | null,
  ) => Promise<readonly StateRecord[]>;
  readonly displayPath: () => Promise<string | null>;
  readonly clock: ClockPort;
  readonly warn?: (event: Record<string, unknown>) => void;
}

type WorkspaceFolder = Extract<
  GatewayV2Snapshot,
  { type: "workspace.folders.snapshot" }
>["payload"]["folders"][number];

export class ProductionWorkspaceChangesControl {
  readonly #options: ProductionWorkspaceChangesControlOptions;

  constructor(options: ProductionWorkspaceChangesControlOptions) {
    this.#options = options;
  }

  #folder(record: StateRecord, now: string): WorkspaceFolder | null {
    const grant = record.value as unknown as Partial<HostDirectoryGrant>;
    try {
      if (
        typeof grant.id !== "string" ||
        record.key !== hostDirectoryGrantStateKey(grant.id) ||
        typeof grant.expiresAt !== "string" ||
        !Array.isArray(grant.operations)
      )
        throw new Error("WORKSPACE_FOLDER_RECORD_INVALID");
      if ((grant.revokedAt ?? null) !== null) return null;
      const expiresAt = new Date(grant.expiresAt).toISOString();
      if (expiresAt <= new Date(now).toISOString()) return null;
      return workspaceFolderSchema.parse({
        grantId: grant.id,
        hostId: grant.hostId,
        displayPath: grant.displayPath,
        operations: [...grant.operations],
        expiresAt,
      });
    } catch (error) {
      (this.#options.warn ?? ((event) => console.error(JSON.stringify(event))))({
        event: "workspace.folders.record_skipped",
        key: record.key,
        code: error instanceof Error ? error.name : "WORKSPACE_FOLDER_RECORD_INVALID",
        at: now,
      });
      return null;
    }
  }

  async #folders(
    query: Extract<GatewayV2Query, { type: "workspace.folders.read" }>,
  ): Promise<GatewayV2Snapshot> {
    const now = this.#options.clock.now();
    const folders: WorkspaceFolder[] = [];
    let afterKey: string | null = null;
    let exhausted = false;
    while (!exhausted && folders.length <= WORKSPACE_FOLDER_LIST_LIMIT) {
      const records: readonly StateRecord[] = await this.#options.listState(
        HOST_DIRECTORY_GRANT_STATE_PREFIX,
        WORKSPACE_FOLDER_LIST_LIMIT + 1,
        afterKey,
      );
      for (const record of records) {
        const folder = this.#folder(record, now);
        if (folder) folders.push(folder);
      }
      afterKey = records.at(-1)?.key ?? null;
      exhausted = records.length <= WORKSPACE_FOLDER_LIST_LIMIT;
    }
    return {
      ...query,
      kind: "snapshot",
      type: "workspace.folders.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        folders: folders.slice(0, WORKSPACE_FOLDER_LIST_LIMIT),
        truncated: folders.length > WORKSPACE_FOLDER_LIST_LIMIT,
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
      (threadId === null
        ? (await this.#options.listState(workspaceIncompleteFolderPrefix(grantId), 1, null))
            .length > 0
        : (await this.#options.readState(workspaceIncompleteThreadKey(grantId, threadId))) !==
          undefined);
    const displayPath = matched ? await this.#options.displayPath() : null;
    return {
      ...query,
      kind: "snapshot",
      type: "workspace.changes.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        grantId,
        grantMatched: matched,
        grantActive: displayPath !== null,
        displayPath,
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
