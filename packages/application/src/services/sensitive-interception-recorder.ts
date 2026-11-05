import type { AgentId, OwnerId } from "@himawari-agent/domain";
import type {
  SensitiveInterceptionObservation,
  SensitiveInterceptionStorePort,
} from "../ports/sensitive-interceptions.js";
import type { ModelEgressContext, ModelEgressSighting } from "./model-egress.js";

export const SENSITIVE_INTERCEPTION_QUEUE_LIMIT = 2000;
const WRITE_BATCH = 500;
const WRITE_DELAY_MS = 200;

export interface SensitiveInterceptionRecorderOptions {
  readonly store: SensitiveInterceptionStorePort;
  readonly now: () => string;
  readonly queueLimit?: number;
  readonly onWriteFailed?: (error: unknown) => void;
  readonly onDropped?: (count: number) => void;
}

interface Pending {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly observation: SensitiveInterceptionObservation;
  readonly at: string;
}

export class SensitiveInterceptionRecorder {
  readonly #options: SensitiveInterceptionRecorderOptions;
  readonly #limit: number;
  #queue: Pending[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #writing: Promise<void> = Promise.resolve();
  #dropped = 0;

  constructor(options: SensitiveInterceptionRecorderOptions) {
    this.#options = options;
    this.#limit = options.queueLimit ?? SENSITIVE_INTERCEPTION_QUEUE_LIMIT;
  }

  get dropped(): number {
    return this.#dropped;
  }

  readonly reportEgress = (
    context: ModelEgressContext,
    sightings: readonly ModelEgressSighting[],
  ): void => {
    this.observe(
      context,
      sightings.map((sighting) => ({
        threadId: context.threadId,
        source: context.source,
        purpose: context.purpose,
        part: sighting.part,
        category: sighting.category,
        ruleId: sighting.ruleId,
        fingerprint: sighting.fingerprint,
        outcome: "masked",
        occurrences: 1,
      })),
    );
  };

  observe(
    scope: { readonly ownerId: OwnerId; readonly agentId: AgentId },
    observations: readonly SensitiveInterceptionObservation[],
  ): void {
    if (observations.length === 0) return;
    let at: string;
    try {
      at = this.#options.now();
    } catch {
      return;
    }
    for (const observation of observations)
      this.#queue.push({ ownerId: scope.ownerId, agentId: scope.agentId, observation, at });
    const excess = this.#queue.length - this.#limit;
    if (excess > 0) {
      this.#queue.splice(0, excess);
      this.#dropped += excess;
      try {
        this.#options.onDropped?.(excess);
      } catch {
        return;
      }
    }
    this.#schedule();
  }

  flush(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const next = this.#writing.then(() => this.#drain());
    this.#writing = next;
    return next;
  }

  #schedule(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, WRITE_DELAY_MS);
    (this.#timer as { unref?: () => void }).unref?.();
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      const batch = this.#queue.splice(0, WRITE_BATCH);
      const groups = new Map<string, Pending[]>();
      for (const item of batch) {
        const key = JSON.stringify([item.ownerId, item.agentId]);
        const group = groups.get(key);
        if (group) group.push(item);
        else groups.set(key, [item]);
      }
      for (const items of groups.values()) {
        const first = items[0];
        if (first === undefined) continue;
        try {
          await this.#options.store.record({
            ownerId: first.ownerId,
            agentId: first.agentId,
            observations: items.map(({ observation }) => observation),
            now: items.reduce((latest, { at }) => (at > latest ? at : latest), first.at),
          });
        } catch (error) {
          try {
            this.#options.onWriteFailed?.(error);
          } catch {
            continue;
          }
        }
      }
    }
  }
}
