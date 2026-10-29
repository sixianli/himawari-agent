// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTROL_CENTER_SURFACE_INVENTORY } from "../src/app/control-center-inventory.js";
import { ControlCenterApp } from "../src/app.js";
import { ControlCenterBrowserStorage, THREAD_CURSOR_STORAGE_KEY } from "../src/browser-storage.js";
import type { ControlCenterRuntimeConfiguration } from "../src/gateway-client.js";
import { messages } from "../src/i18n/resources/zh-CN.js";
import { loadMessageCatalog } from "../src/i18n/runtime.js";
import {
  OPEN_REMINDERS_PAGE,
  OPEN_SETTINGS,
  reminderFocusOf,
  settingsTabOf,
} from "../src/proactive.js";

const boundary = vi.hoisted(() => ({
  load: vi.fn(),
  refresh: vi.fn(),
  login: vi.fn(),
  client: vi.fn(),
  threads: vi.fn(),
  governance: vi.fn(),
  query: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock("../src/gateway-client.js", async (original) => ({
  ...(await original<object>()),
  loadRuntimeConfiguration: boundary.load,
  refreshRuntimeConfiguration: boundary.refresh,
  createBrowserSession: boundary.login,
  GatewayClient: class {
    query = (request: unknown) => boundary.query(request);
    mutate = (request: unknown) => boundary.mutate(request);
    constructor(options: unknown) {
      boundary.client(options);
    }
  },
}));
vi.mock("../src/thread-control-center.js", () => ({ useThreadControlCenter: boundary.threads }));
vi.mock("../src/governance-control-center.js", () => ({
  useGovernanceControlCenter: boundary.governance,
}));
const configuration: ControlCenterRuntimeConfiguration = {
  ownerId: "owner-app",
  agentId: "agent-app",
  deploymentId: "deployment-app",
  authorityEpoch: 1,
  fencingToken: 1,
  actorId: "owner-app",
  csrfToken: "csrf-app",
  sessionId: "session-app",
  canCancelRun: true,
  installedGatewayV2Operations: CONTROL_CENTER_SURFACE_INVENTORY.flatMap((item) => [
    ...item.queries,
    ...item.mutations,
  ]),
};
class Events extends EventTarget {
  static instances: Events[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  readonly url: string;
  readonly options: unknown;
  constructor(url: string, options: unknown) {
    super();
    this.url = url;
    this.options = options;
    Events.instances.push(this);
  }
}
let root: Root, container: HTMLDivElement;
const fetcher = vi.fn();
const text = () => container.textContent ?? "";
async function render() {
  await act(async () => root.render(createElement(ControlCenterApp)));
}
async function settle() {
  for (let round = 0; round < 6; round++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label || item.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`Missing accessible button ${label}`);
  await act(async () => button.click());
}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", Events);
  vi.stubGlobal("fetch", fetcher);
  Events.instances = [];
  window.localStorage.clear();
  new ControlCenterBrowserStorage(window.localStorage).saveLocale("zh-CN");
  window.history.replaceState(null, "", "/threads");
  boundary.load.mockReset().mockResolvedValue(configuration);
  boundary.refresh.mockReset().mockResolvedValue({ ...configuration, csrfToken: "csrf-fresh" });
  boundary.login.mockReset().mockResolvedValue(undefined);
  boundary.client.mockReset();
  boundary.query.mockReset().mockRejectedValue(new Error("QUERY_NOT_EXPECTED"));
  boundary.mutate.mockReset().mockRejectedValue(new Error("MUTATION_NOT_EXPECTED"));
  const child = (name: string) => ({
    title: name,
    content: createElement("div", { "data-child": name }, `${name} content`),
    list: createElement("span", null, `${name} list`),
    details: createElement("span", null, `${name} details`),
  });
  boundary.threads.mockReset().mockImplementation(() => child("threads"));
  boundary.governance.mockReset().mockImplementation(() => child("governance"));
  fetcher
    .mockReset()
    .mockImplementation(async () => new Response(JSON.stringify({ method: "cloudflare-access" })));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("control center application bootstrap and interaction", () => {
  it("opens both authenticated streams, reflects connectivity and closes them on unmount", async () => {
    await render();
    expect(Events.instances).toHaveLength(2);
    expect(
      Events.instances.every(
        (source) => (source.options as { withCredentials: boolean }).withCredentials,
      ),
    ).toBe(true);
    await act(async () => {
      for (const source of Events.instances) source.onopen?.();
    });
    expect(boundary.threads.mock.lastCall?.[0].connection).toBe("connected");
    await act(async () => window.dispatchEvent(new Event("offline")));
    expect(boundary.threads.mock.lastCall?.[0].connection).toBe("offline");
    expect(Events.instances.every((source) => source.close.mock.calls.length > 0)).toBe(true);
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(Events.instances).toHaveLength(4);
    const previous = boundary.threads.mock.lastCall?.[0];
    await act(async () =>
      window.dispatchEvent(new StorageEvent("storage", { key: THREAD_CURSOR_STORAGE_KEY })),
    );
    const latest = boundary.threads.mock.lastCall?.[0];
    expect(latest.refreshSignal).toBe(previous.refreshSignal);
    expect(latest.threadEventSignal).toBe(previous.threadEventSignal + 1);
    expect(latest.threadEvents?.current).toEqual([null]);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => root.render(null));
    expect(Events.instances.every((source) => source.close.mock.calls.length > 0)).toBe(true);
  });
  it.each([401, 403])(
    "enters through Cloudflare Access on HTTP %s without asking for another click",
    async (status) => {
      boundary.load.mockRejectedValueOnce(Object.assign(new Error("session expired"), { status }));
      await render();
      await settle();
      expect(boundary.login).toHaveBeenCalledOnce();
      expect(boundary.login.mock.lastCall?.[1]).toBe(messages["authentication.deviceLabel"]);
      expect(boundary.load).toHaveBeenCalledTimes(2);
      expect(text()).toContain("threads content");
      expect(Events.instances).toHaveLength(2);
    },
  );
  it("[PG-15] opens the reminder a push points at and the apps settings after Google sign-in", async () => {
    boundary.load.mockResolvedValue({
      ...configuration,
      installedGatewayV2Operations: [
        ...(configuration.installedGatewayV2Operations ?? []),
        "memory.overview.read",
        "proactive.overview.read",
      ],
    });
    boundary.query.mockImplementation(async (request: { type: string }) =>
      request.type === "proactive.overview.read"
        ? {
            type: "proactive.overview.snapshot",
            payload: {
              source: "gmail",
              connection: { status: "connected", account: "andy@example.com", connectedAt: null },
              enabled: true,
              quietHours: [],
              importantSenders: [],
              dailyLimitReached: false,
              insights: [],
              audit: { active: false, since: "2026-11-04T00:00:00.000Z", items: [], pending: 0 },
              decisions: [],
              metrics: { spoke: 0, hits: 0, misfires: 0, missed: 0, reviewed: 0 },
              generatedAt: "2026-11-04T00:00:00.000Z",
            },
          }
        : {
            type: "memory.overview.snapshot",
            payload: { reminders: [], upcoming: [], memories: [], pending: [] },
          },
    );
    window.history.replaceState(
      null,
      "",
      "/?reminder=proactive-insight-1&settings=apps&gmail=connected&push=tag-1",
    );
    const reminders = vi.fn();
    const settings = vi.fn();
    window.addEventListener(OPEN_REMINDERS_PAGE, reminders);
    window.addEventListener(OPEN_SETTINGS, settings);
    await render();
    await settle();
    window.removeEventListener(OPEN_REMINDERS_PAGE, reminders);
    window.removeEventListener(OPEN_SETTINGS, settings);
    expect(reminders).toHaveBeenCalledOnce();
    expect(reminderFocusOf(reminders.mock.calls[0]?.[0])).toBe("proactive-insight-1");
    expect(settingsTabOf(settings.mock.calls[0]?.[0])).toBe("tools");
    expect(window.location.search).not.toContain("reminder=");
    expect(window.location.search).not.toContain("gmail=");
    expect(document.body.textContent).toContain(messages["proactive.apps.gmail"]);
    expect(document.body.textContent).toContain("已连接 Gmail。第一次检查马上开始。");
  });
  it("shows the opening state while the configuration is still loading", async () => {
    boundary.load.mockImplementation(() => new Promise(() => undefined));
    await render();
    expect(text()).toBe(messages["entry.opening"]);
    expect(container.querySelector("output")?.textContent).toBe(messages["entry.opening"]);
  });
  it("asks for the email code again when Cloudflare Access no longer lets requests through", async () => {
    boundary.load.mockRejectedValue(new TypeError("Failed to fetch"));
    fetcher.mockImplementation(async () => new Response(null, { status: 401 }));
    await render();
    await settle();
    expect(container.querySelector("h1")?.textContent).toBe(messages["entry.expired.title"]);
    expect(text()).toContain(messages["entry.expired.body"]);
    expect(text()).not.toContain("Failed to fetch");
    expect(boundary.login).not.toHaveBeenCalled();
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      messages["entry.expired.action"],
    ]);
  });
  it("explains an unreachable service without error codes and retries on its own", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      boundary.load.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      fetcher.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await render();
      await settle();
      expect(container.querySelector("h1")?.textContent).toBe(messages["entry.unreachable.title"]);
      expect(text()).toContain("5");
      expect(text()).not.toContain("Failed to fetch");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      await settle();
      expect(boundary.load).toHaveBeenCalledTimes(2);
      expect(text()).toContain("threads content");
    } finally {
      vi.useRealTimers();
    }
  });
  it("stops after one session exchange and offers a manual retry instead of looping", async () => {
    boundary.load.mockRejectedValue(Object.assign(new Error("expired"), { status: 401 }));
    await render();
    await settle();
    expect(boundary.login).toHaveBeenCalledOnce();
    expect(boundary.load).toHaveBeenCalledTimes(2);
    expect(container.querySelector("h1")?.textContent).toBe(messages["entry.unreachable.title"]);
    expect(container.querySelector("output")).toBeNull();
    boundary.load.mockResolvedValue(configuration);
    await click(messages["loading.retry"]);
    await settle();
    expect(text()).toContain("threads content");
  });
  it("hides a rejected session exchange behind the unreachable explanation", async () => {
    boundary.load.mockRejectedValue(Object.assign(new Error("expired"), { status: 401 }));
    boundary.login.mockRejectedValue(
      Object.assign(new Error("IDENTITY_ASSERTION_INVALID"), { status: 401 }),
    );
    await render();
    await settle();
    expect(container.querySelector("h1")?.textContent).toBe(messages["entry.unreachable.title"]);
    expect(text()).not.toContain("IDENTITY_ASSERTION_INVALID");
    expect(Events.instances).toHaveLength(0);
  });
  it("renders built-in authentication, completes factor verification and reloads the app", async () => {
    boundary.load.mockRejectedValueOnce(Object.assign(new Error("expired"), { status: 401 }));
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ method: "built-in" })));
    await render();
    for (const [name, value] of [
      ["username", "fixture"],
      ["password", "component-fixture"],
    ] as const) {
      const input = container.querySelector<HTMLInputElement>(`input[name=${name}]`);
      if (!input) throw new Error("missing login field");
      input.value = value;
    }
    const submit = async () => {
      await act(async () =>
        container
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
    };
    await submit();
    const code = container.querySelector<HTMLInputElement>('input[name="code"]');
    if (!code) throw new Error("missing second factor");
    code.value = "123456";
    await submit();
    expect(boundary.load).toHaveBeenCalledTimes(2);
    expect(text()).toContain("threads content");
    expect(boundary.login).not.toHaveBeenCalled();
  });
  it("clears private child state immediately when a stream reports session revocation", async () => {
    await render();
    boundary.load.mockImplementation(() => new Promise(() => undefined));
    const stream = Events.instances.find((source) => source.url.includes("/thread/"));
    if (!stream) throw new Error("missing thread stream");
    await act(async () =>
      stream.dispatchEvent(
        new MessageEvent("gateway.stream_error", {
          data: JSON.stringify({ code: "IDENTITY_SESSION_INVALID" }),
        }),
      ),
    );
    expect(boundary.threads.mock.lastCall?.[0].configuration).toBeUndefined();
    expect(boundary.threads.mock.lastCall?.[0].client).toBeUndefined();
    expect(text()).not.toContain("threads content");
    expect(text()).toBe(messages["entry.opening"]);
    expect(boundary.load).toHaveBeenCalledTimes(2);
    expect(Events.instances.every((source) => source.close.mock.calls.length > 0)).toBe(true);
  });
  it("refreshes CSRF for the active client and rejects refresh after disposal", async () => {
    await render();
    const options = boundary.client.mock.calls[0]?.[0];
    await act(async () => {
      await expect(options.refreshCsrfToken()).resolves.toBe("csrf-fresh");
    });
    expect(boundary.threads.mock.lastCall?.[0].configuration.csrfToken).toBe("csrf-fresh");
    await act(async () => root.render(null));
    await expect(options.refreshCsrfToken()).rejects.toThrow("CONTROL_CENTER_CLIENT_DISPOSED");
  });
  it("opens settings without putting focus, and its focus ring, on the close button", async () => {
    await render();
    await click(messages["settings.title"]);
    const dialog = document.querySelector<HTMLDialogElement>("dialog");
    expect(dialog?.open).toBe(true);
    expect(document.activeElement).toBe(dialog);
    expect(document.activeElement?.getAttribute("aria-label")).not.toBe(messages["common.close"]);
  });
  it("persists interface language and appearance through the actual shell controls", async () => {
    await render();
    await click(messages["settings.title"]);
    const locale = document.querySelector<HTMLSelectElement>(
      'select[aria-label="' + messages["locale.label"] + '"]',
    );
    if (!locale) throw new Error("missing language selector");
    await act(async () => {
      locale.value = "en";
      locale.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(new ControlCenterBrowserStorage(window.localStorage).readLocale([])).toBe("en");
    await act(async () => {
      await loadMessageCatalog("en");
    });
    expect(document.querySelector<HTMLDialogElement>("dialog")?.open).toBe(true);
    const theme = document.querySelector<HTMLInputElement>(
      'input[name="setting-theme"][value="light"]',
    );
    if (!theme) throw new Error("Missing theme setting");
    expect(theme.closest("label")?.textContent).toBe("Light");
    await act(async () => theme.click());
    expect(theme.checked).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(new ControlCenterBrowserStorage(window.localStorage).readPreferences().theme).toBe(
      "light",
    );
    const name = document.querySelector<HTMLInputElement>(
      'input[aria-label="What should I call you?"]',
    );
    if (!name) throw new Error("Missing name setting");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(name, "Andy");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(new ControlCenterBrowserStorage(window.localStorage).readPreferences().name).toBe(
      "Andy",
    );
  });
  it("[I-16] shows on a second device the name, language and color set on the first", async () => {
    let saved = { name: null, locale: null, accent: null, updatedAt: null } as Record<
      string,
      string | null
    >;
    boundary.load.mockResolvedValue({
      ...configuration,
      installedGatewayV2Operations: [
        ...(configuration.installedGatewayV2Operations ?? []),
        "owner.preferences.read",
        "owner.preferences.set",
      ],
    });
    boundary.query.mockImplementation(async (request: { type: string }) => {
      if (request.type !== "owner.preferences.read") throw new Error("QUERY_NOT_EXPECTED");
      return { type: "owner.preferences.snapshot", payload: saved };
    });
    boundary.mutate.mockImplementation(
      async (request: { type: string; payload: Record<string, string | null> }) => {
        if (request.type !== "owner.preferences.set") throw new Error("MUTATION_NOT_EXPECTED");
        saved = { ...request.payload, updatedAt: "2026-10-29T05:00:00.000Z" };
        return { resultRef: "owner-preferences", replayed: false };
      },
    );
    await render();
    await settle();
    await click(messages["settings.title"]);
    const name = document.querySelector<HTMLInputElement>(
      `input[aria-label="${messages["settings.name"]}"]`,
    );
    if (!name) throw new Error("Missing name setting");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(name, "Andy");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const teal = document.querySelector<HTMLInputElement>(
      'input[name="setting-accent"][value="teal"]',
    );
    if (!teal) throw new Error("Missing accent setting");
    await act(async () => teal.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    expect(saved).toEqual({
      name: "Andy",
      locale: "zh-CN",
      accent: "teal",
      updatedAt: "2026-10-29T05:00:00.000Z",
    });
    saved = { ...saved, locale: "ja" };
    await act(async () => root.unmount());
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-accent");
    root = createRoot(container);
    await render();
    await settle();
    expect(boundary.threads.mock.lastCall?.[0]).toMatchObject({ ownerName: "Andy" });
    expect(document.documentElement.getAttribute("data-accent")).toBe("teal");
    expect(new ControlCenterBrowserStorage(window.localStorage).readLocale([])).toBe("ja");
    expect(boundary.mutate).toHaveBeenCalledTimes(1);
  });
  it("[I-16] keeps a change that could not reach the server and sends it on the next visit", async () => {
    boundary.load.mockResolvedValue({
      ...configuration,
      installedGatewayV2Operations: [
        ...(configuration.installedGatewayV2Operations ?? []),
        "owner.preferences.read",
        "owner.preferences.set",
      ],
    });
    boundary.query.mockResolvedValue({
      type: "owner.preferences.snapshot",
      payload: {
        name: "Old",
        locale: "zh-CN",
        accent: "violet",
        updatedAt: "2026-10-28T00:00:00.000Z",
      },
    });
    const storage = new ControlCenterBrowserStorage(window.localStorage);
    storage.savePreferences({ ...storage.readPreferences(), name: "Andy", accent: "rose" });
    storage.markPreferencesUnsynced(true);
    boundary.mutate.mockResolvedValue({ resultRef: "owner-preferences", replayed: false });
    await render();
    await settle();
    expect(boundary.mutate.mock.lastCall?.[0]).toMatchObject({
      type: "owner.preferences.set",
      payload: { name: "Andy", locale: "zh-CN", accent: "rose" },
    });
    expect(boundary.threads.mock.lastCall?.[0]).toMatchObject({ ownerName: "Andy" });
    expect(storage.readPreferencesUnsynced()).toBe(false);
  });
  it("routes installed /approvals to the governance model", async () => {
    window.history.replaceState(null, "", "/approvals");
    await render();
    expect(text()).toContain("governance content");
    expect(boundary.threads.mock.lastCall?.[0].active).toBe(false);
  });
  it.each(["tasks", "settings", "memory", "sessions"])(
    "explains that /%s has no installed page",
    async (surface) => {
      window.history.replaceState(null, "", `/${surface}`);
      await render();
      expect(text()).toContain(messages["surface.notInstalled.title"]);
      expect(boundary.threads.mock.lastCall?.[0].active).toBe(false);
    },
  );
  it("explains a missing installed feature instead of exposing its inactive controls", async () => {
    window.history.replaceState(null, "", "/memory");
    boundary.load.mockResolvedValue({ ...configuration, installedGatewayV2Operations: [] });
    await render();
    expect(text()).toContain(messages["surface.notInstalled.title"]);
    expect(boundary.governance.mock.lastCall?.[0].active).toBe(false);
  });
  it("ignores late bootstrap resolution after the app is unmounted", async () => {
    let resolve!: (value: ControlCenterRuntimeConfiguration) => void;
    boundary.load.mockImplementation(
      () =>
        new Promise((finish) => {
          resolve = finish;
        }),
    );
    await render();
    await act(async () => root.render(null));
    await act(async () => resolve(configuration));
    expect(boundary.client).not.toHaveBeenCalled();
    expect(Events.instances).toHaveLength(0);
  });
});
