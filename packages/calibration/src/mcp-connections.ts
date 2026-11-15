export const MCP_USAGE_WINDOW_DAYS = 7;

export interface McpUsageCountRow {
  readonly connectionId: string;
  readonly day: string;
  readonly tool: string;
  readonly auto: boolean;
  readonly counter: string;
  readonly value: number;
}

export interface McpToolKinds {
  readonly reads: readonly string[];
  readonly memoryPushes: readonly string[];
  readonly ruleProposals: readonly string[];
}

export interface McpToolCalls {
  readonly tool: string;
  readonly calls: number;
}

export interface McpConnectionUsage {
  readonly connectionId: string;
  readonly reads: number;
  readonly readsByTool: readonly McpToolCalls[];
  readonly delivered: number;
  readonly empty: number;
  readonly autoReads: number;
  readonly autoDelivered: number;
  readonly modelReads: number;
  readonly memoryPushes: number;
  readonly ruleProposals: number;
  readonly ruleProposalsRateLimited: number;
  readonly failed: number;
  readonly rateLimited: number;
}

interface Tally {
  reads: number;
  readsByTool: Map<string, number>;
  delivered: number;
  empty: number;
  autoReads: number;
  autoDelivered: number;
  modelReads: number;
  memoryPushes: number;
  ruleProposals: number;
  ruleProposalsRateLimited: number;
  failed: number;
  rateLimited: number;
}

function emptyTally(): Tally {
  return {
    reads: 0,
    readsByTool: new Map(),
    delivered: 0,
    empty: 0,
    autoReads: 0,
    autoDelivered: 0,
    modelReads: 0,
    memoryPushes: 0,
    ruleProposals: 0,
    ruleProposalsRateLimited: 0,
    failed: 0,
    rateLimited: 0,
  };
}

export function mcpUsageWindow(today: string, days = MCP_USAGE_WINDOW_DAYS) {
  const end = Date.parse(`${today}T00:00:00.000Z`);
  if (!Number.isFinite(end) || !Number.isSafeInteger(days) || days < 1)
    throw new Error("MCP_USAGE_WINDOW_INVALID");
  const fromDay = new Date(end - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { fromDay, toDay: today, days } as const;
}

export function summarizeMcpUsage(
  connectionIds: readonly string[],
  rows: readonly McpUsageCountRow[],
  kinds: McpToolKinds,
  window: { readonly fromDay: string; readonly toDay: string },
): readonly McpConnectionUsage[] {
  const reads = new Set(kinds.reads);
  const pushes = new Set(kinds.memoryPushes);
  const rules = new Set(kinds.ruleProposals);
  const tallies = new Map(connectionIds.map((id) => [id, emptyTally()]));
  for (const row of rows) {
    if (row.day < window.fromDay || row.day > window.toDay) continue;
    const tally = tallies.get(row.connectionId);
    if (!tally) continue;
    const value = row.value;
    if (row.counter === "failed") tally.failed += value;
    if (row.counter === "rate_limited") {
      if (rules.has(row.tool)) tally.ruleProposalsRateLimited += value;
      else tally.rateLimited += value;
    }
    if (reads.has(row.tool)) {
      if (row.counter === "calls") {
        tally.reads += value;
        tally.readsByTool.set(row.tool, (tally.readsByTool.get(row.tool) ?? 0) + value);
        if (row.auto) tally.autoReads += value;
        else tally.modelReads += value;
      }
      if (row.counter === "delivered") {
        tally.delivered += value;
        if (row.auto) tally.autoDelivered += value;
      }
      if (row.counter === "empty") tally.empty += value;
    }
    if (row.counter === "calls" && pushes.has(row.tool)) tally.memoryPushes += value;
    if (row.counter === "calls" && rules.has(row.tool)) tally.ruleProposals += value;
  }
  return connectionIds.map((connectionId) => {
    const tally = tallies.get(connectionId) ?? emptyTally();
    return Object.freeze({
      connectionId,
      reads: tally.reads,
      readsByTool: Object.freeze(
        kinds.reads.map((tool) => ({ tool, calls: tally.readsByTool.get(tool) ?? 0 })),
      ),
      delivered: tally.delivered,
      empty: tally.empty,
      autoReads: tally.autoReads,
      autoDelivered: tally.autoDelivered,
      modelReads: tally.modelReads,
      memoryPushes: tally.memoryPushes,
      ruleProposals: tally.ruleProposals,
      ruleProposalsRateLimited: tally.ruleProposalsRateLimited,
      failed: tally.failed,
      rateLimited: tally.rateLimited,
    });
  });
}
