export const COMMAND_SILENCE_MS = 30_000;
export const COMMAND_SILENCE_CHECK_INTERVAL_MS = 5_000;
export const COMMAND_SILENCE_MAX_LAG_MS = 2_000;

export interface CommandSilenceDetail {
  readonly runId: string;
  readonly silentMs: number;
}

export interface CommandSilenceWatchOptions {
  readonly onSilent: (detail: CommandSilenceDetail) => void;
  readonly onResumed: (detail: CommandSilenceDetail) => void;
  readonly silenceMs?: number;
  readonly checkIntervalMs?: number;
  readonly maxLagMs?: number;
}

interface Entry {
  readonly runId: string;
  lastContactAt: number;
  reported: boolean;
}

export class CommandSilenceWatch {
  readonly #entries = new Map<string, Entry>();
  readonly #options: CommandSilenceWatchOptions;
  readonly #silenceMs: number;
  readonly #checkIntervalMs: number;
  readonly #maxLagMs: number;
  #lastCheckAt: number | null = null;

  constructor(options: CommandSilenceWatchOptions) {
    this.#options = options;
    this.#silenceMs = options.silenceMs ?? COMMAND_SILENCE_MS;
    this.#checkIntervalMs = options.checkIntervalMs ?? COMMAND_SILENCE_CHECK_INTERVAL_MS;
    this.#maxLagMs = options.maxLagMs ?? COMMAND_SILENCE_MAX_LAG_MS;
  }

  size(): number {
    return this.#entries.size;
  }

  observe(key: string, runId: string, running: boolean, nowMs: number): void {
    if (!running) {
      this.#entries.delete(key);
      return;
    }
    const entry = this.#entries.get(key);
    if (!entry) {
      this.#entries.set(key, { runId, lastContactAt: nowMs, reported: false });
      return;
    }
    if (entry.reported)
      this.#options.onResumed({ runId: entry.runId, silentMs: nowMs - entry.lastContactAt });
    entry.lastContactAt = nowMs;
    entry.reported = false;
  }

  check(nowMs: number): void {
    const previous = this.#lastCheckAt;
    this.#lastCheckAt = nowMs;
    if (previous !== null && nowMs - previous > this.#checkIntervalMs + this.#maxLagMs) {
      for (const entry of this.#entries.values()) if (!entry.reported) entry.lastContactAt = nowMs;
      return;
    }
    for (const entry of this.#entries.values()) {
      const silentMs = nowMs - entry.lastContactAt;
      if (entry.reported || silentMs < this.#silenceMs) continue;
      entry.reported = true;
      this.#options.onSilent({ runId: entry.runId, silentMs });
    }
  }
}
