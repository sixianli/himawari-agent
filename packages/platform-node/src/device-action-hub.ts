import type { DeviceActionDeliveryPort } from "@himawari-agent/application";

export const DEVICE_ACTIONS_STREAM_EVENT = "device.actions";

export function deviceActionsFrame(): string {
  return `event: ${DEVICE_ACTIONS_STREAM_EVENT}\ndata: {}\n\n`;
}

export class DeviceActionHub implements DeviceActionDeliveryPort {
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #waiters = new Map<string, Set<() => void>>();

  connected(deviceId: string): boolean {
    return (this.#listeners.get(deviceId)?.size ?? 0) > 0;
  }

  announce(deviceId: string): void {
    for (const listener of [...(this.#listeners.get(deviceId) ?? [])]) listener();
  }

  settled(actionId: string): void {
    const waiters = this.#waiters.get(actionId);
    this.#waiters.delete(actionId);
    for (const waiter of waiters ?? []) waiter();
  }

  waitFor(actionId: string, milliseconds: number): Promise<void> {
    if (milliseconds <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(actionId) ?? new Set();
      this.#waiters.set(actionId, waiters);
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        if (waiters.size === 0 && this.#waiters.get(actionId) === waiters)
          this.#waiters.delete(actionId);
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      waiters.add(done);
    });
  }

  listen(deviceId: string): { readonly next: () => Promise<void>; readonly close: () => void } {
    const listeners = this.#listeners.get(deviceId) ?? new Set();
    this.#listeners.set(deviceId, listeners);
    let pending = true;
    let wake: (() => void) | undefined;
    const listener = () => {
      pending = true;
      wake?.();
    };
    listeners.add(listener);
    return {
      next: () =>
        new Promise((resolve) => {
          const deliver = () => {
            pending = false;
            wake = undefined;
            resolve();
          };
          if (pending) deliver();
          else wake = deliver;
        }),
      close: () => {
        listeners.delete(listener);
        if (listeners.size === 0 && this.#listeners.get(deviceId) === listeners)
          this.#listeners.delete(deviceId);
      },
    };
  }
}

export async function* withDeviceActionSignals(
  source: AsyncGenerator<string>,
  hub: DeviceActionHub,
  deviceId: string,
): AsyncGenerator<string> {
  const listening = hub.listen(deviceId);
  const iterator = source[Symbol.asyncIterator]();
  let frame: Promise<IteratorResult<string>> | undefined;
  let signal: Promise<"signal"> | undefined;
  try {
    while (true) {
      frame ??= iterator.next();
      signal ??= listening.next().then(() => "signal" as const);
      const next = await Promise.race([frame, signal]);
      if (next === "signal") {
        signal = undefined;
        yield deviceActionsFrame();
        continue;
      }
      frame = undefined;
      if (next.done) return;
      yield next.value;
    }
  } finally {
    listening.close();
    void iterator.return?.(undefined).catch(() => undefined);
  }
}
