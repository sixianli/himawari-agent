import type { AgentId, OwnerId } from "@himawari-agent/domain";
import type { JsonObject, PayloadRef } from "./common.js";

export interface HostWorkspaceProjectionRecord {
  readonly workspaceId: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly latestSnapshotId: string;
  readonly directoryGrantIds: readonly string[];
  readonly commandProfileRefs: readonly string[];
  readonly commandObservationRefs: readonly string[];
  readonly commitPreviewRef: string | null;
  readonly recoveryRefs: readonly string[];
  readonly revision: number;
}

export interface HostDirectoryProjectionRecord {
  readonly grantId: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly preparedOperationRefs: readonly string[];
  readonly trashRecordRefs: readonly string[];
  readonly recoveryRefs: readonly string[];
  readonly revision: number;
}

export interface HostWorkspaceProjectionPort {
  readWorkspace(workspaceId: string): Promise<HostWorkspaceProjectionRecord | undefined>;
  listWorkspaces(
    ownerId: OwnerId,
    agentId: AgentId,
  ): Promise<readonly HostWorkspaceProjectionRecord[]>;
  saveWorkspace(
    record: HostWorkspaceProjectionRecord,
    expectedRevision: number | null,
  ): Promise<HostWorkspaceProjectionRecord>;
  readDirectory(grantId: string): Promise<HostDirectoryProjectionRecord | undefined>;
  saveDirectory(
    record: HostDirectoryProjectionRecord,
    expectedRevision: number | null,
  ): Promise<HostDirectoryProjectionRecord>;
}

export interface HostWorkspaceGatewayPayloadPort {
  readBytes(ref: PayloadRef): Promise<Uint8Array>;
  readText(ref: PayloadRef): Promise<string>;
  protectJson(value: JsonObject): Promise<PayloadRef>;
}
