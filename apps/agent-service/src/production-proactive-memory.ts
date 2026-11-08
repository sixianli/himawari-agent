import type {
  AgentId,
  DurableMemoryService,
  MemoryContentPort,
  OwnerId,
  ProactiveMemoryHit,
  ProactiveMemoryRecall,
} from "@himawari-agent/application";
import type { MailEmbeddingContext } from "./production-run-memory.js";

export interface ProactiveMemoryRecallOptions {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly memory: Pick<DurableMemoryService, "search">;
  readonly content: Pick<MemoryContentPort, "readText">;
  readonly embedForMailCheck: <T>(
    context: MailEmbeddingContext,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly minimumSimilarity: number;
  readonly hitsPerMail: number;
  readonly concurrency: number;
}

export function createProactiveMemoryRecall(
  options: ProactiveMemoryRecallOptions,
): ProactiveMemoryRecall {
  return {
    async recall({ queries, deadlineAt, signal }) {
      const context: MailEmbeddingContext = { deadlineAt, signal, costMicros: 0 };
      const hits = new Map<string, readonly ProactiveMemoryHit[]>();
      let failedQueries = 0;
      let next = 0;
      const worker = async () => {
        while (next < queries.length && !signal.aborted) {
          const query = queries[next++];
          if (!query) break;
          try {
            const found = await options.embedForMailCheck(context, () =>
              options.memory.search({
                ownerId: options.ownerId,
                agentId: options.agentId,
                queryRef: "",
                queryText: query.query,
                minimumSimilarity: options.minimumSimilarity,
                recordUse: false,
                includeTentative: true,
                excludeCategories: ["rule"],
                policy: {
                  limit: options.hitsPerMail,
                  allowedClassifications: ["public", "private"],
                },
              }),
            );
            const texts: ProactiveMemoryHit[] = [];
            for (const { memory, score } of found)
              texts.push({
                id: memory.id,
                text: await options.content.readText(memory.contentRef),
                score,
                ...(memory.attributes?.tentative === true ? { tentative: true } : {}),
              });
            if (texts.length > 0) hits.set(query.messageId, texts);
          } catch {
            failedQueries += 1;
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(options.concurrency, queries.length) }, worker),
      );
      return { hits, costMicros: context.costMicros, failedQueries };
    },
  };
}
