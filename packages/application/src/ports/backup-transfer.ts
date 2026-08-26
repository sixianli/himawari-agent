import type {
  AgentId,
  BackupId,
  DeploymentId,
  OwnerId,
  RecoveryPointState,
  TransferId,
  TransferState,
} from "@himawari-agent/domain";

export interface RecoveryPointManifest {
  readonly backupId: BackupId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly deploymentId: DeploymentId;
  readonly schemaVersion: string;
  readonly authorityEpoch: number;
  readonly manifestRef: string;
  readonly digest: string;
  readonly verifiedAt: string;
}

export interface RecoveryPointPort {
  create(state: RecoveryPointState): Promise<RecoveryPointManifest>;
  verify(backupId: BackupId): Promise<RecoveryPointManifest>;
  restoreToTemporary(backupId: BackupId, targetDirectory: string): Promise<RecoveryPointManifest>;
}

export interface TransferManifest {
  readonly transferId: TransferId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly sourceDeploymentId: DeploymentId;
  readonly authorityEpoch: number;
  readonly schemaVersion: string;
  readonly adapterVersions: readonly string[];
  readonly fileDigests: readonly string[];
  readonly excludedSecretRefs: readonly string[];
  readonly packageRef: string;
}

export interface AuthorityTransferPort {
  export(transfer: TransferState): Promise<TransferManifest>;
  inspect(packageRef: string): Promise<TransferManifest>;
  importToTemporary(
    manifest: TransferManifest,
    targetDirectory: string,
  ): Promise<{ readonly state: TransferState; readonly verificationRef: string }>;
  activate(transferId: TransferId, expectedAuthorityEpoch: number): Promise<TransferState>;
}
