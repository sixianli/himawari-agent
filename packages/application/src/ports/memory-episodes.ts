import type { AgentId, OwnerId, ThreadId } from "@himawari-agent/domain";
import type { DataClassification, PayloadRef } from "./common.js";
import type { MemoryIndexEmbedding } from "./memory-projection.js";

export type MemoryEpisodeSource = "day_summary" | "compaction";

export interface MemoryEpisode {
  readonly id: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly day: string;
  readonly source: MemoryEpisodeSource;
  readonly contentRef: PayloadRef;
  readonly dataClassification: DataClassification;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly createdAt: string;
}

export interface MemoryEpisodeDocument extends MemoryEpisode {
  readonly terms: readonly string[];
  readonly embedding: MemoryIndexEmbedding | null;
}

export interface MemoryEpisodeCandidate {
  readonly episode: MemoryEpisode;
  readonly signal: number;
}

export interface MemoryEpisodeSearchResult {
  readonly vector: readonly MemoryEpisodeCandidate[];
  readonly lexical: readonly MemoryEpisodeCandidate[];
}

export interface MemoryEpisodeThreadWatermark {
  readonly threadId: ThreadId;
  readonly summarizedThrough: number;
  readonly lastSequence: number;
  readonly lastCommittedAt: string;
}

export interface MemoryEpisodeStorePort {
  upsert(document: MemoryEpisodeDocument): Promise<void>;
  search(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly embedding: MemoryIndexEmbedding | null;
    readonly terms: readonly string[];
    readonly allowedClassifications: readonly DataClassification[];
    readonly from: string | null;
    readonly to: string | null;
    readonly limit: number;
  }): Promise<MemoryEpisodeSearchResult>;
  listUnembedded(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly model: string;
    readonly dimensions: number;
    readonly after?: { readonly createdAt: string; readonly id: string };
    readonly limit: number;
  }): Promise<readonly MemoryEpisode[]>;
  attachEmbedding(input: {
    readonly episodeId: string;
    readonly embedding: MemoryIndexEmbedding;
  }): Promise<void>;
  listUnsummarized(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly activeSince?: string;
    readonly limit: number;
  }): Promise<readonly MemoryEpisodeThreadWatermark[]>;
  listDaySummaries(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly fromDay: string;
    readonly toDay: string;
    readonly allowedClassifications: readonly DataClassification[];
    readonly limit: number;
  }): Promise<readonly MemoryEpisode[]>;
  listDaySummariesAfter(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly after: MemoryEpisodePosition | null;
    readonly limit: number;
  }): Promise<readonly MemoryEpisode[]>;
}

export interface MemoryEpisodePosition {
  readonly createdAt: string;
  readonly episodeId: string;
}
