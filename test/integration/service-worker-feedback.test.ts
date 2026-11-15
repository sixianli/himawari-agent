import { readFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Listener = (event: Record<string, unknown>) => void;

async function loadWorker() {
  const listeners = new Map<string, Listener>();
  const stored = new Map<string, string>();
  const openWindow = vi.fn(async () => null);
  const waits: Promise<unknown>[] = [];
  const self = {
    addEventListener: (name: string, listener: Listener) => listeners.set(name, listener),
    location: { origin: "https://himawari.example" },
    clients: { matchAll: async () => [], openWindow, claim: async () => undefined },
    registration: { showNotification: vi.fn() },
    navigator: {},
    skipWaiting: () => undefined,
  };
  const caches = {
    open: async (name: string) => {
      expect(name).toBe("himawari-push-feedback");
      return {
        put: async (request: Request, response: Response) => {
          stored.set(new URL(request.url).pathname, await response.text());
        },
      };
    },
  };
  const source = await readFile(
    path.join(import.meta.dirname, "../../apps/control-center/public/sw.js"),
    "utf8",
  );
  runInNewContext(source, {
    self,
    caches,
    Request: class {
      readonly url: string;
      constructor(url: string) {
        this.url = new URL(url, "https://himawari.example").href;
      }
    },
    Response,
    URL,
    Date,
    JSON,
    Promise,
    Number,
  });
  const dispatch = async (name: string, notification: Record<string, unknown>) => {
    listeners.get(name)?.({
      notification: { close: () => undefined, ...notification },
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    });
    await Promise.all(waits.splice(0));
  };
  const push = async (message: Record<string, unknown>) => {
    listeners.get("push")?.({
      data: { json: () => message },
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    });
    await Promise.all(waits.splice(0));
  };
  return { dispatch, push, shown: self.registration.showNotification, openWindow, stored };
}

describe("[WP-11] service worker notification feedback", () => {
  it("[WP-11] opens the thread with the notification tag and keeps a dismissal for the page", async () => {
    const worker = await loadWorker();
    await worker.dispatch("notificationclick", {
      tag: "q1c2Zt9sV0Kx3mWbYp7aLrUe4nHd8fGj",
      data: { navigate: "https://himawari.example/threads/t1" },
    });
    expect(worker.openWindow).toHaveBeenCalledWith(
      "https://himawari.example/threads/t1?push=q1c2Zt9sV0Kx3mWbYp7aLrUe4nHd8fGj",
    );
    await worker.dispatch("notificationclose", { tag: "dismissedTag" });
    expect([...worker.stored.keys()]).toEqual(["/push-feedback/dismissedTag/dismissed"]);
    expect(JSON.parse(worker.stored.get("/push-feedback/dismissedTag/dismissed") ?? "{}")).toEqual({
      tag: "dismissedTag",
      reaction: "dismissed",
      occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    await worker.dispatch("notificationclose", {});
    expect(worker.stored.size).toBe(1);
  });

  it("[IOS-4] shows a notification silently only when the payload asks for it", async () => {
    const worker = await loadWorker();
    await worker.push({ notification: { title: "t", silent: true } });
    await worker.push({ notification: { title: "t" } });
    await worker.push({ notification: { title: "t", silent: "true" } });
    const silent = worker.shown.mock.calls.map(([, options]) => options.silent);
    expect(silent).toEqual([true, false, false]);
  });
});
