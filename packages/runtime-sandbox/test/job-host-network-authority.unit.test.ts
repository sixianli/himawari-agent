import { afterEach, expect, it, vi } from "vitest";
import { JobHostNetworkAuthority } from "../src/job-host-network-authority.ts";

afterEach(() => vi.useRealTimers());

it("requires a fresh one-shot answer and rejects replayed answers", async () => {
  const send = vi.fn(),
    stop = vi.fn();
  const authority = new JobHostNetworkAuthority(send, stop);
  const first = authority.assertCurrent();
  expect(send).toHaveBeenLastCalledWith({ type: "authority_check", checkId: 1 });
  authority.receive(1, true);
  await first;
  const second = expect(authority.assertCurrent()).rejects.toThrow("AUTHORITY_REJECTED");
  expect(send).toHaveBeenLastCalledWith({ type: "authority_check", checkId: 2 });
  authority.receive(1, true);
  await second;
  expect(stop).toHaveBeenCalledTimes(1);
  await expect(authority.assertCurrent()).rejects.toThrow("AUTHORITY_UNAVAILABLE");
});

it.each(["deny", "timeout", "disconnect"] as const)(
  "rejects all pending checks after %s, and a late success cannot restore authority",
  async (reason) => {
    vi.useFakeTimers();
    const send = vi.fn(),
      stop = vi.fn();
    const authority = new JobHostNetworkAuthority(send, stop);
    const first = expect(authority.assertCurrent()).rejects.toThrow("AUTHORITY_REJECTED");
    const second = expect(authority.assertCurrent()).rejects.toThrow("AUTHORITY_REJECTED");
    if (reason === "deny") authority.receive(1, false);
    else if (reason === "disconnect") authority.close();
    else await vi.advanceTimersByTimeAsync(1500);
    await Promise.all([first, second]);
    authority.receive(2, true);
    await expect(authority.assertCurrent()).rejects.toThrow("AUTHORITY_UNAVAILABLE");
    expect(vi.getTimerCount()).toBe(0);
    expect(stop).toHaveBeenCalledTimes(reason === "disconnect" ? 0 : 1);
  },
);

it("bounds concurrent pending checks and fails closed when sending fails", async () => {
  const authority = new JobHostNetworkAuthority(vi.fn(), vi.fn());
  const pending = Array.from({ length: 128 }, () =>
    expect(authority.assertCurrent()).rejects.toThrow("AUTHORITY_REJECTED"),
  );
  await expect(authority.assertCurrent()).rejects.toThrow("AUTHORITY_UNAVAILABLE");
  authority.close();
  await Promise.all(pending);
  const stop = vi.fn();
  const disconnected = new JobHostNetworkAuthority(() => {
    throw new Error("disconnected");
  }, stop);
  await expect(disconnected.assertCurrent()).rejects.toThrow("AUTHORITY_REJECTED");
  expect(stop).toHaveBeenCalledTimes(1);
});
