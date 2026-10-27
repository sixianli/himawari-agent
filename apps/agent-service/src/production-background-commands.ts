import { createHash } from "node:crypto";
import type {
  RuntimeBackgroundCommandNotice,
  RuntimeToolExecutionResult,
  RuntimeToolInvocation,
} from "@himawari-agent/application";

export const BACKGROUND_COMMAND_REF_PREFIX = "background-command:";
const NOTICE_OUTPUT_CHARACTERS = 16384;
const COMMAND_PREVIEW_CHARACTERS = 300;
const STOP_SETTLE_MS = 15_000;
const DEFAULT_OUTPUT_LIMIT = 8192;
const MAXIMUM_OUTPUT_LIMIT = 32768;

export const DEFAULT_COMMAND_WAIT_MS = 30_000;
export const DEFAULT_BACKGROUND_COMMAND_MS = 1_800_000;

export interface BackgroundCommandLimits {
  readonly waitMs: number;
  readonly maximumMs: number;
}

export function backgroundCommandLimits(deadlines: {
  readonly commandWaitMs?: number;
  readonly backgroundCommandMs?: number;
}): BackgroundCommandLimits {
  const maximumMs = deadlines.backgroundCommandMs ?? DEFAULT_BACKGROUND_COMMAND_MS;
  return {
    waitMs: Math.min(deadlines.commandWaitMs ?? DEFAULT_COMMAND_WAIT_MS, maximumMs),
    maximumMs,
  };
}

type CommandState = "running" | "finished" | "stopped";

interface BackgroundCommand {
  readonly taskRef: string;
  readonly runId: string;
  readonly command: string;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  state: CommandState;
  stopReason: "requested" | "run_ended" | null;
  result: RuntimeToolExecutionResult | null;
  endedAt: number | null;
}

type Receipt = (value: unknown) => Promise<{ readonly ref: string }>;

export class ProductionBackgroundCommands {
  readonly #limits: BackgroundCommandLimits;
  readonly #now: () => string;
  readonly #commands = new Map<string, BackgroundCommand>();
  readonly #listeners = new Map<string, (notice: RuntimeBackgroundCommandNotice) => void>();
  readonly #pending = new Map<string, RuntimeBackgroundCommandNotice[]>();

  constructor(options: { readonly limits: BackgroundCommandLimits; readonly now: () => string }) {
    if (
      !Number.isSafeInteger(options.limits.waitMs) ||
      !Number.isSafeInteger(options.limits.maximumMs) ||
      options.limits.waitMs < 1 ||
      options.limits.maximumMs < options.limits.waitMs
    )
      throw new TypeError("BACKGROUND_COMMAND_LIMITS_INVALID");
    this.#limits = options.limits;
    this.#now = options.now;
  }

  get maximumMs(): number {
    return this.#limits.maximumMs;
  }

