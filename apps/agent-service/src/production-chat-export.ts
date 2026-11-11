import type { PayloadProtectorPort, ProductConfiguration } from "@himawari-agent/application";
import {
  buildChatExport,
  CHAT_EXPORT_TOO_LARGE,
  LATEST_MIGRATION_SEQUENCE,
  openReadOnlyDatabase,
} from "@himawari-agent/persistence-sqlite";
import {
  authenticateHttpRequest,
  createDataExportTextPolicy,
  type HttpGatewayAuthenticationPort,
} from "@himawari-agent/platform-node";
import type { FastifyInstance } from "fastify";
import { createStoredZip } from "./production-data-export.js";

export const CHAT_EXPORT_PATH = "/api/data-export/v1/chats";
export const CHAT_EXPORT_ARCHIVE_ROOT = "himawari-chats";
export const CHAT_EXPORT_WEB_MAXIMUM_BYTES = 128 * 1024 * 1024;

export interface ProductionChatExportOptions {
  readonly authentication: HttpGatewayAuthenticationPort;
  readonly sessionCookieName: string;
  readonly ownerId: ProductConfiguration["ownerId"];
  readonly agentId: ProductConfiguration["agentId"];
  readonly databasePath: string;
  readonly protector: PayloadProtectorPort;
  readonly now: () => string;
  readonly maximumBytes?: number;
}

export function registerChatExportRoute(
  app: FastifyInstance,
  options: ProductionChatExportOptions,
): void {
  let running = false;
  app.get(CHAT_EXPORT_PATH, { exposeHeadRoute: false }, async (request, reply) => {
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
        const result = await buildChatExport({
          database,
          scope: { ownerId: options.ownerId, agentId: options.agentId },
          migrationSequence: LATEST_MIGRATION_SEQUENCE,
          protector: options.protector,
          policy: createDataExportTextPolicy(),
          now: options.now,
          maximumBytes: options.maximumBytes ?? CHAT_EXPORT_WEB_MAXIMUM_BYTES,
        });
        const archive = createStoredZip(
          result.files,
          result.manifest.exportedAt,
          CHAT_EXPORT_ARCHIVE_ROOT,
        );
        const stamp = result.manifest.exportedAt.slice(0, 10);
        return reply
          .code(200)
          .header("content-type", "application/zip")
          .header("content-disposition", `attachment; filename="himawari-chats-${stamp}.zip"`)
          .header("x-himawari-export-threads", String(result.manifest.counts.threads))
          .header("x-himawari-export-messages", String(result.manifest.counts.messages))
          .header("x-himawari-export-withheld", String(result.manifest.withheld.messages))
          .send(Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength));
      } finally {
        database.close();
      }
    } catch (error) {
      if (error instanceof Error && error.message === CHAT_EXPORT_TOO_LARGE) {
        request.log.warn({ code: CHAT_EXPORT_TOO_LARGE }, "chat export too large for the web");
        return reply.code(413).send();
      }
      const code =
        error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message)
          ? error.message
          : "CHAT_EXPORT_FAILED";
      request.log.warn({ code }, "chat export failed");
      return reply.code(500).send();
    } finally {
      running = false;
    }
  });
}
