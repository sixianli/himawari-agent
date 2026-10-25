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
      const vector = input.embedding
        ? scoped
            .filter((document) => document.embedding?.model === input.embedding?.model)
            .map((document) => {
              const left = document.embedding?.vector ?? new Float32Array();
              const right = input.embedding?.vector ?? new Float32Array();
              let dot = 0;
              for (let index = 0; index < left.length; index += 1)
                dot += (left[index] ?? 0) * (right[index] ?? 0);
              return candidate(document, dot);
            })
            .filter(({ signal }) => signal >= input.minimumSimilarity)
            .sort((left, right) => right.signal - left.signal)
            .slice(0, input.limit)
        : [];
      const terms = new Set(input.terms);
      const lexical = scoped
        .map((document) =>
          candidate(document, document.terms.filter((term) => terms.has(term)).length),
        )
        .filter(({ signal }) => signal > 0)
        .sort((left, right) => right.signal - left.signal)
        .slice(0, input.limit);
      return { vector, lexical, entity: [], vectorEngine: input.embedding ? "javascript" : "none" };
    },
    listUnindexed: async () => [],
  };
}
