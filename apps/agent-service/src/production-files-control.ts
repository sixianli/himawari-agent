import {
  ApplicationPortError,
  type ClockPort,
  type GatewayV2QueryContext,
  PORT_ERROR_CODES,
  type ProductConfiguration,
  type ThreadArtifactStorePort,
} from "@himawari-agent/application";
import {
  ContractValidationError,
  type GatewayV2Query,
  type GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";

export const PRODUCTION_FILES_OPERATIONS = Object.freeze(["files.list.read"] as const);

export const FILE_CONTENT_PATH_PREFIX = "/api/files/v1/content/";

const displayText = (value: string, maximum = 256): string => {
  let text = "";
  for (const character of value.replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, "\uFFFD")) {
    if (text.length + character.length > maximum) break;
    text += character;
  }
  return text.length > 0 ? text : "\uFFFD";
};

export interface ProductionFilesControlOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly store: ThreadArtifactStorePort;
  readonly threadTitle: (threadId: string) => Promise<string | null>;
  readonly clock: ClockPort;
}

export class ProductionFilesControl {
  readonly #options: ProductionFilesControlOptions;

  constructor(options: ProductionFilesControlOptions) {
    this.#options = options;
  }

  async query(query: GatewayV2Query, context?: GatewayV2QueryContext): Promise<GatewayV2Snapshot> {
    if (query.type !== "files.list.read") throw new Error("FILES_OPERATION_NOT_INSTALLED");
    const { ownerId, agentId } = this.#options.configuration;
    if (
      context?.authentication?.ownerId !== ownerId ||
      query.scope.ownerId !== ownerId ||
      query.scope.agentId !== agentId
    )
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "FILES_SCOPE_MISMATCH");
    const page = await this.#options.store
      .list({
        ownerId,
        agentId,
        threadId: null,
        kind: query.payload.kind,
        origin: query.payload.origin,
        search: query.payload.search,
        before: query.payload.before,
        limit: query.payload.limit,
      })
      .catch((error: unknown) => {
        if (
          error instanceof ApplicationPortError &&
          error.code === PORT_ERROR_CODES.INVALID_OPERATION
        )
          throw new ContractValidationError("payload", "file list page is invalid");
        throw error;
      });
    const titles = new Map<string, string | null>();
    for (const threadId of new Set(page.items.map((artifact) => artifact.threadId))) {
      const title = await this.#options.threadTitle(threadId).catch(() => null);
      titles.set(threadId, title === null ? null : displayText(title));
    }
    return {
      ...query,
      kind: "snapshot",
      type: "files.list.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        files: page.items.map((artifact) => ({
          fileId: artifact.id,
          threadId: artifact.threadId,
          threadTitle: titles.get(artifact.threadId) ?? null,
          name: displayText(artifact.path.split("/").at(-1) || artifact.path),
          kind: artifact.kind,
          origin: artifact.source === "upload" ? "uploaded" : "generated",
          mediaType: displayText(artifact.mediaType, 128),
          sizeBytes: artifact.sizeBytes,
          version: artifact.version,
          createdAt: artifact.createdAt,
          deleted: artifact.deletedAt !== null,
          contentPath:
            artifact.copyRef === null
              ? null
              : `${FILE_CONTENT_PATH_PREFIX}${encodeURIComponent(artifact.id)}`,
        })),
        nextCursor: page.nextCursor,
        generatedAt: this.#options.clock.now(),
      },
    };
  }
}
