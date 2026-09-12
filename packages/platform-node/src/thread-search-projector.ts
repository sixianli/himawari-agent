import type {
  GatewayAuthenticationContext,
  ThreadRepositoryPort,
  ThreadSearchProjectionSourcePort,
} from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import type { HttpGatewayPayloadReadPort } from "./http-gateway-server.js";
import type { ScopedThreadSearchTokenizer } from "./browser-thread-search.js";

/** Bring the rebuildable index up to date before a scoped search; never scan indexed bodies again. */
interface ProjectorOptions {
  sources: ThreadSearchProjectionSourcePort;
  threads: Pick<ThreadRepositoryPort, "projectSearch" | "projectTitleSearch">;
  reader: HttpGatewayPayloadReadPort;
  tokenizer: ScopedThreadSearchTokenizer;
}

export class ThreadSearchProjector {
  readonly #options: ProjectorOptions;
  readonly #inFlight = new Map<string, Promise<void>>();
  constructor(options: ProjectorOptions) {
    this.#options = options;
  }

  synchronize(input: {
    authentication: GatewayAuthenticationContext;
    agentId: string;
  }): Promise<void> {
    const key = JSON.stringify([input.authentication.ownerId, input.agentId]);
    const pending = this.#inFlight.get(key);
    if (pending) return pending;
    const work = this.#synchronize(input).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, work);
    return work;
  }

  async #synchronize(input: {
    authentication: GatewayAuthenticationContext;
    agentId: string;
  }): Promise<void> {
    const scope = {
      ownerId: createOwnerId(input.authentication.ownerId),
      agentId: createAgentId(input.agentId),
    };
    const projectionVersion = this.#options.tokenizer.projectionVersion;
    // Bound initial backfill. A later search continues from durable completed rows;
    // do not return a misleading empty/partial result while work remains.
    for (let batch = 0; batch < 64; batch++) {
      const sources = await this.#options.sources.pending({
        ...scope,
        projectionVersion,
        limit: 64,
      });
      if (sources.length === 0) return;
      for (const source of sources) {
        if (source.ownerId !== scope.ownerId || source.agentId !== scope.agentId)
          throw new Error("THREAD_SEARCH_SOURCE_SCOPE_INVALID");
        const payload = await this.#options.reader.read({
          ...input,
          payloadRef: source.payloadRef,
        });
        if (payload.dataClassification !== source.dataClassification)
          throw new Error("THREAD_SEARCH_SOURCE_CLASSIFICATION_INVALID");
        const tokenRefs = await this.#options.tokenizer.tokenizeDocument({
          ...scope,
          text: payload.content,
        });
        const common = {
          ...scope,
          threadId: source.threadId,
          dataClassification: source.dataClassification,
          projectionVersion,
          tokenRefs,
        };
        if (source.kind === "title")
          await this.#options.threads.projectTitleSearch({
            ...common,
            titleRevision: source.titleRevision,
          });
        else
          await this.#options.threads.projectSearch({
            ...common,
            messageId: source.messageId,
            sequence: source.sequence,
          });
      }
    }
    throw new Error("THREAD_SEARCH_INDEX_CATCHING_UP");
  }
}
