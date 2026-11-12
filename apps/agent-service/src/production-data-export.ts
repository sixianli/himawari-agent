import { crc32 } from "node:zlib";
import type { PayloadProtectorPort, ProductConfiguration } from "@himawari-agent/application";
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
export const DATA_EXPORT_TOO_LARGE = "DATA_EXPORT_TOO_LARGE";
const MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024;
const encoder = new TextEncoder();

export interface ProductionDataExportOptions {
  readonly authentication: HttpGatewayAuthenticationPort;
  readonly sessionCookieName: string;
  readonly ownerId: ProductConfiguration["ownerId"];
  readonly agentId: ProductConfiguration["agentId"];
  readonly databasePath: string;
  readonly protector: PayloadProtectorPort;
  readonly now: () => string;
}

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

export function registerDataExportRoute(
  app: FastifyInstance,
  options: ProductionDataExportOptions,
): void {
  let running = false;
  app.get(DATA_EXPORT_PATH, { exposeHeadRoute: false }, async (request, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    const site = request.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none")
      return reply.code(403).send();
    const authentication = await authenticateHttpRequest(request, options).catch(() => undefined);
    if (!authentication || authentication.ownerId !== options.ownerId)
      return reply.code(401).send();
    if (running) return reply.code(429).send();
    running = true;
    try {
      const database = openReadOnlyDatabase(options.databasePath);
      try {
        const result = await buildPortableExport({
          database,
          scope: { ownerId: options.ownerId, agentId: options.agentId },
          migrationSequence: LATEST_MIGRATION_SEQUENCE,
          protector: options.protector,
          policy: createDataExportTextPolicy(),
          now: options.now,
        });
        const archive = createStoredZip(result.files, result.manifest.exportedAt);
        const stamp = result.manifest.exportedAt.slice(0, 10);
        const placeholders =
          result.manifest.withheld.texts +
          (result.manifest.omitted.find(({ what }) => what === SHORT_TEXT_OMISSION_LABEL)?.count ??
            0);
        return reply
          .code(200)
          .header("content-type", "application/zip")
          .header("content-disposition", `attachment; filename="himawari-export-${stamp}.zip"`)
          .header("x-himawari-export-memories", String(result.manifest.counts.memories))
          .header("x-himawari-export-rules", String(result.manifest.counts.enforcedRules))
          .header("x-himawari-export-withheld", String(placeholders))
          .send(Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength));
      } finally {
        database.close();
      }
    } catch (error) {
      const code =
        error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message)
          ? error.message
          : "DATA_EXPORT_FAILED";
      request.log.warn({ code }, "data export failed");
      return reply.code(500).send();
    } finally {
      running = false;
    }
  });
}
