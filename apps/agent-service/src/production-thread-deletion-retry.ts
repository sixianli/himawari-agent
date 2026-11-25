const BATCH = 50;
const INTERVAL_MS = 3_600_000;

export interface ThreadDeletionRetryPort {
  retryIncompleteThreadDeletions(input: {
    readonly limit: number;
  }): Promise<readonly { readonly lifecycle: string }[]>;
  deleteLegacyThreads(input: {
    readonly limit: number;
  }): Promise<readonly { readonly lifecycle: string }[]>;
}

export class ThreadDeletionRetry {
  readonly #deletion: ThreadDeletionRetryPort;
  readonly #intervalMs: number;
  readonly #onDiagnostic: ((event: Record<string, string>) => void) | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<number> | undefined;

  constructor(options: {
    readonly deletion: ThreadDeletionRetryPort;
    readonly intervalMs?: number;
    readonly onDiagnostic?: (event: Record<string, string>) => void;
  }) {
    this.#deletion = options.deletion;
    this.#intervalMs = options.intervalMs ?? INTERVAL_MS;
    this.#onDiagnostic = options.onDiagnostic;
  }

  async runOnce(): Promise<number> {
    let legacy = 0;
    for (;;) {
      const batch = await this.#deletion.deleteLegacyThreads({ limit: BATCH });
      const verified = batch.filter((report) => report.lifecycle === "deleted_verified").length;
      legacy += verified;
      if (batch.length < BATCH || verified === 0) break;
    }
    if (legacy > 0)
      this.#diagnose({ code: "thread_deletion.legacy_deleted", count: String(legacy) });
    const reports = await this.#deletion.retryIncompleteThreadDeletions({ limit: BATCH });
    const incomplete = reports.filter((report) => report.lifecycle !== "deleted_verified").length;
    if (incomplete > 0)
      this.#diagnose({ code: "thread_deletion.retry_incomplete", count: String(incomplete) });
    return legacy + reports.length;
  }

  #diagnose(event: Record<string, string>): void {
    try {
      this.#onDiagnostic?.(event);
    } catch {}
  }

  start(): void {
    if (this.#timer) return;
    const tick = () => {
      if (this.#running) return;
      this.#running = this.runOnce()
        .catch((error: unknown) => {
          this.#diagnose({
            code: "thread_deletion.retry_failed",
            error: error instanceof Error ? error.name : "unknown",
          });
          return 0;
        })
        .finally(() => {
          this.#running = undefined;
        });
    };
    tick();
    this.#timer = setInterval(tick, this.#intervalMs);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }
}
