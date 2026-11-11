import type { JsonSchema } from "./schema.js";

export const CHAT_FORMAT_VERSION = "himawari.chat-export.v1" as const;
export const CHAT_MANIFEST_FILE = "manifest.json";
export const CHAT_THREADS_FILE = "data/threads.jsonl";
export const CHAT_THREAD_SCHEMA_FILE = "schema/threads.schema.json";
export const CHAT_INDEX_FILE = "CHATS.md";
export const CHAT_SEALED_FILE = "sealed/sealed.enc";

const CLASSIFICATIONS = ["public", "private", "sensitive", "restricted"] as const;
const text = (minLength = 0, maxLength = 100_000_000): JsonSchema => ({
  type: "string",
  minLength,
  maxLength,
});
const integer = (minimum = 0): JsonSchema => ({
  type: "integer",
  minimum,
  maximum: Number.MAX_SAFE_INTEGER,
});
const bool: JsonSchema = { type: "boolean" };
const nullable = (schema: JsonSchema): JsonSchema => ({
  ...schema,
  type: ["null", ...[schema.type ?? []].flat()],
  ...(schema.enum === undefined ? {} : { enum: [...schema.enum, null] }),
});
const enumOf = (values: readonly string[]): JsonSchema => ({ type: "string", enum: values });
const objectOf = (
  properties: { readonly [key: string]: JsonSchema },
  optional: readonly string[] = [],
): JsonSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  additionalProperties: false,
});
const timestamp: JsonSchema = text(20, 40);

const ATTACHMENT_SCHEMA = objectOf({
  name: text(0, 1024),
  bytes: integer(),
  kind: text(1, 32),
  truncated: bool,
});

const MESSAGE_SCHEMA = objectOf(
  {
    id: text(1, 128),
    sequence: integer(1),
    role: enumOf(["owner", "agent", "system"]),
    status: enumOf(["committed", "partial", "failed"]),
    classification: enumOf(CLASSIFICATIONS),
    committedAt: timestamp,
    text: text(),
    withheld: bool,
    attachments: { type: "array", items: ATTACHMENT_SCHEMA },
  },
  ["withheld"],
);

export const CHAT_THREAD_SCHEMA: JsonSchema = objectOf({
  id: text(1, 128),
  title: nullable(objectOf({ text: text(), withheld: bool }, ["withheld"])),
  titleSource: nullable(enumOf(["automatic", "owner"])),
  status: enumOf(["open", "trashed"]),
  answerLocale: enumOf(["zh-CN", "en", "ja"]),
  pinned: bool,
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: nullable(timestamp),
  trashedAt: nullable(timestamp),
  file: text(1, 256),
  messages: { type: "array", items: MESSAGE_SCHEMA },
});

const FILE_ENTRY_SCHEMA = objectOf({
  path: text(1, 256),
  role: enumOf(["data", "schema", "markdown", "sealed"]),
  bytes: integer(),
  lines: integer(),
  sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
});

export const CHAT_MANIFEST_SCHEMA: JsonSchema = objectOf({
  format: { type: "string", const: CHAT_FORMAT_VERSION },
  migrationSequence: integer(),
  exportedAt: timestamp,
  egressRuleset: integer(),
  files: { type: "array", items: FILE_ENTRY_SCHEMA },
  counts: objectOf({
    threads: integer(),
    messages: integer(),
    attachments: integer(),
    markdownThreads: integer(),
    sealedOriginals: integer(),
  }),
  withheld: objectOf({ texts: integer(), threads: integer(), messages: integer() }),
  omitted: {
    type: "array",
    items: objectOf({ what: text(1, 256), count: nullable(integer()), reason: text(1, 1024) }),
  },
});
