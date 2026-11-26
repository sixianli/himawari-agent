import { randomBytes } from "node:crypto";
import type {
  McpConnectionEntry,
  McpConnectionRecord,
  McpConnectionScope,
  McpConnectionStorePort,
  McpUsageCounter,
} from "@himawari-agent/application";

export const MCP_CONNECTION_SUBJECT_PREFIX = "mcp-connection:";

export function newMcpConnectionId(): string {
  return `conn-${randomBytes(12).toString("hex")}`;
}

export function mcpConnectionSubject(connectionId: string): string {
  return `${MCP_CONNECTION_SUBJECT_PREFIX}${connectionId}`;
}

export function mcpUsageDay(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export interface McpUsageRecorder {
  readonly connections: Pick<McpConnectionStorePort, "addUsage" | "touch">;
  readonly scope: McpConnectionScope;
  readonly timeZone: string;
  readonly now: () => string;
  readonly onFailure: (error: unknown) => void;
}

export async function recordMcpUsage(
  recorder: McpUsageRecorder,
  usage: {
    readonly connectionId: string;
    readonly entry: McpConnectionEntry;
    readonly tool: string;
    readonly auto: boolean;
    readonly counts: Readonly<Partial<Record<McpUsageCounter, number>>>;
  },
): Promise<void> {
  try {
    await recorder.connections.addUsage({
      ...recorder.scope,
      ...usage,
      day: mcpUsageDay(recorder.now(), recorder.timeZone),
    });
  } catch (error) {
    recorder.onFailure(error);
  }
}

export async function touchMcpConnection(
  recorder: McpUsageRecorder,
  connectionId: string,
  reportedClient: string | null,
): Promise<void> {
  try {
    await recorder.connections.touch({
      ...recorder.scope,
      id: connectionId,
      seenAt: recorder.now(),
      reportedClient,
    });
  } catch (error) {
    recorder.onFailure(error);
  }
}

export type McpConnectionView = Omit<McpConnectionRecord, "ownerId" | "agentId">;

export function mcpConnectionView(record: McpConnectionRecord): McpConnectionView {
  const { ownerId: _ownerId, agentId: _agentId, ...view } = record;
  return view;
}
