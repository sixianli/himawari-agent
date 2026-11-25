import { createHash } from "node:crypto";
import type {
  ClockPort,
  DataClassification,
  OwnerRuleScope,
  PayloadProtectorPort,
  PayloadStorePort,
  ResultEntryRecord,
  ResultGoneReason,
  ResultNoticeRecord,
  RuntimeCustomToolDescriptor,
  RuntimeToolDescriptor,
  RuntimeToolInvocation,
  SubthreadRecord,
  SubthreadStorePort,
  SubthreadTimerCreator,
  SubthreadTimerRecord,
  SubthreadTimerStatus,
  ThreadCommandService,
  ThreadRepositoryPort,
} from "@himawari-agent/application";
import {
  type DurableSchedule,
  classificationRank,
  evaluateDurableSchedule,
  highestClassification,
} from "@himawari-agent/application";
import type { ThreadBackgroundWork } from "@himawari-agent/gateway-contracts";
import {
  RESULT_BOARD_CHANGED,
  RESULT_BOARD_GONE,
  RESULT_BOARD_GONE_RETURNED,
  RESULT_BOARD_GONE_STOPPED,
  RESULT_BOARD_GONE_STUCK,
  RESULT_BOARD_READY,
  renderPrompt,
  SUBTHREAD_APPROVAL_WAITING,
  SUBTHREAD_BRIEF,
  SUBTHREAD_BUDGET_REACHED,
  SUBTHREAD_CONTINUE,
  SUBTHREAD_CONTINUE_CUT_OFF,
  SUBTHREAD_CONTINUE_PLAN_OPEN,
  SUBTHREAD_EVENT,
  SUBTHREAD_MESSAGES_PREFACE,
  SUBTHREAD_STATUS_BOARD_HEADER,
  TIMER_BRIEF,
  TIMER_DUE,
  TIMER_SCHEDULE_DAILY,
  TIMER_SCHEDULE_EVERY,
  TIMER_SCHEDULE_ONCE,
  TOOL_OPEN_SUBTHREAD,
  TOOL_RECORD_RESULT,
  TOOL_RETURN_RESULT,
  TOOL_SCHEDULE_TASK,
  TOOL_SEND_TO_SUBTHREAD,
  TOOL_STOP_SUBTHREAD,
  TOOL_TELL_MAIN,
  TOOL_VIEW_RESULTS,
  TOOL_VIEW_SUBTHREAD,
  TOOL_WAIT_RESULT,
} from "@himawari-agent/prompt-catalog";
import { classificationWithIdentifiers } from "@himawari-agent/sensitive-capture";
import type { ContextExternalContent } from "./context-external-content.js";
import type { InboxSourceRegistry, ProductionInbox } from "./production-inbox.js";
import type { ProductionMainThread } from "./production-main-thread.js";
import {
  type ConversationKind,
  type ProductionThreadTasks,
  SubthreadToolError,
} from "./production-thread-tasks.js";

type Create = Parameters<ThreadCommandService["create"]>[0];
type MessagesQuery = Parameters<ThreadRepositoryPort["readCommittedMessagesByIds"]>[0];

export const SUBTHREAD_CAPABILITY_PREFIX = "owner.subthread.";
export const MAIN_SUBTHREAD_TOOLS = [
  "open_subthread",
  "send_to_subthread",
  "stop_subthread",
  "view_subthread",
  "schedule_task",
] as const;
export const SUBTHREAD_SIDE_TOOLS = [
  "tell_main",
  "return_result",
  "record_result",
  "wait_result",
] as const;
export const SHARED_SUBTHREAD_TOOLS = ["view_results"] as const;
export const SUBTHREAD_EVENT_KIND = "subthread";
export const MAIN_NOTE_EVENT_KIND = "main_note";
export const RESULT_BOARD_EVENT_KIND = "result_board";
export const SUBTHREAD_CONTINUE_EVENT_KIND = "subthread_continue";
export const DEFAULT_SUBTHREAD_BUDGET_MICROS = 500_000;
export const TIMER_EVENT_KIND = "timer";
export const DEFAULT_TIMER_TIME_ZONE = "Asia/Tokyo";
const TIMER_TICK_MS = 10_000;
const TIMER_MISFIRE_GRACE_MS = 400 * 86_400_000;
const TIMER_MIN_MINUTES = 5;
const TIMER_MAX_MINUTES = 525_600;
const TIMER_DUE_BATCH = 50;
const TIMER_LIST_LIMIT = 200;
const TIMER_CREATORS: readonly SubthreadTimerCreator[] = ["owner", "agreed", "self"];
const DAILY_TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/u;

const FIELD_LIMIT = 4000;
const RESULT_LIMIT = 8000;
const MATTER_LIMIT = 64;
const OWNER_MESSAGES_LIMIT = 20;
const LIST_LIMIT = 30;
const ITEMS_LIMIT = 30;
const HISTORY_LIMIT = 100;
const TELL_KINDS = ["progress", "question", "stuck"] as const;
const RESULT_NAME_LIMIT = 64;
const RESULT_SUMMARY_LIMIT = 300;
const RESULT_BODY_LIMIT = 20_000;
const RESULT_NAMES_PER_MATTER = 100;
const RESULT_VERSIONS_PER_NAME = 20;
const CATALOG_LIMIT = 50;
const NOTICE_BATCH = 100;
const BOARD_SUBTHREADS = 20;
const BOARD_TASKS = 30;
const BOARD_PROGRESS = 300;
const FINISHED_RUNS = new Set(["completed", "failed", "cancelled"]);
const BACKGROUND_SUBTHREADS = 50;
const BACKGROUND_RUNS = 20;
const BACKGROUND_EXCHANGES = 50;
const BACKGROUND_EXCHANGE_TEXT = 2000;
const EXCHANGE_DIRECTIONS = ["to_subthread", "to_main"] as const;
const EXCHANGE_KINDS = [
  "brief",
  "message",
  "result_board",
  "progress",
  "question",
  "stuck",
  "result",
  "budget",
] as const;
type ExchangeDirection = (typeof EXCHANGE_DIRECTIONS)[number];
type ExchangeKind = (typeof EXCHANGE_KINDS)[number];
const SUBTHREAD_TITLE_LIMIT = 20;
const MAX_BUDGET_DOLLARS = 1000;
const MICROS = 1_000_000;

type BackgroundActivity =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_answer"
  | "waiting_result"
  | "idle"
  | "over_budget"
  | "finished";
const LAYOUT_CHARACTERS = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

export function oneLine(value: string): string {
  return value.replace(LAYOUT_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
}

const GONE_REASONS: Record<ResultGoneReason, string> = {
  stopped: RESULT_BOARD_GONE_STOPPED.text,
  returned: RESULT_BOARD_GONE_RETURNED.text,
  stuck: RESULT_BOARD_GONE_STUCK.text,
};

const digest = (value: unknown, length = 32) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, length);

const field = (maxLength: number) => ({ type: "string", minLength: 1, maxLength }) as const;
const subthreadId = { type: "string", minLength: 1, maxLength: 256 } as const;
const budgetField = { type: "number", exclusiveMinimum: 0, maximum: 1000 } as const;

function budgetArgument(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_BUDGET_DOLLARS
  )
    throw new SubthreadToolError("INPUT_INVALID");
  return Math.max(1, Math.round(value * MICROS));
}

function dollars(micros: number): string {
  return (micros / MICROS).toFixed(2);
}

function descriptor(
  name: string,
  description: string,
  parameters: RuntimeCustomToolDescriptor["parameters"],
  keep = false,
): RuntimeToolDescriptor {
  return {
    name,
    capabilityRef: `${SUBTHREAD_CAPABILITY_PREFIX}${name}`,
    capabilityHandleRef: null,
    description,
    parameters,
    ...(keep ? { contextRetention: "keep" as const } : {}),
  };
}

