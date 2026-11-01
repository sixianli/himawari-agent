// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createIntl } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationSettings } from "../src/components/notification-settings.tsx";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../src/gateway-client.ts";
import type { MessageId } from "../src/i18n/message-ids.ts";
import { messages as en } from "../src/i18n/resources/en.ts";
import { messages as ja } from "../src/i18n/resources/ja.ts";
import { messages } from "../src/i18n/resources/zh-CN.ts";
import {
  type PushBrowser,
  type PushStatus,
  pushSupport,
  reportPushFeedback,
  startPresenceHeartbeat,
  webPushSubscriptionId,
} from "../src/web-push.ts";

const configuration: ControlCenterRuntimeConfiguration = {
  ownerId: "owner",
  agentId: "agent",
  deploymentId: "deployment",
  authorityEpoch: 1,
  fencingToken: 1,
  actorId: "owner",
  csrfToken: "csrf-fixture",
  authorizationRef: "authorization-01",
  installedGatewayV2Operations: [
    "push.status.read",
    "push.subscription.set",
    "push.kinds.set",
    "push.test",
  ],
};
const intl = createIntl({ locale: "zh-CN", messages });
const message = (id: MessageId, values?: Record<string, string | number>) =>
  intl.formatMessage({ id }, values);
const PUBLIC_KEY =
  "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
const ENDPOINT = "https://push.example/this-device";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15";

const THIS_DEVICE_ID = "web-push-13e30baf6fc9963eab79da53";

function fakeBrowser(input: {
  userAgent: string;
  standalone: boolean;
  permission: NotificationPermission;
  answer?: NotificationPermission;
  subscribed?: boolean;
  registered?: boolean;
}) {
  let registered = input.registered ?? input.subscribed ?? false;
  let current: PushSubscription | null = null;
  const unsubscribe = vi.fn(async () => {
    current = null;
    return true;
  });
  const makeSubscription = () =>
    ({
      endpoint: ENDPOINT,
      unsubscribe,
      toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: "device-key", auth: "device-auth" } }),
    }) as unknown as PushSubscription;
  if (input.subscribed) current = makeSubscription();
  const subscribe = vi.fn(async () => {
    current = makeSubscription();
    return current;
  });
  const notification = {
    permission: input.permission,
    requestPermission: vi.fn(async () => {
      notification.permission = input.answer ?? "granted";
      return notification.permission;
    }),
  };
  const pushManager = {
    getSubscription: async () => current,
    subscribe,
  } as unknown as PushManager;
  let activate: (value: { readonly pushManager: PushManager }) => void = () => undefined;
  const ready = new Promise<{ readonly pushManager: PushManager }>((resolve) => {
    activate = resolve;
  });
  if (registered) activate({ pushManager });
  const register = vi.fn(async () => {
    registered = true;
    activate({ pushManager });
    return {};
  });
  const browser: PushBrowser = {
    userAgent: input.userAgent,
    maxTouchPoints: input.userAgent.includes("iPhone") ? 5 : 0,
    standalone: input.standalone,
    notification,
    serviceWorker: {
      register,
      getRegistration: async () => (registered ? { pushManager } : undefined),
      ready,
    },
  };
  return { browser, notification, register, subscribe, unsubscribe };
}

function status(
  subscriptions: PushStatus["subscriptions"] = [],
  kinds: PushStatus["kinds"] = ["reminder", "approval", "run"],
): PushStatus {
  return {
    available: true,
    publicKey: PUBLIC_KEY,
    kinds,
    subscriptions,
    generatedAt: "2026-10-26T12:00:00.000Z",
  };
}

const device = (
  subscriptionId: string,
  deviceLabel: string,
  change: Partial<PushStatus["subscriptions"][number]> = {},
): PushStatus["subscriptions"][number] => ({
  subscriptionId,
  deviceLabel,
  endpointHost: "push.example",
  locale: "zh-CN",
  state: "active",
  failureCode: null,
  createdAt: "2026-10-26T10:00:00.000Z",
  lastDeliveredAt: null,
  ...change,
});

