import { createHash } from "node:crypto";
import type {
  RunBackgroundHold,
  RunBackgroundOutcome,
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
const KEPT_FINISHED_COMMANDS = 64;

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

export interface BackgroundCommandResult {
  readonly taskRef: string;
  readonly command: string;
  readonly dataClassification: RuntimeToolInvocation["dataClassification"];
  readonly outcome: RunBackgroundOutcome;
  readonly notice: string;
  readonly delivered: boolean;
}

interface BackgroundCommand {
  readonly taskRef: string;
  readonly runId: string;
  readonly threadId: string | null;
  readonly dataClassification: RuntimeToolInvocation["dataClassification"];
  readonly command: string;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  state: CommandState;
  stopReason: "requested" | "run_ended" | null;
  result: RuntimeToolExecutionResult | null;
  endedAt: number | null;
  delivered: boolean;
}

type Receipt = (value: unknown) => Promise<{ readonly ref: string }>;

export class ProductionBackgroundCommands {
  readonly #limits: BackgroundCommandLimits;
  readonly #now: () => string;
  readonly #commands = new Map<string, BackgroundCommand>();
  readonly #listeners = new Map<string, (notice: RuntimeBackgroundCommandNotice) => boolean>();
  readonly #settledWaiters = new Map<string, Set<() => void>>();

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
    const forward = () => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener("abort", forward, { once: true });
    const startedAt = Date.parse(this.#now());
    const result = execute(controller.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const early = await Promise.race([
      result.then((value) => ({ value })),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), this.#limits.waitMs);
      }),
    ]).finally(() => clearTimeout(timer));
    if (early || signal?.aborted) {
      signal?.removeEventListener("abort", forward);
      return early ? early.value : result;
    }
    signal?.removeEventListener("abort", forward);
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
      threadId: invocation.context?.threadId ?? null,
      dataClassification: invocation.dataClassification,
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
      delivered: false,
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
        "命令结束时系统会自动把结果发给你，不需要反复查询状态，也不要为了等它而拖住这一轮：可以直接回答用户，告诉他命令在后台运行、结束后会主动汇报。",
        "如果命令在你还在回答时结束，结果会马上插进来；如果在你答完之后结束，系统会在这个对话里开新的一轮把结果交给你。",
        "需要时用 execution_task_status 查看状态，用 execution_task_cancel 停止；命令结束后可用 execution_task_output 分页读取输出。",
        `这条命令最晚运行到 ${new Date(deadlineAt).toISOString()}，到时还没结束会被停止。`,
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
    const threadId = invocation.context?.threadId ?? null;
    if (
      !task ||
      (task.runId !== invocation.runId && (task.threadId === null || task.threadId !== threadId))
    )
      return refused(
        "BACKGROUND_COMMAND_NOT_FOUND",
        "找不到这个后台命令。只能管理这个对话里转入后台的命令；服务重启后，之前的后台命令都已停止。",
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

  held(runId: string): readonly RunBackgroundHold[] {
    return [...this.#commands.values()]
      .filter(
        (task) =>
          task.runId === runId &&
          (task.state === "running" || (!task.delivered && task.stopReason !== "run_ended")),
      )
      .map((task) => ({
        taskRef: task.taskRef,
        startedAt: new Date(task.startedAt).toISOString(),
        deadlineAt: new Date(task.deadlineAt).toISOString(),
      }));
  }

  subscribe(
    runId: string,
    listener: (notice: RuntimeBackgroundCommandNotice) => boolean,
  ): () => void {
    this.#listeners.set(runId, listener);
    for (const task of this.#commands.values())
      if (
        task.runId === runId &&
        task.state !== "running" &&
        !task.delivered &&
        task.stopReason !== "run_ended"
      )
        task.delivered = listener({ taskRef: task.taskRef, modelContent: this.#notice(task) });
    return () => {
      if (this.#listeners.get(runId) === listener) this.#listeners.delete(runId);
    };
  }

  async settled(runId: string): Promise<readonly BackgroundCommandResult[]> {
    for (;;) {
      const tasks = [...this.#commands.values()].filter((task) => task.runId === runId);
      if (tasks.every((task) => task.state !== "running"))
        return tasks.map((task) => ({
          taskRef: task.taskRef,
          command: task.command.slice(0, COMMAND_PREVIEW_CHARACTERS),
          dataClassification: task.dataClassification,
          outcome: backgroundOutcome(task),
          notice: this.#notice(task),
          delivered: task.delivered,
        }));
      await new Promise<void>((resolve) => {
        const waiters = this.#settledWaiters.get(runId) ?? new Set<() => void>();
        waiters.add(resolve);
        this.#settledWaiters.set(runId, waiters);
      });
    }
  }

  async cancelRun(runId: string): Promise<void> {
    const tasks = [...this.#commands.values()].filter((task) => task.runId === runId);
    for (const task of tasks)
      if (task.state === "running") {
        task.stopReason = "requested";
        task.controller.abort();
      }
    await settleWithin(Promise.allSettled(tasks.map((task) => task.settled)), STOP_SETTLE_MS);
  }

  async stopRun(runId: string): Promise<void> {
    const tasks = [...this.#commands.values()].filter((task) => task.runId === runId);
    for (const task of tasks)
      if (task.state === "running") {
        task.stopReason = "run_ended";
        task.controller.abort();
      }
    await settleWithin(Promise.allSettled(tasks.map((task) => task.settled)), STOP_SETTLE_MS);
    this.#listeners.delete(runId);
  }

  #finish(task: BackgroundCommand, result: RuntimeToolExecutionResult | null) {
    task.result = result;
    task.endedAt = Date.parse(this.#now());
    task.state = task.stopReason ? "stopped" : "finished";
    if (task.stopReason !== "run_ended") {
      const listener = this.#listeners.get(task.runId);
      task.delivered =
        listener?.({ taskRef: task.taskRef, modelContent: this.#notice(task) }) ?? false;
    }
    const waiters = this.#settledWaiters.get(task.runId);
    this.#settledWaiters.delete(task.runId);
    for (const wake of waiters ?? []) wake();
    this.#prune();
  }

  #prune() {
    const finished = [...this.#commands.values()].filter((task) => task.state !== "running");
    for (const task of finished.slice(0, Math.max(0, finished.length - KEPT_FINISHED_COMMANDS)))
      this.#commands.delete(task.taskRef);
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

function backgroundOutcome(task: BackgroundCommand): RunBackgroundOutcome {
  if (task.stopReason !== null) return "stopped";
  const result = task.result;
  if (result?.outcome === "succeeded") return "completed";
  if (result?.errorCode && /DEADLINE|TIMEOUT|WALL_TIME/.test(result.errorCode)) return "timed_out";
  return "failed";
}

function outcomeText(task: BackgroundCommand): string {
  if (task.stopReason === "requested") return "已按要求停止，命令可能只执行了一部分。";
  if (task.stopReason === "run_ended") return "已停止，命令可能只执行了一部分。";
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
