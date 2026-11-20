import { createHash, randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";
import {
  ApplicationPortError,
  type ClockPort,
  type PayloadProtectorPort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
} from "@himawari-agent/application";
import {
  DATA_EXPORT_ID_PATTERN,
  type GatewayV2Command,
  type GatewayV2Query,
  type GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
import {
  buildPortableExport,
  LATEST_MIGRATION_SEQUENCE,
  openReadOnlyDatabase,
  type PortableFiles,
  SHORT_TEXT_OMISSION_LABEL,
} from "@himawari-agent/persistence-sqlite";
import {
  authenticateHttpRequest,
  createDataExportTextPolicy,
  type HttpGatewayAuthenticationPort,
} from "@himawari-agent/platform-node";
import type { FastifyInstance } from "fastify";

export const DATA_EXPORT_PATH = "/api/data-export/v1/archive";
export const DATA_EXPORT_ARCHIVE_ROOT = "himawari-export";
export const DATA_EXPORT_CANCELLED = "DATA_EXPORT_CANCELLED";
export const DATA_EXPORT_NOT_FOUND = "DATA_EXPORT_NOT_FOUND";
export const DATA_EXPORT_NOT_CANCELLABLE = "DATA_EXPORT_NOT_CANCELLABLE";
export const DATA_EXPORT_TOO_LARGE = "DATA_EXPORT_TOO_LARGE";
export const DATA_EXPORT_BUSY = "DATA_EXPORT_BUSY";
export const DATA_EXPORT_RETENTION_MS = 10 * 60 * 1000;
export const DATA_EXPORT_KEY_LIMIT = 64;
const MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024;
const encoder = new TextEncoder();

function dosDateTime(iso: string): { readonly time: number; readonly date: number } {
  const instant = new Date(iso);
  const year = Math.max(instant.getUTCFullYear(), 1980);
  return {
    time:
      (instant.getUTCHours() << 11) |
      (instant.getUTCMinutes() << 5) |
      Math.floor(instant.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((instant.getUTCMonth() + 1) << 5) | instant.getUTCDate(),
  };
}

export function createStoredZip(
  files: PortableFiles,
  exportedAt: string,
  root: string = DATA_EXPORT_ARCHIVE_ROOT,
  maximumBytes: number = MAXIMUM_ARCHIVE_BYTES,
): Uint8Array {
  const { time, date } = dosDateTime(exportedAt);
  const entries = [...files.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const chunks: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = encoder.encode(`${root}/${name}`);
    const checksum = crc32(content);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, checksum, true);
    local.setUint32(18, content.byteLength, true);
    local.setUint32(22, content.byteLength, true);
    local.setUint16(26, nameBytes.byteLength, true);
    local.setUint16(28, 0, true);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, checksum, true);
    entry.setUint32(20, content.byteLength, true);
    entry.setUint32(24, content.byteLength, true);
    entry.setUint16(28, nameBytes.byteLength, true);
    entry.setUint32(42, offset, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, content);
    directory.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.byteLength + content.byteLength;
    if (offset > maximumBytes) throw new RangeError(DATA_EXPORT_TOO_LARGE);
  }
  const directoryBytes = directory.reduce((sum, part) => sum + part.byteLength, 0);
  if (offset + directoryBytes + 22 > maximumBytes) throw new RangeError(DATA_EXPORT_TOO_LARGE);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directoryBytes, true);
  end.setUint32(16, offset, true);
  const parts = [...chunks, ...directory, new Uint8Array(end.buffer)];
  const archive = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let position = 0;
  for (const part of parts) {
    archive.set(part, position);
    position += part.byteLength;
  }
  return archive;
}

export interface DataExportArchive {
  readonly archive: Buffer;
  readonly fileName: string;
  readonly sha256: string;
  readonly memories: number;
  readonly rules: number;
  readonly withheld: number;
}

export interface DataExportProgress {
  readonly textsRead: number;
  readonly textsTotal: number;
}

export interface DataExportBuildControl {
  readonly signal: AbortSignal;
  readonly onProgress: (progress: DataExportProgress) => void;
}

