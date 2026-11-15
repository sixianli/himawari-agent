import {
  type GatewayV2Snapshot,
  MCP_CONNECTION_NAME_CHARACTERS,
} from "@himawari-agent/gateway-contracts";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "./gateway-client.js";
import { commandMessage, queryMessage } from "./messages.js";

export type McpConnectionsSnapshot = Extract<
  GatewayV2Snapshot,
  { type: "mcp.connections.snapshot" }
>["payload"];
export type McpConnectionItem = McpConnectionsSnapshot["connections"][number];

export const MCP_CONNECTION_OPERATIONS = [
  "mcp.connections.read",
  "mcp.connection.create",
  "mcp.connection.change",
  "mcp.connection.rotate",
] as const;

export const MCP_LOGPUSH_FIELDS_URL =
  "https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/zone/http_requests/";

export function mcpConnectionsInstalled(configuration: ControlCenterRuntimeConfiguration | null) {
  const installed = configuration?.installedGatewayV2Operations ?? [];
  return MCP_CONNECTION_OPERATIONS.every((operation) => installed.includes(operation));
}

export async function readMcpConnections(
  client: Pick<GatewayClient, "query">,
  configuration: ControlCenterRuntimeConfiguration,
): Promise<McpConnectionsSnapshot> {
  const result = await client.query(queryMessage(configuration, "mcp.connections.read", {}));
  if (result.type !== "mcp.connections.snapshot") throw new Error("MCP_CONNECTIONS_INVALID");
  return result.payload;
}

export interface McpConnectionDraft {
  readonly name: string;
  readonly capabilities: readonly ("command_hooks" | "mcp" | "scheduled_tasks")[];
  readonly readCeiling: "public" | "private" | "sensitive";
}

export async function createMcpConnection(
  client: Pick<GatewayClient, "mutate">,
  configuration: ControlCenterRuntimeConfiguration,
  draft: McpConnectionDraft,
): Promise<string> {
  const result = await client.mutate(
    commandMessage(
      configuration,
      "mcp.connection.create",
      { ...draft, capabilities: [...draft.capabilities], pushPolicy: "ask" },
      { risk: "medium" },
    ),
  );
  return result.resultRef;
}

export interface McpConnectionEdit {
  readonly name?: string;
  readonly readCeiling?: McpConnectionDraft["readCeiling"];
  readonly status?: "active" | "paused" | "revoked";
}

export async function changeMcpConnection(
  client: Pick<GatewayClient, "mutate">,
  configuration: ControlCenterRuntimeConfiguration,
  connectionId: string,
  edit: McpConnectionEdit,
): Promise<void> {
  await client.mutate(
    commandMessage(
      configuration,
      "mcp.connection.change",
      {
        connectionId,
        name: edit.name ?? null,
        capabilities: null,
        readCeiling: edit.readCeiling ?? null,
        pushPolicy: null,
        status: edit.status ?? null,
      },
      { risk: "medium" },
    ),
  );
}

export async function rotateMcpConnection(
  client: Pick<GatewayClient, "mutate">,
  configuration: ControlCenterRuntimeConfiguration,
  connectionId: string,
): Promise<void> {
  await client.mutate(
    commandMessage(configuration, "mcp.connection.rotate", { connectionId }, { risk: "medium" }),
  );
}

export async function takeMcpConnectionAddress(
  addressPath: string,
  connectionId: string,
  origin: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<string> {
  const response = await fetcher(
    `${addressPath}?connectionId=${encodeURIComponent(connectionId)}`,
    { credentials: "same-origin", cache: "no-store" },
  );
  if (!response.ok) throw new Error("MCP_CONNECTION_ADDRESS_UNAVAILABLE");
  const body = (await response.json()) as { readonly path?: unknown };
  if (typeof body.path !== "string" || !body.path.startsWith("/"))
    throw new Error("MCP_CONNECTION_ADDRESS_INVALID");
  return `${origin}${body.path}`;
}

export function withinNameLimit(value: string): string {
  const lead = value.length - value.trimStart().length;
  return (
    value.slice(0, lead) + [...value.slice(lead)].slice(0, MCP_CONNECTION_NAME_CHARACTERS).join("")
  );
}
