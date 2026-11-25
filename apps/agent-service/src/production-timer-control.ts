import {
  ApplicationPortError,
  type ClockPort,
  type MemoryReminder,
  PORT_ERROR_CODES,
} from "@himawari-agent/application";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
import {
  renderPrompt,
  TIMER_SCHEDULE_ONCE,
  TIMER_SCHEDULE_YEARLY,
} from "@himawari-agent/prompt-catalog";
import type { ProductionReminderWriter } from "./production-reminder-writer.js";
import {
  DEFAULT_TIMER_TIME_ZONE,
  localTime,
  type ProductionSubthreads,
} from "./production-subthreads.js";

export const PRODUCTION_TIMER_OPERATIONS = Object.freeze(["timers.read", "timers.change"] as const);

type TimersCommand = Extract<GatewayV2Command, { type: "timers.change" }>;
const TASK_LIMIT = 4000;
const RESULT_LIMIT = 2000;
const TIMER_PREFIX = "timer:";

function clip(value: string, limit: number): string {
  return [...value].slice(0, limit).join("");
}

export interface TimerReminders {
  readonly writer: Pick<ProductionReminderWriter, "list" | "cancel">;
  readonly read: (id: string) => Promise<MemoryReminder | undefined>;
}

export class ProductionTimerControl {
  readonly #subthreads: Pick<
    ProductionSubthreads,
    "listTimers" | "pauseTimer" | "resumeTimer" | "cancelTimer"
  >;
  readonly #scope: { readonly ownerId: string; readonly agentId: string };
  readonly #clock: ClockPort;
  readonly #reminders: TimerReminders | undefined;
  readonly #timeZone: string;

  constructor(options: {
    readonly reminders?: TimerReminders;
    readonly timeZone?: string;
    readonly subthreads: Pick<
      ProductionSubthreads,
      "listTimers" | "pauseTimer" | "resumeTimer" | "cancelTimer"
    >;
    readonly scope: { readonly ownerId: string; readonly agentId: string };
    readonly clock: ClockPort;
  }) {
    this.#subthreads = options.subthreads;
    this.#scope = options.scope;
    this.#clock = options.clock;
    this.#reminders = options.reminders;
    this.#timeZone = options.timeZone ?? DEFAULT_TIMER_TIME_ZONE;
  }

  async #reminderRows() {
    if (!this.#reminders) return [];
    const { reminders } = await this.#reminders.writer.list();
    const rows = [];
    for (const reminder of reminders) {
      const stored = await this.#reminders.read(reminder.reminderId);
      const at = localTime(reminder.remindAt, this.#timeZone);
      rows.push({
        timerId: reminder.reminderId,
        kind: "reminder",
        title: null,
        task: clip(reminder.text, TASK_LIMIT) || "-",
        ownerWords: null,
        schedule:
          reminder.repeat === "yearly"
            ? renderPrompt(TIMER_SCHEDULE_YEARLY, { at })
            : renderPrompt(TIMER_SCHEDULE_ONCE, { at }),
        createdBy: "owner",
        status: "active",
        nextAt: reminder.remindAt,
        lastAt: null,
        runCount: 0,
        spentMicros: 0,
        runBudgetMicros: null,
        lastResult: null,
        createdAt: stored?.createdAt ?? reminder.remindAt,
      });
    }
    return rows;
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type !== "timers.read") throw new Error("TIMER_OPERATION_NOT_INSTALLED");
    const views = await this.#subthreads.listTimers();
    return {
      ...query,
      kind: "snapshot",
      type: "timers.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        timers: [
          ...views.map(({ timer, title, task, ownerWords, lastResult, schedule, spentMicros }) => ({
            timerId: timer.id,
            kind: timer.schedule["kind"] === "one_shot" ? "follow_up" : "recurring",
            title,
            task: clip(task, TASK_LIMIT) || "-",
            ownerWords: ownerWords ? clip(ownerWords, TASK_LIMIT) : null,
            schedule,
            createdBy: timer.createdBy,
            status: timer.status,
            nextAt: timer.status === "active" || timer.status === "paused" ? timer.nextAt : null,
            lastAt: timer.lastScheduledAt,
            runCount: timer.runCount,
            spentMicros,
            runBudgetMicros: timer.runBudgetMicros,
            lastResult: lastResult
              ? { text: clip(lastResult.text, RESULT_LIMIT) || "-", at: lastResult.at }
              : null,
            createdAt: timer.createdAt,
          })),
          ...(await this.#reminderRows()),
        ],
        generatedAt: this.#clock.now(),
      },
    } as GatewayV2Snapshot;
  }

  async execute(command: GatewayV2Command): Promise<{ resultRef: string; replayed: boolean }> {
    if (
      command.actor.actorType !== "owner" ||
      command.scope.ownerId !== this.#scope.ownerId ||
      command.scope.agentId !== this.#scope.agentId
    )
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "TIMER_OWNER_REQUIRED");
    if (command.type !== "timers.change") throw new Error("TIMER_OPERATION_NOT_INSTALLED");
    const { timerId, action } = (command as TimersCommand).payload;
    if (!timerId.startsWith(TIMER_PREFIX)) return this.#changeReminder(timerId, action);
    const timer =
      action === "pause"
        ? await this.#subthreads.pauseTimer(timerId)
        : action === "resume"
          ? await this.#subthreads.resumeTimer(timerId)
          : await this.#subthreads.cancelTimer(timerId);
    if (!timer)
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "TIMER_NOT_FOUND");
    const wanted = action === "pause" ? "paused" : action === "resume" ? "active" : "cancelled";
    if (timer.status !== wanted)
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "TIMER_STATE_CHANGED");
    return { resultRef: `${timer.id}:${timer.status}:${timer.updatedAt}`, replayed: false };
  }

  async #changeReminder(
    reminderId: string,
    action: string,
  ): Promise<{ resultRef: string; replayed: boolean }> {
    if (!this.#reminders || !(await this.#reminders.read(reminderId)))
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "TIMER_NOT_FOUND");
    if (action !== "cancel")
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "TIMER_ACTION_NOT_SUPPORTED",
      );
    const before = await this.#reminders.writer.cancel(reminderId);
    return {
      resultRef: `${reminderId}:cancelled:${before.updatedAt}`,
      replayed: before.status === "cancelled",
    };
  }
}
