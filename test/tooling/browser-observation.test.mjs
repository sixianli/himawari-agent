import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createBrowserObservation } from "../../scripts/ci/browser-observation.mjs";

class Page extends EventEmitter {
  address = "https://fixture.invalid/initial?private=value#secret";
  frame = { url: () => this.address };
  url() {
    return this.address;
  }
  mainFrame() {
    return this.frame;
  }
  navigate(address) {
    this.address = address;
    this.emit("framenavigated", this.frame);
  }
}
function request(
  type = "fetch",
  address = "https://fixture.invalid/api/payloads?id=private#secret",
) {
  return {
    resourceType: () => type,
    url: () => address,
    method: () => "GET",
    failure: () => ({ errorText: "net::ERR_ABORTED credential" }),
  };
}
afterEach(() => vi.restoreAllMocks());

it("将旧文档请求的响应和失败关联到发起时epoch，并区分页面且幂等监听", () => {
  let time = 100;
  vi.spyOn(performance, "now").mockImplementation(() => time++);
  const observer = createBrowserObservation();
  const first = new Page(),
    second = new Page();
  expect(observer.watchPage(first)).toBe(1);
  expect(observer.watchPage(first)).toBe(1);
  expect(first.listenerCount("request")).toBe(1);
  expect(observer.watchPage(second)).toBe(2);
  first.emit("framenavigated", { url: () => "https://fixture.invalid/child" });
  const old = request("document");
  first.emit("request", old);
  first.navigate("https://fixture.invalid/new?secret=hidden#fragment");
  const fresh = request("xhr");
  first.emit("request", fresh);
  first.emit("response", { request: () => old, status: () => 200 });
  first.emit("requestfailed", old);
  first.emit("requestfinished", fresh);
  second.emit("request", request("eventsource"));
  const snapshot = observer.snapshot();
  expect(snapshot.schemaVersion).toBe(1);
  const oldEvents = snapshot.events.filter((event) => event.requestId === 1);
  expect(oldEvents.map((event) => event.type)).toEqual(["request", "response", "requestfailed"]);
  expect(oldEvents.every((event) => event.epoch === 0 && event.pageId === 1)).toBe(true);
  expect(oldEvents[1].status).toBe(200);
  expect(snapshot.events.find((event) => event.type === "requestfinished")).toMatchObject({
    requestId: 2,
    epoch: 1,
  });
  expect(snapshot.events.at(-1)).toMatchObject({ pageId: 2, requestId: 3, epoch: 0 });
  expect(snapshot.events.map((event) => event.timeMs)).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

it("仅记录指定资源类型，URL去掉凭据query/hash且不记录data内容", () => {
  const observer = createBrowserObservation();
  const page = new Page();
  observer.watchPage(page);
  for (const type of [
    "document",
    "script",
    "stylesheet",
    "fetch",
    "xhr",
    "eventsource",
    "image",
    "font",
    "other",
  ])
    page.emit(
      "request",
      request(type, "https://user:password@fixture.invalid/path?credential=private#secret"),
    );
  page.emit("request", request("script", "data:text/javascript,private-payload"));
  const snapshot = observer.snapshot();
  expect(snapshot.events).toHaveLength(7);
  expect(
    snapshot.events.slice(0, 6).every((event) => event.url === "https://fixture.invalid/path"),
  ).toBe(true);
  expect(snapshot.events.at(-1).url).toBe("data:");
  expect(JSON.stringify(snapshot)).not.toMatch(/password|credential|private|secret/);
});

it("事件满后pageerror仍独立可见，错误脱敏且有界计数，快照不可反向改写", () => {
  const observer = createBrowserObservation({
    limit: 1,
    redact: (text) => text.replaceAll("credential", "[redacted]"),
  });
  const page = new Page();
  observer.watchPage(page);
  page.emit("requestfailed", request());
  for (let index = 0; index < 53; index++)
    page.emit("pageerror", new Error(`failure credential ${index}`));
  const snapshot = observer.snapshot();
  expect(snapshot.events).toHaveLength(1);
  expect(snapshot.events[0]).toMatchObject({ epoch: null, failure: "net::ERR_ABORTED [redacted]" });
  expect(snapshot.dropped).toBe(53);
  expect(snapshot.errors).toHaveLength(50);
  expect(snapshot.droppedErrors).toBe(3);
  expect(snapshot.errors[0]).toMatchObject({
    type: "pageerror",
    pageId: 1,
    epoch: 0,
    requestId: null,
    message: "failure [redacted] 0",
  });
  expect(JSON.stringify(snapshot)).not.toContain("credential");
  snapshot.errors[0].message = "mutated";
  snapshot.events.length = 0;
  expect(observer.snapshot().errors[0].message).toBe("failure [redacted] 0");
  expect(observer.snapshot().events).toHaveLength(1);
});

it("未饱和的pageerror同时保留事件时序与错误索引", () => {
  const observer = createBrowserObservation();
  const page = new Page();
  observer.watchPage(page);
  page.navigate("about:blank");
  page.emit("pageerror", new Error("fixture failure"));
  const snapshot = observer.snapshot();
  expect(snapshot.events[1]).toEqual(snapshot.errors[0]);
  expect(snapshot.errors[0]).toMatchObject({ epoch: 1, url: "about:", message: "fixture failure" });
  expect(snapshot.dropped).toBe(0);
  expect(snapshot.droppedErrors).toBe(0);
});
