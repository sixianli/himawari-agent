import { createHash } from "node:crypto";
import {
  type ContextConversationRecall,
  type ContextConversationRecallPort,
  type ContextConversationRecallRequest,
  modelVisibleClassifications,
  type PayloadProtectorPort,
  type PayloadStorePort,
} from "@himawari-agent/application";
import {
  type ConversationTurnService,
  conversationRecallText,
  type EmbedWithin,
  type RelevanceTuning,
} from "@himawari-agent/memory-engine";
import type { RunEmbeddingContext } from "./production-run-memory.js";

export const CONVERSATION_RECALL_EMBEDDING_SLOT = "context-conversation-recall:v1";

export interface ProductionConversationRecallOptions {
  readonly turns: Pick<ConversationTurnService, "recall">;
  readonly payloads: Pick<PayloadStorePort, "get" | "put">;
  readonly protector: PayloadProtectorPort;
  readonly embedWithin: <T>(
    context: RunEmbeddingContext,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly maximumCharacters: number;
  readonly providerRequestMs: number;
  readonly relevance?: RelevanceTuning;
  readonly timeZone?: string;
  readonly now: () => string;
  readonly onFailure?: (error: unknown) => void;
}

export class ProductionConversationRecall implements ContextConversationRecallPort {
  readonly #options: ProductionConversationRecallOptions;

  constructor(options: ProductionConversationRecallOptions) {
    this.#options = options;
  }

  async recall(
    request: ContextConversationRecallRequest,
  ): Promise<ContextConversationRecall | undefined> {
    try {
      return await this.#recall(request);
    } catch (error) {
      if (request.signal?.aborted) throw error;
      this.#options.onFailure?.(error);
      return undefined;
    }
  }

  async #recall(
    request: ContextConversationRecallRequest,
  ): Promise<ContextConversationRecall | undefined> {
    const executionLease = request.executionLease;
    if (!executionLease) return undefined;
    const query = await this.#text(request);
    if (!query?.trim()) return undefined;
    const deadlineAt =
      request.deadlineAt ??
      new Date(Date.parse(this.#options.now()) + this.#options.providerRequestMs).toISOString();
    let embeddingFailed = false;
    const within: EmbedWithin = async (_classification, operation) => {
      try {
        return await this.#options.embedWithin(
          {
            ownerId: request.ownerId,
            agentId: request.agentId,
            runId: request.runId,
            executionLease,
            deadlineAt,
            dataClassification: request.dataClassification,
            ...(request.signal ? { signal: request.signal } : {}),
            slot: CONVERSATION_RECALL_EMBEDDING_SLOT,
            skipWhenSlow: true,
          },
          operation,
        );
      } catch (error) {
        embeddingFailed = true;
        throw error;
      }
    };
    const hits = await this.#options.turns.recall({
      ownerId: request.ownerId,
      agentId: request.agentId,
      query,
      excludeThreadId: request.threadId,
      excludeEndedFrom: request.threadInContextSince,
      allowedClassifications: modelVisibleClassifications(),
      maximumCharacters: this.#options.maximumCharacters,
      ...(this.#options.relevance ? { relevance: this.#options.relevance } : {}),
      within,
    });
    request.signal?.throwIfAborted();
    if (embeddingFailed) return undefined;
    const shown = conversationRecallText(hits, {
      maximumCharacters: this.#options.maximumCharacters,
      ...(this.#options.timeZone ? { timeZone: this.#options.timeZone } : {}),
    });
    if (!shown) return undefined;
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          "conversation-recall",
          request.ownerId,
          request.agentId,
          shown.dataClassification,
          shown.text,
        ]),
      )
      .digest("hex");
    const payloadRef = `conversation-recall:${digest}`;
    if (!(await this.#options.payloads.get(payloadRef)))
      await this.#options.payloads.put(
        await this.#options.protector.protect({
          ownerId: request.ownerId,
          agentId: request.agentId,
          ref: payloadRef,
          contentType: "text/plain",
          dataClassification: shown.dataClassification,
          plaintext: new TextEncoder().encode(shown.text),
          createdAt: this.#options.now(),
        }),
      );
    return Object.freeze({
      payloadRef,
      dataClassification: shown.dataClassification,
      turns: shown.turns,
    });
  }

  async #text(request: ContextConversationRecallRequest): Promise<string | undefined> {
    const payload = await this.#options.payloads.get(request.queryRef);
    if (
      !payload ||
      !payload.contentType.startsWith("text/") ||
      payload.dataClassification !== request.dataClassification
    )
      return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await this.#options.protector.unprotect({
        ownerId: request.ownerId,
        agentId: request.agentId,
        payload,
      }),
    );
  }
}
