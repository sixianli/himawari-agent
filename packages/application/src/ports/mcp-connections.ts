import type { AgentId, OwnerId } from "@himawari-agent/domain";

export const MCP_CONNECTION_STATUSES = ["active", "paused", "revoked"] as const;
export type McpConnectionStatus = (typeof MCP_CONNECTION_STATUSES)[number];

export const MCP_CONNECTION_READ_CEILINGS = ["public", "private", "sensitive"] as const;
export type McpConnectionReadCeiling = (typeof MCP_CONNECTION_READ_CEILINGS)[number];

export const MCP_CONNECTION_DEFAULT_READ_CEILING: McpConnectionReadCeiling = "private";

export const MCP_CONNECTION_PUSH_POLICIES = ["ask", "direct"] as const;
export type McpConnectionPushPolicy = (typeof MCP_CONNECTION_PUSH_POLICIES)[number];

export const MCP_CONNECTION_CAPABILITIES = ["command_hooks", "mcp", "scheduled_tasks"] as const;
export type McpConnectionCapability = (typeof MCP_CONNECTION_CAPABILITIES)[number];

export const MCP_CONNECTION_ENTRIES = ["oauth", "service_token"] as const;
export type McpConnectionEntry = (typeof MCP_CONNECTION_ENTRIES)[number];

export const MCP_USAGE_COUNTERS = [
  "calls",
  "delivered",
  "empty",
  "failed",
  "rate_limited",
] as const;
export type McpUsageCounter = (typeof MCP_USAGE_COUNTERS)[number];

export const MCP_CONNECTION_MAXIMUM = 200;
export const MCP_CONNECTION_NAME_MAXIMUM = 64;
export const MCP_CONNECTION_REPORTED_CLIENT_MAXIMUM = 64;

export function mcpConnectionNameHasHiddenCharacter(name: string): boolean {
  return [...name].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x2064) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff ||
      (code >= 0xe0000 && code <= 0xe007f)
    );
  });
}

export interface McpConnectionScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface McpConnectionRecord extends McpConnectionScope {
  readonly id: string;
  readonly name: string;
  readonly capabilities: readonly McpConnectionCapability[];
  readonly readCeiling: McpConnectionReadCeiling;
  readonly pushPolicy: McpConnectionPushPolicy;
  readonly status: McpConnectionStatus;
  readonly reportedClient: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly secretRotatedAt: string | null;
  readonly lastSeenAt: string | null;
}

export interface McpConnectionCreate extends McpConnectionScope {
  readonly id: string;
  readonly name: string;
  readonly secretSha256: string;
  readonly capabilities: readonly McpConnectionCapability[];
  readonly readCeiling: McpConnectionReadCeiling;
  readonly pushPolicy: McpConnectionPushPolicy;
  readonly createdAt: string;
}

export interface McpConnectionChange extends McpConnectionScope {
  readonly id: string;
  readonly updatedAt: string;
  readonly name?: string;
  readonly capabilities?: readonly McpConnectionCapability[];
  readonly readCeiling?: McpConnectionReadCeiling;
  readonly pushPolicy?: McpConnectionPushPolicy;
  readonly status?: McpConnectionStatus;
}

export interface McpConnectionUsageKey {
  readonly connectionId: string;
  readonly day: string;
  readonly tool: string;
  readonly entry: McpConnectionEntry;
  readonly auto: boolean;
}

export interface McpConnectionUsageAdd extends McpConnectionScope, McpConnectionUsageKey {
  readonly counts: Readonly<Partial<Record<McpUsageCounter, number>>>;
}

export interface McpConnectionUsageRow extends McpConnectionUsageKey {
  readonly counter: McpUsageCounter;
  readonly value: number;
}

export interface McpConnectionStorePort {
  create(input: McpConnectionCreate): Promise<McpConnectionRecord>;
  list(scope: McpConnectionScope): Promise<readonly McpConnectionRecord[]>;
  read(input: McpConnectionScope & { readonly id: string }): Promise<McpConnectionRecord | null>;
  findBySecret(
    input: McpConnectionScope & { readonly secretSha256: string },
  ): Promise<McpConnectionRecord | null>;
  change(input: McpConnectionChange): Promise<McpConnectionRecord | null>;
  rotateSecret(
    input: McpConnectionScope & {
      readonly id: string;
      readonly secretSha256: string;
      readonly rotatedAt: string;
    },
  ): Promise<McpConnectionRecord | null>;
  touch(
    input: McpConnectionScope & {
      readonly id: string;
      readonly seenAt: string;
      readonly reportedClient: string | null;
    },
  ): Promise<void>;
  addUsage(input: McpConnectionUsageAdd): Promise<void>;
  usage(
    input: McpConnectionScope & { readonly fromDay: string; readonly toDay: string },
  ): Promise<readonly McpConnectionUsageRow[]>;
}