export interface DataExportJobView {
  readonly exportId: string;
  readonly state: "running" | "ready" | "failed" | "cancelled" | "expired";
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly failureCode: string | null;
  readonly expiresAt: string | null;
  readonly progress: DataExportProgress | null;
  readonly built: DataExportArchive | null;
}

export interface DataExportJobsOptions {
  readonly ownerId: ProductConfiguration["ownerId"];
  readonly agentId: ProductConfiguration["agentId"];
  readonly databasePath: string;
  readonly protector: PayloadProtectorPort;
  readonly now: () => string;
  readonly retentionMs?: number;
  readonly build?: (control: DataExportBuildControl) => Promise<DataExportArchive>;
}

interface DataExportJob {
  readonly exportId: string;
  readonly idempotencyKeys: Set<string>;
  readonly abort: AbortController;
  state: "running" | "ready" | "failed" | "cancelled";
  readonly startedAt: string;
  finishedAt: string | null;
  failureCode: string | null;
  expiresAt: string | null;
  progress: DataExportProgress | null;
  built: DataExportArchive | null;
}

const exportFailureCode = (error: unknown) =>
  error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message)
    ? error.message
    : "DATA_EXPORT_FAILED";

export class DataExportJobs {
  readonly #options: DataExportJobsOptions;
  #building = false;
  #job: DataExportJob | null = null;
  #release: NodeJS.Timeout | null = null;

  constructor(options: DataExportJobsOptions) {
    this.#options = options;
  }

  get busy(): boolean {
    return this.#building;
  }

