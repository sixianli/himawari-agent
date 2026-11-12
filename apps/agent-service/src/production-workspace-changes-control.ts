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
  workspaceChangeItemSchema,
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
export const WORKSPACE_FOLDER_SCAN_PAGES = 10;

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

  #warn(event: Record<string, unknown>): void {
    (this.#options.warn ?? ((entry) => console.error(JSON.stringify(entry))))(event);
  }

  #folder(record: StateRecord, now: string): WorkspaceFolder | null {
    const grant = record.value as unknown as Partial<HostDirectoryGrant>;
    try {
      if (
        typeof grant.id !== "string" ||
        record.key !== hostDirectoryGrantStateKey(grant.id) ||
        typeof grant.expiresAt !== "string" ||
        !Array.isArray(grant.operations) ||
        (grant.revokedAt !== null && typeof grant.revokedAt !== "string")
      )
        throw new Error("WORKSPACE_FOLDER_RECORD_INVALID");
      if (grant.revokedAt !== null) return null;
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
      this.#warn({
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
    let pages = 0;
    while (
      !exhausted &&
      folders.length <= WORKSPACE_FOLDER_LIST_LIMIT &&
      pages < WORKSPACE_FOLDER_SCAN_PAGES
    ) {
      pages += 1;
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
        truncated: folders.length > WORKSPACE_FOLDER_LIST_LIMIT || !exhausted,
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
    const now = this.#options.clock.now();
    const items = page.items.flatMap((item) => {
      try {
        return [
          workspaceChangeItemSchema.parse({
            path: item.path,
            state: item.deletedAt === null ? "changed" : "deleted",
            source: item.source,
            threadId: item.threadId,
            versions: item.versions,
            changedAt: item.changedAt,
            deletedAt: item.deletedAt,
          }),
        ];
      } catch (error) {
        this.#warn({
          event: "workspace.changes.item_skipped",
          threadId: item.threadId,
          code: error instanceof Error ? error.name : "WORKSPACE_CHANGE_ITEM_INVALID",
          at: now,
        });
        return [];
      }
    });
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
        incomplete: incomplete || items.length < page.items.length,
        skippedDirectories: [...THREAD_ARTIFACT_SKIPPED_DIRECTORIES],
        items,
        nextAfterPath:
          page.nextAfterPath === null || items.at(-1)?.path === page.nextAfterPath
            ? page.nextAfterPath
            : (items.at(-1)?.path ?? null),
        generatedAt: now,
      },
    };
  }
}
