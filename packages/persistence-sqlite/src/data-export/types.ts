import type { PayloadProtectorPort } from "@himawari-agent/application";
import type { AgentId, OwnerId } from "@himawari-agent/domain";

export interface ExportTextPolicy {
  readonly rulesetVersion: number;
  hasSecret(text: string): boolean;
  mask(text: string): string;
}

export const WITHHELD_PLACEHOLDER = "[内容含机密，已扣留]";

export type PortableFiles = Map<string, Uint8Array>;

export interface PortableCounts {
  memories: number;
  memoryHistoryEvents: number;
  people: number;
  importBatches: number;
  pairedDevices: number;
  perceptionRecords: number;
  perceptionEpisodes: number;
  deviceMirrorItems: number;
  trackPoints: number;
  perceptionSettings: number;
  limitUsage: number;
  devicePolicies: number;
  deviceActions: number;
  consolidations: number;
  consolidationChanges: number;
  conversationReviews: number;
  conversationReviewChanges: number;
  decisions: number;
  decisionSignals: number;
  markdownMemories: number;
  rules: number;
  enforcedRules: number;
  externalProposals: number;
  ruleHistoryVersions: number;
  sealedOriginals: number;
  sealedEvidenceRows: number;
}

export interface PortableManifest {
  readonly format: string;
  readonly migrationSequence: number;
  readonly exportedAt: string;
  readonly egressRuleset: number;
  readonly files: readonly {
    readonly path: string;
    readonly role: "data" | "schema" | "markdown" | "sealed";
    readonly bytes: number;
    readonly lines: number;
    readonly sha256: string;
  }[];
  readonly counts: PortableCounts;
  readonly withheld: {
    readonly texts: number;
    readonly memories: number;
    readonly decisions: number;
    readonly rules: number;
  };
  readonly omitted: readonly {
    readonly what: string;
    readonly count: number | null;
    readonly reason: string;
  }[];
}

export interface ExportScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface PortableTextDependencies {
  readonly protector: PayloadProtectorPort;
}

export const DATA_EXPORT_ERROR_CODES = Object.freeze({
  EVIDENCE_REQUIRES_SEAL: "DATA_EXPORT_EVIDENCE_REQUIRES_SEAL",
  PAYLOAD_UNAVAILABLE: "DATA_EXPORT_PAYLOAD_UNAVAILABLE",
  SCHEMA_NOT_CURRENT: "DATA_EXPORT_SCHEMA_NOT_CURRENT",
  MANIFEST_INVALID: "DATA_IMPORT_MANIFEST_INVALID",
  FORMAT_UNSUPPORTED: "DATA_IMPORT_FORMAT_UNSUPPORTED",
  MIGRATION_MISMATCH: "DATA_IMPORT_MIGRATION_MISMATCH",
  FILE_LISTING_MISMATCH: "DATA_IMPORT_FILE_LISTING_MISMATCH",
  FILE_HASH_MISMATCH: "DATA_IMPORT_FILE_HASH_MISMATCH",
  FILE_COUNT_MISMATCH: "DATA_IMPORT_FILE_COUNT_MISMATCH",
  PATH_UNSAFE: "DATA_IMPORT_PATH_UNSAFE",
  LINE_INVALID: "DATA_IMPORT_LINE_INVALID",
  REFERENCE_BROKEN: "DATA_IMPORT_REFERENCE_BROKEN",
  TARGET_NOT_EMPTY: "DATA_IMPORT_TARGET_NOT_EMPTY",
  SEAL_REQUIRED_FOR_EVIDENCE: "DATA_IMPORT_SEAL_REQUIRED_FOR_EVIDENCE",
  SEAL_MISMATCH: "DATA_IMPORT_SEAL_MISMATCH",
} as const);

export type DataExportErrorCode =
  (typeof DATA_EXPORT_ERROR_CODES)[keyof typeof DATA_EXPORT_ERROR_CODES];

export class DataExportError extends Error {
  readonly code: DataExportErrorCode;
  readonly detail: string;
  constructor(code: DataExportErrorCode, detail = "") {
    super(detail === "" ? code : `${code}: ${detail}`);
    this.name = "DataExportError";
    this.code = code;
    this.detail = detail;
  }
}

export const SHORT_TEXT_OMISSION_LABEL =
  "含机密的实体名、人物名、别名、来源编号和决定记录里的短文字";