describe("[WP-8] notification settings", () => {
  let container: HTMLDivElement;
  let root: Root;
  const query = vi.fn();
  const mutate = vi.fn();
  const client = { query, mutate } as unknown as GatewayClient;
  let snapshot: PushStatus;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    snapshot = status();
    query.mockReset();
    mutate.mockReset();
    query.mockImplementation(async () => ({ type: "push.status.snapshot", payload: snapshot }));
    mutate.mockImplementation(async (command: { type: string; payload: { endpoint?: string } }) => {
      if (command.type === "push.subscription.set" && command.payload.endpoint) {
        snapshot = status([device(THIS_DEVICE_ID, "Mac 浏览器")], snapshot.kinds);
        return { resultRef: THIS_DEVICE_ID, replayed: false };
      }
      if (command.type === "push.kinds.set") {
        snapshot = {
          ...snapshot,
          kinds: (command.payload as unknown as { kinds: PushStatus["kinds"] }).kinds,
        };
        return { resultRef: "kinds", replayed: false };
      }
      return { resultRef: "ok", replayed: false };
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(browser: PushBrowser) {
    await act(async () => {
      root.render(
        h(NotificationSettings, {
          client,
          configuration,
          locale: "zh-CN",
          connected: true,
          message,
          browser,
        }),
      );
    });
    await settle();
  }

  const settle = () =>
    act(async () => {
      for (let round = 0; round < 5; round += 1)
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(text),
    );

  it("[WP-8] asks iPhone Safari tabs to add the app to the Home Screen first", async () => {
    const fake = fakeBrowser({ userAgent: IPHONE, standalone: false, permission: "default" });
    expect(pushSupport(fake.browser)).toBe("install-first");
    await render(fake.browser);
    expect(container.textContent).toContain("先把 Himawari 加到主屏幕");
    expect(container.textContent).toContain("选“添加到主屏幕”，再点“添加”");
    expect(button("在这台设备开启通知")).toBeUndefined();
    expect(pushSupport({ ...fake.browser, standalone: true })).toBe("supported");
  });

  it("[I-39] keeps the switches and the enable button usable when permission is granted but no worker was ever registered", async () => {
    const fake = fakeBrowser({
      userAgent: MAC,
      standalone: false,
      permission: "granted",
      registered: false,
    });
    await render(fake.browser);
    const switches = [...container.querySelectorAll<HTMLInputElement>('input[role="switch"]')];
    expect(switches).toHaveLength(3);
    expect(switches.every((item) => !item.disabled)).toBe(true);
    expect(button("在这台设备开启通知")?.disabled).toBe(false);
    await act(async () => button("在这台设备开启通知")?.click());
    await settle();
    expect(fake.register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(container.textContent).toContain("这台设备 · 已开启");
  });

  it("[WP-8] turns on push: switches save for the account, then permission, worker, subscription and a test", async () => {
    const fake = fakeBrowser({ userAgent: MAC, standalone: false, permission: "default" });
    await render(fake.browser);
    const runToggle = container.querySelector<HTMLInputElement>('input[aria-label="任务结束"]');
    await act(async () => runToggle?.click());
    await act(async () => button("在这台设备开启通知")?.click());
    await settle();

    expect(fake.notification.requestPermission).toHaveBeenCalledOnce();
    expect(fake.register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    const [options] = fake.subscribe.mock.calls[0] as unknown as [PushSubscriptionOptionsInit];
    expect(options.userVisibleOnly).toBe(true);
    expect(
      btoa(String.fromCharCode(...(options.applicationServerKey as Uint8Array)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
    ).toBe(PUBLIC_KEY);
    const [kindsSet, subscribe, test] = mutate.mock.calls.map(([command]) => command);
    expect(kindsSet).toMatchObject({
      type: "push.kinds.set",
      payload: { kinds: ["reminder", "approval"] },
    });
    expect(subscribe).toMatchObject({
      type: "push.subscription.set",
      authorizationRef: "authorization-01",
      payload: {
        action: "subscribe",
        endpoint: ENDPOINT,
        keys: { p256dh: "device-key", auth: "device-auth" },
        locale: "zh-CN",
        deviceLabel: "Mac 浏览器",
      },
    });
    expect(test).toMatchObject({
      type: "push.test",
      payload: { subscriptionId: THIS_DEVICE_ID },
    });
    expect(container.textContent).toContain("这台设备 · 已开启");
    expect(container.textContent).toContain("已发出，几秒内会弹出。");
  });

  it("[WP-8] shows the account switches on a device that is not subscribed, and a change from another device after reload", async () => {
    const fake = fakeBrowser({ userAgent: MAC, standalone: false, permission: "default" });
    snapshot = status([device("web-push-phone", "iPhone 主屏应用")], ["reminder", "approval"]);
    await render(fake.browser);
    const switchFor = (label: string) =>
      container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    expect(switchFor("任务结束")?.checked).toBe(false);
    expect(switchFor("等你审批")?.checked).toBe(true);
    mutate.mockClear();
    await act(async () => switchFor("任务结束")?.click());
    await settle();
    expect(mutate.mock.calls.map(([command]) => command.type)).toEqual(["push.kinds.set"]);
    expect(switchFor("任务结束")?.checked).toBe(true);
  });

  it("[WP-8] explains how to unblock when notifications were refused", async () => {
    const fake = fakeBrowser({
      userAgent: IPHONE,
      standalone: true,
      permission: "default",
      answer: "denied",
    });
    await render(fake.browser);
    await act(async () => button("在这台设备开启通知")?.click());
    await settle();
    expect(fake.subscribe).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("这台设备拒绝了通知");
    expect(container.textContent).toContain("设置” › 通知 › Himawari");
  });

  it("[WP-8] changes kinds without a test, shows a paused device and removes other devices", async () => {
    const fake = fakeBrowser({
      userAgent: IPHONE,
      standalone: true,
      permission: "granted",
      subscribed: true,
    });
    snapshot = status(
      [
        device(THIS_DEVICE_ID, "iPhone 主屏应用", {
          state: "paused",
          failureCode: "WEB_PUSH_HTTP_403",
        }),
        device("web-push-other", "Mac 浏览器", { lastDeliveredAt: "2026-10-26T06:32:00.000Z" }),
      ],
      ["reminder", "run"],
    );
    await render(fake.browser);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="等你审批"]')?.checked).toBe(
      false,
    );
    expect(container.textContent).toContain("这台设备的推送已暂停");
    expect(container.textContent).toContain("WEB_PUSH_HTTP_403");
    expect(container.textContent).toContain("其他已开启的设备");

    mutate.mockImplementation(async () => ({ resultRef: THIS_DEVICE_ID, replayed: false }));
    await act(async () =>
      container.querySelector<HTMLInputElement>('input[aria-label="等你审批"]')?.click(),
    );
    await settle();
    expect(mutate.mock.calls.map(([command]) => command.type)).toEqual(["push.kinds.set"]);
    expect(mutate.mock.calls[0]?.[0].payload.kinds).toEqual(["reminder", "approval", "run"]);

    await act(async () => button("移除")?.click());
    await settle();
    expect(mutate.mock.calls.at(-1)?.[0].payload).toEqual({
      action: "unsubscribe",
      subscriptionId: "web-push-other",
      endpoint: null,
      keys: null,
      locale: null,
      deviceLabel: null,
    });
    expect(fake.unsubscribe).not.toHaveBeenCalled();

    await act(async () => button("在这台设备关闭")?.click());
    await settle();
    expect(fake.unsubscribe).toHaveBeenCalledOnce();
    expect(mutate.mock.calls.at(-1)?.[0].payload.subscriptionId).toBe(THIS_DEVICE_ID);
  });

  it("[WP-8] says when the server has no push key", async () => {
    snapshot = { ...status(), available: false, publicKey: null };
    await render(fakeBrowser({ userAgent: MAC, standalone: false, permission: "default" }).browser);
    expect(container.textContent).toContain("这台服务器还没开推送。");
  });

  it("[WP-8] computes the same device id as the server and has every text in three languages", async () => {
    expect(await webPushSubscriptionId(ENDPOINT)).toBe(THIS_DEVICE_ID);
    const ids = Object.keys(messages).filter((id) => id.startsWith("push."));
    expect(ids.length).toBeGreaterThan(30);
    for (const id of ids) {
      expect(en[id as MessageId]).toBeTruthy();
      expect(ja[id as MessageId]).toBeTruthy();
    }
  });

  it("[WP-8] reports page presence every 30 seconds while visible and at once when hidden", async () => {
    let visibility: DocumentVisibilityState = "visible";
    const listeners = new Map<string, () => void>();
    let tick: (() => void) | undefined;
    const stop = startPresenceHeartbeat({
      client,
      configuration,
      document: {
        get visibilityState() {
          return visibility;
        },
        addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
        removeEventListener: (name: string) => listeners.delete(name),
      } as unknown as Document,
      setInterval: (handler, ms) => {
        expect(ms).toBe(30_000);
        tick = handler;
        return 1;
      },
      clearInterval: vi.fn(),
    });
    tick?.();
    visibility = "hidden";
    listeners.get("visibilitychange")?.();
    tick?.();
    const beats = mutate.mock.calls.map(([command]) => command);
    expect(beats.map((command) => [command.type, command.payload.visible])).toEqual([
      ["presence.heartbeat", true],
      ["presence.heartbeat", true],
      ["presence.heartbeat", false],
    ]);
    expect(new Set(beats.map((command) => command.payload.clientId)).size).toBe(1);
    stop();
    expect(listeners.size).toBe(0);
  });

  it("[WP-11] reports an opened notification from the address and dismissals kept by the worker, then forgets them", async () => {
    const TAG = "q1c2Zt9sV0Kx3mWbYp7aLrUe4nHd8fGj";
    const entries = new Map<string, unknown>([
      [
        "/push-feedback/d1/dismissed",
        { tag: "dismissedTag", reaction: "dismissed", occurredAt: "2026-10-28T05:00:00.000Z" },
      ],
      ["/push-feedback/bad/dismissed", { tag: "bad tag!", reaction: "dismissed", occurredAt: "x" }],
    ]);
    const cache = {
      keys: async () => [...entries.keys()].map((url) => ({ url }) as Request),
      match: async (request: Request) =>
        ({ json: async () => entries.get(request.url) }) as Response,
      delete: async (request: Request) => entries.delete(request.url),
    };
    const replaceState = vi.fn();
    await reportPushFeedback({
      client,
      configuration,
      location: { href: `https://himawari.example/threads/t1?push=${TAG}&x=1#end` },
      history: { replaceState, state: { kept: true } },
      caches: { open: async () => cache as unknown as Cache },
      now: () => new Date("2026-10-28T05:01:00.000Z"),
    });
    expect(replaceState).toHaveBeenCalledWith({ kept: true }, "", "/threads/t1?x=1#end");
    const [command] = mutate.mock.calls.at(-1) ?? [];
    expect(command).toMatchObject({
      type: "push.feedback.record",
      authorizationRef: "authorization-01",
      payload: {
        events: [
          { tag: TAG, reaction: "opened", occurredAt: "2026-10-28T05:01:00.000Z" },
          { tag: "dismissedTag", reaction: "dismissed", occurredAt: "2026-10-28T05:00:00.000Z" },
        ],
      },
    });
    expect(entries.size).toBe(0);

    mutate.mockClear();
    await reportPushFeedback({
      client,
      configuration,
      location: { href: "https://himawari.example/threads/t1" },
      history: { replaceState, state: null },
      caches: undefined,
      now: () => new Date(),
    });
    expect(mutate).not.toHaveBeenCalled();
  });
});
