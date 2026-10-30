import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type GatewayAuthenticationContext,
  type ThreadRepositoryPort,
  type ThreadSearchProjectionSource,
  type ThreadSearchProjectionSourcePort,
} from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import type { HttpGatewayPayloadReadPort } from "./http-gateway-server.js";
import type { ScopedThreadSearchTokenizer } from "./browser-thread-search.js";

interface ProjectorOptions {
  sources: ThreadSearchProjectionSourcePort;
  threads: Pick<ThreadRepositoryPort, "projectSearch" | "projectTitleSearch">;
  reader: HttpGatewayPayloadReadPort;
  tokenizer: ScopedThreadSearchTokenizer;
  onSourceSkipped?: (source: ThreadSearchProjectionSource, error: unknown) => void;
}

function isUnreadableSource(error: unknown): boolean {
  return (
    (error instanceof ApplicationPortError &&
      (error.code === PORT_ERROR_CODES.INVALID_OPERATION ||
        error.code === PORT_ERROR_CODES.NOT_FOUND)) ||
    (error instanceof Error && error.message === "THREAD_SEARCH_SOURCE_CLASSIFICATION_INVALID")
  );
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
        let text = "";
        try {
          const payload = await this.#options.reader.read({
            ...input,
            payloadRef: source.payloadRef,
          });
          if (payload.dataClassification !== source.dataClassification)
            throw new Error("THREAD_SEARCH_SOURCE_CLASSIFICATION_INVALID");
          text = payload.content;
        } catch (error) {
          if (!isUnreadableSource(error)) throw error;
          this.#options.onSourceSkipped?.(source, error);
        }
        const tokenRefs = await this.#options.tokenizer.tokenizeDocument({
          ...scope,
          text,
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

export class ThreadSearchBackgroundIndexer {
  readonly #synchronize: () => Promise<void>;
  readonly #onError: (error: unknown) => void;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: {
    readonly synchronize: () => Promise<void>;
    readonly onError: (error: unknown) => void;
    readonly intervalMs: number;
  }) {
    this.#synchronize = options.synchronize;
    this.#onError = options.onError;
    this.#intervalMs = options.intervalMs;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.kick(), this.#intervalMs);
    this.#timer.unref();
    this.kick();
  }

  kick(): void {
    this.#synchronize().catch(this.#onError);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
