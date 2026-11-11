import {
  type AgentId,
  type DataClassification,
  modelVisibleClassifications,
  type OwnerId,
  type ProactiveRecentSummaries,
} from "@himawari-agent/application";
import type { MemoryEpisodeService } from "@himawari-agent/memory-engine";
import type { MailEmbeddingContext } from "./production-run-memory.js";

export interface ProactiveRecentSummariesOptions {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly episodes: Pick<
    MemoryEpisodeService,
    "dueSegments" | "summarize" | "recent" | "recentDays"
  >;
  readonly allowedClassifications: readonly DataClassification[];
  readonly capturePaused: () => Promise<boolean>;
  readonly embedForMailCheck: <T>(
    context: MailEmbeddingContext,
    operation: () => Promise<T>,
  ) => Promise<T>;
}

export function createProactiveRecentSummaries(
  options: ProactiveRecentSummariesOptions,
): ProactiveRecentSummaries {
  const scope = { ownerId: options.ownerId, agentId: options.agentId };
  const allowed = modelVisibleClassifications().filter((classification) =>
    options.allowedClassifications.includes(classification),
  );
  return Object.freeze<ProactiveRecentSummaries>({
    async catchUp({ days, limit, deadlineAt, signal, generate }) {
      if (await options.capturePaused()) return { generated: 0, costMicros: 0, failed: false };
      const { fromDay } = options.episodes.recentDays(days);
      const segments = (await options.episodes.dueSegments({ ...scope, limit: limit * 4 }))
        .filter(
          ({ day, dataClassification }) => day >= fromDay && allowed.includes(dataClassification),
        )
        .slice(0, limit);
      const context: MailEmbeddingContext = { deadlineAt, signal, costMicros: 0 };
      let generated = 0;
      for (const segment of segments) {
        if (signal.aborted) return { generated, costMicros: context.costMicros, failed: true };
        try {
          await options.embedForMailCheck(context, () =>
            options.episodes.summarize(segment, generate),
          );
          generated += 1;
        } catch {
          return { generated, costMicros: context.costMicros, failed: true };
        }
      }
      return { generated, costMicros: context.costMicros, failed: false };
    },
    async recent({ days, limit }) {
      const found = await options.episodes.recent({
        ...scope,
        days,
        limit,
        allowedClassifications: allowed,
      });
      return {
        partial: found.partial,
        summaries: found.summaries.map(({ episode, text }) => ({
          id: episode.id,
          day: episode.day,
          text,
          dataClassification: episode.dataClassification,
        })),
      };
    },
  });
}
