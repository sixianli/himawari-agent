import type {
  DeviceNotificationDeliver,
  DeviceNotificationHub,
  DevicePresence,
} from "@himawari-agent/platform-node";

export const MAC_PLACEMENT_LIMIT = 100;

export interface NotificationPlacement {
  place(notification: DeviceNotificationDeliver, expiresAtMilliseconds: number): boolean;
  holds(id: string): boolean;
  withdraw(id: string): void;
  withdrawExpired(nowMilliseconds: number): void;
  heldCount(): number;
}

export interface MacPlacementOptions {
  readonly hub: DeviceNotificationHub;
  readonly presence: DevicePresence;
  readonly windowMilliseconds: () => number;
  readonly nowMilliseconds: () => number;
}

export class MacPlacement implements NotificationPlacement {
  readonly #options: MacPlacementOptions;
  readonly #placed = new Map<
    string,
    { readonly devices: readonly string[]; readonly expiresAt: number }
  >();

  constructor(options: MacPlacementOptions) {
    this.#options = options;
  }

  holds(id: string): boolean {
    return this.#placed.has(id);
  }

  place(notification: DeviceNotificationDeliver, expiresAtMilliseconds: number): boolean {
    if (this.#placed.has(notification.id)) return true;
    const { hub, presence } = this.#options;
    const devices = presence
      .recent(this.#options.nowMilliseconds(), this.#options.windowMilliseconds())
      .filter((deviceId) => hub.connected(deviceId))
      .slice(0, 1);
    if (devices.length === 0) return false;
    if (this.#placed.size >= MAC_PLACEMENT_LIMIT) return false;
    for (const deviceId of devices)
      hub.send(deviceId, { event: "notification.deliver", data: notification });
    this.#placed.set(notification.id, { devices, expiresAt: expiresAtMilliseconds });
    return true;
  }

  withdraw(id: string): void {
    const placed = this.#placed.get(id);
    if (!placed) return;
    this.#placed.delete(id);
    for (const deviceId of placed.devices)
      this.#options.hub.send(deviceId, { event: "notification.withdraw", data: { id } });
  }

  heldCount(): number {
    return this.#placed.size;
  }

  withdrawExpired(now: number): void {
    for (const [id, placed] of [...this.#placed]) if (now >= placed.expiresAt) this.withdraw(id);
  }
}
