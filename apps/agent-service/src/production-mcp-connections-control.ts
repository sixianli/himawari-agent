import {
  ApplicationPortError,
  type ClockPort,
  type GatewayAuthenticationContext,
  type GatewayV2QueryContext,
  MCP_CONNECTION_MAXIMUM,
  MCP_CONNECTION_NAME_MAXIMUM,
  type McpConnectionChange,
  type McpConnectionStorePort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
} from "@himawari-agent/application";
import { mcpUsageWindow, summarizeMcpUsage } from "@himawari-agent/calibration/mcp-connections";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
import {
  authenticateHttpRequest,
  type HttpGatewayAuthenticationPort,
} from "@himawari-agent/platform-node";
import type { FastifyInstance } from "fastify";
import { AUTHORIZED_PER_MINUTE } from "./bearer-admission.js";
import {
  mcpConnectionIdFor,
  mcpConnectionSecretDigest,
  mcpConnectionView,
  mcpUsageDay,
  newMcpConnectionSecret,
} from "./production-mcp-connections.js";
import {
  MCP_READ_BODY_LIMIT,
  MCP_READ_PATH,
  MCP_READ_TOOL_NAMES,
  MCP_WRITE_TOOL_NAMES,
} from "./production-mcp-read.js";

export const PRODUCTION_MCP_CONNECTION_OPERATIONS = Object.freeze([
  "mcp.connections.read",
  "mcp.connection.create",
  "mcp.connection.change",
  "mcp.connection.rotate",
] as const);

export const MCP_CONNECTION_ADDRESS_PATH = "/api/mcp-connections/address";
export const MCP_CONNECTION_ADDRESS_TTL_MS = 10 * 60_000;

export const MCP_TOOL_KINDS = Object.freeze({
  reads: MCP_READ_TOOL_NAMES,
  memoryPushes: MCP_WRITE_TOOL_NAMES.filter((name) => name !== "propose_rule"),
  ruleProposals: MCP_WRITE_TOOL_NAMES.filter((name) => name === "propose_rule"),
});

export class McpConnectionAddresses {
  readonly #clock: ClockPort;
  readonly #pending = new Map<string, { readonly secret: string; readonly until: number }>();

  constructor(clock: ClockPort) {
    this.#clock = clock;
  }

  hold(connectionId: string, secret: string): void {
    this.#sweep();
    this.#pending.set(connectionId, {
      secret,
      until: Date.parse(this.#clock.now()) + MCP_CONNECTION_ADDRESS_TTL_MS,
    });
  }

  drop(connectionId: string): void {
    this.#pending.delete(connectionId);
  }

  take(connectionId: string): string | null {
    this.#sweep();
    const held = this.#pending.get(connectionId);
    this.#pending.delete(connectionId);
    return held?.secret ?? null;
  }

  #sweep(): void {
    const now = Date.parse(this.#clock.now());
    for (const [connectionId, { until }] of this.#pending)
      if (until <= now) this.#pending.delete(connectionId);
  }
}

export interface ProductionMcpConnectionsControlOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly store: McpConnectionStorePort;
  readonly addresses: McpConnectionAddresses;
  readonly minute: (connectionId: string) => {
    readonly reads: number;
    readonly hookReads: number;
  };
  readonly hookReadsPerMinute: number;
  readonly timeZone: string;
  readonly clock: ClockPort;
}

export class ProductionMcpConnectionsControl {
  readonly #options: ProductionMcpConnectionsControlOptions;

  constructor(options: ProductionMcpConnectionsControlOptions) {
    this.#options = options;
  }

