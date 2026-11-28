import {
  ApplicationPortError,
  type ClockPort,
  type GatewayAuthenticationContext,
  type GatewayV2QueryContext,
  MCP_CONNECTION_MAXIMUM,
  MCP_CONNECTION_NAME_MAXIMUM,
  type McpConnectionChange,
  type McpConnectionStorePort,
  type McpOAuthRegistration,
  PORT_ERROR_CODES,
  type ProductConfiguration,
} from "@himawari-agent/application";
import { mcpUsageWindow, summarizeMcpUsage } from "@himawari-agent/calibration/mcp-connections";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
import { AUTHORIZED_PER_MINUTE } from "./bearer-admission.js";
import {
  MCP_DEFAULT_PUSH_POLICY,
  type ProductionMcpAuthorization,
} from "./production-mcp-authorization.js";
import { mcpConnectionView, mcpUsageDay } from "./production-mcp-connections.js";
import {
  MCP_READ_BODY_LIMIT,
  MCP_READ_TOOL_NAMES,
  MCP_WRITE_TOOL_NAMES,
} from "./production-mcp-read.js";

export const PRODUCTION_MCP_CONNECTION_OPERATIONS = Object.freeze([
  "mcp.connections.read",
  "mcp.connection.change",
  "mcp.grants.read",
  "mcp.grant.approve",
  "mcp.grant.deny",
] as const);

export const MCP_TOOL_KINDS = Object.freeze({
  reads: MCP_READ_TOOL_NAMES,
  memoryPushes: MCP_WRITE_TOOL_NAMES.filter((name) => name !== "propose_rule"),
  ruleProposals: MCP_WRITE_TOOL_NAMES.filter((name) => name === "propose_rule"),
});

export interface ProductionMcpConnectionsControlOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly store: McpConnectionStorePort;
  readonly authorization: Pick<ProductionMcpAuthorization, "pendingGrants" | "approve" | "deny">;
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
    if (query.type === "mcp.grants.read") {
      this.#scope(context?.authentication, query.scope);
      const grants = await this.#options.authorization.pendingGrants();
      return {
        ...query,
        kind: "snapshot",
        type: "mcp.grants.snapshot",
        actor: { actorType: "system", actorId: "agent-service" },
        payload: {
          grants: grants.map((grant) => ({
            id: grant.id,
            clientName: grant.clientName,
            registration: grant.registration,
            clientHost: grant.clientHost,
            redirectHost: grant.redirectHost,
            localRedirect: grant.localRedirect,
            wantsWrite: grant.wantsWrite,
            existingConnection: grant.existingConnection ? { ...grant.existingConnection } : null,
            createdAt: grant.createdAt,
            expiresAt: grant.expiresAt,
          })),
          defaults: {
            pushPolicy: MCP_DEFAULT_PUSH_POLICY,
          },
          generatedAt: this.#options.clock.now(),
        },
      };
    }
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
            pushPolicy: view.pushPolicy,
            status: view.status,
            reportedClient: view.reportedClient,
            createdAt: view.createdAt,
            updatedAt: view.updatedAt,
            registration: registrationOf(view.oauthClientId),
            clientHost: clientHostOf(view.oauthClientId),
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
    if (command.type === "mcp.grant.approve") {
      this.#scope(authentication, command.scope);
      const { grantId, name, pushPolicy, write } = command.payload;
      const connectionId = await this.#options.authorization.approve({
        grantId,
        name,
        pushPolicy,
        write,
      });
      return { resultRef: connectionId, replayed: false };
    }
    if (command.type === "mcp.grant.deny") {
      this.#scope(authentication, command.scope);
      this.#options.authorization.deny(command.payload.grantId);
      return { resultRef: command.payload.grantId, replayed: false };
    }
    if (command.type === "mcp.connection.change") {
      const scope = this.#scope(authentication, command.scope);
      const { connectionId, name, capabilities, pushPolicy, status } = command.payload;
      if (name === null && capabilities === null && pushPolicy === null && status === null)
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
        ...(pushPolicy === null ? {} : { pushPolicy }),
        ...(status === null ? {} : { status }),
      };
      const changed = await this.#options.store.change(change);
      if (!changed)
        throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MCP_CONNECTION_NOT_FOUND");
      return { resultRef: changed.id, replayed: false };
    }
    throw new Error("MCP_CONNECTIONS_OPERATION_NOT_INSTALLED");
  }
}

function registrationOf(clientId: string | null): McpOAuthRegistration | null {
  if (clientId === null) return null;
  return clientId.startsWith("https://") ? "metadata_document" : "dynamic";
}

function clientHostOf(clientId: string | null): string | null {
  if (clientId === null || !clientId.startsWith("https://") || !URL.canParse(clientId)) return null;
  return new URL(clientId).host;
}
