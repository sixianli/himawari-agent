import type { AgentId, OwnerId, ThreadId } from "@himawari-agent/domain";
import type { DataClassification } from "./common.js";
import type { MemoryIndexEmbedding } from "./memory-projection.js";

export interface ConversationTurn {
  readonly id: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly day: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly dataClassification: DataClassification;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly indexedAt: string;
}

export interface ConversationTurnDocument extends ConversationTurn {
  readonly terms: readonly string[];
  readonly embedding: MemoryIndexEmbedding | null;
}

export interface ConversationTurnCandidate {
  readonly turn: ConversationTurn;
  readonly signal: number;
}

export interface ConversationTurnSearchResult {
  readonly vector: readonly ConversationTurnCandidate[];
  readonly lexical: readonly ConversationTurnCandidate[];
}

export interface ConversationTurnWatermark {
  readonly threadId: ThreadId;
  readonly indexedFrom: number;
  readonly indexedThrough: number;
  readonly lastSequence: number;
}

export interface ConversationTurnStorePort {
  upsert(document: ConversationTurnDocument): Promise<void>;
  search(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly embedding: MemoryIndexEmbedding | null;
    readonly terms: readonly string[];
    readonly allowedClassifications: readonly DataClassification[];
    readonly from: string | null;
    readonly to: string | null;
    readonly excludeThreadId: ThreadId | null;
    readonly limit: number;
  }): Promise<ConversationTurnSearchResult>;
  listBehind(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly limit: number;
  }): Promise<readonly ConversationTurnWatermark[]>;
  listUnembedded(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly model: string;
    readonly dimensions: number;
    readonly classifications: readonly DataClassification[];
    readonly limit: number;
  }): Promise<readonly ConversationTurn[]>;
  attachEmbedding(input: {
    readonly turnId: string;
    readonly embedding: MemoryIndexEmbedding;
  }): Promise<void>;
}
