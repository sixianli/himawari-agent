import type { AgentId, OwnerId } from "@himawari-agent/domain";

export const THREAD_ARTIFACT_SOURCES = ["write", "edit", "bash", "upload"] as const;
export type ThreadArtifactSource = (typeof THREAD_ARTIFACT_SOURCES)[number];

export const THREAD_ARTIFACT_KINDS = [
  "document",
  "code",
  "web",
  "image",
  "pdf",
  "data",
  "other",
] as const;
export type ThreadArtifactKind = (typeof THREAD_ARTIFACT_KINDS)[number];

export const THREAD_ARTIFACT_ORIGINS = ["uploaded", "generated"] as const;
export type ThreadArtifactOrigin = (typeof THREAD_ARTIFACT_ORIGINS)[number];

export const THREAD_ARTIFACT_LIST_LIMIT = 200;

export interface ThreadArtifactScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface ThreadArtifact {
  readonly id: string;
  readonly threadId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly source: ThreadArtifactSource;
  readonly path: string;
  readonly kind: ThreadArtifactKind;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string | null;
  readonly version: number;
  readonly turn: number;
  readonly copyRef: string | null;
  readonly overlapped: boolean;
  readonly createdAt: string;
  readonly deletedAt: string | null;
}

export type ThreadArtifactRegistration = Omit<ThreadArtifact, "version" | "turn" | "deletedAt">;

export interface ThreadArtifactListQuery extends ThreadArtifactScope {
  readonly threadId: string | null;
  readonly kind: ThreadArtifactKind | null;
  readonly origin?: ThreadArtifactOrigin | null;
  readonly search: string | null;
  readonly before: string | null;
  readonly limit: number;
}

export interface ThreadArtifactPage {
  readonly items: readonly ThreadArtifact[];
  readonly nextCursor: string | null;
}

export interface ThreadArtifactStorePort {
  register(
    input: ThreadArtifactScope & { readonly artifact: ThreadArtifactRegistration },
  ): Promise<{ readonly artifact: ThreadArtifact; readonly created: boolean }>;
  latest(
    input: ThreadArtifactScope & { readonly threadId: string; readonly path: string },
  ): Promise<ThreadArtifact | null>;
  get(input: ThreadArtifactScope & { readonly id: string }): Promise<ThreadArtifact | null>;
  versions(
    input: ThreadArtifactScope & { readonly threadId: string; readonly path: string },
  ): Promise<readonly ThreadArtifact[]>;
  list(input: ThreadArtifactListQuery): Promise<ThreadArtifactPage>;
  markDeleted(
    input: ThreadArtifactScope & {
      readonly threadId: string;
      readonly paths: readonly string[];
      readonly deletedAt: string;
    },
  ): Promise<number>;
}
