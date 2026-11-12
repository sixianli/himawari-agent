import { createHash } from "node:crypto";
import {
  HOST_READ_ONLY_ERROR_CODES,
  type HostDirectoryGrant,
  HostReadOnlyError,
  type HostReadOnlyPort,
  type IdGeneratorPort,
  THREAD_ARTIFACT_LIST_LIMIT,
  type ThreadArtifactKind,
  type ThreadArtifactPage,
  type ThreadArtifactScope,
  type ThreadArtifactSource,
  type ThreadArtifactStorePort,
} from "@himawari-agent/application";

export const THREAD_ARTIFACT_COPY_LIMIT_BYTES = 32 * 1024 * 1024;
export const THREAD_ARTIFACTS_PER_CALL = 50;

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".cache",
  ".venv",
  ".pytest_cache",
  ".mypy_cache",
  ".next",
  ".turbo",
]);

export const THREAD_ARTIFACT_SKIPPED_DIRECTORIES: readonly string[] = Object.freeze([
  ...SKIPPED_DIRECTORIES,
]);

const KINDS: Readonly<Record<string, readonly [ThreadArtifactKind, string]>> = {
  html: ["web", "text/html"],
  htm: ["web", "text/html"],
  png: ["image", "image/png"],
  jpg: ["image", "image/jpeg"],
  jpeg: ["image", "image/jpeg"],
  gif: ["image", "image/gif"],
  webp: ["image", "image/webp"],
  avif: ["image", "image/avif"],
  svg: ["image", "image/svg+xml"],
  pdf: ["pdf", "application/pdf"],
  md: ["document", "text/markdown"],
  markdown: ["document", "text/markdown"],
  txt: ["document", "text/plain"],
  rst: ["document", "text/plain"],
  doc: ["document", "application/msword"],
  docx: ["document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  odt: ["document", "application/vnd.oasis.opendocument.text"],
  rtf: ["document", "application/rtf"],
  ppt: ["document", "application/vnd.ms-powerpoint"],
  pptx: ["document", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  csv: ["data", "text/csv"],
  tsv: ["data", "text/tab-separated-values"],
  json: ["data", "application/json"],
  jsonl: ["data", "application/x-ndjson"],
  xml: ["data", "application/xml"],
  yaml: ["data", "application/yaml"],
  yml: ["data", "application/yaml"],
  xls: ["data", "application/vnd.ms-excel"],
  xlsx: ["data", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  sqlite: ["data", "application/vnd.sqlite3"],
  db: ["data", "application/vnd.sqlite3"],
};

const CODE_EXTENSIONS = new Set([
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "swift",
  "php",
  "sh",
  "bash",
  "zsh",
  "css",
  "scss",
  "sql",
  "lua",
  "r",
  "dart",
  "vue",
  "svelte",
  "toml",
  "ini",
]);

export function classifyThreadArtifact(path: string): {
  readonly kind: ThreadArtifactKind;
  readonly mediaType: string;
} {
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const known = KINDS[extension];
  if (known) return { kind: known[0], mediaType: known[1] };
  if (CODE_EXTENSIONS.has(extension)) return { kind: "code", mediaType: "text/plain" };
  return { kind: "other", mediaType: "application/octet-stream" };
}

export function skipsThreadArtifact(path: string): boolean {
  return path.split("/").some((part) => SKIPPED_DIRECTORIES.has(part));
}

export interface ThreadArtifactCandidate {
  readonly path: string;
  readonly sizeBytes?: number;
  readonly sha256?: string | null;
}

export interface ThreadArtifactRecording {
  readonly ownerId: ThreadArtifactScope["ownerId"];
  readonly agentId: ThreadArtifactScope["agentId"];
  readonly threadId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly source: ThreadArtifactSource;
  readonly grant: HostDirectoryGrant;
  readonly candidates: readonly ThreadArtifactCandidate[];
  readonly overlapped: boolean;
  readonly onIncomplete?: () => void;
  readonly saveCopy: (
    key: string,
    bytes: Uint8Array,
    mediaType: string,
  ) => Promise<{ readonly ref: string }>;
}

export class ProductionThreadArtifacts {
  readonly #store: ThreadArtifactStorePort;
  readonly #files: Pick<HostReadOnlyPort, "readFile" | "inspectEntry">;
  readonly #ids: IdGeneratorPort;
  readonly #now: () => string;
  readonly #warn: (event: Record<string, unknown>) => void;
  readonly #running = new Map<string, Set<{ overlapped: boolean }>>();

  constructor(options: {
    readonly store: ThreadArtifactStorePort;
    readonly files: Pick<HostReadOnlyPort, "readFile" | "inspectEntry">;
    readonly ids: IdGeneratorPort;
    readonly now: () => string;
    readonly warn?: (event: Record<string, unknown>) => void;
  }) {
    this.#store = options.store;
    this.#files = options.files;
    this.#ids = options.ids;
    this.#now = options.now;
    this.#warn =
      options.warn ?? ((event: Record<string, unknown>) => console.error(JSON.stringify(event)));
  }

  begin(grantId: string): () => boolean {
    const running = this.#running.get(grantId) ?? new Set<{ overlapped: boolean }>();
    const entry = { overlapped: running.size > 0 };
    for (const other of running) other.overlapped = true;
    running.add(entry);
    this.#running.set(grantId, running);
    return () => {
      running.delete(entry);
      if (running.size === 0) this.#running.delete(grantId);
      return entry.overlapped;
    };
  }

  async recordDeleted(input: {
    readonly ownerId: ThreadArtifactScope["ownerId"];
    readonly agentId: ThreadArtifactScope["agentId"];
    readonly threadId: string;
    readonly runId: string;
    readonly toolCallId: string;
    readonly paths: readonly string[];
    readonly grant: HostDirectoryGrant;
    readonly overlapped: boolean;
  }): Promise<boolean> {
    let paths = input.paths.filter((path) => !skipsThreadArtifact(path));
    let unknown = false;
    if (input.overlapped)
      paths = (
        await Promise.all(
          paths.map(async (path) =>
            (await this.#isMissing(input.grant, path).catch(() => {
              unknown = true;
              return false;
            }))
              ? path
              : null,
          ),
        )
      ).filter((path): path is string => path !== null);
    if (paths.length === 0) return unknown;
    try {
      await this.#store.markDeleted({
        ownerId: input.ownerId,
        agentId: input.agentId,
        threadId: input.threadId,
        paths,
        deletedAt: this.#now(),
      });
    } catch (error) {
      this.#warn({
        event: "thread.artifact.mark_deleted_failed",
        runId: input.runId,
        toolCallId: input.toolCallId,
        code: error instanceof Error ? error.message : "THREAD_ARTIFACT_MARK_DELETED_FAILED",
        at: this.#now(),
      });
      return true;
    }
    return unknown;
  }

  async #isMissing(grant: HostDirectoryGrant, relativePath: string): Promise<boolean> {
    try {
      const kind = await this.#files.inspectEntry({ grant, relativePath });
      return kind === null || kind === "directory";
    } catch (error) {
      if (
        error instanceof HostReadOnlyError &&
        error.code === HOST_READ_ONLY_ERROR_CODES.TARGET_MISSING
      )
        return true;
      throw error;
    }
  }

  async reconcileDeleted(input: {
    readonly ownerId: ThreadArtifactScope["ownerId"];
    readonly agentId: ThreadArtifactScope["agentId"];
    readonly grant: HostDirectoryGrant;
  }): Promise<number> {
    const scope = { ownerId: input.ownerId, agentId: input.agentId };
    const seen = new Set<string>();
    const missing = new Map<string, string[]>();
    let before: string | null = null;
    do {
      const page: ThreadArtifactPage = await this.#store.list({
        ...scope,
        threadId: null,
        kind: null,
        origin: "generated",
        search: null,
        before,
        limit: THREAD_ARTIFACT_LIST_LIMIT,
      });
      for (const artifact of page.items) {
        const key = `${artifact.threadId}\u0000${artifact.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (artifact.deletedAt !== null || skipsThreadArtifact(artifact.path)) continue;
        if (!(await this.#isMissing(input.grant, artifact.path))) continue;
        missing.set(artifact.threadId, [...(missing.get(artifact.threadId) ?? []), artifact.path]);
      }
      before = page.nextCursor;
    } while (before !== null);
    let marked = 0;
    for (const [threadId, paths] of missing)
      marked += await this.#store.markDeleted({
        ...scope,
        threadId,
        paths,
        deletedAt: this.#now(),
      });
    return marked;
  }

  async record(input: ThreadArtifactRecording): Promise<number> {
    let created = 0;
    const seen = new Set<string>();
    for (const candidate of input.candidates) {
      if (seen.has(candidate.path) || skipsThreadArtifact(candidate.path)) continue;
      if (seen.size >= THREAD_ARTIFACTS_PER_CALL) {
        input.onIncomplete?.();
        break;
      }
      seen.add(candidate.path);
      try {
        const outcome = await this.#recordOne(input, candidate);
        if (outcome === "created") created++;
        if (outcome === "unreadable") input.onIncomplete?.();
      } catch (error) {
        input.onIncomplete?.();
        this.#warn({
          event: "thread.artifact.record_failed",
          runId: input.runId,
          toolCallId: input.toolCallId,
          code: error instanceof Error ? error.message : "THREAD_ARTIFACT_RECORD_FAILED",
          at: this.#now(),
        });
      }
    }
    return created;
  }

  async #recordOne(
    input: ThreadArtifactRecording,
    candidate: ThreadArtifactCandidate,
  ): Promise<"created" | "unchanged" | "unreadable"> {
    const { kind, mediaType } = classifyThreadArtifact(candidate.path);
    const scope = { ownerId: input.ownerId, agentId: input.agentId };
    const oversized =
      candidate.sizeBytes !== undefined && candidate.sizeBytes > THREAD_ARTIFACT_COPY_LIMIT_BYTES;
    let bytes: Uint8Array | null = null;
    if (!oversized) {
      try {
        bytes = await this.#files.readFile({
          grant: input.grant,
          relativePath: candidate.path,
          maximumBytes: THREAD_ARTIFACT_COPY_LIMIT_BYTES,
        });
      } catch (error) {
        if (
          !(error instanceof HostReadOnlyError) ||
          error.code !== HOST_READ_ONLY_ERROR_CODES.LENGTH_EXCEEDED ||
          candidate.sizeBytes === undefined
        )
          return "unreadable";
      }
    }
    const sha256 = bytes
      ? createHash("sha256").update(bytes).digest("hex")
      : (candidate.sha256 ?? null);
    const latest = await this.#store.latest({
      ...scope,
      threadId: input.threadId,
      path: candidate.path,
    });
    if (latest && latest.deletedAt === null && sha256 !== null && latest.sha256 === sha256)
      return "unchanged";
    const key = createHash("sha256")
      .update(JSON.stringify([input.toolCallId, candidate.path]))
      .digest("hex")
      .slice(0, 32);
    const copy = bytes ? await input.saveCopy(`artifact-copy:${key}`, bytes, mediaType) : null;
    const result = await this.#store.register({
      ...scope,
      artifact: {
        id: this.#ids.next("thread-artifact"),
        threadId: input.threadId,
        runId: input.runId,
        toolCallId: input.toolCallId,
        source: input.source,
        path: candidate.path,
        kind,
        mediaType,
        sizeBytes: bytes ? bytes.byteLength : (candidate.sizeBytes ?? 0),
        sha256,
        copyRef: copy?.ref ?? null,
        overlapped: input.overlapped,
        createdAt: this.#now(),
      },
    });
    return result.created ? "created" : "unchanged";
  }
}
