import type {
  DeviceNotificationDeliver,
  DeviceNotificationHub,
  DevicePresence,
} from "@himawari-agent/platform-node";

const REMEMBER_LIMIT = 500;

export interface NotificationPlacement {
  place(notification: DeviceNotificationDeliver): boolean;
  withdraw(id: string): void;
}

export interface MacPlacementOptions {
  readonly hub: DeviceNotificationHub;
  readonly presence: DevicePresence;
  readonly windowMilliseconds: () => number;
  readonly nowMilliseconds: () => number;
}

export class MacPlacement implements NotificationPlacement {
  readonly #options: MacPlacementOptions;
  readonly #placed = new Map<string, readonly string[]>();

  constructor(options: MacPlacementOptions) {
    this.#options = options;
  }

  place(notification: DeviceNotificationDeliver): boolean {
    if (this.#placed.has(notification.id)) return true;
    const { hub, presence } = this.#options;
    const devices = presence
      .recent(this.#options.nowMilliseconds(), this.#options.windowMilliseconds())
      .filter((deviceId) => hub.connected(deviceId));
    if (devices.length === 0) return false;
    for (const deviceId of devices)
      hub.send(deviceId, { event: "notification.deliver", data: notification });
    this.#placed.set(notification.id, devices);
    if (this.#placed.size > REMEMBER_LIMIT) {
      const oldest = this.#placed.keys().next().value;
      if (oldest !== undefined) this.#placed.delete(oldest);
    }
    return true;
  }

  withdraw(id: string): void {
    const devices = this.#placed.get(id);
    if (!devices) return;
    this.#placed.delete(id);
    for (const deviceId of devices)
      this.#options.hub.send(deviceId, { event: "notification.withdraw", data: { id } });
  }
}
