import type { DurableMemoryService } from "@himawari-agent/application";

export class ProductionMemoryWorker {
  readonly #service: Pick<DurableMemoryService, "runProjectionBatch">;
  readonly #assertActive: () => void | Promise<void>;
  readonly #onFailure: (error: unknown) => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<void> = Promise.resolve();
  #stopped = true;

  constructor(input: {
    service: Pick<DurableMemoryService, "runProjectionBatch">;
    assertActive: () => void | Promise<void>;
    onFailure: (error: unknown) => void;
  }) {
    this.#service = input.service;
    this.#assertActive = input.assertActive;
    this.#onFailure = input.onFailure;
  }

  async start(): Promise<void> {
    if (!this.#stopped) throw new Error("MEMORY_WORKER_ALREADY_STARTED");
    this.#stopped = false;
    this.#inFlight = this.#tick();
    await this.#inFlight;
  }

  stopAccepting(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
  }

  async drain(): Promise<void> {
    this.stopAccepting();
    await this.#inFlight;
  }

  async #tick(): Promise<void> {
    try {
      if (this.#stopped) return;
      await this.#assertActive();
      if (this.#stopped) return;
      // One claim at a time makes authority checks apply before each new job.
      await this.#service.runProjectionBatch(1);
      if (!this.#stopped) {
        this.#timer = setTimeout(() => {
          this.#inFlight = this.#tick();
          void this.#inFlight.catch(() => undefined);
        }, 1000);
        this.#timer.unref();
      }
    } catch (error) {
      this.stopAccepting();
      this.#onFailure(error);
      throw error;
    }
  }
}