export function mainSubthreadDescriptors(): readonly RuntimeToolDescriptor[] {
  return [
    descriptor("open_subthread", TOOL_OPEN_SUBTHREAD.text, {
      type: "object",
      properties: {
        objective: field(FIELD_LIMIT),
        background: field(FIELD_LIMIT),
        done_when: field(FIELD_LIMIT),
        avoid: field(FIELD_LIMIT),
        deliver: field(FIELD_LIMIT),
        owner_messages: {
          type: "array",
          items: field(256),
          minItems: 1,
          maxItems: OWNER_MESSAGES_LIMIT,
          uniqueItems: true,
        },
        matter: field(MATTER_LIMIT),
        title: field(SUBTHREAD_TITLE_LIMIT),
        budget: budgetField,
      },
      required: [
        "objective",
        "background",
        "done_when",
        "avoid",
        "deliver",
        "owner_messages",
        "matter",
        "title",
      ],
      additionalProperties: false,
    }),
    descriptor("send_to_subthread", TOOL_SEND_TO_SUBTHREAD.text, {
      type: "object",
      properties: { subthread: subthreadId, text: field(FIELD_LIMIT), budget: budgetField },
      required: ["subthread", "text"],
      additionalProperties: false,
    }),
    descriptor("stop_subthread", TOOL_STOP_SUBTHREAD.text, {
      type: "object",
      properties: { subthread: subthreadId, reason: field(1000) },
      required: ["subthread", "reason"],
      additionalProperties: false,
    }),
    descriptor(
      "view_subthread",
      TOOL_VIEW_SUBTHREAD.text,
      {
        type: "object",
        properties: { subthread: subthreadId, history: { type: "boolean" } },
        additionalProperties: false,
      },
      true,
    ),
    viewResultsDescriptor(true),
    descriptor("schedule_task", TOOL_SCHEDULE_TASK.text, {
      type: "object",
      properties: {
        task: field(FIELD_LIMIT),
        schedule: {
          type: "object",
          properties: {
            once_at: field(40),
            daily_at: { type: "string", pattern: DAILY_TIME.source },
            every_minutes: {
              type: "integer",
              minimum: TIMER_MIN_MINUTES,
              maximum: TIMER_MAX_MINUTES,
            },
          },
          minProperties: 1,
          maxProperties: 1,
          additionalProperties: false,
        },
        created_by: { type: "string", enum: [...TIMER_CREATORS] },
        owner_messages: {
          type: "array",
          items: field(256),
          maxItems: OWNER_MESSAGES_LIMIT,
          uniqueItems: true,
        },
        matter: field(MATTER_LIMIT),
        title: field(SUBTHREAD_TITLE_LIMIT),
        budget: budgetField,
      },
      required: ["task", "schedule", "created_by", "matter", "title"],
      additionalProperties: false,
    }),
  ];
}

type TimerSchedule = DurableSchedule & { readonly timeZone: string };

