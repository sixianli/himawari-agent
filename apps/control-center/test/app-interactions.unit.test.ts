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

// Parent-app contracts: child query/render behavior is covered independently by
// component tests; these seams expose whether bootstrap and privacy state reach
// the correct child. SSE synchronizers, routing, storage and shell remain real.
const boundary = vi.hoisted(() => ({
  load: vi.fn(),
  refresh: vi.fn(),
  login: vi.fn(),
  client: vi.fn(),
  threads: vi.fn(),
  governance: vi.fn(),
  operations: vi.fn(),
}));
vi.mock("../src/gateway-client.js", async (original) => ({
  ...(await original<object>()),
  loadRuntimeConfiguration: boundary.load,
  refreshRuntimeConfiguration: boundary.refresh,
  createBrowserSession: boundary.login,
  GatewayClient: class {
    constructor(options: unknown) {
      boundary.client(options);
    }
  },
}));
vi.mock("../src/thread-control-center.js", () => ({ useThreadControlCenter: boundary.threads }));
vi.mock("../src/governance-control-center.js", () => ({
  useGovernanceControlCenter: boundary.governance,
}));
vi.mock("../src/operations-control-center.js", () => ({
  useOperationsControlCenter: boundary.operations,
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
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label || item.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`Missing accessible button ${label}`);
  await act(async () => button.click());
}
beforeEach(() => {
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
  const child = (name: string) => ({
    title: name,
    content: createElement("div", { "data-child": name }, `${name} content`),
    list: createElement("span", null, `${name} list`),
    details: createElement("span", null, `${name} details`),
  });
  boundary.threads.mockReset().mockImplementation(() => child("threads"));
  boundary.governance.mockReset().mockImplementation(() => child("governance"));
  boundary.operations.mockReset().mockImplementation(() => child("operations"));
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
    const previousSignal = boundary.threads.mock.lastCall?.[0].refreshSignal;
    await act(async () =>
      window.dispatchEvent(new StorageEvent("storage", { key: THREAD_CURSOR_STORAGE_KEY })),
    );
    expect(boundary.threads.mock.lastCall?.[0].refreshSignal).toBe(previousSignal + 1);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => root.render(null));
    expect(Events.instances.every((source) => source.close.mock.calls.length > 0)).toBe(true);
  });
  it.each([401, 403])(
    "offers explicit external sign-in on HTTP %s then retries bootstrap",
    async (status) => {
      boundary.load.mockRejectedValueOnce(Object.assign(new Error("session expired"), { status }));
      await render();
      expect(Events.instances).toHaveLength(0);
      expect(text()).toContain(messages["authentication.required"]);
      await click(messages["authentication.signIn"]);
      expect(boundary.login).toHaveBeenCalledOnce();
      expect(boundary.load).toHaveBeenCalledTimes(2);
      expect(text()).toContain("threads content");
      expect(Events.instances).toHaveLength(2);
    },
  );
  it("shows bootstrap and sign-in failures without treating them as connected", async () => {
    boundary.load.mockRejectedValue(Object.assign(new Error("expired"), { status: 401 }));
    boundary.login.mockRejectedValue(new Error("exchange unavailable"));
    await render();
    await click(messages["authentication.signIn"]);
    expect(text()).toContain("exchange unavailable");
    expect(Events.instances).toHaveLength(0);
    boundary.login.mockRejectedValue("opaque failure");
    await click(messages["authentication.signIn"]);
    expect(text()).toContain("CONTROL_CENTER_REQUEST_REJECTED");
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
    expect(text()).toContain("CONTROL_CENTER_REAUTHENTICATION_REQUIRED");
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
  it("persists interface language and appearance through the actual shell controls", async () => {
    await render();
    const locale = container.querySelector<HTMLSelectElement>(
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
    await click("☼ Light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(new ControlCenterBrowserStorage(window.localStorage).readPreferences().theme).toBe(
      "light",
    );
  });
  it.each(["approvals", "tasks", "settings", "memory", "sessions"])(
    "routes installed /%s to the correct feature model",
    async (surface) => {
      window.history.replaceState(null, "", `/${surface}`);
      await render();
      expect(text()).toContain(
        surface === "approvals" ? "governance content" : "operations content",
      );
      expect(boundary.threads.mock.lastCall?.[0].active).toBe(false);
    },
  );
  it("explains a missing installed feature instead of exposing its inactive controls", async () => {
    window.history.replaceState(null, "", "/memory");
    boundary.load.mockResolvedValue({ ...configuration, installedGatewayV2Operations: [] });
    await render();
    expect(text()).toContain(messages["surface.notInstalled.title"]);
    expect(text()).not.toContain("operations content");
    expect(boundary.operations.mock.lastCall?.[0].active).toBe(false);
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