  async run(
    invocation: RuntimeToolInvocation,
    signal: AbortSignal | undefined,
    execute: (signal: AbortSignal) => Promise<RuntimeToolExecutionResult>,
    receipt: Receipt,
  ): Promise<RuntimeToolExecutionResult> {
    const controller = new AbortController();
    const startedAt = Date.parse(this.#now());
    const result = execute(
      signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const early = await Promise.race([
      result.then((value) => ({ value })),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), this.#limits.waitMs);
      }),
    ]).finally(() => clearTimeout(timer));
    if (early) return early.value;
    if (signal?.aborted) return result;
    const taskRef = `${BACKGROUND_COMMAND_REF_PREFIX}${createHash("sha256")
      .update(JSON.stringify([invocation.runId, invocation.toolCallId]))
      .digest("hex")
      .slice(0, 24)}`;
    const deadlineAt = Math.min(
      startedAt + this.#limits.maximumMs,
      invocation.executionDeadlineAt === undefined
        ? Number.POSITIVE_INFINITY
        : Date.parse(invocation.executionDeadlineAt),
    );
    const command =
      typeof invocation.arguments["command"] === "string" ? invocation.arguments["command"] : "";
    const task: BackgroundCommand = {
      taskRef,
      runId: invocation.runId,
      command,
      startedAt,
      deadlineAt,
      controller,
      settled: result.then(
        (value) => this.#finish(task, value),
        () => this.#finish(task, null),
      ),
      state: "running",
      stopReason: null,
      result: null,
      endedAt: null,
    };
    this.#commands.set(taskRef, task);
    const saved = await receipt({
      taskRef,
      command,
      startedAt: new Date(startedAt).toISOString(),
      deadlineAt: new Date(deadlineAt).toISOString(),
    });
    return {
      outcome: "succeeded",
      dispatchState: "accepted",
      resultRef: saved.ref,
      errorCode: null,
      externalActionId: null,
      modelContent: [
        `命令运行超过 ${Math.round(this.#limits.waitMs / 1000)} 秒还没结束，已转入后台继续运行，没有被停止。`,
        `任务编号：${taskRef}`,
        "命令结束时系统会自动把结果发给你，不需要反复查询状态；在此期间可以先做别的事。",
        "需要时用 execution_task_status 查看状态，用 execution_task_cancel 停止；命令结束后可用 execution_task_output 分页读取输出。",
        `这条命令最晚运行到 ${new Date(deadlineAt).toISOString()}，到时还没结束会被停止。本轮回答结束时，仍在运行的后台命令也会被停止。`,
      ].join("\n"),
    };
  }

  manages(invocation: RuntimeToolInvocation): boolean {
    const ref = invocation.arguments["resourceRef"];
    return typeof ref === "string" && ref.startsWith(BACKGROUND_COMMAND_REF_PREFIX);
  }

  async manage(
    invocation: RuntimeToolInvocation,
    receipt: Receipt,
  ): Promise<RuntimeToolExecutionResult> {
    const action = invocation.capabilityRef.replace("execution.task.", "");
    const args = invocation.arguments;
    const allowed = ["resourceRef", ...(action === "output" ? ["cursor", "limit"] : [])];
    const cursor = args["cursor"] ?? null;
    const limit = args["limit"] ?? DEFAULT_OUTPUT_LIMIT;
    const offset = cursor === null ? 0 : Number(cursor);
    if (
      !["status", "output", "cancel"].includes(action) ||
      Object.keys(args).some((name) => !allowed.includes(name)) ||
      (cursor !== null && (typeof cursor !== "string" || !/^\d{1,9}$/.test(cursor))) ||
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAXIMUM_OUTPUT_LIMIT
    )
      return refused("MANAGED_TASK_INPUT_INVALID", "参数不正确，没有执行任何操作。");
    const task = this.#commands.get(String(args["resourceRef"]));
    if (!task || task.runId !== invocation.runId)
      return refused(
        "BACKGROUND_COMMAND_NOT_FOUND",
        "找不到这个后台命令。只能管理本轮回答里转入后台的命令；本轮结束后它们已被停止。",
      );
    if (action === "cancel" && task.state === "running") {
      task.stopReason = "requested";
      task.controller.abort();
      await settleWithin(task.settled, STOP_SETTLE_MS);
    }
    const value = action === "output" ? this.#output(task, offset, limit) : this.#status(task);
    const saved = await receipt(value);
    return {
      outcome: "succeeded",
      dispatchState: "accepted",
      resultRef: saved.ref,
      errorCode: null,
      externalActionId: null,
      modelContent: JSON.stringify(value),
    };
  }

  running(runId: string): number {
    let count = 0;
    for (const task of this.#commands.values())
      if (task.runId === runId && task.state === "running") count++;
    return count;
  }

  subscribe(runId: string, listener: (notice: RuntimeBackgroundCommandNotice) => void): () => void {
    this.#listeners.set(runId, listener);
    const pending = this.#pending.get(runId) ?? [];
    this.#pending.delete(runId);
    for (const notice of pending) listener(notice);
    return () => {
      if (this.#listeners.get(runId) === listener) this.#listeners.delete(runId);
    };
  }

  async stopRun(runId: string): Promise<void> {
    const tasks = [...this.#commands.values()].filter((task) => task.runId === runId);
    for (const task of tasks)
      if (task.state === "running") {
        task.stopReason = "run_ended";
        task.controller.abort();
      }
    await settleWithin(Promise.allSettled(tasks.map((task) => task.settled)), STOP_SETTLE_MS);
    for (const task of tasks) this.#commands.delete(task.taskRef);
    this.#pending.delete(runId);
    this.#listeners.delete(runId);
  }

  #finish(task: BackgroundCommand, result: RuntimeToolExecutionResult | null) {
    task.result = result;
    task.endedAt = Date.parse(this.#now());
    task.state = task.stopReason ? "stopped" : "finished";
    if (task.stopReason === "run_ended") return;
    const notice = { taskRef: task.taskRef, modelContent: this.#notice(task) };
    const listener = this.#listeners.get(task.runId);
    if (listener) listener(notice);
    else this.#pending.set(task.runId, [...(this.#pending.get(task.runId) ?? []), notice]);
  }

  #notice(task: BackgroundCommand): string {
    const content = task.result?.modelContent ?? "";
    const shown = content.slice(0, NOTICE_OUTPUT_CHARACTERS);
    return [
      `后台命令已结束（任务编号 ${task.taskRef}）。`,
      `命令：${task.command.slice(0, COMMAND_PREVIEW_CHARACTERS)}`,
      `用时：${Math.round(((task.endedAt ?? task.startedAt) - task.startedAt) / 1000)} 秒`,
      `结果：${outcomeText(task)}`,
      "输出：",
      shown,
      ...(content.length > shown.length
        ? [
            `输出较长，以上是前 ${shown.length} 个字符；用 execution_task_output 并把 cursor 设为 "${shown.length}" 读取后面的部分。`,
          ]
        : []),
    ].join("\n");
  }

  #status(task: BackgroundCommand) {
    return {
      resourceRef: task.taskRef,
      status: task.state,
      outcome: task.state === "running" ? null : outcomeText(task),
      errorCode: task.result?.errorCode ?? null,
      command: task.command.slice(0, COMMAND_PREVIEW_CHARACTERS),
      startedAt: new Date(task.startedAt).toISOString(),
      endedAt: task.endedAt === null ? null : new Date(task.endedAt).toISOString(),
      elapsedSeconds: Math.round(
        ((task.endedAt ?? Date.parse(this.#now())) - task.startedAt) / 1000,
      ),
      deadlineAt: new Date(task.deadlineAt).toISOString(),
    };
  }

  #output(task: BackgroundCommand, offset: number, limit: number) {
    if (task.state === "running")
      return {
        resourceRef: task.taskRef,
        status: task.state,
        text: "",
        nextCursor: null,
        end: false,
        note: "命令还在运行。输出要等命令结束后才能读取；结束时系统会自动把结果发给你。",
      };
    const content = task.result?.modelContent ?? "";
    const text = content.slice(offset, offset + limit);
    const next = offset + text.length;
    return {
      resourceRef: task.taskRef,
      status: task.state,
      text,
      nextCursor: next < content.length ? String(next) : null,
      end: next >= content.length,
      totalCharacters: content.length,
    };
  }
}

function outcomeText(task: BackgroundCommand): string {
  if (task.stopReason === "requested") return "已按你的要求停止，命令可能只执行了一部分。";
  const result = task.result;
  if (!result || result.outcome === "result_unknown")
    return `结果未知（${result?.errorCode ?? "BACKGROUND_COMMAND_RESULT_UNKNOWN"}），不要直接重复执行，先核实已经产生的效果。`;
  if (result.outcome === "awaiting_approval") return "等待批准，命令没有执行。";
  return result.outcome === "succeeded"
    ? "命令已运行结束"
    : `失败（${result.errorCode ?? "未知错误"}）`;
}

function refused(errorCode: string, modelContent: string): RuntimeToolExecutionResult {
  return {
    outcome: "failed",
    dispatchState: "not_sent",
    resultRef: null,
    errorCode,
    externalActionId: null,
    modelContent,
  };
}

async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
