import { sha256Hex } from "./canonical.js";
import type { ChatManifest } from "./chats.js";
import {
  CHAT_FORMAT_VERSION,
  CHAT_INDEX_FILE,
  CHAT_MANIFEST_FILE,
  CHAT_MANIFEST_SCHEMA,
  CHAT_SEALED_FILE,
  CHAT_THREAD_SCHEMA,
  CHAT_THREAD_SCHEMA_FILE,
  CHAT_THREADS_FILE,
} from "./chat-schemas.js";
import { validateAgainst } from "./schema.js";
import { DATA_EXPORT_ERROR_CODES, DataExportError, type PortableFiles } from "./types.js";
import { assertSafePath } from "./verify.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
const failure = (code: keyof typeof DATA_EXPORT_ERROR_CODES, detail: string): DataExportError =>
  new DataExportError(DATA_EXPORT_ERROR_CODES[code], detail);

export function verifyChatExport(files: PortableFiles, migrationSequence: number): ChatManifest {
  const bytes = files.get(CHAT_MANIFEST_FILE);
  if (bytes === undefined) throw failure("MANIFEST_INVALID", "缺少清单");
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw failure("MANIFEST_INVALID", "清单不是有效的 JSON");
  }
  const format = (value as { format?: unknown } | null)?.format;
  if (typeof value === "object" && value !== null && format !== CHAT_FORMAT_VERSION)
    throw failure("FORMAT_UNSUPPORTED", String(format));
  const problem = validateAgainst(CHAT_MANIFEST_SCHEMA, value);
  if (problem !== null) throw failure("MANIFEST_INVALID", problem);
  const manifest = value as ChatManifest;
  if (manifest.migrationSequence > migrationSequence)
    throw failure("MIGRATION_MISMATCH", String(manifest.migrationSequence));
  const listed = new Set(manifest.files.map((entry) => entry.path));
  const actual = [...files.keys()].filter((path) => path !== CHAT_MANIFEST_FILE);
  if (listed.size !== manifest.files.length || actual.length !== listed.size)
    throw failure("FILE_LISTING_MISMATCH", "清单和实际文件不一致");
  for (const entry of manifest.files) {
    assertSafePath(entry.path);
    const content = files.get(entry.path);
    if (content === undefined) throw failure("FILE_LISTING_MISMATCH", entry.path);
    if (content.byteLength !== entry.bytes || sha256Hex(content) !== entry.sha256)
      throw failure("FILE_HASH_MISMATCH", entry.path);
  }

  for (const required of [CHAT_THREADS_FILE, CHAT_THREAD_SCHEMA_FILE, CHAT_INDEX_FILE])
    if (!listed.has(required)) throw failure("FILE_LISTING_MISMATCH", `缺少 ${required}`);
  const data = files.get(CHAT_THREADS_FILE);
  if (data === undefined) throw failure("FILE_LISTING_MISMATCH", CHAT_THREADS_FILE);
  let raw: string;
  try {
    raw = decoder.decode(data);
  } catch {
    throw failure("LINE_INVALID", "threads.jsonl 不是有效的 UTF-8");
  }
  const rows = raw === "" ? [] : raw.replace(/\n$/u, "").split("\n");
  if (raw !== "" && !raw.endsWith("\n")) throw failure("LINE_INVALID", "最后一行缺少换行");
  const threadIds = new Set<string>();
  const messageIds = new Set<string>();
  const markdown = new Set<string>();
  let messages = 0;
  let attachments = 0;
  let withheldMessages = 0;
  let withheldTexts = 0;
  const withheldThreadIds = new Set<string>();
  rows.forEach((line, index) => {
    let thread: unknown;
    try {
      thread = JSON.parse(line);
    } catch {
      throw failure("LINE_INVALID", `${CHAT_THREADS_FILE}:${index + 1}`);
    }
    const bad = validateAgainst(CHAT_THREAD_SCHEMA, thread);
    if (bad !== null) throw failure("LINE_INVALID", `${CHAT_THREADS_FILE}:${index + 1} ${bad}`);
    const row = thread as {
      id: string;
      file: string;
      title: { withheld?: boolean } | null;
      messages: { id: string; sequence: number; withheld?: boolean; attachments: unknown[] }[];
    };
    if (threadIds.has(row.id)) throw failure("REFERENCE_BROKEN", `重复的对话 ${row.id}`);
    threadIds.add(row.id);
    assertSafePath(row.file);
    if (!row.file.startsWith("chats/") || !row.file.endsWith(".md"))
      throw failure("REFERENCE_BROKEN", `对话 ${row.id} 的 Markdown 路径 ${row.file}`);
    if (row.title?.withheld === true) {
      withheldTexts += 1;
      withheldThreadIds.add(row.id);
    }
    if (!files.has(row.file) || markdown.has(row.file))
      throw failure("REFERENCE_BROKEN", `对话 ${row.id} 的 Markdown ${row.file}`);
    markdown.add(row.file);
    let previous = 0;
    for (const message of row.messages) {
      if (message.sequence <= previous || messageIds.has(message.id))
        throw failure("REFERENCE_BROKEN", `对话 ${row.id} 的消息顺序或编号`);
      previous = message.sequence;
      messageIds.add(message.id);
      messages += 1;
      attachments += message.attachments.length;
      if (message.withheld === true) {
        withheldMessages += 1;
        withheldTexts += 1;
        withheldThreadIds.add(row.id);
      }
    }
  });
  const declared = manifest.counts;
  if (
    declared.threads !== rows.length ||
    declared.markdownThreads !== markdown.size ||
    declared.messages !== messages ||
    declared.attachments !== attachments ||
    manifest.withheld.messages !== withheldMessages ||
    manifest.withheld.texts !== withheldTexts ||
    manifest.withheld.threads !== withheldThreadIds.size ||
    declared.sealedOriginals !== (listed.has(CHAT_SEALED_FILE) ? withheldTexts : 0)
  )
    throw failure("FILE_COUNT_MISMATCH", "清单里的条数和数据文件不符");
  const dataEntry = manifest.files.find((entry) => entry.path === CHAT_THREADS_FILE);
  if (dataEntry?.lines !== rows.length) throw failure("FILE_COUNT_MISMATCH", CHAT_THREADS_FILE);
  return manifest;
}