  #scope(
    authentication: GatewayAuthenticationContext | undefined,
    scope: { readonly ownerId: string; readonly agentId: string },
  ) {
    const { ownerId, agentId } = this.#options.configuration;
    if (
      !authentication ||
      authentication.ownerId !== ownerId ||
      scope.ownerId !== ownerId ||
      scope.agentId !== agentId
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "MCP_CONNECTIONS_OWNER_REQUIRED",
      );
    return { ownerId, agentId };
  }

  async query(query: GatewayV2Query, context?: GatewayV2QueryContext): Promise<GatewayV2Snapshot> {
    if (query.type !== "mcp.connections.read")
      throw new Error("MCP_CONNECTIONS_OPERATION_NOT_INSTALLED");
    const scope = this.#scope(context?.authentication, query.scope);
    const now = this.#options.clock.now();
    const window = mcpUsageWindow(mcpUsageDay(now, this.#options.timeZone));
    const connections = await this.#options.store.list(scope);
    const rows = await this.#options.store.usage({
      ...scope,
      fromDay: window.fromDay,
      toDay: window.toDay,
    });
    const usage = summarizeMcpUsage(
      connections.map(({ id }) => id),
      rows,
      MCP_TOOL_KINDS,
      window,
    );
    const minutes = connections.map(({ id }) => this.#options.minute(id));
    return {
      ...query,
      kind: "snapshot",
      type: "mcp.connections.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        connections: connections.map((connection, index) => {
          const { connectionId: _connectionId, ...counts } = usage[index] as (typeof usage)[number];
          const view = mcpConnectionView(connection);
          return {
            id: view.id,
            name: view.name,
            capabilities: [...view.capabilities],
            readCeiling: view.readCeiling,
            pushPolicy: view.pushPolicy,
            status: view.status,
            reportedClient: view.reportedClient,
            createdAt: view.createdAt,
            updatedAt: view.updatedAt,
            secretRotatedAt: view.secretRotatedAt,
            lastSeenAt: view.lastSeenAt,
            minute: minutes[index] ?? { reads: 0, hookReads: 0 },
            usage: { ...counts, readsByTool: counts.readsByTool.map((entry) => ({ ...entry })) },
          };
        }),
        window,
        limits: [
          {
            key: "mcp.connections",
            value: MCP_CONNECTION_MAXIMUM,
            used: connections.filter(({ status }) => status !== "revoked").length,
          },
          {
            key: "mcp.connection.name_characters",
            value: MCP_CONNECTION_NAME_MAXIMUM,
            used: Math.max(
              0,
              ...connections
                .filter(({ status }) => status !== "revoked")
                .map(({ name }) => [...name].length),
            ),
          },
          { key: "mcp.request.body_bytes", value: MCP_READ_BODY_LIMIT, used: null },
          {
            key: "mcp.reads_per_minute",
            value: AUTHORIZED_PER_MINUTE,
            used: Math.max(0, ...minutes.map(({ reads }) => reads)),
          },
          {
            key: "mcp.hook_reads_per_minute",
            value: this.#options.hookReadsPerMinute,
            used: Math.max(0, ...minutes.map(({ hookReads }) => hookReads)),
          },
        ],
        addressPath: MCP_CONNECTION_ADDRESS_PATH,
        generatedAt: now,
      },
    };
  }

  async execute(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly command: GatewayV2Command;
  }): Promise<{ resultRef: string; replayed: boolean }> {
    const { authentication, command } = input;
    const now = this.#options.clock.now();
    if (command.type === "mcp.connection.create") {
      const scope = this.#scope(authentication, command.scope);
      askFirstOnly(command.payload.pushPolicy);
      const id = mcpConnectionIdFor(scope, command.idempotencyKey);
      const created = async () =>
        (await this.#options.store.list(scope)).some((connection) => connection.id === id);
      if (await created()) return { resultRef: id, replayed: true };
      const secret = newMcpConnectionSecret();
      const record = await this.#options.store
        .create({
          ...scope,
          id,
          name: command.payload.name,
          secretSha256: mcpConnectionSecretDigest(secret),
          capabilities: command.payload.capabilities,
          readCeiling: command.payload.readCeiling,
          pushPolicy: command.payload.pushPolicy,
          createdAt: now,
        })
        .catch(async (error: unknown) => {
          if (await created()) return null;
          throw error;
        });
      if (record === null) return { resultRef: id, replayed: true };
      this.#options.addresses.hold(record.id, secret);
      return { resultRef: record.id, replayed: false };
    }
    if (command.type === "mcp.connection.change") {
      const scope = this.#scope(authentication, command.scope);
      const { connectionId, name, capabilities, readCeiling, pushPolicy, status } = command.payload;
      if (pushPolicy !== null) askFirstOnly(pushPolicy);
      if (
        name === null &&
        capabilities === null &&
        readCeiling === null &&
        pushPolicy === null &&
        status === null
      )
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "MCP_CONNECTION_CHANGE_EMPTY",
        );
      const change: McpConnectionChange = {
        ...scope,
        id: connectionId,
        updatedAt: now,
        ...(name === null ? {} : { name }),
        ...(capabilities === null ? {} : { capabilities }),
        ...(readCeiling === null ? {} : { readCeiling }),
        ...(pushPolicy === null ? {} : { pushPolicy }),
        ...(status === null ? {} : { status }),
      };
      const changed = await this.#options.store.change(change);
      if (!changed)
        throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MCP_CONNECTION_NOT_FOUND");
      if (changed.status === "revoked") this.#options.addresses.drop(changed.id);
      return { resultRef: changed.id, replayed: false };
    }
    if (command.type === "mcp.connection.rotate") {
      const scope = this.#scope(authentication, command.scope);
      const secret = newMcpConnectionSecret();
      const rotated = await this.#options.store.rotateSecret({
        ...scope,
        id: command.payload.connectionId,
        secretSha256: mcpConnectionSecretDigest(secret),
        rotatedAt: now,
      });
      if (!rotated)
        throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MCP_CONNECTION_NOT_FOUND");
      this.#options.addresses.hold(rotated.id, secret);
      return { resultRef: rotated.id, replayed: false };
    }
    throw new Error("MCP_CONNECTIONS_OPERATION_NOT_INSTALLED");
  }
}

function askFirstOnly(pushPolicy: string): void {
  if (pushPolicy !== "ask")
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "MCP_CONNECTION_PUSH_POLICY_NOT_AVAILABLE",
    );
}

export interface McpConnectionAddressRouteOptions {
  readonly authentication: HttpGatewayAuthenticationPort;
  readonly sessionCookieName: string;
  readonly ownerId: ProductConfiguration["ownerId"];
  readonly addresses: McpConnectionAddresses;
}

const CONNECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function registerMcpConnectionAddressRoute(
  app: FastifyInstance,
  options: McpConnectionAddressRouteOptions,
): void {
  app.get(
    MCP_CONNECTION_ADDRESS_PATH,
    { exposeHeadRoute: false, logLevel: "silent" },
    async (request, reply) => {
      reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
      const site = request.headers["sec-fetch-site"];
      if (site !== undefined && site !== "same-origin" && site !== "none")
        return reply.code(403).send();
      const authentication = await authenticateHttpRequest(request, options).catch(() => undefined);
      if (!authentication || authentication.ownerId !== options.ownerId)
        return reply.code(401).send();
      const connectionId = (request.query as Record<string, unknown> | null)?.["connectionId"];
      if (typeof connectionId !== "string" || !CONNECTION_ID_PATTERN.test(connectionId))
        return reply.code(400).send();
      const secret = options.addresses.take(connectionId);
      if (secret === null) return reply.code(404).send();
      return reply.code(200).send({ connectionId, path: `${MCP_READ_PATH}/${secret}` });
    },
  );
}
