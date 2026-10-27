import { describe, expect, it, vi } from "vitest";
import { recoverBrowserEntry } from "../src/browser-entry.js";

const rejected = (status?: number) =>
  Object.assign(new Error("rejected"), status === undefined ? {} : { status });
const method = (value: string) => new Response(JSON.stringify({ method: value }));

describe("browser entry recovery", () => {
  it("treats a redirected identity probe as an expired Cloudflare Access login", async () => {
    const fetch = vi.fn(async () => ({ type: "opaqueredirect", status: 0, ok: false }) as Response);
    await expect(
      recoverBrowserEntry({ fetch, deviceLabel: "browser", failure: rejected(), exchanged: false }),
    ).resolves.toEqual({ kind: "access-expired" });
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/identity/v1/method", {
      credentials: "same-origin",
      redirect: "manual",
      headers: { accept: "application/json" },
    });
  });

  it("exchanges the Access identity for a session once and asks for a reload", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(method("cloudflare-access"))
      .mockResolvedValueOnce(new Response("{}", { status: 201 }));
    await expect(
      recoverBrowserEntry({
        fetch,
        deviceLabel: "browser",
        failure: rejected(401),
        exchanged: false,
      }),
    ).resolves.toEqual({ kind: "reload" });
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/identity/v1/sessions",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ deviceLabel: "browser" }) }),
    );
    fetch.mockResolvedValueOnce(method("cloudflare-access"));
    await expect(
      recoverBrowserEntry({
        fetch,
        deviceLabel: "browser",
        failure: rejected(401),
        exchanged: true,
      }),
    ).resolves.toEqual({ kind: "unreachable", automatic: false });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    [rejected(), { kind: "unreachable", automatic: true }],
    [rejected(503), { kind: "unreachable", automatic: true }],
    [rejected(400), { kind: "unreachable", automatic: false }],
  ])("retries only transient bootstrap failures on its own", async (failure, expected) => {
    const fetch = vi.fn(async () => method("cloudflare-access"));
    await expect(
      recoverBrowserEntry({ fetch, deviceLabel: "browser", failure, exchanged: false }),
    ).resolves.toEqual(expected);
  });

  it("hands built-in identity back to the account login form", async () => {
    const fetch = vi.fn(async () => method("built-in"));
    await expect(
      recoverBrowserEntry({
        fetch,
        deviceLabel: "browser",
        failure: rejected(401),
        exchanged: false,
      }),
    ).resolves.toEqual({ kind: "built-in-login" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
