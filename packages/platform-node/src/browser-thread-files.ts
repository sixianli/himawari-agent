import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ApplicationPortError,
  executionToolItemId,
  type GatewayAuthenticationContext,
  type PayloadProtectorPort,
  type PayloadStorePort,
  PORT_ERROR_CODES,
  type ThreadArtifact,
  type ThreadArtifactKind,
  type ThreadArtifactOrigin,
  type ThreadArtifactScope,
  type ThreadArtifactStorePort,
} from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";

export const FILE_PREVIEW_TICKET_MS = 5 * 60 * 1000;

const UPLOADED_IMAGE_CONTENT_TYPE = "text/x-himawari-image";
const UPLOADED_IMAGE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;

const PREVIEW_MEDIA_TYPES = new Set(["text/html", "image/svg+xml"]);
const INLINE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/pdf",
]);

export interface BrowserThreadFile {
  readonly id: string;
  readonly threadId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolItemId: string;
  readonly source: ThreadArtifact["source"];
  readonly path: string;
  readonly name: string;
  readonly kind: ThreadArtifactKind;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly version: number;
  readonly turn: number;
  readonly commandKey: string | null;
  readonly stored: boolean;
  readonly overlapped: boolean;
  readonly createdAt: string;
  readonly deleted: boolean;
}

export interface BrowserThreadFileContent {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly fileName: string;
  readonly disposition: "inline" | "attachment";
}

export interface HttpGatewayFilesPort {
  list(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly agentId: string;
    readonly threadId: string | null;
    readonly kind: ThreadArtifactKind | null;
    readonly origin: ThreadArtifactOrigin | null;
    readonly search: string | null;
    readonly before: string | null;
    readonly limit: number;
  }): Promise<{ readonly items: readonly BrowserThreadFile[]; readonly nextCursor: string | null }>;
  versions(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly agentId: string;
    readonly fileId: string;
  }): Promise<{ readonly items: readonly BrowserThreadFile[] }>;
  content(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly agentId: string;
    readonly fileId: string;
    readonly download: boolean;
  }): Promise<BrowserThreadFileContent>;
  previewTicket(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly agentId: string;
    readonly fileId: string;
  }): Promise<{ readonly url: string; readonly expiresAt: string }>;
  preview(input: { readonly ticket: string }): Promise<BrowserThreadFileContent>;
}

export interface BrowserThreadFilesOptions {
  readonly ownerId: string;
  readonly agentId: string;
  readonly store: ThreadArtifactStorePort;
  readonly payloads: () => PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly previewOrigin?: string;
  readonly ticketKey: Uint8Array;
  readonly now: () => string;
  readonly commandKey?: (runId: string, toolCallId: string) => string;
}

function fileName(path: string): string {
  return path.split("/").at(-1) || path;
}

function browserFile(
  artifact: ThreadArtifact,
  commandKey: BrowserThreadFilesOptions["commandKey"],
): BrowserThreadFile {
  return Object.freeze({
    id: artifact.id,
    threadId: artifact.threadId,
    runId: artifact.runId,
    toolCallId: artifact.toolCallId,
    toolItemId: executionToolItemId(artifact.toolCallId),
    source: artifact.source,
    path: artifact.path,
    name: fileName(artifact.path),
    kind: artifact.kind,
    mediaType: artifact.mediaType,
    sizeBytes: artifact.sizeBytes,
    version: artifact.version,
    turn: artifact.turn,
    commandKey:
      artifact.source === "bash" && commandKey
        ? commandKey(artifact.runId, artifact.toolCallId)
        : null,
    stored: artifact.copyRef !== null,
    overlapped: artifact.overlapped,
    createdAt: artifact.createdAt,
    deleted: artifact.deletedAt !== null,
  });
}

function notFound(): never {
  throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "File was not found");
}

export class BrowserThreadFiles implements HttpGatewayFilesPort {
  readonly #options: BrowserThreadFilesOptions;

  #file = (artifact: ThreadArtifact) => browserFile(artifact, this.#options.commandKey);

  constructor(options: BrowserThreadFilesOptions) {
    if (options.ticketKey.byteLength < 32) throw new Error("FILE_PREVIEW_KEY_INVALID");
    this.#options = options;
  }

