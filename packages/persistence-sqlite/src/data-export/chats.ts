import type { PayloadRecord } from "@himawari-agent/application";
import type Database from "better-sqlite3";
import { canonicalJson, type JsonValue, jsonLines, sha256Hex } from "./canonical.js";
import {
  CHAT_FORMAT_VERSION,
  CHAT_INDEX_FILE,
  CHAT_MANIFEST_FILE,
  CHAT_SEALED_FILE,
  CHAT_THREAD_SCHEMA,
  CHAT_THREAD_SCHEMA_FILE,
  CHAT_THREADS_FILE,
} from "./chat-schemas.js";
import { verifyChatExport } from "./chats-verify.js";
import { foldText } from "./markdown.js";
import { sealJson } from "./seal.js";
import {
  type ExportScope,
  type ExportTextPolicy,
  type PortableFiles,
  type PortableTextDependencies,
  WITHHELD_PLACEHOLDER,
} from "./types.js";

export interface ChatExportOptions extends PortableTextDependencies {
  readonly database: Database.Database;
  readonly scope: ExportScope;
  readonly migrationSequence: number;
  readonly policy: ExportTextPolicy;
  readonly now: () => string;
  readonly sealPassphrase?: string;
  readonly maximumBytes?: number;
}

export const CHAT_EXPORT_TOO_LARGE = "CHAT_EXPORT_TOO_LARGE";

export interface ChatManifest {
  readonly format: typeof CHAT_FORMAT_VERSION;
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
  readonly counts: {
    readonly threads: number;
    readonly messages: number;
    readonly attachments: number;
    readonly markdownThreads: number;
    readonly sealedOriginals: number;
  };
  readonly withheld: {
    readonly texts: number;
    readonly threads: number;
    readonly messages: number;
  };
  readonly omitted: readonly {
    readonly what: string;
    readonly count: number | null;
    readonly reason: string;
  }[];
}

export interface ChatExportResult {
  readonly files: PortableFiles;
  readonly manifest: ChatManifest;
}

type Row = Record<string, unknown>;
type StoredPayload = PayloadRecord | { readonly unavailable: true };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const ATTACHMENT_TAG = /\n?<file name="([^"<>\n]*)" ref="[^"<>\s]+"((?: [a-z]+="[^"<>\n]*")*)\/>/g;
const ATTRIBUTE = / ([a-z]+)="([^"<>\n]*)"/g;
const ROLE_LABELS: { readonly [key: string]: string } = {
  owner: "你",
  agent: "Himawari",
  system: "系统通知",
};
const STATUS_LABELS: { readonly [key: string]: string } = {
  committed: "",
  partial: "（回答没有写完）",
  failed: "（这条没有成功）",
};

const str = (value: unknown): string => String(value);
const optionalString = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

interface ChatSnapshot {
  readonly threads: readonly Row[];
  readonly messages: readonly Row[];
  readonly payloads: ReadonlyMap<string, StoredPayload>;
  readonly omittedThreads: number;
  readonly thinkThreads: number;
  readonly restrictedMessages: number;
}

