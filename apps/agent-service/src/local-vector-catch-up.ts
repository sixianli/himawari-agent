const FIRST_RETRY_MS = 60_000;
const LONGEST_RETRY_MS = 3_600_000;

export interface LocalVectorCatchUp {
  observe(ready: boolean): void;
}

export function createLocalVectorCatchUp(input: {
  readonly run: () => Promise<void>;
  readonly failed: (error: unknown, retryInMs: number) => void;
  readonly schedule?: (callback: () => void, delayMs: number) => void;
}): LocalVectorCatchUp {
  const schedule =
    input.schedule ??
    ((callback: () => void, delayMs: number) => {
      setTimeout(callback, delayMs).unref();
    });
  let ready = false;
  let state: "waiting" | "running" | "retrying" | "done" = "waiting";
  let failures = 0;
  const start = () => {
    if (!ready || state !== "waiting") return;
    state = "running";
    void input.run().then(
      () => {
        state = "done";
      },
      (error: unknown) => {
        const retryInMs = Math.min(FIRST_RETRY_MS * 2 ** failures, LONGEST_RETRY_MS);
        failures += 1;
        state = "retrying";
        schedule(() => {
          state = "waiting";
          start();
        }, retryInMs);
        try {
          input.failed(error, retryInMs);
        } catch {
          return;
        }
      },
    );
  };
  return {
    observe(next) {
      ready = next;
      start();
    },
  };
}