  #scope(
    authentication: GatewayAuthenticationContext | null,
    agentId: string,
  ): ThreadArtifactScope {
    const ownerId = authentication ? authentication.ownerId : this.#options.ownerId;
    if (ownerId !== this.#options.ownerId || agentId !== this.#options.agentId)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "File scope mismatch");
    return { ownerId: createOwnerId(ownerId), agentId: createAgentId(agentId) };
  }

  async list(input: Parameters<HttpGatewayFilesPort["list"]>[0]) {
    const page = await this.#options.store.list({
      ...this.#scope(input.authentication, input.agentId),
      threadId: input.threadId,
      kind: input.kind,
      origin: input.origin,
      search: input.search,
      before: input.before,
      limit: input.limit,
    });
    return Object.freeze({ items: page.items.map(this.#file), nextCursor: page.nextCursor });
  }

  async versions(input: Parameters<HttpGatewayFilesPort["versions"]>[0]) {
    const scope = this.#scope(input.authentication, input.agentId);
    const artifact = (await this.#options.store.get({ ...scope, id: input.fileId })) ?? notFound();
    const items = await this.#options.store.versions({
      ...scope,
      threadId: artifact.threadId,
      path: artifact.path,
    });
    return Object.freeze({ items: items.map(this.#file) });
  }

  async content(input: Parameters<HttpGatewayFilesPort["content"]>[0]) {
    const scope = this.#scope(input.authentication, input.agentId);
    const artifact = (await this.#options.store.get({ ...scope, id: input.fileId })) ?? notFound();
    const { bytes, mediaType } = await this.#read(scope, artifact);
    return Object.freeze({
      bytes,
      mediaType,
      fileName: fileName(artifact.path),
      disposition:
        !input.download && INLINE_MEDIA_TYPES.has(artifact.mediaType) ? "inline" : "attachment",
    } as const);
  }

  async previewTicket(input: Parameters<HttpGatewayFilesPort["previewTicket"]>[0]) {
    const origin = this.#options.previewOrigin;
    if (!origin)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.OPERATION_NOT_INSTALLED,
        "File preview origin is not configured",
      );
    const scope = this.#scope(input.authentication, input.agentId);
    const artifact = (await this.#options.store.get({ ...scope, id: input.fileId })) ?? notFound();
    if (!PREVIEW_MEDIA_TYPES.has(artifact.mediaType) || artifact.copyRef === null) notFound();
    const expiresAt = new Date(
      Date.parse(this.#options.now()) + FILE_PREVIEW_TICKET_MS,
    ).toISOString();
    const body = Buffer.from(JSON.stringify([artifact.id, expiresAt])).toString("base64url");
    return Object.freeze({
      url: `${origin}/preview/${body}.${this.#sign(body)}`,
      expiresAt,
    });
  }

  async preview(input: { readonly ticket: string }) {
    const [body, signature, extra] = input.ticket.split(".");
    if (!body || !signature || extra !== undefined || body.length > 512) notFound();
    const expected = Buffer.from(this.#sign(body));
    const received = Buffer.from(signature);
    if (expected.byteLength !== received.byteLength || !timingSafeEqual(expected, received))
      notFound();
    let fileId: unknown;
    let expiresAt: unknown;
    try {
      [fileId, expiresAt] = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as [
        unknown,
        unknown,
      ];
    } catch {
      notFound();
    }
    if (
      typeof fileId !== "string" ||
      typeof expiresAt !== "string" ||
      !(Date.parse(expiresAt) > Date.parse(this.#options.now()))
    )
      notFound();
    const scope = this.#scope(null, this.#options.agentId);
    const artifact = (await this.#options.store.get({ ...scope, id: fileId })) ?? notFound();
    if (!PREVIEW_MEDIA_TYPES.has(artifact.mediaType)) notFound();
    const { bytes, mediaType } = await this.#read(scope, artifact);
    return Object.freeze({
      bytes,
      mediaType,
      fileName: fileName(artifact.path),
      disposition: "inline",
    } as const);
  }

  #sign(body: string): string {
    return createHmac("sha256", this.#options.ticketKey)
      .update(`himawari.file-preview.v1:${body}`)
      .digest("base64url");
  }

  async #read(
    scope: ThreadArtifactScope,
    artifact: ThreadArtifact,
  ): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }> {
    if (artifact.copyRef === null)
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "File copy was not kept");
    const payload = (await this.#options.payloads().get(artifact.copyRef)) ?? notFound();
    const bytes = await this.#options.protector.unprotect({ ...scope, payload });
    if (artifact.source !== "upload" || payload.contentType !== UPLOADED_IMAGE_CONTENT_TYPE)
      return { bytes, mediaType: artifact.mediaType };
    const image = UPLOADED_IMAGE.exec(new TextDecoder().decode(bytes)) ?? notFound();
    return {
      bytes: Buffer.from(image[2] ?? "", "base64"),
      mediaType: image[1] ?? artifact.mediaType,
    };
  }
}