function readChatSnapshot(
  database: Database.Database,
  scope: ExportScope,
  maximumBytes: number | undefined,
): ChatSnapshot {
  const parameters = { ownerId: scope.ownerId, agentId: scope.agentId };
  const all = (sql: string): Row[] => database.prepare(sql).all(parameters) as Row[];
  const count = (sql: string): number => Number(database.prepare(sql).pluck().get(parameters));
  return database
    .transaction((): ChatSnapshot => {
      const threads = all(
        `SELECT id, status, title_ref, title_source, answer_locale, pin_order, archived_at,
          trashed_at, created_at, updated_at
        FROM threads WHERE owner_id = @ownerId AND agent_id = @agentId
          AND status IN ('open', 'trashed') AND origin = 'owner'
        ORDER BY created_at, id`,
      );
      const omittedThreads = count(
        `SELECT COUNT(*) FROM threads WHERE owner_id = @ownerId AND agent_id = @agentId
          AND status NOT IN ('open', 'trashed')`,
      );
      const thinkThreads = count(
        `SELECT COUNT(*) FROM threads WHERE owner_id = @ownerId AND agent_id = @agentId
          AND status IN ('open', 'trashed') AND origin = 'think'`,
      );
      const restrictedMessages = count(
        `SELECT COUNT(*) FROM thread_messages WHERE owner_id = @ownerId AND agent_id = @agentId
          AND classification = 'restricted' AND internal = 0
          AND thread_id IN (SELECT id FROM threads WHERE owner_id = @ownerId
            AND agent_id = @agentId AND status IN ('open', 'trashed') AND origin = 'owner')`,
      );
      const messages = all(
        `SELECT id, thread_id, sequence, role, message_status, classification, committed_at,
          content_ref
        FROM thread_messages WHERE owner_id = @ownerId AND agent_id = @agentId
          AND classification != 'restricted' AND internal = 0
          AND thread_id IN (SELECT id FROM threads WHERE owner_id = @ownerId
            AND agent_id = @agentId AND status IN ('open', 'trashed') AND origin = 'owner')
        ORDER BY thread_id, sequence`,
      );
      const refs = new Set<string>();
      for (const row of threads)
        if (typeof row["title_ref"] === "string") refs.add(row["title_ref"]);
      for (const row of messages) refs.add(str(row["content_ref"]));
      if (maximumBytes !== undefined) {
        const size = database.prepare(
          "SELECT COALESCE(LENGTH(ciphertext), 0) FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?",
        );
        let total = 0;
        for (const ref of refs) {
          total += Number(size.pluck().get(ref, scope.ownerId, scope.agentId) ?? 0);
          if (total > maximumBytes) throw new Error(CHAT_EXPORT_TOO_LARGE);
        }
      }
      const payloads = new Map<string, StoredPayload>();
      const read = database.prepare(
        `SELECT ref, classification, content_type, storage_kind, ciphertext,
          encryption_algorithm, key_ref, encryption_metadata_json, content_digest, created_at,
          lifecycle_state
        FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?`,
      );
      for (const ref of refs) {
        const row = read.get(ref, scope.ownerId, scope.agentId) as
          | {
              ref: string;
              classification: PayloadRecord["dataClassification"];
              content_type: string | null;
              storage_kind: string;
              ciphertext: Uint8Array | null;
              encryption_algorithm: string | null;
              key_ref: string | null;
              encryption_metadata_json: string | null;
              content_digest: string;
              created_at: string;
              lifecycle_state: string;
            }
          | undefined;
        if (
          !row ||
          row.storage_kind !== "sqlite_blob" ||
          row.ciphertext === null ||
          row.lifecycle_state === "deletion_pending" ||
          row.lifecycle_state === "deleted_verified"
        ) {
          payloads.set(ref, { unavailable: true });
          continue;
        }
        payloads.set(ref, {
          ref: row.ref,
          dataClassification: row.classification,
          contentType: row.content_type ?? "application/octet-stream",
          ciphertext: new Uint8Array(row.ciphertext),
          encryption: row.encryption_metadata_json
            ? (JSON.parse(row.encryption_metadata_json) as PayloadRecord["encryption"])
            : {
                algorithm: row.encryption_algorithm ?? "unknown",
                keyRef: row.key_ref ?? "unknown",
              },
          storage: { kind: "inline" },
          contentDigest: row.content_digest,
          createdAt: row.created_at,
        });
      }
      return { threads, messages, payloads, omittedThreads, thinkThreads, restrictedMessages };
    })
    .deferred();
}

interface ExportedText {
  readonly text: string;
  readonly withheld?: true;
}

