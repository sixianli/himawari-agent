import type { ThreadExecutionRecord } from "@himawari-agent/gateway-contracts";
import type { RunSummary } from "../src/execution-view.js";

export const runStart = Date.parse("2026-10-26T12:23:57.695Z");
export const at = (milliseconds: number) => new Date(runStart + milliseconds).toISOString();
let sequence = 0;
const record = (
  milliseconds: number,
  overrides: Partial<ThreadExecutionRecord>,
): ThreadExecutionRecord => {
  sequence += 1;
  return {
    id: `event:${sequence}`,
    itemId: `event:${sequence}`,
    sequence,
    kind: "status",
    phase: "updated",
    name: "runtime.turn_started",
    text: "",
    input: "",
    output: "",
    activity: "",
    activityIcon: "",
    occurredAt: at(milliseconds),
    ...overrides,
  };
};
const status = (milliseconds: number, name: string, phase: ThreadExecutionRecord["phase"]) =>
  record(milliseconds, { name, phase });
const message = (
  milliseconds: number,
  itemId: string,
  phase: ThreadExecutionRecord["phase"],
  text: string,
) => record(milliseconds, { kind: "message", itemId, phase, name: "deepseek-v4-flash", text });
const toolCall = (messageRecord: ThreadExecutionRecord, index: number, itemId: string) => ({
  ...messageRecord,
  id: `${messageRecord.id}:call:${index}`,
  itemId,
  kind: "tool" as const,
  phase: "updated" as const,
  name: "web_search",
  text: "",
  input: '{"query":"US news"}',
});
const tool = (milliseconds: number, itemId: string, phase: ThreadExecutionRecord["phase"]) =>
  record(milliseconds, { kind: "tool", itemId, phase, name: "web_search" });
const toolExecution = (milliseconds: number, itemId: string, edge: "started" | "ended") =>
  record(milliseconds, { itemId, name: `runtime.tool_execution.${edge}` });

export function newsRun() {
  sequence = 0;
  const records: ThreadExecutionRecord[] = [
    status(647, "memory.query", "updated"),
    record(2117, { name: "memory.selection", phase: "completed", text: "2" }),
    record(2138, { name: "context.formed", phase: "completed", text: "1" }),
    status(2339, "deepseek-v4-flash", "started"),
    status(2340, "runtime.turn_started", "updated"),
    message(2341, "message:first", "updated", ""),
    message(4193, "message:first", "updated", "我来搜索"),
  ];
  const narration = message(5104, "message:first", "completed", "我来搜索最新的美国新闻。");
  records.push(
    narration,
    toolCall(narration, 0, "tool:zh"),
    toolCall(narration, 1, "tool:en"),
    tool(5108, "tool:zh", "started"),
    tool(5116, "tool:en", "started"),
    status(7529, "runtime.suspended", "waiting"),
    status(15957, "deepseek-v4-flash", "started"),
    status(15958, "runtime.turn_started", "updated"),
  );
  const resumed = message(15960, "message:resumed", "completed", "");
  records.push(
    resumed,
    toolCall(resumed, 0, "tool:zh"),
    toolCall(resumed, 1, "tool:en"),
    tool(15961, "tool:zh", "started"),
    tool(15962, "tool:en", "started"),
    toolExecution(16200, "tool:zh", "started"),
    toolExecution(16300, "tool:en", "started"),
    toolExecution(18700, "tool:zh", "ended"),
    toolExecution(18800, "tool:en", "ended"),
    tool(18813, "tool:zh", "completed"),
    tool(18890, "tool:en", "completed"),
    status(18893, "runtime.turn_started", "updated"),
    record(19600, { itemId: "thinking:last", name: "runtime.thinking.started" }),
    record(21000, { itemId: "thinking:last", name: "runtime.thinking.ended" }),
    record(21800, { itemId: "text:last", name: "runtime.text.started" }),
    message(22400, "message:last", "updated", "以下是今天的美国新闻"),
    message(25473, "message:last", "completed", "以下是今天的美国新闻……".repeat(10)),
    status(25721, "runtime.completed", "completed"),
  );
  return records;
}
export const completedRun: RunSummary = {
  runId: "run:news",
  revision: 3,
  status: "completed",
  createdAt: at(0),
  updatedAt: at(27082),
  background: null,
  backgroundCommands: [],
};

export function gameRun(until = Number.POSITIVE_INFINITY) {
  sequence = 0;
  const writing = (milliseconds: number, lines: number) => {
    const streamed = record(milliseconds, {
      kind: "tool",
      itemId: "tool:write",
      phase: "updated",
      name: "write",
      input: '{"path":"game.html"}',
    });
    return [
      streamed,
      {
        ...streamed,
        id: `${streamed.id}:writing`,
        kind: "status" as const,
        name: "runtime.tool_call.writing",
        input: "",
        text: String(lines),
      },
    ];
  };
  const records: ThreadExecutionRecord[] = [
    status(100, "memory.query", "updated"),
    status(1500, "deepseek-v4-flash", "started"),
    status(1501, "runtime.turn_started", "updated"),
    message(1600, "message:game", "updated", ""),
    record(5300, { itemId: "thinking:game", name: "runtime.thinking.started" }),
    record(20400, { itemId: "thinking:game", name: "runtime.thinking.ended" }),
    record(20500, { itemId: "output:game", name: "runtime.tool_call.started" }),
    ...writing(20600, 10),
    ...writing(30000, 200),
    ...writing(45000, 400),
  ];
  const finished = message(45800, "message:game", "completed", "");
  records.push(
    finished,
    {
      ...finished,
      id: `${finished.id}:call:1`,
      itemId: "tool:write",
      kind: "tool",
      phase: "updated",
      name: "write",
      text: "",
      input: '{"path":"game.html","content":"<html>"}',
    },
    record(45900, { kind: "tool", itemId: "tool:write", phase: "started", name: "write" }),
    toolExecution(46000, "tool:write", "started"),
    toolExecution(50000, "tool:write", "ended"),
    record(50400, { kind: "tool", itemId: "tool:write", phase: "completed", name: "write" }),
    status(52000, "runtime.completed", "completed"),
  );
  return records.filter((item) => Date.parse(item.occurredAt) - runStart <= until);
}
