import { machineSecretHoldStart } from "@himawari-agent/sensitive-capture";
import { executionMessageItemId } from "./thread-execution-projection.js";
import { redactTracePayload } from "./trace-redaction.js";

export type ExecutionLiveEvent =
  | {
      readonly kind: "text";
      readonly threadId: string;
      readonly runId: string;
      readonly itemId: string;
      readonly offset: number;
      readonly text: string;
    }
  | { readonly kind: "changed"; readonly runId: string };

export interface ExecutionLiveText {
  readonly runId: string;
  readonly itemId: string;
  readonly text: string;
}

const RETAINED_RUNS = 200;

export class ExecutionLiveFeed {
  readonly #listeners = new Set<(event: ExecutionLiveEvent) => void>();
  readonly #texts = new Map<
    string,
    { readonly threadId: string; readonly itemId: string; readonly shown: string }
  >();

  subscribe(listener: (event: ExecutionLiveEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  assistantText(input: {
    readonly threadId: string | null;
    readonly runId: string;
    readonly timestamp: unknown;
    readonly text: string;
  }): void {
    if (!input.threadId) return;
    const itemId = executionMessageItemId(input.runId, input.timestamp);
    const holdStart = machineSecretHoldStart(input.text);
    const redacted = redactTracePayload(input.text.slice(0, holdStart ?? input.text.length));
    const shown = typeof redacted === "string" ? redacted : "";
    const prior = this.#texts.get(input.runId);
    const base = prior?.itemId === itemId ? prior.shown : "";
    if (prior && shown === base) return;
    const offset = shown.startsWith(base) ? base.length : 0;
    this.#texts.delete(input.runId);
    this.#texts.set(input.runId, { threadId: input.threadId, itemId, shown });
    if (this.#texts.size > RETAINED_RUNS) {
      const oldest = this.#texts.keys().next().value;
      if (oldest !== undefined) this.#texts.delete(oldest);
    }
    this.#emit({
      kind: "text",
      threadId: input.threadId,
      runId: input.runId,
      itemId,
      offset,
      text: shown.slice(offset),
    });
  }

  changed(runId: string): void {
    this.#emit({ kind: "changed", runId });
  }

  finished(runId: string): void {
    this.#texts.delete(runId);
  }

  current(threadId: string): readonly ExecutionLiveText[] {
    return [...this.#texts.entries()]
      .filter(([, entry]) => entry.threadId === threadId)
      .map(([runId, entry]) => ({ runId, itemId: entry.itemId, text: entry.shown }));
  }

  #emit(event: ExecutionLiveEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {}
    }
  }
}
