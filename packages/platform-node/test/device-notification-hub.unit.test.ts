import { describe, expect, it } from "vitest";
import {
  DeviceNotificationHub,
  DevicePresence,
  deviceNotificationFrame,
  withDeviceNotifications,
} from "../src/device-notification-hub.js";

const deliver = (id: string) =>
  ({
    event: "notification.deliver",
    data: { id, kind: "reminder", title: "t", body: "b", homeKey: null, createdAt: "x" },
  }) as const;

describe("[IOS-9] device notification hub", () => {
  it("formats a frame as a named event with no id line", () => {
    const text = deviceNotificationFrame({ event: "notification.withdraw", data: { id: "a" } });
    expect(text).toBe('event: notification.withdraw\ndata: {"id":"a"}\n\n');
  });

  it("delivers to every open listener of a device only, and forgets a closed one", async () => {
    const hub = new DeviceNotificationHub();
    const first = hub.listen("mac-1");
    const second = hub.listen("mac-1");
    const other = hub.listen("mac-2");
    expect(hub.send("mac-1", deliver("a"))).toBe(2);
    expect(await first.next()).toEqual(deliver("a"));
    expect(await second.next()).toEqual(deliver("a"));
    first.close();
    expect(hub.connected("mac-1")).toBe(true);
    second.close();
    expect(hub.connected("mac-1")).toBe(false);
    expect(hub.send("mac-1", deliver("b"))).toBe(0);
    expect(hub.connected("mac-2")).toBe(true);
    other.close();
  });

  it("keeps only the newest 200 frames for a slow listener", async () => {
    const hub = new DeviceNotificationHub();
    const listening = hub.listen("mac");
    for (let index = 0; index < 205; index += 1) hub.send("mac", deliver(`id${index}`));
    const first = await listening.next();
    expect(first).toEqual(deliver("id5"));
    listening.close();
  });

  it("interleaves notification frames into a source stream and stops listening when it ends", async () => {
    const hub = new DeviceNotificationHub();
    async function* source() {
      yield "a\n\n";
      await new Promise((resolve) => setTimeout(resolve, 30));
      yield "b\n\n";
    }
    const out: string[] = [];
    const reading = (async () => {
      for await (const chunk of withDeviceNotifications(source(), hub, "mac")) out.push(chunk);
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(hub.connected("mac")).toBe(true);
    hub.send("mac", deliver("x"));
    await reading;
    expect(out[0]).toBe("a\n\n");
    expect(out.some((chunk) => chunk.startsWith("event: notification.deliver"))).toBe(true);
    expect(out.at(-1)).toBe("b\n\n");
    expect(hub.connected("mac")).toBe(false);
  });
});

describe("[IOS-9] device presence", () => {
  it("lists devices with input inside the window, keeps the newest report and can forget one", () => {
    const presence = new DevicePresence();
    presence.record("a", 1_000);
    presence.record("a", 500);
    presence.record("b", 100);
    expect(presence.recent(1_200, 300)).toEqual(["a"]);
    expect(presence.recent(1_200, 2_000)).toEqual(["a", "b"]);
    presence.forget("a");
    expect(presence.recent(1_200, 2_000)).toEqual(["b"]);
  });
});
