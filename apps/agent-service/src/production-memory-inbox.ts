import type {
  AgentId,
  ClockPort,
  MemoryHistoryEvent,
  OwnerId,
  ProductMemoryStatePort,
} from "@himawari-agent/application";
import { MEMORY_SAVED_EVENT, renderPrompt } from "@himawari-agent/prompt-catalog";
import type { InboxSourceRegistry, ProductionInbox } from "./production-inbox.js";

export const MEMORY_SAVED_EVENT_KIND = "memory_saved";
const MEMORY_SAVED_PRIORITY = 5;
const DEFAULT_INTERVAL_MS = 10_000;
const LOOKBACK_MS = 24 * 3_600_000;
const BATCH = 100;
const NOTICED_KINDS: readonly MemoryHistoryEvent["kind"][] = ["created", "updated"];

export interface ProductionMemoryInboxOptions {
  readonly ownerId: string;
  readonly agentId: string;
  readonly state: Pick<ProductMemoryStatePort, "listHistoryAfter" | "numbers">;
  readonly mainThread: { read(): Promise<string | undefined> };
  readonly formatTime: (iso: string) => string;
  readonly clock: ClockPort;
  readonly intervalMs?: number;
  readonly onFailure?: (error: unknown) => void;
}

export class ProductionMemoryInbox {
  readonly #options: ProductionMemoryInboxOptions;
  #inbox: Pick<ProductionInbox, "submit"> | undefined;
  #cursor = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<unknown> | undefined;
  #stopped = true;

  constructor(options: ProductionMemoryInboxOptions) {
    this.#options = options;
  }

  registerSource(registry: InboxSourceRegistry): void {
    registry.register({
      kind: MEMORY_SAVED_EVENT_KIND,
      describe: "新存下的记忆",
      externalContent: false,
      fromOwner: false,
      priority: MEMORY_SAVED_PRIORITY,
    });
  }

  attach(inbox: Pick<ProductionInbox, "submit">): void {
    this.#inbox = inbox;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#schedule(0);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running?.catch(() => undefined);
  }

  #schedule(delay: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#running = this.tick()
        .catch((error: unknown) => this.#fail(error))
        .finally(() => {
          this.#running = undefined;
          this.#schedule(this.#options.intervalMs ?? DEFAULT_INTERVAL_MS);
        });
    }, delay);
    this.#timer.unref?.();
  }

  #fail(error: unknown): void {
    try {
      this.#options.onFailure?.(error);
    } catch {}
  }

  async tick(): Promise<number> {
    const inbox = this.#inbox;
    if (!inbox) return 0;
    const scope = {
      ownerId: this.#options.ownerId as OwnerId,
      agentId: this.#options.agentId as AgentId,
    };
    const since = new Date(Date.parse(this.#options.clock.now()) - LOOKBACK_MS).toISOString();
    let submitted = 0;
    for (;;) {
      const events = await this.#options.state.listHistoryAfter({
        ...scope,
        afterId: this.#cursor,
        since,
        kinds: NOTICED_KINDS,
        limit: BATCH,
      });
      if (events.length === 0) return submitted;
      const main = await this.#options.mainThread.read();
      const numbers = new Map(
        (
          await this.#options.state.numbers({
            ...scope,
            memoryIds: [...new Set(events.map((event) => event.memoryId))],
          })
        ).map(({ memoryId, number }) => [memoryId, number]),
      );
      for (const event of events) {
        const number = numbers.get(event.memoryId);
        if (number !== undefined && (main === undefined || event.sourceThreadId !== main)) {
          const result = await inbox.submit({
            sourceKind: MEMORY_SAVED_EVENT_KIND,
            sourceRef: event.memoryId,
            sourceVersion: String(event.id),
            summary: renderPrompt(MEMORY_SAVED_EVENT, {
              number: String(number),
              time: this.#options.formatTime(event.occurredAt),
            }),
            externalContent: false,
            threadId: null,
          });
          if (!result.accepted)
            this.#fail(new Error(`MEMORY_INBOX_SUBMIT_FAILED:${result.reason}`));
          else if (!result.duplicate) submitted += 1;
        }
        this.#cursor = event.id;
      }
      if (events.length < BATCH) return submitted;
    }
  }
}