export function localTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}（${timeZone}）`;
}

function scheduleText(schedule: TimerSchedule): string {
  if (schedule.kind === "one_shot")
    return renderPrompt(TIMER_SCHEDULE_ONCE, { at: localTime(schedule.at, schedule.timeZone) });
  if (schedule.kind === "daily")
    return renderPrompt(TIMER_SCHEDULE_DAILY, {
      time: `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`,
      timeZone: schedule.timeZone,
    });
  return renderPrompt(TIMER_SCHEDULE_EVERY, {
    minutes: String(Math.round(schedule.intervalMs / 60_000)),
  });
}

export interface SubthreadTimerView {
  readonly timer: SubthreadTimerRecord;
  readonly title: string | null;
  readonly task: string;
  readonly ownerWords: string | null;
  readonly lastResult: { readonly text: string; readonly at: string } | null;
  readonly schedule: string;
  readonly spentMicros: number;
}

function viewResultsDescriptor(needsMatter: boolean): RuntimeToolDescriptor {
  return descriptor("view_results", TOOL_VIEW_RESULTS.text, {
    type: "object",
    properties: {
      matter: field(MATTER_LIMIT),
      subthread: subthreadId,
      name: field(RESULT_NAME_LIMIT * 4),
    },
    ...(needsMatter ? { required: ["matter"] } : {}),
    additionalProperties: false,
  });
}

export function subthreadSideDescriptors(): readonly RuntimeToolDescriptor[] {
  const items = { type: "array", items: field(1000), maxItems: ITEMS_LIMIT } as const;
  return [
    descriptor("tell_main", TOOL_TELL_MAIN.text, {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...TELL_KINDS] },
        text: field(FIELD_LIMIT),
        wake: { type: "boolean" },
      },
      required: ["kind", "text"],
      additionalProperties: false,
    }),
    descriptor(
      "return_result",
      TOOL_RETURN_RESULT.text,
      {
        type: "object",
        properties: {
          conclusion: field(RESULT_LIMIT),
          criteria: { ...items, minItems: 1 },
          outputs: items,
          open_issues: items,
          results: {
            type: "array",
            items: field(RESULT_NAME_LIMIT * 4),
            maxItems: ITEMS_LIMIT,
          },
        },
        required: ["conclusion", "criteria"],
        additionalProperties: false,
      },
      true,
    ),
    descriptor("record_result", TOOL_RECORD_RESULT.text, {
      type: "object",
      properties: {
        name: field(RESULT_NAME_LIMIT * 4),
        summary: field(RESULT_SUMMARY_LIMIT * 4),
        body: field(RESULT_BODY_LIMIT),
      },
      required: ["name", "summary", "body"],
      additionalProperties: false,
    }),
    viewResultsDescriptor(false),
    descriptor("wait_result", TOOL_WAIT_RESULT.text, {
      type: "object",
      properties: { subthread: subthreadId, name: field(RESULT_NAME_LIMIT * 4) },
      required: ["subthread", "name"],
      additionalProperties: false,
    }),
  ];
}

function textArgument(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > maximum)
    throw new SubthreadToolError("INPUT_INVALID");
  return value.trim();
}

function listArgument(value: unknown, required: boolean): readonly string[] {
  if (value === undefined && !required) return [];
  if (
    !Array.isArray(value) ||
    (required && value.length === 0) ||
    value.length > ITEMS_LIMIT ||
    !value.every((item) => typeof item === "string" && item.trim().length > 0)
  )
    throw new SubthreadToolError("INPUT_INVALID");
  return value.map((item: string) => textArgument(item, 1000));
}

function onlyArguments(args: Readonly<Record<string, unknown>>, allowed: readonly string[]) {
  if (Object.keys(args).some((name) => !allowed.includes(name)))
    throw new SubthreadToolError("INPUT_INVALID");
}

export interface SubthreadInboxAttachment {
  readonly inbox: Pick<ProductionInbox, "submit">;
  readonly cancelThreadRuns?: (threadId: string) => Promise<void>;
}

function nameArgument(value: unknown): string {
  if (typeof value !== "string") throw new SubthreadToolError("INPUT_INVALID");
  const name = oneLine(value);
  if (name.length === 0 || [...name].length > RESULT_NAME_LIMIT)
    throw new SubthreadToolError("INPUT_INVALID");
  return name;
}

function scheduleArgument(value: unknown, now: string, timeZone: string): TimerSchedule {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new SubthreadToolError("INPUT_INVALID");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1) throw new SubthreadToolError("INPUT_INVALID");
  const [[key, raw]] = entries as [[string, unknown]];
  if (key === "once_at") {
    if (typeof raw !== "string" || raw.length > 40 || !/(Z|[+-]\d{2}:\d{2})$/u.test(raw))
      throw new SubthreadToolError("INPUT_INVALID");
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) throw new SubthreadToolError("INPUT_INVALID");
    return {
      kind: "one_shot",
      at: new Date(Math.max(at, Date.parse(now))).toISOString(),
      misfireGraceMs: TIMER_MISFIRE_GRACE_MS,
      timeZone,
    };
  }
  if (key === "daily_at") {
    const match = typeof raw === "string" ? DAILY_TIME.exec(raw) : null;
    if (!match) throw new SubthreadToolError("INPUT_INVALID");
    return {
      kind: "daily",
      timeZone,
      hour: Number(match[1]),
      minute: Number(match[2]),
      misfireGraceMs: TIMER_MISFIRE_GRACE_MS,
    };
  }
  if (key === "every_minutes") {
    if (
      typeof raw !== "number" ||
      !Number.isSafeInteger(raw) ||
      raw < TIMER_MIN_MINUTES ||
      raw > TIMER_MAX_MINUTES
    )
      throw new SubthreadToolError("INPUT_INVALID");
    return {
      kind: "interval",
      anchorAt: new Date(Date.parse(now) + raw * 60_000).toISOString(),
      intervalMs: raw * 60_000,
      misfireGraceMs: TIMER_MISFIRE_GRACE_MS,
      timeZone,
    };
  }
  throw new SubthreadToolError("INPUT_INVALID");
}

function nextFrom(schedule: TimerSchedule, now: string): string | null {
  if (schedule.kind === "one_shot") return schedule.at < now ? now : schedule.at;
  return evaluateDurableSchedule(schedule, { now, lastScheduledAt: null }).nextAt;
}

function storedSchedule(value: Readonly<Record<string, unknown>>): TimerSchedule {
  return value as unknown as TimerSchedule;
}

export interface ProductionSubthreadsOptions {
  readonly ownerId: OwnerRuleScope["ownerId"];
  readonly agentId: OwnerRuleScope["agentId"];
  readonly mainThread: Pick<ProductionMainThread, "read">;
  readonly threads: Pick<ThreadRepositoryPort, "readCommittedMessagesByIds" | "listRuns">;
  readonly commands: Pick<ThreadCommandService, "create">;
  readonly store: SubthreadStorePort;
  readonly tasks: Pick<ProductionThreadTasks, "tasks" | "content">;
  readonly externalContent: Pick<ContextExternalContent, "readThread" | "markThread">;
  readonly threadOf: (runId: string) => Promise<string | null | undefined>;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly defaultBudgetMicros?: number;
  readonly timeZone?: string;
  readonly timerTickMs?: number;
  readonly onTimerFailure?: (error: unknown) => void;
}

export type SubthreadRunEnding = "continued" | "over_budget" | "settled";

type Result = { readonly value: unknown; readonly contentClassification?: DataClassification };

export class ProductionSubthreads {
  readonly #options: ProductionSubthreadsOptions;
  #attached: SubthreadInboxAttachment | undefined;
  #draining: Promise<void> = Promise.resolve();
  #timerLoop: ReturnType<typeof setInterval> | undefined;
  #ticking: Promise<void> | undefined;

  constructor(options: ProductionSubthreadsOptions) {
    this.#options = options;
  }

  get #scope() {
    return { ownerId: this.#options.ownerId, agentId: this.#options.agentId };
  }

  attach(attachment: SubthreadInboxAttachment): void {
    this.#attached = attachment;
    void this.drainNotices().catch(() => undefined);
  }

  registerSources(registry: InboxSourceRegistry): void {
    registry.register({
      kind: SUBTHREAD_EVENT_KIND,
      describe: "子线程",
      externalContent: false,
      fromOwner: false,
      priority: 4,
      verbatim: true,
    });
    registry.register({
      kind: MAIN_NOTE_EVENT_KIND,
      describe: "主对话",
      externalContent: false,
      fromOwner: false,
      priority: 3,
      verbatim: true,
    });
    registry.register({
      kind: SUBTHREAD_CONTINUE_EVENT_KIND,
      describe: "接着做",
      externalContent: false,
      fromOwner: false,
      priority: 2,
      verbatim: true,
    });
    registry.register({
      kind: TIMER_EVENT_KIND,
      describe: "定时",
      externalContent: false,
      fromOwner: false,
      priority: 2,
      verbatim: true,
    });
    registry.register({
      kind: RESULT_BOARD_EVENT_KIND,
      describe: "结果板",
      externalContent: false,
      fromOwner: false,
      priority: 3,
      verbatim: true,
    });
  }

  async kindOfThread(threadId: string): Promise<ConversationKind> {
    if ((await this.#options.mainThread.read()) === threadId) return "main";
    return (await this.#options.store.read({ ...this.#scope, threadId })) ? "subthread" : "other";
  }

  async conversation(
    runId: string,
  ): Promise<{ readonly threadId: string; readonly kind: ConversationKind } | undefined> {
    const threadId = await this.#options.threadOf(runId);
    if (!threadId) return undefined;
    return { threadId, kind: await this.kindOfThread(threadId) };
  }

  async open(threadId: string): Promise<SubthreadRecord | undefined> {
    const subthread = await this.#options.store.read({ ...this.#scope, threadId });
    return subthread?.status === "open" ? subthread : undefined;
  }

  subthreadMessage(
    events: readonly {
      readonly sourceKind: string;
      readonly sourceRef: string;
      readonly text: string;
    }[],
  ) {
    const timers = events.filter((event) => event.sourceKind === TIMER_EVENT_KIND);
    const board = events.filter((event) => event.sourceKind === RESULT_BOARD_EVENT_KIND);
    const continuing = events.filter((event) => event.sourceKind === SUBTHREAD_CONTINUE_EVENT_KIND);
    const notes = events.filter(
      (event) =>
        event.sourceKind !== RESULT_BOARD_EVENT_KIND &&
        event.sourceKind !== SUBTHREAD_CONTINUE_EVENT_KIND &&
        event.sourceKind !== TIMER_EVENT_KIND &&
        !event.sourceRef.startsWith("brief:"),
    );
    return [
      ...events.filter((event) => event.sourceRef.startsWith("brief:")).map((event) => event.text),
      ...timers.map((event) => event.text),
      ...board.map((event) => event.text),
      ...continuing.slice(-1).map((event) => event.text),
      ...(notes.length > 0 ? [SUBTHREAD_MESSAGES_PREFACE.text] : []),
      ...notes.map((event) => event.text),
    ].join("\n\n");
  }

  async drainNotices(): Promise<void> {
    const inbox = this.#attached?.inbox;
    if (!inbox) return;
    const previous = this.#draining;
    const turn = previous.then(() => this.#drain(inbox));
    this.#draining = turn.catch(() => undefined);
    await turn;
  }

  async #drain(inbox: Pick<ProductionInbox, "submit">): Promise<void> {
    const main = await this.#options.mainThread.read();
    for (;;) {
      const notices = await this.#options.store.listResultNotices({
        ...this.#scope,
        limit: NOTICE_BATCH,
      });
      if (notices.length === 0) return;
      for (const notice of notices) {
        const submitted = await inbox.submit({
          sourceKind: RESULT_BOARD_EVENT_KIND,
          sourceRef: notice.id,
          sourceVersion: "1",
          summary: this.#noticeText(notice),
          externalContent: notice.externalContent,
          threadId: notice.receiverThreadId === main ? null : notice.receiverThreadId,
        });
        if (!submitted.accepted) throw new Error(`RESULT_NOTICE_REJECTED:${submitted.reason}`);
        if (notice.receiverThreadId !== main && (await this.open(notice.receiverThreadId)))
          await this.#exchange({
            threadId: notice.receiverThreadId,
            direction: "to_subthread",
            kind: "result_board",
            text: this.#noticeText(notice),
            key: notice.id,
          });
        await this.#options.store.deleteResultNotice({ ...this.#scope, id: notice.id });
      }
      if (notices.length < NOTICE_BATCH) return;
    }
  }

  #noticeText(notice: ResultNoticeRecord): string {
    const values = {
      subthread: notice.writerThreadId,
      name: notice.name,
      version: String(notice.version ?? ""),
    };
    if (notice.kind === "ready") return renderPrompt(RESULT_BOARD_READY, values);
    if (notice.kind === "changed") return renderPrompt(RESULT_BOARD_CHANGED, values);
    return renderPrompt(RESULT_BOARD_GONE, {
      subthread: notice.writerThreadId,
      name: notice.name,
      reason: GONE_REASONS[notice.reason ?? "stopped"],
    });
  }

  async run(invocation: RuntimeToolInvocation): Promise<Result> {
    const tool = invocation.capabilityRef.slice(SUBTHREAD_CAPABILITY_PREFIX.length);
    const conversation = await this.conversation(invocation.runId);
    const main = (MAIN_SUBTHREAD_TOOLS as readonly string[]).includes(tool);
    const side = (SUBTHREAD_SIDE_TOOLS as readonly string[]).includes(tool);
    if (!conversation || (main && conversation.kind !== "main"))
      throw new SubthreadToolError("NOT_HERE");
    if (side && conversation.kind !== "subthread") throw new SubthreadToolError("NOT_HERE");
    if (!main && !side && conversation.kind === "other") throw new SubthreadToolError("NOT_HERE");
    const args = invocation.arguments;
    switch (tool) {
      case "open_subthread":
        return this.#open(invocation, conversation.threadId, args);
      case "send_to_subthread":
        return this.#send(invocation, conversation.threadId, args);
      case "stop_subthread":
        return this.#stop(conversation.threadId, args);
      case "view_subthread":
        return this.#view(conversation.threadId, args);
      case "schedule_task":
        return this.#schedule(invocation, conversation.threadId, args);
      case "tell_main":
        return this.#tellMain(invocation, conversation.threadId, args);
      case "return_result":
        return this.#return(invocation, conversation.threadId, args);
      case "record_result":
        return this.#record(invocation, conversation.threadId, args);
      case "view_results":
        return this.#viewResults(invocation, conversation, args);
      case "wait_result":
        return this.#wait(invocation, conversation.threadId, args);
      default:
        throw new SubthreadToolError("INPUT_INVALID");
    }
  }

  #budget(subthread: SubthreadRecord): number {
    return (
      subthread.budgetMicros ?? this.#options.defaultBudgetMicros ?? DEFAULT_SUBTHREAD_BUDGET_MICROS
    );
  }

  #spent(subthread: SubthreadRecord): Promise<number> {
    return this.#options.store.spentMicros({ ...this.#scope, threadId: subthread.threadId });
  }

  async overBudget(threadId: string): Promise<boolean> {
    const subthread = await this.open(threadId);
    if (!subthread) return false;
    const spent = await this.#spent(subthread);
    const budget = this.#budget(subthread);
    if (spent < budget) return false;
    if (subthread.budgetHitAt === null) {
      await this.#options.store.noteActivity({
        ...this.#scope,
        threadId,
        budgetHit: true,
        now: this.#options.clock.now(),
      });
      const tasks = (await this.#options.tasks.tasks(threadId)).filter(
        (task) => task.status !== "deleted",
      );
      const reached = renderPrompt(SUBTHREAD_BUDGET_REACHED, {
        spent: dollars(spent),
        budget: dollars(budget),
        total: String(tasks.length),
        done: String(tasks.filter((task) => task.status === "completed").length),
      });
      await this.#exchange({
        threadId,
        direction: "to_main",
        kind: "budget",
        text: reached,
        key: budget,
      });
      await this.#submit({
        kind: SUBTHREAD_EVENT_KIND,
        sourceRef: `budget:${threadId}:${digest([threadId, budget])}`,
        text: this.#event(subthread, "budget", reached),
        threadId: null,
        externalContent: await this.#marked(threadId),
      });
    }
    return true;
  }

  async parentOf(threadId: string): Promise<string | undefined> {
    return (await this.#options.store.read({ ...this.#scope, threadId }))?.parentThreadId;
  }

  async awaitingApproval(input: { readonly threadId: string; readonly runId: string }) {
    const subthread = await this.open(input.threadId);
    if (!subthread) return;
    if (subthread.approvalRunId !== input.runId)
      await this.#options.store.noteActivity({
        ...this.#scope,
        threadId: input.threadId,
        approvalRunId: input.runId,
        now: this.#options.clock.now(),
      });
    await this.#submit({
      kind: SUBTHREAD_EVENT_KIND,
      sourceRef: `approval:${digest([input.threadId, input.runId])}`,
      text: this.#event(subthread, "approval", SUBTHREAD_APPROVAL_WAITING.text),
      threadId: null,
      externalContent: await this.#marked(input.threadId),
    });
  }

  listAwaitingApproval(): Promise<readonly SubthreadRecord[]> {
    return this.#options.store.listAwaitingApproval(this.#scope);
  }

  async approvalSettled(threadId: string): Promise<void> {
    await this.#options.store.noteActivity({
      ...this.#scope,
      threadId,
      approvalRunId: null,
      now: this.#options.clock.now(),
    });
  }

  async afterRun(input: {
    readonly threadId: string;
    readonly runId: string;
    readonly cutOff: boolean;
  }): Promise<SubthreadRunEnding> {
    const subthread = await this.open(input.threadId);
    if (!subthread) return "settled";
    if (await this.overBudget(input.threadId)) return "over_budget";
    if (subthread.askedAt !== null || subthread.stuckAt !== null) return "settled";
    const waiting = await this.#options.store.listWaiting({
      ...this.#scope,
      parentThreadId: subthread.parentThreadId,
    });
    if (waiting.includes(subthread.threadId)) return "settled";
    const open = (await this.#options.tasks.tasks(input.threadId)).some(
      (task) => task.status === "pending" || task.status === "in_progress",
    );
    if (!input.cutOff && !open) return "settled";
    await this.#submit({
      kind: SUBTHREAD_CONTINUE_EVENT_KIND,
      sourceRef: `continue:${input.threadId}`,
      version: input.runId,
      text: renderPrompt(SUBTHREAD_CONTINUE, {
        reason: input.cutOff ? SUBTHREAD_CONTINUE_CUT_OFF.text : SUBTHREAD_CONTINUE_PLAN_OPEN.text,
      }),
      threadId: input.threadId,
      externalContent: false,
    });
    return "continued";
  }

  async statusBoard(threadId: string, ceiling: DataClassification): Promise<string | undefined> {
    if ((await this.#options.mainThread.read()) !== threadId) return undefined;
    const open = (await this.#options.store.list({ ...this.#scope, parentThreadId: threadId }))
      .filter((subthread) => subthread.status === "open")
      .slice(-BOARD_SUBTHREADS);
    if (open.length === 0) return undefined;
    const queues = await this.#queues(threadId);
    const visible = (classification: string) =>
      classificationRank(classification as DataClassification) <= classificationRank(ceiling);
    const lines = [SUBTHREAD_STATUS_BOARD_HEADER.text];
    for (const subthread of open) {
      const { activity: status } = await this.#activity(subthread, queues);
      const spending =
        status === "over_budget"
          ? ` spent=${dollars(await this.#spent(subthread))}/${dollars(this.#budget(subthread))} USD`
          : "";
      lines.push(
        `- subthread ${subthread.threadId} (${oneLine(subthread.matter)}) status=${status}${spending}`,
      );
      if (subthread.progressRef !== null) {
        const payload = await this.#options.payloads.get(subthread.progressRef as never);
        const progress =
          payload && visible(payload.dataClassification)
            ? await this.#text(subthread.progressRef)
            : undefined;
        if (progress !== undefined)
          lines.push(`  progress: ${[...oneLine(progress)].slice(0, BOARD_PROGRESS).join("")}`);
      }
      const tasks = (await this.#options.tasks.tasks(subthread.threadId))
        .filter((task) => task.status !== "deleted")
        .slice(0, BOARD_TASKS);
      for (const task of tasks) {
        const content = visible(task.classification)
          ? await this.#options.tasks.content(task)
          : undefined;
        const wording = task.status === "in_progress" ? content?.activeForm : content?.subject;
        lines.push(
          `  task ${task.number} [${task.status}]${wording ? ` ${oneLine(wording)}` : ""}`,
        );
      }
    }
    return lines.join("\n");
  }

  async #queues(parentThreadId: string) {
    const scope = { ...this.#scope, parentThreadId };
    return {
      waiting: new Set(await this.#options.store.listWaiting(scope)),
      queued: new Set(await this.#options.store.listQueued(scope)),
    };
  }

  async #activity(
    subthread: SubthreadRecord,
    queues: { readonly waiting: ReadonlySet<string>; readonly queued: ReadonlySet<string> },
  ): Promise<{
    readonly activity: BackgroundActivity;
    readonly runCount: number;
    readonly runs: Awaited<ReturnType<ThreadRepositoryPort["listRuns"]>>;
  }> {
    const runs = await this.#options.threads.listRuns(
      this.#options.ownerId as never,
      this.#options.agentId as never,
      subthread.threadId as never,
    );
    const active = runs.filter((run) => !FINISHED_RUNS.has(run.status));
    const activity: BackgroundActivity =
      subthread.status !== "open"
        ? "finished"
        : subthread.budgetHitAt !== null
          ? "over_budget"
          : active.some((run) => run.status === "awaiting_approval")
            ? "waiting_approval"
            : subthread.askedAt !== null
              ? "waiting_answer"
              : queues.waiting.has(subthread.threadId)
                ? "waiting_result"
                : active.some((run) => run.status !== "accepted")
                  ? "running"
                  : active.length > 0 || queues.queued.has(subthread.threadId)
                    ? "queued"
                    : "idle";
    return { activity, runCount: runs.length, runs };
  }

  async backgroundWork(): Promise<ThreadBackgroundWork> {
    const main = await this.#options.mainThread.read();
    if (!main) return { matters: [] };
    const all = (await this.#options.store.list({ ...this.#scope, parentThreadId: main })).slice(
      -BACKGROUND_SUBTHREADS,
    );
    const queues = await this.#queues(main);
    const matters = new Map<
      string,
      ThreadBackgroundWork["matters"][number]["subthreads"][number][]
    >();
    for (const subthread of all) {
      const { activity, runCount, runs } = await this.#activity(subthread, queues);
      const tasks = [];
      for (const task of await this.#options.tasks.tasks(subthread.threadId)) {
        if (task.status === "deleted") continue;
        const content = await this.#options.tasks.content(task);
        tasks.push({
          number: task.number,
          status: task.status,
          subject: content?.subject ?? null,
          activeForm: content?.activeForm ?? null,
        });
      }
      const progress =
        subthread.progressRef === null ? undefined : await this.#text(subthread.progressRef);
      const row = {
        subthreadId: subthread.threadId,
        status: subthread.status,
        activity: activity === "waiting_approval" ? "running" : activity,
        openedAt: subthread.createdAt,
        updatedAt: subthread.updatedAt,
        progress: progress === undefined ? null : [...progress].slice(0, 2000).join(""),
        progressAt: subthread.progressAt,
        runCount,
        spentMicros: await this.#spent(subthread),
        budgetMicros: this.#budget(subthread),
        title: subthread.title,
        runs: runs.slice(-BACKGROUND_RUNS).map((run) => ({
          runId: run.runId,
          status: run.status,
          startedAt: run.createdAt,
          updatedAt: run.updatedAt,
        })),
        exchanges: await this.#exchanges(subthread.threadId),
        tasks,
      };
      matters.set(subthread.matter, [...(matters.get(subthread.matter) ?? []), row]);
    }
    return {
      matters: [...matters].map(([matter, subthreads]) => ({ matter, subthreads })),
    };
  }

  async #exchange(input: {
    readonly threadId: string;
    readonly direction: ExchangeDirection;
    readonly kind: ExchangeKind;
    readonly text: string;
    readonly key: unknown;
  }): Promise<void> {
    const id = `exchange:${digest([input.threadId, input.direction, input.kind, input.key], 48)}`;
    const textRef = `subthread-${id}`;
    await this.#put(textRef, input.text);
    await this.#options.store.recordExchange({
      ...this.#scope,
      id,
      threadId: input.threadId,
      direction: input.direction,
      kind: input.kind,
      textRef,
      now: this.#options.clock.now(),
    });
  }

  async #exchanges(threadId: string) {
    const rows = [];
    for (const exchange of await this.#options.store.listExchanges({
      ...this.#scope,
      threadId,
      limit: BACKGROUND_EXCHANGES,
    })) {
      const text = await this.#text(exchange.textRef);
      if (
        text === undefined ||
        !(EXCHANGE_DIRECTIONS as readonly string[]).includes(exchange.direction) ||
        !(EXCHANGE_KINDS as readonly string[]).includes(exchange.kind)
      )
        continue;
      rows.push({
        direction: exchange.direction as ExchangeDirection,
        kind: exchange.kind as ExchangeKind,
        text: [...text].slice(0, BACKGROUND_EXCHANGE_TEXT).join(""),
        at: exchange.createdAt,
      });
    }
    return rows;
  }

  async #text(ref: string): Promise<string | undefined> {
    const payload = await this.#options.payloads.get(ref as never);
    if (!payload) return undefined;
    return new TextDecoder("utf-8", { fatal: false }).decode(
      await this.#options.protector.unprotect({ ...this.#scope, payload }),
    );
  }

  async #put(ref: string, text: string, floor: DataClassification = "private") {
    const dataClassification = highestClassification(floor, [
      classificationWithIdentifiers(text, "private"),
    ]);
    if (!(await this.#options.payloads.get(ref as never)))
      await this.#options.payloads.put(
        await this.#options.protector.protect({
          ...this.#scope,
          ref,
          contentType: "text/plain",
          dataClassification,
          plaintext: new TextEncoder().encode(text),
          createdAt: this.#options.clock.now(),
        }),
      );
    return dataClassification;
  }

  async #submit(input: {
    readonly kind: string;
    readonly sourceRef: string;
    readonly text: string;
    readonly threadId: string | null;
    readonly externalContent: boolean;
    readonly version?: string;
  }): Promise<void> {
    const inbox = this.#attached?.inbox;
    if (!inbox) throw new SubthreadToolError("NOT_HERE");
    const submitted = await inbox.submit({
      sourceKind: input.kind,
      sourceRef: input.sourceRef,
      sourceVersion: input.version ?? "1",
      summary: input.text,
      externalContent: input.externalContent,
      threadId: input.threadId,
    });
    if (!submitted.accepted) throw new SubthreadToolError("INPUT_INVALID");
  }

  async #marked(threadId: string): Promise<boolean> {
    return (await this.#options.externalContent.readThread(threadId)).length > 0;
  }

  async #child(parent: string, value: unknown): Promise<SubthreadRecord> {
    if (typeof value !== "string" || value.length === 0)
      throw new SubthreadToolError("INPUT_INVALID");
    const subthread = await this.#options.store.read({ ...this.#scope, threadId: value });
    if (!subthread || subthread.parentThreadId !== parent)
      throw new SubthreadToolError("UNKNOWN_SUBTHREAD");
    return subthread;
  }

  async #ownerWords(main: string, ids: readonly string[]): Promise<string> {
    const messages = await this.#options.threads.readCommittedMessagesByIds({
      ...(this.#scope as Pick<MessagesQuery, "ownerId" | "agentId">),
      threadId: main as MessagesQuery["threadId"],
      messageIds: ids as MessagesQuery["messageIds"],
    });
    const owned = messages.filter((message) => message.role === "owner" && !message.internal);
    if (owned.length !== ids.length) throw new SubthreadToolError("INPUT_INVALID");
    const words: string[] = [];
    for (const message of [...owned].sort((a, b) => a.sequence - b.sequence)) {
      const text = await this.#text(message.contentRef);
      if (text === undefined) throw new SubthreadToolError("INPUT_INVALID");
      words.push(`- ${text.replace(/\s+/gu, " ").trim()}`);
    }
    return words.join("\n");
  }

  async #open(
    invocation: RuntimeToolInvocation,
    main: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Result> {
    onlyArguments(args, [
      "objective",
      "background",
      "done_when",
      "avoid",
      "deliver",
      "owner_messages",
      "matter",
      "budget",
      "title",
    ]);
    const budgetMicros = budgetArgument(args["budget"]);
    const title = oneLine(textArgument(args["title"], SUBTHREAD_TITLE_LIMIT * 4));
    if (title.length === 0 || [...title].length > SUBTHREAD_TITLE_LIMIT)
      throw new SubthreadToolError("INPUT_INVALID");
    const brief = {
      objective: textArgument(args["objective"], FIELD_LIMIT),
      background: textArgument(args["background"], FIELD_LIMIT),
      doneWhen: textArgument(args["done_when"], FIELD_LIMIT),
      avoid: textArgument(args["avoid"], FIELD_LIMIT),
      deliver: textArgument(args["deliver"], FIELD_LIMIT),
    };
    const matter = textArgument(args["matter"], MATTER_LIMIT).replace(/\s+/gu, " ");
    const ids = args["owner_messages"];
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > OWNER_MESSAGES_LIMIT ||
      !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256) ||
      new Set(ids).size !== ids.length
    )
      throw new SubthreadToolError("INPUT_INVALID");
    const openKey = digest([invocation.runId, invocation.toolCallId]);
    const existing = await this.#options.store.readByOpenKey({ ...this.#scope, openKey });
    if (existing) return { value: { subthread: existing.threadId, matter: existing.matter } };
    const ownerWords = await this.#ownerWords(main, ids as string[]);
    const threadId = `thread:subthread:${openKey}`;
    const briefRef = `subthread-brief:${openKey}`;
    const briefText = renderPrompt(SUBTHREAD_BRIEF, { ...brief, ownerWords });
    const classification = await this.#put(briefRef, briefText);
    await this.#options.commands.create({
      ownerId: this.#options.ownerId as Create["ownerId"],
      agentId: this.#options.agentId as Create["agentId"],
      threadId: threadId as NonNullable<Create["threadId"]>,
      idempotencyKey: `subthread:${openKey}`,
      origin: "think",
      resultRef: briefRef as Create["resultRef"],
    });
    for (const { origin } of await this.#options.externalContent.readThread(main))
      await this.#options.externalContent.markThread(threadId, invocation.runId, origin);
    const { subthread } = await this.#options.store.open({
      ...this.#scope,
      threadId,
      parentThreadId: main,
      matter,
      title,
      openKey,
      openedByRunId: invocation.runId,
      briefRef,
      classification,
      now: this.#options.clock.now(),
    });
    if (budgetMicros !== undefined && subthread.budgetMicros === null)
      await this.#options.store.noteActivity({
        ...this.#scope,
        threadId,
        budgetMicros,
        now: this.#options.clock.now(),
      });
    await this.#exchange({
      threadId,
      direction: "to_subthread",
      kind: "brief",
      text: briefText,
      key: "brief",
    });
    await this.#submit({
      kind: MAIN_NOTE_EVENT_KIND,
      sourceRef: `brief:${threadId}`,
      text: briefText,
      threadId,
      externalContent: await this.#marked(main),
    });
    return { value: { subthread: subthread.threadId, matter: subthread.matter } };
  }

  async #send(
    invocation: RuntimeToolInvocation,
    main: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Result> {
    onlyArguments(args, ["subthread", "text", "budget"]);
    const subthread = await this.#child(main, args["subthread"]);
    const text = textArgument(args["text"], FIELD_LIMIT);
    const budgetMicros = budgetArgument(args["budget"]);
    if (subthread.status !== "open") throw new SubthreadToolError("SUBTHREAD_CLOSED");
    const spent = await this.#spent(subthread);
    if (budgetMicros !== undefined) {
      if (budgetMicros <= spent) throw new SubthreadToolError("BUDGET_TOO_LOW");
      await this.#options.store.noteActivity({
        ...this.#scope,
        threadId: subthread.threadId,
        budgetMicros,
        now: this.#options.clock.now(),
      });
    } else if (spent >= this.#budget(subthread)) throw new SubthreadToolError("OVER_BUDGET");
    if (subthread.askedAt !== null)
      await this.#options.store.noteActivity({
        ...this.#scope,
        threadId: subthread.threadId,
        asked: false,
        now: this.#options.clock.now(),
      });
    if (subthread.stuckAt !== null)
      await this.#options.store.markStuck({
        ...this.#scope,
        threadId: subthread.threadId,
        stuck: false,
        now: this.#options.clock.now(),
      });
    await this.#exchange({
      threadId: subthread.threadId,
      direction: "to_subthread",
      kind: "message",
      text,
      key: [invocation.runId, invocation.toolCallId],
    });
    await this.#submit({
      kind: MAIN_NOTE_EVENT_KIND,
      sourceRef: `relay:${digest([invocation.runId, invocation.toolCallId])}`,
      text,
      threadId: subthread.threadId,
      externalContent: await this.#marked(main),
    });
    return { value: { sent: true, subthread: subthread.threadId } };
  }

  async #stop(main: string, args: Readonly<Record<string, unknown>>): Promise<Result> {
    onlyArguments(args, ["subthread", "reason"]);
    const subthread = await this.#child(main, args["subthread"]);
    textArgument(args["reason"], 1000);
    if (subthread.status === "open")
      await this.#options.store.settle({
        ...this.#scope,
        threadId: subthread.threadId,
        to: "stopped",
        resultRef: null,
        now: this.#options.clock.now(),
      });
    await this.drainNotices();
    await this.#cancelTimersOf(subthread.threadId);
    await this.#attached?.cancelThreadRuns?.(subthread.threadId);
    return { value: { stopped: true, subthread: subthread.threadId } };
  }

  async #schedule(
    invocation: RuntimeToolInvocation,
    main: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Result> {
    onlyArguments(args, [
      "task",
      "schedule",
      "created_by",
      "owner_messages",
      "matter",
      "title",
      "budget",
    ]);
    const ids = args["owner_messages"] ?? [];
    if (
      !Array.isArray(ids) ||
      ids.length > OWNER_MESSAGES_LIMIT ||
      !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256) ||
      new Set(ids).size !== ids.length
    )
      throw new SubthreadToolError("INPUT_INVALID");
    const runBudgetMicros =
      budgetArgument(args["budget"]) ??
      this.#options.defaultBudgetMicros ??
      DEFAULT_SUBTHREAD_BUDGET_MICROS;
    const title = oneLine(textArgument(args["title"], SUBTHREAD_TITLE_LIMIT * 4));
    if (title.length === 0 || [...title].length > SUBTHREAD_TITLE_LIMIT)
      throw new SubthreadToolError("INPUT_INVALID");
    const task = textArgument(args["task"], FIELD_LIMIT);
    const matter = textArgument(args["matter"], MATTER_LIMIT).replace(/\s+/gu, " ");
    const createdBy = args["created_by"];
    if (!TIMER_CREATORS.includes(createdBy as SubthreadTimerCreator))
      throw new SubthreadToolError("INPUT_INVALID");
    const now = this.#options.clock.now();
    const schedule = scheduleArgument(args["schedule"], now, this.#timeZone);
    const openKey = digest([invocation.runId, invocation.toolCallId]);
    const timerId = `timer:${openKey}`;
    const existing = await this.#options.store.readTimer({ ...this.#scope, id: timerId });
    if (existing)
      return {
        value: { subthread: existing.threadId, timer: existing.id, next_at: existing.nextAt },
      };
    const threadId = `thread:subthread:${openKey}`;
    const briefRef = `subthread-brief:${openKey}`;
    const briefText = renderPrompt(TIMER_BRIEF, { task, schedule: scheduleText(schedule) });
    const classification = await this.#put(briefRef, briefText);
    const taskRef = `timer-task:${openKey}`;
    await this.#put(taskRef, task);
    const ownerWordsRef = ids.length > 0 ? `timer-owner-words:${openKey}` : null;
    if (ownerWordsRef)
      await this.#put(ownerWordsRef, await this.#ownerWords(main, ids as string[]));
    await this.#options.commands.create({
      ownerId: this.#options.ownerId as Create["ownerId"],
      agentId: this.#options.agentId as Create["agentId"],
      threadId: threadId as NonNullable<Create["threadId"]>,
      idempotencyKey: `subthread:${openKey}`,
      origin: "think",
      resultRef: briefRef as Create["resultRef"],
    });
    for (const { origin } of await this.#options.externalContent.readThread(main))
      await this.#options.externalContent.markThread(threadId, invocation.runId, origin);
    await this.#options.store.open({
      ...this.#scope,
      threadId,
      parentThreadId: main,
      matter,
      title,
      openKey,
      openedByRunId: invocation.runId,
      briefRef,
      classification,
      now,
    });
    await this.#exchange({
      threadId,
      direction: "to_subthread",
      kind: "brief",
      text: briefText,
      key: "brief",
    });
    const timer = await this.#options.store.createTimer({
      ...this.#scope,
      id: timerId,
      threadId,
      schedule: schedule as unknown as Readonly<Record<string, unknown>>,
      taskRef,
      ownerWordsRef,
      createdBy: createdBy as SubthreadTimerCreator,
      nextAt: nextFrom(schedule, now),
      runBudgetMicros,
      now,
    });
    return {
      value: {
        subthread: threadId,
        timer: timer.id,
        next_at: timer.nextAt,
        next_local: timer.nextAt ? localTime(timer.nextAt, this.#timeZone) : null,
      },
    };
  }

  get #timeZone(): string {
    return this.#options.timeZone ?? DEFAULT_TIMER_TIME_ZONE;
  }

  startTimers(): void {
    if (this.#timerLoop) return;
    this.#timerLoop = setInterval(() => {
      void this.tickTimers().catch((error: unknown) => this.#options.onTimerFailure?.(error));
    }, this.#options.timerTickMs ?? TIMER_TICK_MS);
    this.#timerLoop.unref?.();
    void this.tickTimers().catch((error: unknown) => this.#options.onTimerFailure?.(error));
  }

  stopTimers(): void {
    if (this.#timerLoop) clearInterval(this.#timerLoop);
    this.#timerLoop = undefined;
  }

  tickTimers(): Promise<void> {
    if (this.#ticking) return this.#ticking;
    const tick = this.#tick().finally(() => {
      this.#ticking = undefined;
    });
    this.#ticking = tick;
    return tick;
  }

  async #tick(): Promise<void> {
    if (!this.#attached?.inbox) return;
    const now = this.#options.clock.now();
    const due = await this.#options.store.listDueTimers({
      ...this.#scope,
      now,
      limit: TIMER_DUE_BATCH,
    });
    for (const timer of due) await this.#fire(timer, now);
  }

  async #fire(timer: SubthreadTimerRecord, now: string): Promise<void> {
    const subthread = await this.open(timer.threadId);
    if (!subthread) {
      await this.#setTimer(timer.id, ["active", "paused"], "cancelled");
      return;
    }
    const schedule = storedSchedule(timer.schedule);
    const evaluation = evaluateDurableSchedule(schedule, {
      now,
      lastScheduledAt: timer.lastScheduledAt,
    });
    if (evaluation.outcome !== "due" || evaluation.scheduledAt === null) {
      await this.#options.store.advanceTimer({
        ...this.#scope,
        id: timer.id,
        scheduledAt: null,
        nextAt: evaluation.nextAt,
        finished: schedule.kind === "one_shot" && evaluation.nextAt === null,
        now,
      });
      return;
    }
    const spent = await this.#spent(subthread);
    await this.#options.store.noteActivity({
      ...this.#scope,
      threadId: subthread.threadId,
      budgetMicros: Math.min(MAX_BUDGET_DOLLARS * MICROS, spent + timer.runBudgetMicros),
      now,
    });
    const due = renderPrompt(TIMER_DUE, {
      run: String(timer.runCount + 1),
      due: localTime(evaluation.scheduledAt, schedule.timeZone ?? this.#timeZone),
    });
    const brief = timer.runCount === 0 ? await this.#text(subthread.briefRef) : undefined;
    await this.#submit({
      kind: TIMER_EVENT_KIND,
      sourceRef: timer.id,
      version: evaluation.scheduledAt,
      text: brief === undefined ? due : `${brief}\n\n${due}`,
      threadId: subthread.threadId,
      externalContent: false,
    });
    await this.#options.store.advanceTimer({
      ...this.#scope,
      id: timer.id,
      scheduledAt: evaluation.scheduledAt,
      nextAt: schedule.kind === "one_shot" ? null : evaluation.nextAt,
      finished: schedule.kind === "one_shot",
      now,
    });
  }

  async #setTimer(
    id: string,
    from: readonly SubthreadTimerStatus[],
    to: SubthreadTimerStatus,
    nextAt?: string | null,
  ): Promise<SubthreadTimerRecord | undefined> {
    return this.#options.store.setTimerStatus({
      ...this.#scope,
      id,
      from,
      to,
      ...(nextAt !== undefined ? { nextAt } : {}),
      now: this.#options.clock.now(),
    });
  }

  async #cancelTimersOf(threadId: string): Promise<void> {
    for (const timer of await this.#options.store.listTimers({
      ...this.#scope,
      limit: TIMER_LIST_LIMIT,
    }))
      if (timer.threadId === threadId)
        await this.#setTimer(timer.id, ["active", "paused"], "cancelled");
  }

  async listTimers(): Promise<readonly SubthreadTimerView[]> {
    const views: SubthreadTimerView[] = [];
    for (const timer of await this.#options.store.listTimers({
      ...this.#scope,
      limit: TIMER_LIST_LIMIT,
    })) {
      const subthread = await this.#options.store.read({
        ...this.#scope,
        threadId: timer.threadId,
      });
      views.push({
        timer,
        title: subthread?.title ?? null,
        task: (await this.#text(timer.taskRef)) ?? "",
        ownerWords: timer.ownerWordsRef ? ((await this.#text(timer.ownerWordsRef)) ?? null) : null,
        lastResult: await this.#lastResult(timer),
        schedule: scheduleText(storedSchedule(timer.schedule)),
        spentMicros: await this.#options.store.spentMicros({
          ...this.#scope,
          threadId: timer.threadId,
        }),
      });
    }
    return views;
  }

  async #lastResult(
    timer: SubthreadTimerRecord,
  ): Promise<{ readonly text: string; readonly at: string } | null> {
    if (timer.lastScheduledAt === null) return null;
    const exchanges = await this.#options.store.listExchanges({
      ...this.#scope,
      threadId: timer.threadId,
      limit: BACKGROUND_EXCHANGES,
    });
    const last = [...exchanges]
      .filter(
        (exchange) =>
          exchange.direction === "to_main" &&
          exchange.kind !== "budget" &&
          exchange.createdAt >= (timer.lastScheduledAt ?? ""),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .at(-1);
    if (!last) return null;
    const text = await this.#text(last.textRef);
    return text === undefined ? null : { text, at: last.createdAt };
  }

  async pauseTimer(id: string): Promise<SubthreadTimerRecord | undefined> {
    return this.#setTimer(id, ["active"], "paused");
  }

  async resumeTimer(id: string): Promise<SubthreadTimerRecord | undefined> {
    const timer = await this.#options.store.readTimer({ ...this.#scope, id });
    if (!timer || timer.status !== "paused") return timer;
    return this.#setTimer(
      id,
      ["paused"],
      "active",
      nextFrom(storedSchedule(timer.schedule), this.#options.clock.now()),
    );
  }

  async cancelTimer(id: string): Promise<SubthreadTimerRecord | undefined> {
    const timer = await this.#setTimer(id, ["active", "paused"], "cancelled");
    if (timer?.status === "cancelled") {
      const subthread = await this.open(timer.threadId);
      if (subthread)
        await this.#options.store.settle({
          ...this.#scope,
          threadId: subthread.threadId,
          to: "stopped",
          resultRef: null,
          now: this.#options.clock.now(),
        });
      await this.drainNotices();
      await this.#attached?.cancelThreadRuns?.(timer.threadId);
    }
    return timer;
  }

  async #view(main: string, args: Readonly<Record<string, unknown>>): Promise<Result> {
    onlyArguments(args, ["subthread", "history"]);
    if (args["history"] !== undefined && typeof args["history"] !== "boolean")
      throw new SubthreadToolError("INPUT_INVALID");
    if (args["subthread"] === undefined) {
      const all = await this.#options.store.list({ ...this.#scope, parentThreadId: main });
      return {
        value: {
          subthreads: all.slice(-LIST_LIMIT).map((subthread) => ({
            subthread: subthread.threadId,
            matter: subthread.matter,
            status: subthread.status,
            opened_at: subthread.createdAt,
          })),
          ...(all.length > LIST_LIMIT ? { not_listed: all.length - LIST_LIMIT } : {}),
        },
      };
    }
    const subthread = await this.#child(main, args["subthread"]);
    const tasks = await this.#options.tasks.tasks(subthread.threadId);
    const rows = [];
    const classifications: DataClassification[] = [subthread.classification as DataClassification];
    for (const task of tasks) {
      const content = await this.#options.tasks.content(task);
      classifications.push(task.classification as DataClassification);
      rows.push({
        task: task.number,
        subject: content?.subject ?? null,
        active_form: content?.activeForm ?? null,
        status: task.status,
        blocked_by: task.blockedBy,
      });
    }
    const history =
      args["history"] === true
        ? await this.#history(subthread.threadId, classifications)
        : undefined;
    const result = subthread.resultRef ? await this.#text(subthread.resultRef) : undefined;
    return {
      value: {
        subthread: subthread.threadId,
        matter: subthread.matter,
        status: subthread.status,
        brief: (await this.#text(subthread.briefRef)) ?? null,
        tasks: rows,
        ...(result === undefined ? {} : { result }),
        ...(history ? { history } : {}),
      },
      contentClassification: highestClassification("private", classifications),
    };
  }

  async #history(threadId: string, classifications: DataClassification[]) {
    const changes = await this.#options.store.listTaskChanges({
      ...this.#scope,
      threadId,
      limit: HISTORY_LIMIT,
    });
    const rows = [];
    for (const change of changes) {
      const content = await this.#options.tasks.content(change);
      classifications.push(change.classification as DataClassification);
      rows.push({
        task: change.number,
        revision: change.revision,
        at: change.changedAt,
        ...(content
          ? { subject: content.subject, status: content.status, blocked_by: content.blockedBy }
          : {}),
      });
    }
    return rows;
  }

  #event(subthread: SubthreadRecord, kind: string, body: string): string {
    return renderPrompt(SUBTHREAD_EVENT, {
      subthread: subthread.threadId,
      matter: subthread.matter,
      kind,
      body,
    });
  }

  async #tellMain(
    invocation: RuntimeToolInvocation,
    threadId: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Result> {
    onlyArguments(args, ["kind", "text", "wake"]);
    const kind = args["kind"];
    if (!(TELL_KINDS as readonly unknown[]).includes(kind))
      throw new SubthreadToolError("INPUT_INVALID");
    const text = textArgument(args["text"], FIELD_LIMIT);
    if (args["wake"] !== undefined && typeof args["wake"] !== "boolean")
      throw new SubthreadToolError("INPUT_INVALID");
    const subthread = await this.open(threadId);
    if (!subthread) throw new SubthreadToolError("SUBTHREAD_CLOSED");
    const wake = kind !== "progress" || args["wake"] === true;
    if (kind === "progress") {
      const progressRef = `subthread-progress:${digest([invocation.runId, invocation.toolCallId])}`;
      await this.#put(progressRef, text);
      await this.#options.store.noteActivity({
        ...this.#scope,
        threadId,
        progressRef,
        now: this.#options.clock.now(),
      });
    }
    if (kind === "question")
      await this.#options.store.noteActivity({
        ...this.#scope,
        threadId,
        asked: true,
        now: this.#options.clock.now(),
      });
    if (kind === "stuck") {
      await this.#options.store.markStuck({
        ...this.#scope,
        threadId,
        stuck: true,
        now: this.#options.clock.now(),
      });
      await this.drainNotices();
    }
    await this.#exchange({
      threadId,
      direction: "to_main",
      kind: kind as ExchangeKind,
      text,
      key: [invocation.runId, invocation.toolCallId],
    });
    if (wake)
      await this.#submit({
        kind: SUBTHREAD_EVENT_KIND,
        sourceRef: `${kind as string}:${threadId}:${digest([invocation.runId, invocation.toolCallId])}`,
        text: this.#event(subthread, kind as string, text),
        threadId: null,
        externalContent: await this.#marked(threadId),
      });
    return { value: { told: true, woke_main: wake } };
  }

  async #return(
    invocation: RuntimeToolInvocation,
    threadId: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Result> {
    onlyArguments(args, ["conclusion", "criteria", "outputs", "open_issues", "results"]);
    const conclusion = textArgument(args["conclusion"], RESULT_LIMIT);
    const criteria = listArgument(args["criteria"], true);
    const outputs = listArgument(args["outputs"], false);
    const issues = listArgument(args["open_issues"], false);
    if (args["results"] !== undefined && !Array.isArray(args["results"]))
      throw new SubthreadToolError("INPUT_INVALID");
    const results = [
      ...new Set(((args["results"] as unknown[] | undefined) ?? []).map(nameArgument)),
    ];
    if (results.length > ITEMS_LIMIT) throw new SubthreadToolError("INPUT_INVALID");
    const subthread = await this.open(threadId);
    if (!subthread) throw new SubthreadToolError("SUBTHREAD_CLOSED");
    const own = new Set(
      (
        await this.#options.store.listResults({
          ...this.#scope,
          parentThreadId: subthread.parentThreadId,
          matter: subthread.matter,
          writerThreadId: threadId,
        })
      ).map((entry) => entry.name),
    );
    if (results.some((name) => !own.has(name))) throw new SubthreadToolError("UNKNOWN_RESULT");
    const tasks = await this.#options.tasks.tasks(threadId);
    if (tasks.some((task) => task.status !== "completed" && task.status !== "deleted"))
      throw new SubthreadToolError("TASKS_OPEN");
    const body = JSON.stringify(
      {
        conclusion,
        criteria,
        ...(outputs.length > 0 ? { outputs } : {}),
        ...(issues.length > 0 ? { open_issues: issues } : {}),
        ...(results.length > 0 ? { results } : {}),
      },
      null,
      2,
    );
    const resultRef = `subthread-result:${digest([invocation.runId, invocation.toolCallId])}`;
    await this.#put(resultRef, body);
    await this.#exchange({
      threadId,
      direction: "to_main",
      kind: "result",
      text: conclusion,
      key: "result",
    });
    await this.#submit({
      kind: SUBTHREAD_EVENT_KIND,
      sourceRef: `result:${threadId}:`,
      text: this.#event(subthread, "result", body),
      threadId: null,
      externalContent: await this.#marked(threadId),
    });
    await this.#options.store.settle({
      ...this.#scope,
      threadId,
      to: "returned",
      resultRef,
      now: this.#options.clock.now(),
    });
    await this.drainNotices();
    return { value: { returned: true } };
  }

  async #record(
    invocation: RuntimeToolInvocation,
    threadId: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Result> {
    onlyArguments(args, ["name", "summary", "body"]);
    const name = nameArgument(args["name"]);
    if (typeof args["summary"] !== "string") throw new SubthreadToolError("INPUT_INVALID");
    const summary = oneLine(args["summary"]);
    if (summary.length === 0 || [...summary].length > RESULT_SUMMARY_LIMIT)
      throw new SubthreadToolError("INPUT_INVALID");
    const body = textArgument(args["body"], RESULT_BODY_LIMIT);
    if (!(await this.open(threadId))) throw new SubthreadToolError("SUBTHREAD_CLOSED");
    const key = digest([invocation.runId, invocation.toolCallId]);
    const summaryRef = `result-summary:${key}`;
    const bodyRef = `result-body:${key}`;
    const classification = highestClassification("private", [
      await this.#put(summaryRef, summary),
      await this.#put(bodyRef, body),
    ]);
    const outcome = await this.#options.store.recordResult({
      ...this.#scope,
      writerThreadId: threadId,
      name,
      summaryRef,
      bodyRef,
      classification,
      externalContent: await this.#marked(threadId),
      maxNames: RESULT_NAMES_PER_MATTER,
      maxVersions: RESULT_VERSIONS_PER_NAME,
      now: this.#options.clock.now(),
    });
    if (outcome.outcome === "closed") throw new SubthreadToolError("SUBTHREAD_CLOSED");
    if (outcome.outcome !== "recorded") throw new SubthreadToolError("RESULT_LIMIT");
    await this.drainNotices();
    return { value: { recorded: true, name, version: outcome.entry.version } };
  }

  async #board(
    conversation: { readonly threadId: string; readonly kind: ConversationKind },
    args: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly parentThreadId: string; readonly matter: string }> {
    if (conversation.kind === "main") {
      if (args["matter"] === undefined) throw new SubthreadToolError("INPUT_INVALID");
      return {
        parentThreadId: conversation.threadId,
        matter: textArgument(args["matter"], MATTER_LIMIT).replace(/\s+/gu, " "),
      };
    }
    const own = await this.#options.store.read({ ...this.#scope, threadId: conversation.threadId });
    if (!own) throw new SubthreadToolError("NOT_HERE");
    if (args["matter"] !== undefined && textArgument(args["matter"], MATTER_LIMIT) !== own.matter)
      throw new SubthreadToolError("OTHER_MATTER");
    return { parentThreadId: own.parentThreadId, matter: own.matter };
  }

  async #markFrom(readerThreadId: string, runId: string, entries: readonly ResultEntryRecord[]) {
    for (const writer of new Set(
      entries.filter((entry) => entry.externalContent).map((entry) => entry.writerThreadId),
    ))
      for (const { origin } of await this.#options.externalContent.readThread(writer))
        await this.#options.externalContent.markThread(readerThreadId, runId as never, origin);
  }

  async #viewResults(
    invocation: RuntimeToolInvocation,
    conversation: { readonly threadId: string; readonly kind: ConversationKind },
    args: Readonly<Record<string, unknown>>,
  ): Promise<Result> {
    onlyArguments(args, ["matter", "subthread", "name"]);
    const board = await this.#board(conversation, args);
    if (args["name"] !== undefined && args["subthread"] === undefined)
      throw new SubthreadToolError("INPUT_INVALID");
    let writer: string | null = null;
    if (args["subthread"] !== undefined) {
      if (typeof args["subthread"] !== "string") throw new SubthreadToolError("INPUT_INVALID");
      const found = await this.#options.store.read({ ...this.#scope, threadId: args["subthread"] });
      if (!found || found.parentThreadId !== board.parentThreadId || found.matter !== board.matter)
        throw new SubthreadToolError("OTHER_MATTER");
      writer = found.threadId;
    }
    if (writer !== null && args["name"] !== undefined) {
      const name = nameArgument(args["name"]);
      const found = await this.#options.store.readResult({
        ...this.#scope,
        readerThreadId: conversation.threadId,
        writerThreadId: writer,
        name,
        now: this.#options.clock.now(),
      });
      if (!found) throw new SubthreadToolError("UNKNOWN_RESULT");
      await this.#markFrom(conversation.threadId, invocation.runId, [found]);
      return {
        value: {
          subthread: found.writerThreadId,
          name: found.name,
          version: found.version,
          recorded_at: found.createdAt,
          summary: (await this.#text(found.summaryRef)) ?? null,
          body: (await this.#text(found.bodyRef)) ?? null,
        },
        contentClassification: found.classification as DataClassification,
      };
    }
    const entries = await this.#options.store.listResults({
      ...this.#scope,
      ...board,
      writerThreadId: writer,
    });
    const listed = entries.slice(0, CATALOG_LIMIT);
    await this.#markFrom(conversation.threadId, invocation.runId, listed);
    const rows = [];
    for (const entry of listed)
      rows.push({
        subthread: entry.writerThreadId,
        name: entry.name,
        summary: (await this.#text(entry.summaryRef)) ?? null,
        version: entry.version,
        recorded_at: entry.createdAt,
      });
    return {
      value: {
        matter: board.matter,
        results: rows,
        ...(entries.length > listed.length ? { not_listed: entries.length - listed.length } : {}),
      },
      contentClassification: highestClassification(
        "private",
        listed.map((entry) => entry.classification as DataClassification),
      ),
    };
  }

  async #wait(
    invocation: RuntimeToolInvocation,
    threadId: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Result> {
    onlyArguments(args, ["subthread", "name"]);
    if (typeof args["subthread"] !== "string" || args["subthread"].length === 0)
      throw new SubthreadToolError("INPUT_INVALID");
    const name = nameArgument(args["name"]);
    if (!(await this.open(threadId))) throw new SubthreadToolError("SUBTHREAD_CLOSED");
    const outcome = await this.#options.store.waitResult({
      ...this.#scope,
      waitId: `wait:${digest([invocation.runId, invocation.toolCallId])}`,
      waiterThreadId: threadId,
      writerThreadId: args["subthread"],
      name,
      now: this.#options.clock.now(),
    });
    switch (outcome.outcome) {
      case "available":
        return { value: { available: true, version: outcome.version } };
      case "gone":
        return { value: { unavailable: GONE_REASONS[outcome.reason] } };
      case "waiting":
        return { value: { waiting: true } };
      case "cycle":
        throw new SubthreadToolError("WAIT_CYCLE");
      default:
        throw new SubthreadToolError("OTHER_MATTER");
    }
  }
}
