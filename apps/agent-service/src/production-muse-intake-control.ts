import {
  ApplicationPortError,
  type ClockPort,
  type IdGeneratorPort,
  type MuseIntakeItem,
  type MuseIntakePort,
  museSourceCounts,
  PORT_ERROR_CODES,
  type ProactiveScope,
  type ProactiveSealPort,
} from "@himawari-agent/application";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";

export const PRODUCTION_MUSE_OPERATIONS = Object.freeze([
  "muse.overview.read",
  "muse.item.rate",
  "muse.intake.set",
  "muse.data.clear",
] as const);

export const MUSE_WEEK_MS = 7 * 86_400_000;
export const MUSE_WINDOW_MS = 30 * 86_400_000;
export const MUSE_LIST_LIMIT = 20;
export const MUSE_DELAY_MINIMUM_SAMPLES = 10;

function clean(text: string, limit: number): string {
  return [...text.replace(/\p{Cc}+/gu, " ").trim()].slice(0, limit).join("");
}

export function museDelayMedianMinutes(items: readonly MuseIntakeItem[]) {
  const minutes = items
    .filter(
      (item) =>
        item.kind === "proactive" &&
        item.state === "delivered" &&
        item.eventAt !== null &&
        museSourceCounts(item.sources["event_at"]) &&
        museSourceCounts(item.sources["occurred_at"]) &&
        Date.parse(item.occurredAt) >= Date.parse(item.eventAt),
    )
    .map((item) => (Date.parse(item.occurredAt) - Date.parse(item.eventAt as string)) / 60_000)
    .sort((left, right) => left - right);
  if (minutes.length < MUSE_DELAY_MINIMUM_SAMPLES) return null;
  const middle = Math.floor(minutes.length / 2);
  const median =
    minutes.length % 2 === 1
      ? (minutes[middle] as number)
      : ((minutes[middle - 1] as number) + (minutes[middle] as number)) / 2;
  return { medianMinutes: Math.round(median), samples: minutes.length };
}

export class ProductionMuseControl {
  readonly #scope: ProactiveScope;
  readonly #store: MuseIntakePort;
  readonly #seal: ProactiveSealPort;
  readonly #ids: IdGeneratorPort;
  readonly #clock: ClockPort;

  constructor(options: {
    readonly scope: ProactiveScope;
    readonly store: MuseIntakePort;
    readonly seal: ProactiveSealPort;
    readonly ids: IdGeneratorPort;
    readonly clock: ClockPort;
  }) {
    this.#scope = options.scope;
    this.#store = options.store;
    this.#seal = options.seal;
    this.#ids = options.ids;
    this.#clock = options.clock;
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type !== "muse.overview.read") throw new Error("MUSE_OPERATION_NOT_INSTALLED");
    const now = this.#clock.now();
    const nowMs = Date.parse(now);
    const since = new Date(nowMs - MUSE_WINDOW_MS).toISOString();
    const weekStart = nowMs - MUSE_WEEK_MS;
    const items = await this.#store.listItems({ ...this.#scope, since, limit: 500 });
    const status = await this.#store.channelStatus({ ...this.#scope, now });
    const inWeek = (item: MuseIntakeItem) => Date.parse(item.occurredAt) >= weekStart;
    const proactive = items.filter((item) => item.kind === "proactive" && inWeek(item));
    const rateable = items.filter(
      (item) => item.state === "delivered" || item.state === "succeeded",
    );
    const shown = [...rateable]
      .sort(
        (left, right) =>
          Number(left.timingOk !== null) - Number(right.timingOk !== null) ||
          right.occurredAt.localeCompare(left.occurredAt),
      )
      .slice(0, MUSE_LIST_LIMIT);
    const open = async (ref: string | null, limit: number) => {
      if (ref === null) return null;
      const text = await this.#seal.open({ ...this.#scope, ref });
      return text === undefined ? null : clean(text, limit) || null;
    };
    return {
      ...query,
      kind: "snapshot",
      type: "muse.overview.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        channel: {
          state: status.state,
          lastBatchAt: status.lastBatchAt,
          gapCount: status.gapCount,
        },
        receivedWeek: proactive.filter((item) => item.state === "delivered").length,
        suppressedWeek: proactive.filter((item) => item.state === "suppressed").length,
        pending: rateable.filter((item) => item.timingOk === null).length,
        delay: museDelayMedianMinutes(items),
        items: await Promise.all(
          shown.map(async (item) => ({
            kind: item.kind,
            naturalKey: item.naturalKey,
            occurredAt: item.occurredAt,
            title: item.textWithheld ? null : await open(item.titleRef, 300),
            text: item.textWithheld ? null : await open(item.textRef, 500),
            withheld: item.textWithheld,
            timingOk: item.timingOk,
            contentOk: item.contentOk,
          })),
        ),
        generatedAt: now,
      },
    };
  }

  async execute(command: GatewayV2Command): Promise<{ resultRef: string; replayed: boolean }> {
    if (
      command.actor.actorType !== "owner" ||
      command.scope.ownerId !== this.#scope.ownerId ||
      command.scope.agentId !== this.#scope.agentId
    )
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "MUSE_OWNER_REQUIRED");
    switch (command.type) {
      case "muse.item.rate": {
        const { kind, naturalKey, timingOk, contentOk } = command.payload;
        if ((timingOk === null) !== (contentOk === null))
          throw new ApplicationPortError(
            PORT_ERROR_CODES.INVALID_OPERATION,
            "MUSE_RATING_INCOMPLETE",
          );
        const rated = await this.#store.rate({
          ...this.#scope,
          kind,
          naturalKey,
          timingOk,
          contentOk,
          entryId: this.#ids.next("muse-reference-entry"),
          now: this.#clock.now(),
        });
        if (!rated)
          throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MUSE_ITEM_NOT_FOUND");
        return { resultRef: `muse-item:${kind}:${naturalKey}`, replayed: false };
      }
      case "muse.intake.set": {
        await this.#store.setPaused({ ...this.#scope, paused: command.payload.paused });
        return { resultRef: "muse-intake-settings", replayed: false };
      }
      case "muse.data.clear": {
        const { refs } = await this.#store.clearAll(this.#scope);
        if (refs.length > 0) await this.#seal.release({ ...this.#scope, refs });
        return { resultRef: "muse-intake-cleared", replayed: false };
      }
      default:
        throw new Error("MUSE_OPERATION_NOT_INSTALLED");
    }
  }
}
