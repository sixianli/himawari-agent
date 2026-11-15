import type { AgentId, OwnerId } from "@himawari-agent/domain";
import type { McpConnectionEntry, McpConnectionPushPolicy } from "./mcp-connections.js";

export const MCP_SYNC_RESERVED_PROJECT_ID = "proj-none";
export const MCP_SYNC_PROJECT_ID_PREFIX = "proj-";

export const MCP_SYNC_KINDS = ["owner", "project_note"] as const;
export type McpSyncKind = (typeof MCP_SYNC_KINDS)[number];

export const MCP_SYNC_CLASSIFICATIONS = ["private", "sensitive"] as const;
export type McpSyncClassification = (typeof MCP_SYNC_CLASSIFICATIONS)[number];

export const MCP_SYNC_ITEM_STATUSES = [
  "pending",
  "saved",
  "unchanged",
  "updated",
  "declined_before",
  "owner_deleted",
  "awaiting_project_approval",
] as const;
export type McpSyncItemStatus = (typeof MCP_SYNC_ITEM_STATUSES)[number];

export const MCP_SYNC_DELETE_STATUSES = [
  "deleted",
  "version_mismatch",
  "awaiting_owner",
  "not_accepted",
] as const;
export type McpSyncDeleteStatus = (typeof MCP_SYNC_DELETE_STATUSES)[number];

export const MCP_SYNC_LIMIT_NAMES = [
  "stable_id_chars",
  "project_name_chars",
  "owner_text_chars",
  "note_text_chars",
  "batch_entries",
  "batch_deletes",
  "delete_brake_permille",
] as const;
export type McpSyncLimitName = (typeof MCP_SYNC_LIMIT_NAMES)[number];

export const MCP_SYNC_LIMIT_DEFAULTS: Readonly<Record<McpSyncLimitName, number>> = Object.freeze({
  stable_id_chars: 512,
  project_name_chars: 256,
  owner_text_chars: 2000,
  note_text_chars: 20_000,
  batch_entries: 50,
  batch_deletes: 200,
  delete_brake_permille: 500,
});

export const MCP_SYNC_LIMIT_CEILINGS: Readonly<Record<McpSyncLimitName, number>> = Object.freeze({
  stable_id_chars: 1024,
  project_name_chars: 256,
  owner_text_chars: 2000,
  note_text_chars: 60_000,
  batch_entries: 200,
  batch_deletes: 1000,
  delete_brake_permille: 1000,
});

export type McpSyncLimits = Readonly<Record<McpSyncLimitName, number>>;

export interface McpSyncScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface McpSyncPushItem {
  readonly index: number;
  readonly projectName: string | null;
  readonly stableId: string;
  readonly kind: McpSyncKind;
  readonly category: string;
  readonly classification: McpSyncClassification;
  readonly textSha256: string;
  readonly contentRef: string;
  readonly proposalContentRef: string | null;
  readonly proposalId: string;
}

export interface McpSyncPushDelete {
  readonly index: number;
  readonly projectName: string | null;
  readonly stableId: string;
  readonly versionTag: string;
}

export interface McpSyncPushInput extends McpSyncScope {
  readonly connectionId: string;
  readonly entry: McpConnectionEntry;
  readonly pushPolicy: McpConnectionPushPolicy;
  readonly now: string;
  readonly day: string;
  readonly brakePermille: number;
  readonly items: readonly McpSyncPushItem[];
  readonly deletes: readonly McpSyncPushDelete[];
}

export interface McpSyncItemResult {
  readonly index: number;
  readonly status: McpSyncItemStatus;
  readonly versionTag: string;
  readonly entryId: string;
  readonly projectId: string;
}

export interface McpSyncDeleteResult {
  readonly index: number;
  readonly status: McpSyncDeleteStatus;
}

export interface McpSyncPushResult {
  readonly items: readonly McpSyncItemResult[];
  readonly deletes: readonly McpSyncDeleteResult[];
}

export interface McpProjectNote {
  readonly entryId: string;
  readonly stableId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly connectionName: string;
  readonly category: string;
  readonly classification: McpSyncClassification;
  readonly contentRef: string;
  readonly version: number;
  readonly lastSyncedAt: string;
}

export interface McpMemorySyncStorePort {
  push(input: McpSyncPushInput): Promise<McpSyncPushResult>;
  limits(scope: McpSyncScope): Promise<McpSyncLimits>;
  projectNotes(
    input: McpSyncScope & {
      readonly projectName: string;
      readonly maxClassification: McpSyncClassification;
      readonly limit: number;
    },
  ): Promise<{ readonly found: boolean; readonly notes: readonly McpProjectNote[] }>;
  replacedMemory(input: McpSyncScope & { readonly proposalId: string }): Promise<string | null>;
}
