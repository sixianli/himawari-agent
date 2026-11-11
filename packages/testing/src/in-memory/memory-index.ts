import type {
  MemoryIndexCandidate,
  MemoryIndexDocument,
  MemoryIndexStorePort,
} from "@himawari-agent/application";

export function inMemoryMemoryIndex(): MemoryIndexStorePort & {
  readonly documents: Map<string, MemoryIndexDocument>;
} {
  const documents = new Map<string, MemoryIndexDocument>();
  const candidate = (document: MemoryIndexDocument, signal: number): MemoryIndexCandidate => ({
    memoryId: document.memoryId,
    revision: document.revision,
    importancePermille: 500,
    confidencePermille: 1000,
    updatedAt: document.indexedAt,
    lastUsedAt: null,
    signal,
    startsAt: document.indexedAt,
    endsAt: null,
    current: true,
  });
  return {
    documents,
    upsert: async (document) => {
      documents.set(document.memoryId, document);
    },
    delete: async (memoryId) => {
      documents.delete(memoryId);
    },
    clearScope: async (ownerId, agentId) => {
      for (const [id, document] of documents)
        if (document.ownerId === ownerId && document.agentId === agentId) documents.delete(id);
    },
    search: async (input) => {
      const scoped = [...documents.values()].filter(
        (document) => document.ownerId === input.ownerId && document.agentId === input.agentId,
      );
      const similarity = (document: MemoryIndexDocument): number | undefined => {
        if (!input.embedding || document.embedding?.model !== input.embedding.model)
          return undefined;
        const left = document.embedding.vector;
        const right = input.embedding.vector;
        if (left.length !== right.length) return undefined;
        let dot = 0;
        let leftNorm = 0;
        let rightNorm = 0;
        for (let index = 0; index < left.length; index += 1) {
          const a = left[index] ?? 0;
          const b = right[index] ?? 0;
          dot += a * b;
          leftNorm += a * a;
          rightNorm += b * b;
        }
        return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
      };
      const withSimilarity = (
        document: MemoryIndexDocument,
        found: MemoryIndexCandidate,
      ): MemoryIndexCandidate => {
        const value = similarity(document);
        return value === undefined ? found : { ...found, similarity: value };
      };
      const vector = input.embedding
        ? scoped
            .filter((document) => similarity(document) !== undefined)
            .map((document) =>
              withSimilarity(document, candidate(document, similarity(document) ?? 0)),
            )
            .filter(({ signal }) => signal >= input.minimumSimilarity)
            .sort((left, right) => right.signal - left.signal)
            .slice(0, input.limit)
        : [];
      const terms = new Set(input.terms);
      const lexical = scoped
        .map((document) =>
          withSimilarity(
            document,
            candidate(document, document.terms.filter((term) => terms.has(term)).length),
          ),
        )
        .filter(({ signal }) => signal > 0)
        .sort((left, right) => right.signal - left.signal)
        .slice(0, input.limit);
      return { vector, lexical, entity: [], vectorEngine: input.embedding ? "javascript" : "none" };
    },
    listUnindexed: async () => [],
  };
}
