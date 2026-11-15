export const DEVICE_NOTIFICATION_EVENTS = Object.freeze({
  deliver: "notification.deliver",
  withdraw: "notification.withdraw",
} as const);

export interface DeviceNotificationDeliver {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly homeKey: string | null;
  readonly createdAt: string;
}

export type DeviceNotificationFrame =
  | { readonly event: "notification.deliver"; readonly data: DeviceNotificationDeliver }
  | { readonly event: "notification.withdraw"; readonly data: { readonly id: string } };

export function deviceNotificationFrame(frame: DeviceNotificationFrame): string {
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

const QUEUE_LIMIT = 200;

export class DeviceNotificationHub {
  readonly #listeners = new Map<string, Set<(frame: DeviceNotificationFrame) => void>>();

  connected(deviceId: string): boolean {
    return (this.#listeners.get(deviceId)?.size ?? 0) > 0;
  }

  send(deviceId: string, frame: DeviceNotificationFrame): number {
    const listeners = [...(this.#listeners.get(deviceId) ?? [])];
    for (const listener of listeners) listener(frame);
    return listeners.length;
  }

  listen(deviceId: string): {
    readonly next: () => Promise<DeviceNotificationFrame>;
    readonly close: () => void;
  } {
    const listeners = this.#listeners.get(deviceId) ?? new Set();
    this.#listeners.set(deviceId, listeners);
    const queue: DeviceNotificationFrame[] = [];
    let wake: (() => void) | undefined;
    const listener = (frame: DeviceNotificationFrame) => {
      if (queue.length >= QUEUE_LIMIT) queue.shift();
      queue.push(frame);
      wake?.();
    };
    listeners.add(listener);
    return {
      next: async () => {
        while (queue.length === 0)
          await new Promise<void>((resolve) => {
            wake = () => {
              wake = undefined;
              resolve();
            };
          });
        return queue.shift() as DeviceNotificationFrame;
      },
      close: () => {
        listeners.delete(listener);
        if (listeners.size === 0 && this.#listeners.get(deviceId) === listeners)
          this.#listeners.delete(deviceId);
      },
    };
  }
}

export async function* withDeviceNotifications(
  source: AsyncGenerator<string>,
  hub: DeviceNotificationHub,
  deviceId: string,
): AsyncGenerator<string> {
  const listening = hub.listen(deviceId);
  const iterator = source[Symbol.asyncIterator]();
  let frame: Promise<IteratorResult<string>> | undefined;
  let signal: Promise<DeviceNotificationFrame> | undefined;
  try {
    while (true) {
      frame ??= iterator.next();
      signal ??= listening.next();
      const next = await Promise.race([frame, signal]);
      if ("event" in next) {
        signal = undefined;
        yield deviceNotificationFrame(next);
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

export class DevicePresence {
  readonly #lastInput = new Map<string, number>();

  record(deviceId: string, lastInputMs: number): void {
    const known = this.#lastInput.get(deviceId) ?? 0;
    if (lastInputMs > known) this.#lastInput.set(deviceId, lastInputMs);
  }

  forget(deviceId: string): void {
    this.#lastInput.delete(deviceId);
  }

  recent(nowMs: number, windowMs: number): readonly string[] {
    return [...this.#lastInput]
      .filter(([, at]) => nowMs - at <= windowMs)
      .map(([deviceId]) => deviceId);
  }
}
