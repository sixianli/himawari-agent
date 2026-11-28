import type { AgentId, MemoryGenerationId, MemoryId, OwnerId } from "@himawari-agent/domain";
import type { ProductMemoryRecord } from "./memory-projection.js";

export interface MemoryBookScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface MemorySourceMessage {
  readonly contentRef: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly sequence: number;
}

export interface MemorySettings {
  readonly capturePaused: boolean;
  readonly updatedAt: string | null;
  readonly lastViewedAt: string | null;
}

export interface MemoryProfilePin {
  readonly memoryId: MemoryId;
  readonly pinned: boolean;
  readonly updatedAt: string;
}

export interface MemoryPerson {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly relation: string | null;
  readonly reverseRelation: string | null;
  readonly links: readonly { readonly personId: string; readonly relation: string }[];
  readonly memoryIds: readonly MemoryId[];
  readonly updatedAt: string;
}

export interface MemoryPersonMention {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly relation: string | null;
  readonly reverseRelation: string | null;
  readonly personId: string | null;
  readonly maybeSameAs: string | null;
}

export interface MemoryPersonLinkMention {
  readonly from: string;
  readonly to: string;
  readonly relation: string;
  readonly reverseRelation: string | null;
}

export interface MemoryPersonSuggestion {
  readonly id: string;
  readonly personId: string;
  readonly candidateId: string;
  readonly createdAt: string;
}

export const MEMORY_IMPORT_SOURCES = ["codex", "assistant", "himawari"] as const;
export type MemoryImportSource = (typeof MEMORY_IMPORT_SOURCES)[number];

export interface MemoryImportBatch {
  readonly id: string;
  readonly source: MemoryImportSource;
  readonly itemCount: number;
  readonly createdAt: string;
  readonly undoneAt: string | null;
}

export interface MemorySubCategoryCount {
  readonly category: string;
  readonly subCategory: string;
  readonly count: number;
}

export interface MemoryBookStorePort {
  readSettings(scope: MemoryBookScope): Promise<MemorySettings>;
  writeSettings(
    input: MemoryBookScope & { readonly capturePaused: boolean; readonly updatedAt: string },
  ): Promise<void>;
  markViewed(input: MemoryBookScope & { readonly viewedAt: string }): Promise<void>;
  setProfilePin(
    input: MemoryBookScope & {
      readonly memoryId: MemoryId;
      readonly pinned: boolean;
      readonly updatedAt: string;
    },
  ): Promise<void>;
  listProfilePins(scope: MemoryBookScope): Promise<readonly MemoryProfilePin[]>;
  latestGeneration(scope: MemoryBookScope): Promise<MemoryGenerationId | undefined>;
  directGeneration(scope: MemoryBookScope): Promise<MemoryGenerationId>;
  listInactive(
    input: MemoryBookScope & { readonly trashedAfter: string; readonly limit: number },
  ): Promise<readonly ProductMemoryRecord[]>;
  listExpiredTrash(
    input: MemoryBookScope & { readonly trashedBefore: string; readonly limit: number },
  ): Promise<readonly MemoryId[]>;
  listSubCategories(scope: MemoryBookScope): Promise<readonly MemorySubCategoryCount[]>;
  recordPeople(
    input: MemoryBookScope & {
      readonly memoryId: MemoryId;
      readonly people: readonly MemoryPersonMention[];
      readonly links: readonly MemoryPersonLinkMention[];
      readonly now: string;
    },
  ): Promise<void>;
  listPeople(scope: MemoryBookScope): Promise<readonly MemoryPerson[]>;
  listPersonSuggestions(scope: MemoryBookScope): Promise<readonly MemoryPersonSuggestion[]>;
  decidePersonSuggestion(
    input: MemoryBookScope & { readonly id: string; readonly merge: boolean; readonly now: string },
  ): Promise<boolean>;
  createImportBatch(input: MemoryBookScope & MemoryImportBatch): Promise<void>;
  listImportBatches(
    input: MemoryBookScope & { readonly limit: number },
  ): Promise<readonly MemoryImportBatch[]>;
  markImportUndone(
    input: MemoryBookScope & { readonly id: string; readonly undoneAt: string },
  ): Promise<boolean>;
  findOwnerMessages(
    input: MemoryBookScope & {
      readonly lookups: readonly { readonly threadId: string; readonly refs: readonly string[] }[];
    },
  ): Promise<readonly MemorySourceMessage[]>;
}
