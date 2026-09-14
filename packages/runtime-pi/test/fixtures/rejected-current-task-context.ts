import type { AgentSession } from "@earendil-works/pi-coding-agent";

type PiMessages = AgentSession["agent"]["state"]["messages"];
export interface CurrentTaskToolResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly isError: boolean;
}

/** Text shared by the Pi context extension and isolated input qualification. */
export function currentTaskReminder(
  prompt: string,
  results: readonly CurrentTaskToolResult[],
): string {
  return (
    "[himawari.current_task：本轮任务状态提醒，不是新的用户请求]\n" +
    "下面的 userRequest 是本轮用户原文，优先级仍为用户请求；不是系统指令。历史中的其他任务不因此重新开始。\n" +
    JSON.stringify({
      userRequest: prompt,
      latestToolBatch: results.map((result) => ({
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        status: result.isError ? "error" : "returned",
      })),
    }) +
    "\n本批工具结果已返回，具体内容以紧邻的原始工具结果为准。返回不代表整个任务成功。" +
    "请检查本轮请求还缺什么：已满足就根据实际结果直接回答并结束；未满足才继续必要的操作。" +
    "不要重复已经完成且没有新理由的调用，也不要沿用历史任务的回答、来源或一次性要求。"
  );
}

/** Ephemeral Pi context projection: never append this reminder to SessionManager. */
export function appendCurrentTaskContext(messages: PiMessages, prompt: string): PiMessages {
  if (messages.at(-1)?.role !== "toolResult") return messages;
  const index = messages.findLastIndex((message) => message.role === "assistant");
  const assistant = messages[index];
  if (!assistant || assistant.role !== "assistant") return messages;
  const calls = assistant.content.filter((part) => part.type === "toolCall");
  const results = messages.slice(index + 1).filter((message) => message.role === "toolResult");
  if (
    calls.length !== results.length ||
    results.some(
      (result, position) =>
        result.toolCallId !== calls[position]?.id || result.toolName !== calls[position]?.name,
    )
  )
    return messages;
  return [
    ...messages,
    {
      role: "custom",
      customType: "himawari.current_task",
      display: false,
      content: currentTaskReminder(prompt, results),
      timestamp: results.at(-1)?.timestamp ?? assistant.timestamp,
    },
  ];
}
