import {
  type ClockPort,
  ownerMessagesPrompt,
  type PayloadProtectorPort,
  type PayloadStorePort,
  type RuntimeSteerNote,
  type ThreadRepositoryPort,
} from "@himawari-agent/application";

type FoldInput = Parameters<ThreadRepositoryPort["foldQueuedOwnerRuns"]>[0];
type RunId = FoldInput["runId"];

const DEFAULT_INTERVAL_MS = 500;

export interface ProductionOwnerSteeringOptions {
  readonly ownerId: FoldInput["ownerId"];
  readonly agentId: FoldInput["agentId"];
  readonly threads: Pick<ThreadRepositoryPort, "foldQueuedOwnerRuns" | "unfoldOwnerRun">;
  readonly payloads: Pick<PayloadStorePort, "get">;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly limit: () => Promise<number>;
  readonly intervalMs?: number;
  readonly onFailure?: (error: unknown) => void;
}

export class ProductionOwnerSteering {
  readonly #options: ProductionOwnerSteeringOptions;
  readonly #listeners = new Map<string, (note: RuntimeSteerNote) => boolean>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #polling: Promise<void> | undefined;

  constructor(options: ProductionOwnerSteeringOptions) {
    this.#options = options;
  }

  subscribe(runId: string, listener: (note: RuntimeSteerNote) => boolean): () => void {
    this.#listeners.set(runId, listener);
    if (!this.#timer) {
      this.#timer = setInterval(() => {
        void this.poll();
      }, this.#options.intervalMs ?? DEFAULT_INTERVAL_MS);
      this.#timer.unref?.();
    }
    return () => {
      if (this.#listeners.get(runId) === listener) this.#listeners.delete(runId);
      if (this.#listeners.size === 0 && this.#timer) {
        clearInterval(this.#timer);
        this.#timer = undefined;
      }
    };
  }

  poll(): Promise<void> {
    this.#polling ??= this.#pollAll().finally(() => {
      this.#polling = undefined;
    });
    return this.#polling;
  }

  async #pollAll(): Promise<void> {
    for (const [runId, listener] of [...this.#listeners])
      await this.#steer(runId as RunId, listener).catch((error: unknown) => {
        try {
          this.#options.onFailure?.(error);
        } catch {}
      });
  }

  async #steer(runId: RunId, listener: (note: RuntimeSteerNote) => boolean): Promise<void> {
    const { ownerId, agentId, threads, clock } = this.#options;
    const folded = await threads.foldQueuedOwnerRuns({
      ownerId,
      agentId,
      runId,
      limit: await this.#options.limit(),
      now: clock.now(),
      whileRunning: true,
    });
    const first = folded[0];
    if (!first) return;
    let delivered = false;
    try {
      const parts = [];
      for (const message of folded)
        parts.push({
          id: message.messageId,
          text: await this.#text(message.contentRef),
          viaPhoneVoice: message.viaPhoneVoice === true,
        });
      delivered =
        this.#listeners.get(runId) === listener &&
        listener({
          ref: `owner-follow-up:${runId}:${first.position}`,
          modelContent: ownerMessagesPrompt(parts),
        });
    } finally {
      if (!delivered)
        for (const message of folded)
          await threads.unfoldOwnerRun({ ownerId, agentId, runId, foldedRunId: message.runId });
    }
  }

  async #text(ref: string): Promise<string> {
    const payload = await this.#options.payloads.get(ref as never);
    if (!payload) throw new Error("OWNER_FOLLOW_UP_MESSAGE_MISSING");
    return new TextDecoder("utf-8", { fatal: false }).decode(
      await this.#options.protector.unprotect({
        ownerId: this.#options.ownerId,
        agentId: this.#options.agentId,
        payload,
      }),
    );
  }
}