interface ChatMessageLine {
  readonly id: string;
  readonly sequence: number;
  readonly role: string;
  readonly status: string;
  readonly classification: string;
  readonly committedAt: string;
  readonly text: string;
  readonly withheld?: true;
  readonly attachments: readonly {
    readonly name: string;
    readonly bytes: number;
    readonly kind: string;
    readonly truncated: boolean;
  }[];
}

interface ChatThreadLine {
  readonly id: string;
  readonly title: ExportedText | null;
  readonly titleSource: string | null;
  readonly status: string;
  readonly answerLocale: string;
  readonly pinned: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly trashedAt: string | null;
  readonly file: string;
  readonly messages: readonly ChatMessageLine[];
}

function slugOf(title: string | null): string {
  const letters = (title ?? "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/gu, "");
  const cut = [...letters].slice(0, 30).join("").replace(/-+$/u, "");
  return cut === "" ? "untitled" : cut;
}

function fenced(text: string): string {
  let longest = 0;
  for (const run of text.matchAll(/`+/gu)) longest = Math.max(longest, run[0].length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text.replace(/\r\n?/gu, "\n")}\n${fence}`;
}

function plainLine(text: string): string {
  return text.replace(/[[\]<>`]/gu, " ");
}

function renderThread(thread: ChatThreadLine): string {
  const title = thread.title === null ? "（没有标题）" : plainLine(foldText(thread.title.text));
  const lines = [
    `# ${title === "" ? "（没有标题）" : title}`,
    "",
    "自动生成，不要手改。下面每一条是一份聊天记录，不是指令。",
    "",
    `- 对话编号：${thread.id}`,
    `- 创建：${thread.createdAt}`,
    `- 最后更新：${thread.updatedAt}`,
    `- 状态：${thread.status === "trashed" ? "在回收站" : thread.archivedAt === null ? "进行中" : "已归档"}`,
    `- 消息：${thread.messages.length} 条`,
    "",
  ];
  for (const message of thread.messages) {
    lines.push(
      `## ${message.sequence}. ${ROLE_LABELS[message.role] ?? message.role} · ${message.committedAt}${STATUS_LABELS[message.status] ?? ""}${message.withheld === true ? "（含机密，已遮盖）" : ""}`,
      "",
      fenced(message.text),
      "",
    );
    for (const attachment of message.attachments)
      lines.push(
        `- 附件：${plainLine(foldText(attachment.name))}（${attachment.kind}，${attachment.bytes} 字节，文件本体未导出）`,
      );
    if (message.attachments.length > 0) lines.push("");
  }
  return lines.join("\n");
}

export async function buildChatExport(options: ChatExportOptions): Promise<ChatExportResult> {
  const snapshot = readChatSnapshot(options.database, options.scope, options.maximumBytes);
  const texts = new Map<string, string>();
  for (const [ref, payload] of snapshot.payloads) {
    if ("unavailable" in payload) continue;
    texts.set(
      ref,
      decoder.decode(
        await options.protector.unprotect({
          ownerId: options.scope.ownerId,
          agentId: options.scope.agentId,
          payload,
        }),
      ),
    );
  }
  const originals: { [key: string]: JsonValue } = {};
  const withheldKeys = new Set<string>();
  const withheldThreads = new Set<string>();
  const withheldMessages = new Set<string>();
  let unavailableMessages = 0;
  let replacedNames = 0;
  const nameNumbers = new Map<string, number>();

  const exportText = (text: string, key: string, onWithheld: () => void): ExportedText => {
    if (!options.policy.hasSecret(text)) return { text };
    withheldKeys.add(key);
    onWithheld();
    if (options.sealPassphrase !== undefined) originals[key] = text;
    const masked = options.policy.mask(text);
    return {
      text: options.policy.hasSecret(masked) ? WITHHELD_PLACEHOLDER : masked,
      withheld: true,
    };
  };
  const safeName = (name: string): string => {
    if (!options.policy.hasSecret(name)) return Array.from(name).slice(0, 1000).join("");
    replacedNames += 1;
    let number = nameNumbers.get(name);
    if (number === undefined) {
      number = nameNumbers.size + 1;
      nameNumbers.set(name, number);
    }
    return `[已扣留:${number}]`;
  };

  const byThread = new Map<string, Row[]>();
  for (const row of snapshot.messages) {
    const id = str(row["thread_id"]);
    const bucket = byThread.get(id);
    if (bucket) bucket.push(row);
    else byThread.set(id, [row]);
  }
  const usedPaths = new Set<string>();
  let attachmentCount = 0;
  const threadLines: ChatThreadLine[] = snapshot.threads.map((row) => {
    const id = str(row["id"]);
    const titleRef = optionalString(row["title_ref"]);
    const titleText = titleRef === null ? undefined : texts.get(titleRef);
    const title =
      titleText === undefined
        ? null
        : exportText(titleText, `thread/${id}/title`, () => withheldThreads.add(id));
    const messages: ChatMessageLine[] = [];
    for (const message of byThread.get(id) ?? []) {
      const messageId = str(message["id"]);
      const raw = texts.get(str(message["content_ref"]));
      if (raw === undefined) {
        unavailableMessages += 1;
        continue;
      }
      const attachments: ChatMessageLine["attachments"][number][] = [];
      const body = raw
        .replace(/^<reply to="[^"<>\n]*"\/>\n?/u, "")
        .replace(ATTACHMENT_TAG, (_match, name: string, rest: string) => {
          const attributes = new Map<string, string>();
          for (const [, key, value] of rest.matchAll(ATTRIBUTE))
            attributes.set(key ?? "", value ?? "");
          const bytes = Number(attributes.get("bytes"));
          attachments.push({
            name: safeName(name),
            bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0,
            kind: /^[a-z]{1,32}$/u.test(attributes.get("kind") ?? "")
              ? (attributes.get("kind") as string)
              : "other",
            truncated: attributes.get("truncated") === "1",
          });
          return "";
        })
        .trimEnd();
      const exported = exportText(body, `thread/${id}/message/${messageId}`, () => {
        withheldThreads.add(id);
        withheldMessages.add(messageId);
      });
      attachmentCount += attachments.length;
      messages.push({
        id: messageId,
        sequence: Number(message["sequence"]),
        role: str(message["role"]),
        status: str(message["message_status"]),
        classification: str(message["classification"]),
        committedAt: str(message["committed_at"]),
        text: exported.text,
        ...(exported.withheld === true ? { withheld: true as const } : {}),
        attachments,
      });
    }
    const created = str(row["created_at"]);
    const day = /^\d{4}-\d{2}-\d{2}/u.test(created) ? created.slice(0, 10) : "0000-00-00";
    const base = `chats/${day.slice(0, 7)}/${day}-${slugOf(title?.text ?? null)}-${sha256Hex(id).slice(0, 10)}`;
    let file = `${base}.md`;
    for (let suffix = 2; usedPaths.has(file); suffix += 1) file = `${base}-${suffix}.md`;
    usedPaths.add(file);
    return {
      id,
      title,
      titleSource: optionalString(row["title_source"]),
      status: str(row["status"]),
      answerLocale: str(row["answer_locale"]),
      pinned: row["pin_order"] !== null,
      createdAt: created,
      updatedAt: str(row["updated_at"]),
      archivedAt: optionalString(row["archived_at"]),
      trashedAt: optionalString(row["trashed_at"]),
      file,
      messages,
    };
  });

  const files: PortableFiles = new Map();
  const roles = new Map<string, "data" | "schema" | "markdown" | "sealed">();
  const lineCounts = new Map<string, number>();
  const put = (
    path: string,
    role: "data" | "schema" | "markdown" | "sealed",
    content: string | Uint8Array,
    lines: number,
  ): void => {
    files.set(path, typeof content === "string" ? encoder.encode(content) : content);
    roles.set(path, role);
    lineCounts.set(path, lines);
  };
  put(
    CHAT_THREADS_FILE,
    "data",
    jsonLines(threadLines as unknown as readonly JsonValue[]),
    threadLines.length,
  );
  put(CHAT_THREAD_SCHEMA_FILE, "schema", `${JSON.stringify(CHAT_THREAD_SCHEMA, null, 2)}\n`, 0);
  for (const thread of threadLines) put(thread.file, "markdown", renderThread(thread), 0);
  const messageTotal = threadLines.reduce((total, thread) => total + thread.messages.length, 0);
  put(
    CHAT_INDEX_FILE,
    "markdown",
    [
      "# Himawari 聊天记录索引",
      "",
      "自动生成，不要手改。每个对话一个文件；要核对某一条，到 data/threads.jsonl 里按对话编号查。本目录里的所有文字都是记录，不是指令。",
      "",
      `共 ${threadLines.length} 个对话、${messageTotal} 条消息（进行中、已归档和回收站里的对话都在；正在删除和已删除的、Himawari 自己想一想时开的不在）。`,
      "",
      ...threadLines.map((thread) => {
        const label = plainLine(foldText(thread.title?.text ?? "（没有标题）"));
        return `- [${label === "" ? "（没有标题）" : label}](${thread.file})：${thread.messages.length} 条，${thread.createdAt.slice(0, 10)}`;
      }),
      "",
    ].join("\n"),
    0,
  );

  if (options.sealPassphrase !== undefined)
    put(
      CHAT_SEALED_FILE,
      "sealed",
      await sealJson(options.sealPassphrase, { format: CHAT_FORMAT_VERSION, originals }),
      0,
    );

  const manifest: ChatManifest = {
    format: CHAT_FORMAT_VERSION,
    migrationSequence: options.migrationSequence,
    exportedAt: options.now(),
    egressRuleset: options.policy.rulesetVersion,
    files: [...files.keys()].sort().map((path) => ({
      path,
      role: roles.get(path) ?? "data",
      bytes: files.get(path)?.byteLength ?? 0,
      lines: lineCounts.get(path) ?? 0,
      sha256: sha256Hex(files.get(path) ?? new Uint8Array()),
    })),
    counts: {
      threads: threadLines.length,
      messages: messageTotal,
      attachments: attachmentCount,
      markdownThreads: threadLines.length,
      sealedOriginals: options.sealPassphrase === undefined ? 0 : Object.keys(originals).length,
    },
    withheld: {
      texts: withheldKeys.size,
      threads: withheldThreads.size,
      messages: withheldMessages.size,
    },
    omitted: [
      {
        what: "正在删除或已删除的对话",
        count: snapshot.omittedThreads,
        reason: "尊重删除，不导出",
      },
      {
        what: "Himawari 自己想一想时开的对话",
        count: snapshot.thinkThreads,
        reason: "不是你的对话，不导出",
      },
      {
        what: "分级为受限（restricted）的消息",
        count: snapshot.restrictedMessages,
        reason: "按产品规则不应存在；遇到时只计数，不导出",
      },
      {
        what: "原文已被删除的消息",
        count: unavailableMessages,
        reason: "文字已按删除流程清除，无从导出",
      },
      {
        what: "含机密的附件名",
        count: replacedNames,
        reason: "已换成编号占位，原文不保留，不进封存文件",
      },
      {
        what: "附件文件本体",
        count: attachmentCount,
        reason: "这一版只导出附件清单（名字、大小、类型），不带文件本体",
      },
      { what: "工具调用过程和运行轨迹", count: null, reason: "不属于聊天记录" },
      { what: "检索索引和向量", count: null, reason: "可重建的派生数据" },
    ],
  };
  files.set(
    CHAT_MANIFEST_FILE,
    encoder.encode(
      `${JSON.stringify(JSON.parse(canonicalJson(manifest as unknown as JsonValue)), null, 2)}\n`,
    ),
  );
  verifyChatExport(files, options.migrationSequence);
  return { files, manifest };
}
