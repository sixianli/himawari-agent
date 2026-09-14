// @vitest-environment jsdom
import { act, type ComponentType, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountDevices, AccountLogin, accountRequest } from "../src/components/account-login.js";
import { messages } from "../src/i18n/resources/zh-CN.js";
import { ControlCenterIntlProvider } from "../src/i18n/runtime.js";

let root: Root;
let container: HTMLDivElement;
const fetcher = vi.fn();
const credential = "component-test-only";
const response = (body: unknown = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetcher.mockReset());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render<T extends object>(child: ComponentType<T>, props: T) {
  const provider = { locale: "zh-CN" as const, loadingLabel: "加载中", children: h(child, props) };
  await act(async () => {
    root.render(h(ControlCenterIntlProvider, provider));
  });
}

function field(name: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (!input) throw new Error(`Missing accessible form field: ${name}`);
  input.value = value;
  return input;
}
async function submit() {
  const form = container.querySelector("form");
  if (!form) throw new Error("Missing login form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
async function click(text: string, scope: ParentNode = container) {
  const button = [...scope.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => button.click());
}

describe("account login and device interactions", () => {
  it.each([undefined, "csrf-component-fixture"])(
    "completes password then factor with csrf=%s",
    async (csrfToken) => {
      fetcher.mockImplementation(async () => response());
      const complete = vi.fn(),
        cancel = vi.fn();
      await render(AccountLogin, {
        ...(csrfToken ? { csrfToken } : {}),
        onComplete: complete,
        onCancel: cancel,
      });
      field("username", "fixture-owner");
      field("password", credential);
      if (!csrfToken) field("deviceLabel", "Browser fixture");
      await submit();
      const [url, request] = fetcher.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`/api/identity/v1/${csrfToken ? "reauthenticate" : "password"}`);
      expect(JSON.parse(String(request.body))).toMatchObject({
        username: "fixture-owner",
        password: credential,
      });
      expect(request.credentials).toBe("same-origin");
      expect(new Headers(request.headers).get("x-csrf-token")).toBe(csrfToken ?? null);
      expect(container.querySelector('input[name="password"]')).toBeNull();
      const code = field("code", "123456");
      expect(document.activeElement).toBe(code);
      expect(complete).not.toHaveBeenCalled();
      await submit();
      expect(fetcher.mock.calls[1]?.[0]).toBe("/api/identity/v1/verify");
      expect(JSON.parse(String(fetcher.mock.calls[1]?.[1].body))).toEqual({ code: "123456" });
      expect(complete).toHaveBeenCalledOnce();
      await click(messages["governed.cancel"]);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
  it.each([
    [429, "account.rateLimited"],
    [503, "error.currentUnavailable"],
    [401, "account.rejected"],
  ] as const)(
    "shows an actionable login error for HTTP %i without advancing",
    async (status, message) => {
      fetcher.mockResolvedValue(response({}, status));
      const complete = vi.fn();
      await render(AccountLogin, { onComplete: complete });
      field("username", "fixture-owner");
      field("password", credential);
      await submit();
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(messages[message]);
      expect(container.querySelector('input[name="code"]')).toBeNull();
      expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
        false,
      );
      expect(complete).not.toHaveBeenCalled();
    },
  );
  it("prevents duplicate login while a request is pending and permits retry after a network failure", async () => {
    let reject: (error: Error) => void = () => {
      throw new Error("Request not started");
    };
    fetcher.mockImplementation(
      () =>
        new Promise((_resolve, failure) => {
          reject = failure;
        }),
    );
    await render(AccountLogin, { onComplete: vi.fn() });
    field("username", "fixture-owner");
    field("password", credential);
    await submit();
    await submit();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      true,
    );
    await act(async () => reject(new Error("controlled network failure")));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      messages["account.rejected"],
    );
    fetcher.mockResolvedValue(response());
    await submit();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(container.querySelector('input[name="code"]')).not.toBeNull();
  });
  it("revokes a different device, reloads its list, then signs out the current device", async () => {
    const current = {
      id: "current",
      label: "Current browser",
      current: true,
      lastSeenAt: "2026-09-14T00:00:00Z",
    };
    const other = { ...current, id: "other", label: "Other browser", current: false };
    let devices = [current, other];
    fetcher.mockImplementation(async (url: string, request?: RequestInit) => {
      if (url.endsWith("/devices")) return response({ devices });
      expect(new Headers(request?.headers).get("x-csrf-token")).toBe("csrf-device-fixture");
      const id = JSON.parse(String(request?.body)).deviceId;
      devices = devices.filter((device) => device.id !== id);
      return response();
    });
    const signedOut = vi.fn();
    await render(AccountDevices, {
      csrfToken: "csrf-device-fixture",
      onSignedOut: signedOut,
      onReauthenticated: vi.fn(),
    });
    const otherRow = [...container.querySelectorAll("li")].find((li) =>
      li.textContent?.includes(other.label),
    );
    if (!otherRow) throw new Error("Missing other device");
    await click(messages["account.revoke"], otherRow);
    expect(container.textContent).not.toContain(other.label);
    expect(container.textContent).toContain(current.label);
    expect(signedOut).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/devices"))).toHaveLength(2);
    await click(messages["account.revoke"]);
    expect(signedOut).toHaveBeenCalledOnce();
  });
  it("shows device operation failure, supports reauthentication and logout", async () => {
    fetcher.mockImplementation(async () => response({ devices: [] }));
    const signedOut = vi.fn(),
      reauthenticated = vi.fn();
    await render(AccountDevices, {
      csrfToken: "csrf-device-fixture",
      onSignedOut: signedOut,
      onReauthenticated: reauthenticated,
    });
    fetcher.mockResolvedValueOnce(response({}, 503));
    await click(messages["account.signOut"]);
    expect(signedOut).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      messages["account.deviceActionFailed"],
    );
    await click(messages["account.reauthenticate"]);
    await click(messages["governed.cancel"]);
    expect(container.querySelector("form")).toBeNull();
    await click(messages["account.reauthenticate"]);
    field("username", "fixture-owner");
    field("password", credential);
    await submit();
    field("code", "123456");
    await submit();
    expect(reauthenticated).toHaveBeenCalledOnce();
    await click(messages["account.signOut"]);
    expect(signedOut).toHaveBeenCalledOnce();
  });
  it.each([null, {}, { devices: {} }, { devices: [null] }, { devices: [{ id: 1 }] }])(
    "rejects malformed device data without rendering controls for it: %j",
    async (body) => {
      fetcher.mockResolvedValue(response(body));
      await render(AccountDevices, {
        csrfToken: "csrf-fixture",
        onSignedOut: vi.fn(),
        onReauthenticated: vi.fn(),
      });
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        messages["account.deviceActionFailed"],
      );
      expect(container.querySelectorAll("li")).toHaveLength(0);
    },
  );
  it("does not update an unmounted device view when its pending request settles", async () => {
    let finish: (value: Response) => void = () => {
      throw new Error("Request not started");
    };
    fetcher.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    await render(AccountDevices, {
      csrfToken: "csrf-fixture",
      onSignedOut: vi.fn(),
      onReauthenticated: vi.fn(),
    });
    await act(async () => root.render(null));
    await act(async () => finish(response({ devices: [] })));
    expect(container.childElementCount).toBe(0);
  });
  it("uses GET without a request body for device inspection", async () => {
    fetcher.mockImplementation(async () => response({ devices: [] }));
    await expect(accountRequest("devices")).resolves.toEqual({ devices: [] });
    expect(fetcher).toHaveBeenCalledWith("/api/identity/v1/devices", {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
  });
});
