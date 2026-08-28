import type { DataClassification, PayloadRef } from "./common.js";

export type HostFileOperationKind = "read" | "create" | "update" | "move" | "trash" | "restore";

export interface HostDirectoryGrant {
  readonly id: string;
  readonly revision: number;
  readonly hostId: string;
  readonly canonicalRootId: string;
  readonly displayPath: string;
  readonly operations: readonly HostFileOperationKind[];
  readonly dataClassification: DataClassification;
  readonly disclosure: "none" | "model" | "worker" | "external_approved";
  readonly pathPolicy: "same_filesystem_no_links";
  readonly mountPolicy: "fixed_device";
  readonly authorizationRef: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface HostFileIdentity {
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly linkCount: number;
  readonly sizeBytes: number;
  readonly modifiedAtMillis: number;
}

export interface PreparedFileOperation {
  readonly id: string;
  readonly revision: number;
  readonly grantId: string;
  readonly operation: "create" | "update" | "move" | "trash" | "restore";
  readonly relativePath: string;
  readonly targetIdentity: HostFileIdentity | null;
  readonly previousDigest: string | null;
  readonly candidatePayloadRef: PayloadRef | null;
  readonly candidateDigest: string | null;
  readonly redactedDiffRef: PayloadRef | null;
  readonly sizeBytes: number;
  readonly recoveryStrategy: "exclusive_create" | "verified_backup" | "controlled_trash";
  readonly canonicalHash: string;
  readonly expiresAt: string;
  readonly status: "prepared" | "executing" | "verified" | "invalidated" | "failed";
}

export interface HostTrashRecord {
  readonly id: string;
  readonly hostId: string;
  readonly grantId: string;
  readonly originalRelativePath: string;
  readonly trashRelativePath: string;
  readonly originalIdentity: HostFileIdentity;
  readonly digest: string;
  readonly trashedAt: string;
  readonly retentionObservation: string;
  readonly status: "trashed" | "restored" | "permanently_deleted";
}

export interface HostFilePlatformPort {
  inspectRoot(path: string): Promise<HostFileIdentity>;
  inspect(grant: HostDirectoryGrant, relativePath: string): Promise<HostFileIdentity | undefined>;
  read(grant: HostDirectoryGrant, relativePath: string, maximumBytes: number): Promise<Uint8Array>;
  createExclusive(
    grant: HostDirectoryGrant,
    relativePath: string,
    bytes: Uint8Array,
  ): Promise<HostFileIdentity>;
  replaceAtomic(
    grant: HostDirectoryGrant,
    relativePath: string,
    expected: HostFileIdentity,
    bytes: Uint8Array,
  ): Promise<HostFileIdentity>;
  trash(
    grant: HostDirectoryGrant,
    relativePath: string,
    expected: HostFileIdentity,
  ): Promise<{ readonly identity: HostFileIdentity; readonly trashRelativePath: string }>;
  restore(
    grant: HostDirectoryGrant,
    trashRelativePath: string,
    originalRelativePath: string,
  ): Promise<HostFileIdentity>;
}

export interface HostFileStatePort {
  saveGrant(
    grant: HostDirectoryGrant,
    expectedRevision: number | null,
  ): Promise<HostDirectoryGrant>;
  readGrant(grantId: string): Promise<HostDirectoryGrant | undefined>;
  savePrepared(
    operation: PreparedFileOperation,
    expectedRevision: number | null,
  ): Promise<PreparedFileOperation>;
  readPrepared(operationId: string): Promise<PreparedFileOperation | undefined>;
  saveTrash(record: HostTrashRecord): Promise<HostTrashRecord>;
  readTrash(recordId: string): Promise<HostTrashRecord | undefined>;
}

export interface HostFileDigestPort {
  digest(bytes: Uint8Array): string;
  digestCanonical(value: string): string;
}

export interface GovernedCodingOperationsPort {
  access(absolutePath: string, mode: "read" | "write"): Promise<void>;
  readFile(absolutePath: string): Promise<Uint8Array>;
  writeFile(absolutePath: string, content: string): Promise<void>;
  makeDirectory(absolutePath: string): Promise<void>;
  executeCommand(input: {
    readonly command: string;
    readonly cwd: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly onData: (data: Uint8Array) => void;
  }): Promise<{ readonly exitCode: number | null }>;
}