  async buildNow(
    control: DataExportBuildControl = {
      signal: new AbortController().signal,
      onProgress: () => {},
    },
  ): Promise<DataExportArchive> {
    if (this.#building) throw new Error(DATA_EXPORT_BUSY);
    this.#building = true;
    try {
      return await (this.#options.build ?? ((given) => this.#build(given)))(control);
    } finally {
      this.#building = false;
    }
  }

  #discard(): void {
    if (this.#release) clearTimeout(this.#release);
    this.#release = null;
    this.#job = null;
  }

  start(idempotencyKey: string): { readonly exportId: string; readonly replayed: boolean } {
    const current = this.#job;
    if (
      current &&
      (current.state === "running" || current.state === "ready") &&
      (current.expiresAt === null ||
        Date.parse(this.#options.now()) < Date.parse(current.expiresAt))
    ) {
      if (current.idempotencyKeys.has(idempotencyKey))
        return { exportId: current.exportId, replayed: true };
      if (current.state === "running") {
        if (current.idempotencyKeys.size >= DATA_EXPORT_KEY_LIMIT)
          throw new Error(DATA_EXPORT_BUSY);
        current.idempotencyKeys.add(idempotencyKey);
        return { exportId: current.exportId, replayed: false };
      }
    }
    if (this.#building) throw new Error(DATA_EXPORT_BUSY);
    const job: DataExportJob = {
      idempotencyKeys: new Set([idempotencyKey]),
      exportId: `data-export:${randomBytes(16).toString("base64url")}`,
      abort: new AbortController(),
      state: "running",
      startedAt: this.#options.now(),
      finishedAt: null,
      failureCode: null,
      expiresAt: null,
      progress: null,
      built: null,
    };
    this.#discard();
    this.#job = job;
    const retentionMs = this.#options.retentionMs ?? DATA_EXPORT_RETENTION_MS;
    void this.buildNow({
      signal: job.abort.signal,
      onProgress: (progress) => {
        if (job.state === "running") job.progress = progress;
      },
    }).then(
      (built) => {
        if (job.state !== "running") return;
        job.progress = null;
        job.finishedAt = this.#options.now();
        job.expiresAt = new Date(Date.parse(job.finishedAt) + retentionMs).toISOString();
        job.built = built;
        job.state = "ready";
        this.#release = setTimeout(() => {
          if (this.#job === job) this.#job = null;
        }, retentionMs);
        this.#release.unref();
      },
      (error: unknown) => {
        if (job.state !== "running") return;
        job.progress = null;
        job.finishedAt = this.#options.now();
        job.failureCode = exportFailureCode(error);
        job.state = "failed";
      },
    );
    return { exportId: job.exportId, replayed: false };
  }

  cancel(exportId: string): { readonly exportId: string; readonly replayed: boolean } {
    const job = this.#job;
    if (
      !job ||
      job.exportId !== exportId ||
      (job.expiresAt !== null && Date.parse(this.#options.now()) >= Date.parse(job.expiresAt))
    )
      throw new Error(DATA_EXPORT_NOT_FOUND);
    if (job.state === "cancelled") return { exportId, replayed: true };
    if (job.state === "failed") throw new Error(DATA_EXPORT_NOT_CANCELLABLE);
    if (this.#release) clearTimeout(this.#release);
    this.#release = null;
    job.state = "cancelled";
    job.finishedAt = this.#options.now();
    job.expiresAt = null;
    job.progress = null;
    job.built = null;
    job.abort.abort(new Error(DATA_EXPORT_CANCELLED));
    return { exportId, replayed: false };
  }

  view(exportId: string): DataExportJobView {
    const job = this.#job;
    if (
      !job ||
      job.exportId !== exportId ||
      (job.expiresAt !== null && Date.parse(this.#options.now()) >= Date.parse(job.expiresAt))
    )
      return {
        exportId,
        state: "expired",
        startedAt: null,
        finishedAt: null,
        failureCode: null,
        expiresAt: null,
        progress: null,
        built: null,
      };
    const { idempotencyKeys: _idempotencyKeys, abort: _abort, ...view } = job;
    return view;
  }

  async #build({ signal, onProgress }: DataExportBuildControl): Promise<DataExportArchive> {
    const database = openReadOnlyDatabase(this.#options.databasePath);
    try {
      const result = await buildPortableExport({
        database,
        scope: { ownerId: this.#options.ownerId, agentId: this.#options.agentId },
        migrationSequence: LATEST_MIGRATION_SEQUENCE,
        protector: this.#options.protector,
        policy: createDataExportTextPolicy(),
        now: this.#options.now,
        signal,
        onProgress: (textsRead, textsTotal) => onProgress({ textsRead, textsTotal }),
      });
      signal.throwIfAborted();
      const zip = createStoredZip(result.files, result.manifest.exportedAt);
      const archive = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
      return {
        archive,
        fileName: `himawari-export-${result.manifest.exportedAt.slice(0, 10)}.zip`,
        sha256: createHash("sha256").update(archive).digest("hex"),
        memories: result.manifest.counts.memories,
        rules: result.manifest.counts.enforcedRules,
        withheld:
          result.manifest.withheld.texts +
          (result.manifest.omitted.find(({ what }) => what === SHORT_TEXT_OMISSION_LABEL)?.count ??
            0),
      };
    } finally {
      database.close();
    }
  }
}

export function deviceExportArchive(options: {
  readonly ownerId: ProductConfiguration["ownerId"];
  readonly jobs: DataExportJobs;
}) {
  return (input: {
    readonly authentication: { readonly ownerId: string };
    readonly exportId: string;
  }) => {
    if (input.authentication.ownerId !== options.ownerId) return undefined;
    const view = options.jobs.view(input.exportId);
    if (view.state !== "ready" || !view.built) return undefined;
    return {
      bytes: view.built.archive,
      mediaType: "application/zip",
      fileName: view.built.fileName,
    };
  };
}

export const PRODUCTION_DATA_EXPORT_OPERATIONS = Object.freeze([
  "data.export.start",
  "data.export.cancel",
  "data.export.status.read",
] as const);

export interface ProductionDataExportControlOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly jobs: DataExportJobs;
  readonly clock: ClockPort;
}

export class ProductionDataExportControl {
  readonly #options: ProductionDataExportControlOptions;

  constructor(options: ProductionDataExportControlOptions) {
    this.#options = options;
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type !== "data.export.status.read")
      throw new Error("DATA_EXPORT_OPERATION_NOT_INSTALLED");
    const view = this.#options.jobs.view(query.payload.exportId);
    return {
      ...query,
      kind: "snapshot",
      type: "data.export.status.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        exportId: view.exportId,
        state: view.state,
        startedAt: view.startedAt,
        finishedAt: view.finishedAt,
        failureCode: view.failureCode,
        progress: view.state === "running" ? view.progress : null,
        result:
          view.state === "ready" && view.built && view.expiresAt
            ? {
                downloadPath: `${DATA_EXPORT_PATH}?exportId=${encodeURIComponent(view.exportId)}`,
                fileName: view.built.fileName,
                sizeBytes: view.built.archive.byteLength,
                sha256: view.built.sha256,
                memories: view.built.memories,
                rules: view.built.rules,
                withheld: view.built.withheld,
                expiresAt: view.expiresAt,
              }
            : null,
        generatedAt: this.#options.clock.now(),
      },
    };
  }

  async execute(command: GatewayV2Command): Promise<{ resultRef: string; replayed: boolean }> {
    const { ownerId, agentId } = this.#options.configuration;
    if (
      command.actor.actorType !== "owner" ||
      command.scope.ownerId !== ownerId ||
      command.scope.agentId !== agentId
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "DATA_EXPORT_OWNER_REQUIRED",
      );
    try {
      if (command.type === "data.export.cancel") {
        const cancelled = this.#options.jobs.cancel(command.payload.exportId);
        return { resultRef: cancelled.exportId, replayed: cancelled.replayed };
      }
      if (command.type !== "data.export.start")
        throw new Error("DATA_EXPORT_OPERATION_NOT_INSTALLED");
      const started = this.#options.jobs.start(command.idempotencyKey);
      return { resultRef: started.exportId, replayed: started.replayed };
    } catch (error) {
      if (error instanceof Error && error.message === DATA_EXPORT_NOT_FOUND)
        throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, DATA_EXPORT_NOT_FOUND);
      if (
        error instanceof Error &&
        (error.message === DATA_EXPORT_BUSY || error.message === DATA_EXPORT_NOT_CANCELLABLE)
      )
        throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, error.message);
      throw error;
    }
  }
}

export interface ProductionDataExportOptions {
  readonly authentication: HttpGatewayAuthenticationPort;
  readonly sessionCookieName: string;
  readonly ownerId: ProductConfiguration["ownerId"];
  readonly jobs: DataExportJobs;
}

export function registerDataExportRoute(
  app: FastifyInstance,
  options: ProductionDataExportOptions,
): void {
  app.get(DATA_EXPORT_PATH, { exposeHeadRoute: false }, async (request, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    const site = request.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none")
      return reply.code(403).send();
    const authentication = await authenticateHttpRequest(request, options).catch(() => undefined);
    if (!authentication || authentication.ownerId !== options.ownerId)
      return reply.code(401).send();
    const exportId = (request.query as Record<string, unknown> | null)?.["exportId"];
    let built: DataExportArchive;
    if (exportId !== undefined) {
      if (typeof exportId !== "string" || !DATA_EXPORT_ID_PATTERN.test(exportId))
        return reply.code(400).send();
      const view = options.jobs.view(exportId);
      if (view.state !== "ready" || !view.built) return reply.code(404).send();
      built = view.built;
    } else {
      if (options.jobs.busy) return reply.code(429).send();
      try {
        built = await options.jobs.buildNow();
      } catch (error) {
        if (error instanceof Error && error.message === DATA_EXPORT_BUSY)
          return reply.code(429).send();
        request.log.warn({ code: exportFailureCode(error) }, "data export failed");
        return reply.code(500).send();
      }
    }
    return reply
      .code(200)
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="${built.fileName}"`)
      .header("x-himawari-export-memories", String(built.memories))
      .header("x-himawari-export-rules", String(built.rules))
      .header("x-himawari-export-withheld", String(built.withheld))
      .send(built.archive);
  });
}
