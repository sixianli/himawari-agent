import { thinkSettingDefinition } from "@himawari-agent/application";

const DAY_MS = 86_400_000;
const BATCH = 50;
const BATCHES_PER_PASS = 20;
const INTERVAL_MS = 3_600_000;

export interface ThinkRetentionDeletion {
  deleteExpiredThinkThreads(input: {
    readonly archivedBefore: string;
    readonly activeBefore: string;
    readonly limit: number;
  }): Promise<readonly unknown[]>;
}

export interface ThinkRetentionOptions {
  readonly deletion: ThinkRetentionDeletion;
  readonly settings: {
    overrides(): Promise<Readonly<Record<string, number>>>;
    defaultValue(key: "threadRetentionDays"): number;
  };
  readonly clock: { now(): string };
  readonly intervalMs?: number;
  readonly onDiagnostic?: (event: Record<string, string>) => void;
}

export class ThinkThreadRetention {
  readonly #options: ThinkRetentionOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<number> | undefined;

  constructor(options: ThinkRetentionOptions) {
    this.#options = options;
  }

  async retentionDays(): Promise<number> {
    const { minimum, maximum } = thinkSettingDefinition("threadRetentionDays");
    const stored = await this.#options.settings
      .overrides()
      .then((overrides) => overrides["threadRetentionDays"])
      .catch(() => undefined);
    if (
      stored !== undefined &&
      Number.isSafeInteger(stored) &&
      stored >= minimum &&
      stored <= maximum
    )
      return stored;
    return this.#options.settings.defaultValue("threadRetentionDays");
  }

  async runOnce(): Promise<number> {
    const days = await this.retentionDays();
    const now = Date.parse(this.#options.clock.now());
    const archivedBefore = new Date(now - days * DAY_MS).toISOString();
    const activeBefore = new Date(now - (days + 1) * DAY_MS).toISOString();
    let deleted = 0;
    for (let batch = 0; batch < BATCHES_PER_PASS; batch += 1) {
      const reports = await this.#options.deletion.deleteExpiredThinkThreads({
        archivedBefore,
        activeBefore,
        limit: BATCH,
      });
      deleted += reports.length;
      if (reports.length < BATCH) break;
    }
    return deleted;
  }

  start(): void {
    if (this.#timer) return;
    const tick = () => {
      if (this.#running) return;
      this.#running = this.runOnce()
        .catch((error: unknown) => {
          this.#options.onDiagnostic?.({
            code: "think.retention_failed",
            error: error instanceof Error ? error.name : "unknown",
          });
          return 0;
        })
        .finally(() => {
          this.#running = undefined;
        });
    };
    tick();
    this.#timer = setInterval(tick, this.#options.intervalMs ?? INTERVAL_MS);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }
}
