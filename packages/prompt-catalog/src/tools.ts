import { fixedPrompt } from "./entry.js";

export const TOOL_REMINDER_SET = fixedPrompt({
  id: "tools.reminder-set",
  purpose: "reminder_set 工具的描述：什么时候设提醒、时间怎么写、失败时怎么说",
  usedBy: ["apps/agent-service/src/production-reminder-writer.ts"],
  layer: "tools",
  output: "free-text",
  text: "给主人设一个提醒，到点会在 Himawari 网页和已开启的手机通知里提醒。主人要你提醒、别让他忘记某件事时使用，不要只写进文件或说“记住了”。text 写要提醒的事；due 写主人当地时间，有钟点写 YYYY-MM-DDTHH:MM，只有日期写 YYYY-MM-DD（当天早上 9 点提醒），按本轮请求里给出的当地时间换算“明天”“周五”；每年都有的日子（生日、纪念日）repeat 填 yearly，due 写下一次的日期，其余填 none。已过去的时间或两年以后的时间会被拒绝，此时把原因告诉主人，不要说已设好。成功后把返回的提醒时间原样告诉主人。提醒是主人自己的，可以随时取消。",
});

export const TOOL_REMINDER_LIST = fixedPrompt({
  id: "tools.reminder-list",
  purpose: "reminder_list 工具的描述",
  usedBy: ["apps/agent-service/src/production-reminder-writer.ts"],
  layer: "tools",
  output: "free-text",
  text: "列出主人还没到点的提醒（含 reminderId、事项和提醒时间）。主人问有哪些提醒，或要取消、确认某个提醒前使用。只读。",
});

export const TOOL_REMINDER_CANCEL = fixedPrompt({
  id: "tools.reminder-cancel",
  purpose: "reminder_cancel 工具的描述",
  usedBy: ["apps/agent-service/src/production-reminder-writer.ts"],
  layer: "tools",
  output: "free-text",
  text: "取消一个还没到点的提醒。reminderId 取自 reminder_set 或 reminder_list 的返回；不确定是哪一个时先用 reminder_list，不要猜。",
});

export const TOOL_RECALL = fixedPrompt({
  id: "tools.recall",
  purpose: "recall 工具的描述：什么时候查长期记忆和对话摘要",
  usedBy: ["apps/agent-service/src/production-memory-recall.ts"],
  layer: "tools",
  output: "free-text",
  text: "查主人的长期记忆和以前的对话摘要。主人问到以前说过的事、某天或某段时间发生过什么、以前的情况（换手机前、搬家前）时使用。query 写要找的内容；问到具体时间时填 from、to（YYYY-MM-DD，按主人所在时区）；问以前的情况时 includeHistory 填 true。返回的记忆带有效期，已失效的标为历史；对话摘要按日期给出。只查主人自己的记忆，不会联网。",
});

export const TOOL_TASK_STATUS = fixedPrompt({
  id: "tools.execution-task-status",
  purpose: "execution_task_status 工具的描述",
  usedBy: ["apps/agent-service/src/production-managed-tasks.ts"],
  layer: "tools",
  output: "free-text",
  text: "查询本轮转入后台的命令或已启动任务的实际状态。后台命令结束时系统会主动通知，不要反复轮询。",
});

export const TOOL_TASK_OUTPUT = fixedPrompt({
  id: "tools.execution-task-output",
  purpose: "execution_task_output 工具的描述",
  usedBy: ["apps/agent-service/src/production-managed-tasks.ts"],
  layer: "tools",
  output: "free-text",
  text: "分页读取本轮后台命令或任务已保存的输出；不会启动或重启任何命令。",
});

export const TOOL_TASK_CANCEL = fixedPrompt({
  id: "tools.execution-task-cancel",
  purpose: "execution_task_cancel 工具的描述",
  usedBy: ["apps/agent-service/src/production-managed-tasks.ts"],
  layer: "tools",
  output: "free-text",
  text: "停止本轮转入后台的命令或已启动的任务，返回实际停止或待核查状态。",
});
