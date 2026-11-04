import { createHash } from "node:crypto";
import type {
  RunBackgroundHold,
  RunBackgroundOutcome,
  RuntimeBackgroundCommandNotice,
  RuntimeToolExecutionResult,
  RuntimeToolInvocation,
} from "@himawari-agent/application";
import {
  BACKGROUND_AWAITING_APPROVAL,
  BACKGROUND_DONE_COMMAND,
  BACKGROUND_DONE_DURATION,
  BACKGROUND_DONE_OUTPUT_HEADER,
  BACKGROUND_DONE_OUTPUT_TRUNCATED,
  BACKGROUND_DONE_RESULT,
  BACKGROUND_DONE_TITLE,
  BACKGROUND_FAILED,
  BACKGROUND_HANDOFF_DEADLINE,
  BACKGROUND_HANDOFF_GUIDANCE,
  BACKGROUND_HANDOFF_STARTED,
  BACKGROUND_HANDOFF_TASK,
  BACKGROUND_RESULT_UNKNOWN,
  BACKGROUND_STOP_REQUESTED,
  BACKGROUND_STOP_RUN_ENDED,
  BACKGROUND_SUCCEEDED,
  renderPrompt,
  TOOL_RESULT_BACKGROUND_RUNNING,
} from "@himawari-agent/prompt-catalog";

export const BACKGROUND_COMMAND_REF_PREFIX = "background-command:";

export function backgroundCommandRef(runId: string, toolCallId: string): string {
  return `${BACKGROUND_COMMAND_REF_PREFIX}${createHash("sha256")
    .update(JSON.stringify([runId, toolCallId]))
    .digest("hex")
    .slice(0, 24)}`;
}
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
  readonly output: string;
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
  readonly commandRef: string | undefined;
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
    label?: (command: string) => Promise<{ readonly ref: string }>,
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
    const taskRef = backgroundCommandRef(invocation.runId, invocation.toolCallId);
    const deadlineAt = Math.min(
      startedAt + this.#limits.maximumMs,
      invocation.executionDeadlineAt === undefined
        ? Number.POSITIVE_INFINITY
        : Date.parse(invocation.executionDeadlineAt),
    );
    const command =
      typeof invocation.arguments["command"] === "string" ? invocation.arguments["command"] : "";
    const commandRef = label
      ? (await label(command.slice(0, COMMAND_PREVIEW_CHARACTERS))).ref
      : undefined;
    const task: BackgroundCommand = {
      taskRef,
      runId: invocation.runId,
      threadId: invocation.context?.threadId ?? null,
      dataClassification: invocation.dataClassification,
      command,
      commandRef,
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
        renderPrompt(BACKGROUND_HANDOFF_STARTED, {
          seconds: String(Math.round(this.#limits.waitMs / 1000)),
        }),
        renderPrompt(BACKGROUND_HANDOFF_TASK, { taskRef }),
        BACKGROUND_HANDOFF_GUIDANCE.text,
        renderPrompt(BACKGROUND_HANDOFF_DEADLINE, { deadline: new Date(deadlineAt).toISOString() }),
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
        ...(task.commandRef ? { commandRef: task.commandRef } : {}),
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
        return tasks.map((task) => this.#result(task));
      await new Promise<void>((resolve) => {
        const waiters = this.#settledWaiters.get(runId) ?? new Set<() => void>();
        waiters.add(resolve);
        this.#settledWaiters.set(runId, waiters);
      });
    }
  }

  result(taskRef: string): BackgroundCommandResult | undefined {
    const task = this.#commands.get(taskRef);
    return task && task.state !== "running" ? this.#result(task) : undefined;
  }

  #result(task: BackgroundCommand): BackgroundCommandResult {
    return {
      taskRef: task.taskRef,
      command: task.command.slice(0, COMMAND_PREVIEW_CHARACTERS),
      output: outputTail(commandOutput(task.result?.modelContent ?? "")),
      dataClassification: task.dataClassification,
      outcome: backgroundOutcome(task),
      notice: this.#notice(task),
      delivered: task.delivered,
    };
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
      renderPrompt(BACKGROUND_DONE_TITLE, { taskRef: task.taskRef }),
      renderPrompt(BACKGROUND_DONE_COMMAND, {
        command: task.command.slice(0, COMMAND_PREVIEW_CHARACTERS),
      }),
      renderPrompt(BACKGROUND_DONE_DURATION, {
        seconds: String(Math.round(((task.endedAt ?? task.startedAt) - task.startedAt) / 1000)),
      }),
      renderPrompt(BACKGROUND_DONE_RESULT, { outcome: outcomeText(task) }),
      BACKGROUND_DONE_OUTPUT_HEADER.text,
      shown,
      ...(content.length > shown.length
        ? [renderPrompt(BACKGROUND_DONE_OUTPUT_TRUNCATED, { characters: String(shown.length) })]
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
        note: TOOL_RESULT_BACKGROUND_RUNNING.text,
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

const OUTPUT_TAIL_LINES = 20;
const OUTPUT_TAIL_CHARACTERS = 4000;

function commandOutput(content: string): string {
  let envelope: unknown;
  try {
    envelope = JSON.parse(content);
  } catch {
    return content;
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return content;
  const fields = envelope as Record<string, unknown>;
  if (fields["schemaVersion"] !== "pi-result.v1" || !Array.isArray(fields["content"]))
    return content;
  return fields["content"]
    .flatMap((part: unknown) =>
      part &&
      typeof part === "object" &&
      (part as Record<string, unknown>)["type"] === "text" &&
      typeof (part as Record<string, unknown>)["text"] === "string"
        ? [(part as Record<string, string>)["text"]]
        : [],
    )
    .join("\n");
}

function outputTail(content: string): string {
  const lines = content.replace(/\r\n?/g, "\n").trimEnd().split("\n");
  return lines.slice(-OUTPUT_TAIL_LINES).join("\n").slice(-OUTPUT_TAIL_CHARACTERS);
}

function backgroundOutcome(task: BackgroundCommand): RunBackgroundOutcome {
  if (task.stopReason !== null) return "stopped";
  const result = task.result;
  if (result?.outcome === "succeeded") return "completed";
  if (result?.errorCode && /DEADLINE|TIMEOUT|WALL_TIME/.test(result.errorCode)) return "timed_out";
  return "failed";
}

function outcomeText(task: BackgroundCommand): string {
  if (task.stopReason === "requested") return BACKGROUND_STOP_REQUESTED.text;
  if (task.stopReason === "run_ended") return BACKGROUND_STOP_RUN_ENDED.text;
  const result = task.result;
  if (!result || result.outcome === "result_unknown")
    return renderPrompt(BACKGROUND_RESULT_UNKNOWN, {
      errorCode: result?.errorCode ?? "BACKGROUND_COMMAND_RESULT_UNKNOWN",
    });
  if (result.outcome === "awaiting_approval") return BACKGROUND_AWAITING_APPROVAL.text;
  return result.outcome === "succeeded"
    ? BACKGROUND_SUCCEEDED.text
    : renderPrompt(BACKGROUND_FAILED, { errorCode: result.errorCode ?? "未知错误" });
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
