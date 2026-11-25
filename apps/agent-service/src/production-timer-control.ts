import {
  ApplicationPortError,
  type ClockPort,
  PORT_ERROR_CODES,
} from "@himawari-agent/application";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
import type { ProductionSubthreads } from "./production-subthreads.js";

export const PRODUCTION_TIMER_OPERATIONS = Object.freeze(["timers.read", "timers.change"] as const);

type TimersCommand = Extract<GatewayV2Command, { type: "timers.change" }>;
const TASK_LIMIT = 4000;

export class ProductionTimerControl {
  readonly #subthreads: Pick<
    ProductionSubthreads,
    "listTimers" | "pauseTimer" | "resumeTimer" | "cancelTimer"
  >;
  readonly #scope: { readonly ownerId: string; readonly agentId: string };
  readonly #clock: ClockPort;

  constructor(options: {
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
        timers: views.map(({ timer, title, task, schedule, spentMicros }) => ({
          timerId: timer.id,
          title,
          task: [...task].slice(0, TASK_LIMIT).join("") || "-",
          schedule,
          createdBy: timer.createdBy,
          status: timer.status,
          nextAt: timer.status === "active" || timer.status === "paused" ? timer.nextAt : null,
          lastAt: timer.lastScheduledAt,
          runCount: timer.runCount,
          spentMicros,
          runBudgetMicros: timer.runBudgetMicros,
          createdAt: timer.createdAt,
        })),
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
}
