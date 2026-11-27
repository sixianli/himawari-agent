import { stat, statfs } from "node:fs/promises";
import path from "node:path";
import type { ClockPort, ProductConfiguration } from "@himawari-agent/application";
import type { GatewayV2Query, GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";

export const PRODUCTION_SERVER_STATUS_OPERATIONS = Object.freeze(["server.status.read"] as const);

export interface ServerStatusHealthPort {
  authenticatedSnapshot(authenticated: boolean): {
    readonly live: boolean;
    readonly ready: boolean;
    readonly status: "healthy" | "degraded" | "not_ready" | "not_live";
    readonly dependencies: readonly {
      readonly name: string;
      readonly required: boolean;
      readonly status: "healthy" | "degraded" | "blocked" | "unavailable";
      readonly reasonCode: string | null;
    }[];
  };
}

export interface ServerRelease {
  readonly commit: string;
  readonly installedAt: string | null;
}

export interface ServerDisk {
  readonly availableBytes: number;
  readonly totalBytes: number;
}

export interface ProductionServerStatusControlOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly health: ServerStatusHealthPort;
  readonly clock: ClockPort;
  readonly release: () => Promise<ServerRelease | null>;
  readonly disk: () => Promise<ServerDisk | null>;
}

const RELEASE_DIRECTORY = /^\d{4}-\d{2}-\d{2}-([0-9a-f]{7,40})$/u;

export function releaseDirectoryOf(file: string): { directory: string; commit: string } | null {
  const parts = path.resolve(file).split(path.sep);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const match = RELEASE_DIRECTORY.exec(parts[index] ?? "");
    if (match?.[1])
      return { directory: parts.slice(0, index + 1).join(path.sep) || path.sep, commit: match[1] };
  }
  return null;
}

export async function readServerRelease(file: string): Promise<ServerRelease | null> {
  const found = releaseDirectoryOf(file);
  if (!found) return null;
  const info = await stat(found.directory).catch(() => null);
  const born = info && info.birthtimeMs > 0 ? new Date(info.birthtimeMs).toISOString() : null;
  return { commit: found.commit, installedAt: born };
}

export async function readServerDisk(directory: string): Promise<ServerDisk | null> {
  const info = await statfs(directory).catch(() => null);
  if (!info || info.bsize <= 0 || info.blocks <= 0) return null;
  return {
    availableBytes: info.bavail * info.bsize,
    totalBytes: info.blocks * info.bsize,
  };
}

export class ProductionServerStatusControl {
  readonly #options: ProductionServerStatusControlOptions;

  constructor(options: ProductionServerStatusControlOptions) {
    this.#options = options;
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type !== "server.status.read")
      throw new Error("SERVER_STATUS_OPERATION_NOT_INSTALLED");
    const snapshot = this.#options.health.authenticatedSnapshot(true);
    const [release, disk] = await Promise.all([
      this.#options.release().catch(() => null),
      this.#options.disk().catch(() => null),
    ]);
    return {
      ...query,
      kind: "snapshot",
      type: "server.status.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        live: snapshot.live,
        ready: snapshot.ready,
        status: snapshot.status,
        dependencies: snapshot.dependencies.map((dependency) => ({
          name: dependency.name,
          required: dependency.required,
          status: dependency.status,
          reasonCode: dependency.reasonCode,
        })),
        release,
        disk,
        generatedAt: this.#options.clock.now(),
      },
    };
  }
}
