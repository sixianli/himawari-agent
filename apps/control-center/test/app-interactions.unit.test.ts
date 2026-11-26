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
  const button = [...document.querySelectorAll("button")].find(
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
            payload: { reminders: [], upcoming: [], cancelled: [], memories: [], pending: [] },
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
  it("[UI-S1] signs out from settings with a built-in account and shows the build version", async () => {
    vi.stubGlobal("__HIMAWARI_BUILD__", { revision: "0268662", date: "2026-11-01" });
    fetcher.mockImplementation(
      async (url: string) =>
        new Response(JSON.stringify(url.endsWith("/method") ? { method: "built-in" } : {})),
    );
    await render();
    await click(messages["settings.title"]);
    expect(document.querySelector("dialog")?.textContent).toContain("版本 0268662 · 2026/11/1");
    boundary.load.mockImplementation(() => new Promise(() => undefined));
    await click(messages["account.signOut"]);
    const logout = fetcher.mock.calls.find(([url]) => String(url).endsWith("/logout"));
    expect(logout?.[1]?.method).toBe("POST");
    expect(logout?.[1]?.headers["x-csrf-token"]).toBe(configuration.csrfToken);
    expect(text()).toBe(messages["entry.opening"]);
  });
  it("[UI-S1] shows the build date as written, not shifted by the viewer's time zone", async () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    try {
      vi.stubGlobal("__HIMAWARI_BUILD__", { revision: "0268662", date: "2026-11-01" });
      await render();
      await click(messages["settings.title"]);
      expect(document.querySelector(".settings-version")?.textContent).toBe(
        "版本 0268662 · 2026/11/1",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("[UI-S1] keeps the account when sign-out fails and lets the owner try again", async () => {
    fetcher.mockImplementation(async (url: string) =>
      url.endsWith("/method")
        ? new Response(JSON.stringify({ method: "built-in" }))
        : new Response("{}", { status: 503 }),
    );
    await render();
    await click(messages["settings.title"]);
    await click(messages["account.signOut"]);
    expect(document.querySelector('dialog [role="alert"]')?.textContent).toBe(
      messages["account.deviceActionFailed"],
    );
    expect(text()).toContain("threads content");
    expect(
      document.querySelector<HTMLButtonElement>("dialog .setting-row button:not([aria-haspopup])")
        ?.disabled,
    ).toBe(false);
  });
  it("[UI-S2] offers no sign-out without a built-in account and hides an unknown build version", async () => {
    await render();
    await click(messages["settings.title"]);
    expect(document.querySelector("dialog")?.textContent).not.toContain(
      messages["account.signOut"],
    );
    expect(document.querySelector(".settings-version")).toBeNull();
  });
  it("persists interface language and appearance through the actual shell controls", async () => {
    await render();
    await click(messages["settings.title"]);
    expect(document.querySelector("dialog select")).toBeNull();
    const locale = document.querySelector<HTMLButtonElement>(
      `button[aria-haspopup="listbox"][aria-label="${messages["locale.label"]}"]`,
    );
    if (!locale) throw new Error("missing language selector");
    expect(locale.textContent).toBe(messages["locale.zhCN"]);
    await act(async () => locale.click());
    const english = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (option) => option.textContent === messages["locale.en"],
    );
    if (!english) throw new Error("missing English option");
    await act(async () => english.click());
    expect(document.querySelector('[role="listbox"]')).toBeNull();
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
    expect(document.querySelector('input[name="setting-accent"]')).toBeNull();
    expect(document.querySelector(".accent-swatches")).toBeNull();
    await click("Personalization");
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
  function preferenceServer(initial: Record<string, unknown> = {}) {
    let state: Record<string, unknown> = {
      name: null,
      locale: null,
      accent: null,
      theme: null,
      modelRef: null,
      thinkingLevel: null,
      revision: 0,
      updatedAt: null,
      ...initial,
    };
    const sent: Record<string, unknown>[] = [];
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
      return { type: "owner.preferences.snapshot", payload: { ...state } };
    });
    boundary.mutate.mockImplementation(
      async (request: { type: string; payload: Record<string, unknown> }) => {
        if (request.type !== "owner.preferences.set") throw new Error("MUTATION_NOT_EXPECTED");
        sent.push(request.payload);
        const { expectedRevision, ...values } = request.payload;
        if (expectedRevision !== state["revision"])
          throw Object.assign(new Error("PORT_CONFLICT"), { status: 409 });
        const revision = (state["revision"] as number) + 1;
        state = { ...values, revision, updatedAt: "2026-10-30T01:00:00.000Z" };
        return { resultRef: `owner-preferences:${revision}`, replayed: false };
      },
    );
    return {
      sent,
      state: () => state,
      changeElsewhere: (values: Record<string, unknown>) => {
        state = { ...state, ...values, revision: (state["revision"] as number) + 1 };
      },
    };
  }
  const waitForSave = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
  const threadOptions = () =>
    boundary.threads.mock.lastCall?.[0] as {
      ownerName?: string;
      modelChoice?: { modelRef: string; thinkingLevel: string };
      onModelChoiceChange: (choice: { modelRef: string; thinkingLevel: string }) => void;
    };
  async function reopenOnAnotherDevice() {
    await act(async () => root.unmount());
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-accent");
    document.documentElement.removeAttribute("data-theme");
    root = createRoot(container);
    await render();
    await settle();
  }

  it("[I-16] shows on a second device every setting chosen on the first", async () => {
    const server = preferenceServer();
    await render();
    await settle();
    await click(messages["settings.title"]);
    const theme = document.querySelector<HTMLInputElement>(
      'input[name="setting-theme"][value="light"]',
    );
    if (!theme) throw new Error("Missing theme setting");
    await act(async () => theme.click());
    await click(messages["review.settings.personalization"]);
    const name = document.querySelector<HTMLInputElement>(
      `input[aria-label="${messages["settings.name"]}"]`,
    );
    if (!name) throw new Error("Missing name setting");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(name, "Andy");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      threadOptions().onModelChoiceChange({ modelRef: "model-second", thinkingLevel: "high" }),
    );
    await waitForSave();
    expect(server.state()).toMatchObject({
      name: "Andy",
      locale: "zh-CN",
      theme: "light",
      modelRef: "model-second",
      thinkingLevel: "high",
    });
    server.changeElsewhere({ locale: "ja" });
    await reopenOnAnotherDevice();
    expect(threadOptions()).toMatchObject({
      ownerName: "Andy",
      modelChoice: { modelRef: "model-second", thinkingLevel: "high" },
    });
    expect(document.documentElement.hasAttribute("data-accent")).toBe(false);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(new ControlCenterBrowserStorage(window.localStorage).readLocale([])).toBe("ja");
  });

  it("[I-16] does not let a stale change from an offline device overwrite a newer one", async () => {
    const server = preferenceServer({
      name: "Andy",
      locale: "zh-CN",
      accent: "violet",
      theme: "dark",
      revision: 2,
      updatedAt: "2026-10-30T00:00:00.000Z",
    });
    const storage = new ControlCenterBrowserStorage(window.localStorage);
    storage.savePreferences({ theme: "light", accent: "rose", name: "Old" });
    storage.savePreferencesRevision(1);
    storage.markPreferencesUnsynced(true);
    await render();
    await settle();
    expect(server.sent).toEqual([]);
    expect(server.state()).toMatchObject({ name: "Andy", theme: "dark", revision: 2 });
    expect(threadOptions()).toMatchObject({ ownerName: "Andy" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(storage.readPreferencesUnsynced()).toBe(false);
  });

  it("[I-16] sends a change that could not reach the server when nothing newer was saved", async () => {
    const server = preferenceServer({
      name: "Old",
      locale: "zh-CN",
      accent: "violet",
      theme: "dark",
      revision: 1,
      updatedAt: "2026-10-28T00:00:00.000Z",
    });
    const storage = new ControlCenterBrowserStorage(window.localStorage);
    storage.savePreferences({ theme: "light", accent: "rose", name: "Andy" });
    storage.savePreferencesRevision(1);
    storage.markPreferencesUnsynced(true);
    await render();
    await settle();
    expect(server.state()).toMatchObject({
      name: "Andy",
      accent: "rose",
      theme: "light",
      revision: 2,
    });
    expect(threadOptions()).toMatchObject({ ownerName: "Andy" });
    expect(storage.readPreferencesUnsynced()).toBe(false);
  });

  it("[I-16] keeps both changes when two devices change different settings at once", async () => {
    const server = preferenceServer({
      locale: "zh-CN",
      accent: "violet",
      theme: "dark",
      revision: 1,
      updatedAt: "2026-10-30T00:00:00.000Z",
    });
    await render();
    await settle();
    server.changeElsewhere({ name: "Phone" });
    await click(messages["settings.title"]);
    const light = document.querySelector<HTMLInputElement>(
      'input[name="setting-theme"][value="light"]',
    );
    if (!light) throw new Error("Missing theme setting");
    await act(async () => light.click());
    await waitForSave();
    await settle();
    expect(server.state()).toMatchObject({ name: "Phone", theme: "light", revision: 3 });
    expect(threadOptions()).toMatchObject({ ownerName: "Phone" });
  });

  it("[I-16] picks up a change made on another device when the page comes back to the front", async () => {
    const server = preferenceServer({
      locale: "zh-CN",
      accent: "violet",
      theme: "dark",
      revision: 1,
      updatedAt: "2026-10-30T00:00:00.000Z",
    });
    await render();
    await settle();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    server.changeElsewhere({ theme: "light", modelRef: "model-second", thinkingLevel: "low" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(threadOptions()).toMatchObject({
      modelChoice: { modelRef: "model-second", thinkingLevel: "low" },
    });
    expect(server.sent).toEqual([]);
  });

  it("routes installed /approvals to the governance model", async () => {
    window.history.replaceState(null, "", "/approvals");
    await render();
    expect(text()).toContain("governance content");
    expect(boundary.threads.mock.lastCall?.[0].active).toBe(false);
  });
  it.each(["tasks", "inbox", "trace", "sessions"])(
    "says plainly that /%s is not a page",
    async (surface) => {
      window.history.replaceState(null, "", `/${surface}`);
      await render();
      expect(text()).toContain(messages["surface.notFound.title"]);
      expect(boundary.threads.mock.lastCall?.[0].active).toBe(false);
    },
  );
  it("[UI-13] opens /memory as the memory page of the conversations surface, not a missing feature", async () => {
    window.history.replaceState(null, "", "/memory?selected=thread-1");
    await render();
    const options = boundary.threads.mock.lastCall?.[0];
    expect(options.active).toBe(true);
    expect(options.route).toMatchObject({
      surfaceId: "threads",
      page: "memory",
      objectId: "thread-1",
    });
    expect(text()).not.toContain(messages["surface.notFound.title"]);
  });
  it("[UI-13] says a made-up address is not a page and offers the way back", async () => {
    window.history.replaceState(null, "", "/no-such-page");
    await render();
    expect(text()).toContain(messages["surface.notFound.title"]);
    expect(boundary.threads.mock.lastCall?.[0].active).toBe(false);
    const home = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === messages["surface.notFound.action"],
    );
    await act(async () => home?.click());
    expect(window.location.pathname).toBe("/threads");
    expect(text()).not.toContain(messages["surface.notFound.title"]);
  });
  it("explains a missing installed feature instead of exposing its inactive controls", async () => {
    window.history.replaceState(null, "", "/capabilities");
    boundary.load.mockResolvedValue({ ...configuration, installedGatewayV2Operations: [] });
    await render();
    expect(text()).toContain(messages["surface.notFound.title"]);
    expect(boundary.governance.mock.lastCall?.[0].active).toBe(false);
  });
  it("[UI-46] closes the phone sidebar when the owner taps outside it", async () => {
    await render();
    await settle();
    const shell = container.querySelector<HTMLElement>(".app-shell");
    const toggle = container.querySelector<HTMLButtonElement>(".mobile-sidebar-toggle");
    expect(toggle?.getAttribute("aria-label")).toBe(messages["layout.showList"]);
    await act(async () => toggle?.click());
    expect(shell?.getAttribute("data-mobile-view")).toBe("list");
    const scrim = container.querySelector<HTMLButtonElement>(".sidebar-scrim");
    expect(scrim?.getAttribute("aria-hidden")).toBe("true");
    await act(async () => scrim?.click());
    expect(shell?.getAttribute("data-mobile-view")).toBe("content");
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
