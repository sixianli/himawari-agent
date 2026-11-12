export { canonicalJson, sha256Hex } from "./canonical.js";
export {
  buildDemoPack,
  DEMO_PACK_ERROR_CODES,
  type DemoPackOptions,
  demoMemoryId,
  demoPersonId,
} from "./demo-pack.js";
export { type ReadLimits, readPortableDirectory, writePortableDirectory } from "./directory.js";
export { buildPortableExport, type ExportOptions, type ExportResult } from "./export.js";
export { type ImportOptions, type ImportReport, importPortableExport } from "./import.js";
export { foldText, MEMORY_ID_PATTERN } from "./markdown.js";
export { openReadOnlyDatabase } from "./read-only.js";
export { FORMAT_VERSION, MANIFEST_FILE, SEALED_FILE } from "./schemas.js";
export { SEAL_ERROR_CODES, SealError, sealJson, unsealJson } from "./seal.js";
export {
  DATA_EXPORT_ERROR_CODES,
  DataExportError,
  type ExportScope,
  type ExportTextPolicy,
  type PortableCounts,
  type PortableFiles,
  type PortableManifest,
  SHORT_TEXT_OMISSION_LABEL,
  WITHHELD_PLACEHOLDER,
} from "./types.js";
export {
  checkMarkdownMapping,
  type ParsedPortable,
  parsePortable,
  verifyIntegrity,
} from "./verify.js";
export {
  CHAT_EXPORT_TOO_LARGE,
  type ChatExportOptions,
  type ChatExportResult,
  type ChatManifest,
  buildChatExport,
} from "./chats.js";
export { verifyChatExport } from "./chats-verify.js";
export { CHAT_FORMAT_VERSION, CHAT_SEALED_FILE } from "./chat-schemas.js";
export { normalizeProposalText, proposalTextDigest } from "../external-proposal-text.js";
