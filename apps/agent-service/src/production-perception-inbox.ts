import type {
  ClockPort,
  PerceptionEpisode,
  PerceptionRecordType,
  PerceptionScope,
  PerceptionStorePort,
} from "@himawari-agent/application";
import { PERCEPTION_EPISODE_EVENT, renderPrompt } from "@himawari-agent/prompt-catalog";
import type { InboxSourceRegistry, ProductionInbox } from "./production-inbox.js";

export const PERCEPTION_EPISODE_EVENT_KIND = "perception_episode";
const PERCEPTION_EPISODE_PRIORITY = 5;

export interface ProductionPerceptionInboxOptions {
  readonly scope: PerceptionScope;
  readonly store: Pick<PerceptionStorePort, "readSettings">;
  readonly timeZone: string;
  readonly clock: ClockPort;
}

function localMinute(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

export class ProductionPerceptionInbox {
  readonly #options: ProductionPerceptionInboxOptions;
  #inbox: Pick<ProductionInbox, "submit"> | undefined;

  constructor(options: ProductionPerceptionInboxOptions) {
    this.#options = options;
  }

  registerSource(registry: InboxSourceRegistry): void {
    registry.register({
      kind: PERCEPTION_EPISODE_EVENT_KIND,
      describe: "手机感知到的一段经历",
      externalContent: true,
      fromOwner: false,
      priority: PERCEPTION_EPISODE_PRIORITY,
    });
  }

  attach(inbox: Pick<ProductionInbox, "submit">): void {
    this.#inbox = inbox;
  }

  async episode(input: {
    readonly episode: PerceptionEpisode;
    readonly types: readonly PerceptionRecordType[];
  }): Promise<void> {
    const inbox = this.#inbox;
    if (!inbox) throw new Error("PERCEPTION_INBOX_NOT_READY");
    const settings = await this.#options.store.readSettings(this.#options.scope);
    const now = this.#options.clock.now();
    if (settings.pausedUntil !== null && settings.pausedUntil > now) return;
    const { episode } = input;
    const result = await inbox.submit({
      sourceKind: PERCEPTION_EPISODE_EVENT_KIND,
      sourceRef: episode.id,
      sourceVersion: String(episode.recordCount),
      summary: renderPrompt(PERCEPTION_EPISODE_EVENT, {
        episodeId: episode.id,
        from: localMinute(episode.startedAtMs, this.#options.timeZone),
        to: localMinute(episode.endedAtMs + 60_000, this.#options.timeZone),
        kinds: [...input.types].sort().join(", "),
      }),
      externalContent: true,
      threadId: null,
    });
    if (!result.accepted) throw new Error(`PERCEPTION_INBOX_SUBMIT_FAILED:${result.reason}`);
  }
}
