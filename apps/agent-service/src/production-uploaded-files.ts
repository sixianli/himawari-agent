import type {
  IdGeneratorPort,
  PayloadProtectorPort,
  PayloadStorePort,
  RuntimeRequest,
  ThreadArtifactKind,
  ThreadArtifactStorePort,
  ThreadRepositoryPort,
} from "@himawari-agent/application";
import { classifyThreadArtifact } from "./production-thread-artifacts.js";

const ATTACHMENT_TAG =
  /<file name="([^"<>\n]*)" ref="([^"<>\s]+)" bytes="(\d+)" kind="([a-z]+)"(?: truncated="1")?\/>/g;
const EXTRACTED_TEXT_KINDS = new Set(["pdf", "word", "excel", "powerpoint"]);
const MESSAGE_PAGE = 200;

export interface UploadedFile {
  readonly name: string;
  readonly ref: string;
  readonly bytes: number;
  readonly kind: string;
}

export function uploadedFiles(text: string): readonly UploadedFile[] {
  return [...text.matchAll(ATTACHMENT_TAG)].map((match) => ({
    name: match[1] || "file",
    ref: match[2] ?? "",
    bytes: Number(match[3]),
    kind: match[4] ?? "text",
  }));
}

export function uploadedArtifact(file: UploadedFile): {
  readonly path: string;
  readonly kind: ThreadArtifactKind;
  readonly mediaType: string;
} {
  if (file.kind === "image") {
    const known = classifyThreadArtifact(file.name);
    return {
      path: file.name,
      kind: "image",
      mediaType: known.kind === "image" ? known.mediaType : "image/png",
    };
  }
  if (EXTRACTED_TEXT_KINDS.has(file.kind))
    return { path: `${file.name}.txt`, kind: "document", mediaType: "text/plain" };
  const known = classifyThreadArtifact(file.name);
  return known.kind === "other" || known.kind === "image" || known.kind === "pdf"
    ? { path: file.name, kind: "document", mediaType: "text/plain" }
    : { path: file.name, ...known };
}

export interface ProductionUploadedFilesOptions {
  readonly threads: Pick<ThreadRepositoryPort, "listMessages">;
  readonly payloads: Pick<PayloadStorePort, "get">;
  readonly protector: PayloadProtectorPort;
  readonly store: ThreadArtifactStorePort;
  readonly ids: IdGeneratorPort;
  readonly now: () => string;
  readonly warn?: (event: Record<string, unknown>) => void;
}

export class ProductionUploadedFiles {
  readonly #options: ProductionUploadedFilesOptions;

  constructor(options: ProductionUploadedFilesOptions) {
    this.#options = options;
  }

  start(request: RuntimeRequest): Promise<void> {
    return this.#record(request).catch((error: unknown) =>
      (this.#options.warn ?? ((event) => console.error(JSON.stringify(event))))({
        event: "thread.upload.record_failed",
        runId: request.runId,
        code: error instanceof Error ? error.message : "THREAD_UPLOAD_RECORD_FAILED",
        at: this.#options.now(),
      }),
    );
  }

  async #record(request: RuntimeRequest): Promise<void> {
    const { ownerId, agentId, threadId, runId } = request;
    if (!threadId) return;
    let after = 0;
    for (;;) {
      const messages = await this.#options.threads.listMessages(
        ownerId,
        agentId,
        threadId,
        after,
        MESSAGE_PAGE,
      );
      const message = messages.find(
        (item) => item.role === "owner" && item.runId === runId && item.status === "committed",
      );
      if (message) {
        const payload = await this.#options.payloads.get(message.contentRef);
        if (!payload || payload.contentType !== "text/plain") return;
        const text = new TextDecoder().decode(
          await this.#options.protector.unprotect({ ownerId, agentId, payload }),
        );
        for (const file of uploadedFiles(text)) {
          const artifact = uploadedArtifact(file);
          await this.#options.store.register({
            ownerId,
            agentId,
            artifact: {
              id: this.#options.ids.next("thread-artifact"),
              threadId,
              runId,
              toolCallId: `upload:${file.ref}`,
              source: "upload",
              ...artifact,
              sizeBytes: file.bytes,
              sha256: null,
              copyRef: file.ref,
              overlapped: false,
              createdAt: message.committedAt,
            },
          });
        }
        return;
      }
      const last = messages.at(-1);
      if (!last || messages.length < MESSAGE_PAGE) return;
      after = last.sequence;
    }
  }
}
