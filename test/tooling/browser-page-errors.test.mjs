import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  collectPageErrors,
  directPageErrorListener,
  expectedOfflineTransportError,
  findDirectPageErrorListeners,
  findUnwatchedBrowserLaunches,
} from "../../scripts/browser-page-errors.mjs";

class Page extends EventEmitter {
  frame = {};
  url() {
    return "http://127.0.0.1:41013/threads/thread-main";
  }
  mainFrame() {
    return this.frame;
  }
  navigationRequest(frame = this.frame) {
    const request = { isNavigationRequest: () => true, frame: () => frame };
    this.emit("request", request);
    return request;
  }
  fetchRequest() {
    const request = { isNavigationRequest: () => false, frame: () => this.frame };
    this.emit("request", request);
    return request;
  }
  commit(frame = this.frame) {
    this.emit("framenavigated", frame);
  }
  fail(message) {
    this.emit("pageerror", new Error(message));
  }
}
const cancelled = "/127.0.0.1:41013/api/gateway/v2/queries due to access control checks.";

it("[webkit-teardown] 页面被换掉的这段时间里，WebKit 对在途请求报的 access control 错误不算页面报错", () => {
  const page = new Page();
  const errors = collectPageErrors(page);
  page.navigationRequest();
  page.fail(cancelled);
  page.commit();
  expect(errors).toEqual([]);
});

it("[webkit-teardown] 反向：页面稳定时同一条错误照常记录", () => {
  const page = new Page();
  const errors = collectPageErrors(page);
  page.fail(cancelled);
  page.fetchRequest();
  page.fail(cancelled);
  page.navigationRequest();
  page.commit();
  page.fail(cancelled);
  expect(errors).toEqual([cancelled, cancelled, cancelled]);
});

it("[webkit-teardown] 反向：换页期间其他报错照常记录", () => {
  const page = new Page();
  const errors = collectPageErrors(page);
  page.navigationRequest();
  page.fail("TypeError: undefined is not an object");
  page.fail("Unhandled Promise Rejection: Error: CONTROL_CENTER_RESPONSE_INVALID");
  expect(errors).toEqual([
    "TypeError: undefined is not an object",
    "Unhandled Promise Rejection: Error: CONTROL_CENTER_RESPONSE_INVALID",
  ]);
});

it("[webkit-teardown] 反向：换页期间别的源被拦下的请求照常记录", () => {
  const page = new Page();
  const errors = collectPageErrors(page);
  const crossOrigin = "/127.0.0.1:41014/api/gateway/v2/queries due to access control checks.";
  const otherHost = "/evil.example/collect due to access control checks.";
  page.navigationRequest();
  page.fail(crossOrigin);
  page.fail(otherHost);
  page.fail(`prefix ${cancelled}`);
  expect(errors).toEqual([crossOrigin, otherHost, `prefix ${cancelled}`]);
});

it("[webkit-teardown] 反向：页面地址没写端口时看不出协议，同主机的报错照常记录", () => {
  const page = new Page();
  page.url = () => "https://himawari.example/threads";
  const errors = collectPageErrors(page);
  const sameHost = "/himawari.example/api/gateway/v2/queries due to access control checks.";
  page.navigationRequest();
  page.fail(sameHost);
  expect(errors).toEqual([sameHost]);
});

it("[webkit-teardown] 反向：子框架的导航请求不算换页", () => {
  const page = new Page();
  const errors = collectPageErrors(page);
  page.navigationRequest({});
  page.fail(cancelled);
  expect(errors).toEqual([cancelled]);
});

it("[webkit-teardown] 换页请求失败后窗口关闭，之后的错误照常记录", () => {
  const page = new Page();
  const errors = collectPageErrors(page);
  const request = page.navigationRequest();
  page.emit("requestfailed", request);
  page.fail(cancelled);
  expect(errors).toEqual([cancelled]);
});

it("把错误追加到调用方给的数组里", () => {
  const page = new Page();
  const shared = ["earlier"];
  expect(collectPageErrors(page, shared)).toBe(shared);
  page.fail("later");
  expect(shared).toEqual(["earlier", "later"]);
});

it("[webkit-teardown] 直接监听 pageerror 的各种写法都认得出，等待注入的错误不算", () => {
  for (const source of [
    'page.on("pageerror", collect)',
    "page.once('pageerror', collect)",
    'page.addListener( "pageerror", collect)',
    'page.prependListener("pageerror", collect)',
    'page.prependOnceListener("pageerror", collect)',
  ])
    expect(directPageErrorListener.test(source)).toBe(true);
  for (const source of [
    'page.waitForEvent("pageerror")',
    'page.on("console", collect)',
    "watchPageErrors(page, collect)",
  ])
    expect(directPageErrorListener.test(source)).toBe(false);
});

const allowedDirectListeners = new Set([
  "browser-page-errors.mjs",
  "ci/browser-observation.mjs",
  "test-browser-page-errors-browser.mjs",
]);

it("[webkit-teardown] 扫描能找出放进目录里的直接监听，允许名单里的不算", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "page-error-scan-"));
  try {
    await mkdir(path.join(root, "ci"));
    await writeFile(path.join(root, "bad.mjs"), 'page.on("pageerror", collect);\n');
    await writeFile(path.join(root, "ci", "nested.mjs"), "page.once('pageerror', collect);\n");
    await writeFile(
      path.join(root, "ci", "browser-observation.mjs"),
      'page.on("pageerror", record);\n',
    );
    await writeFile(path.join(root, "good.mjs"), "watchPageErrors(page, collect);\n");
    await writeFile(path.join(root, "notes.md"), 'page.on("pageerror", x)\n');
    expect(await findDirectPageErrorListeners(root, allowedDirectListeners)).toEqual([
      "bad.mjs",
      "ci/nested.mjs",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const screenshotOnlyLaunches = new Set([
  "browser-page-errors.mjs",
  "render-brand-assets.mjs",
  "test-control-center-visual-v4.mjs",
]);

it("[webkit-teardown] 浏览器测试脚本一律经 browser-page-errors.mjs 收页面报错", async () => {
  const scripts = path.resolve(import.meta.dirname, "../../scripts");
  const qualification = path.resolve(import.meta.dirname, "../qualification");
  expect(await findDirectPageErrorListeners(scripts, allowedDirectListeners)).toEqual([]);
  expect(await findUnwatchedBrowserLaunches(scripts, screenshotOnlyLaunches)).toEqual([]);
  expect(await findDirectPageErrorListeners(qualification, new Set())).toEqual([]);
  expect(await findUnwatchedBrowserLaunches(qualification, new Set())).toEqual([]);
});

it("[webkit-teardown] 扫描能找出启动了浏览器却不收页面报错的脚本，只截图的允许名单不算", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "page-error-launch-"));
  try {
    await mkdir(path.join(root, "demo"));
    await writeFile(path.join(root, "bare.mjs"), "const b = await chromium.launch();\n");
    await writeFile(path.join(root, "demo", "nested.ts"), "await webkit.launch({});\n");
    await writeFile(
      path.join(root, "watched.mjs"),
      "const b = await chromium.launch();\nwatchPageErrors(page, collect);\n",
    );
    await writeFile(
      path.join(root, "collected.mjs"),
      "const b = await firefox.launch();\ncollectPageErrors(page);\n",
    );
    await writeFile(
      path.join(root, "imported.mjs"),
      'import { collectPageErrors } from "./browser-page-errors.mjs";\nawait chromium.launch();\n',
    );
    await writeFile(
      path.join(root, "persistent.mjs"),
      "await chromium.launchPersistentContext(dir);\n",
    );
    await writeFile(path.join(root, "server.mjs"), "await chromium.launchServer ({});\n");
    await writeFile(
      path.join(root, "server-collected.mjs"),
      "await chromium.launchServer();\ncollectPageErrors(page);\n",
    );
    await writeFile(path.join(root, "render-brand-assets.mjs"), "await chromium.launch();\n");
    await writeFile(path.join(root, "notes.md"), "chromium.launch()\n");
    expect(await findUnwatchedBrowserLaunches(root, new Set(["render-brand-assets.mjs"]))).toEqual([
      "bare.mjs",
      "demo/nested.ts",
      "imported.mjs",
      "persistent.mjs",
      "server.mjs",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("[webkit-teardown] 断网阶段只放过夹具主机上那几个路径的 access control 报错", () => {
  const base = "http://127.0.0.1:41013";
  const paths = ["/api/gateway/v2/events", "/api/gateway/thread/v3/events"];
  const ok = "/127.0.0.1:41013/api/gateway/v2/events due to access control checks.";
  const withQuery =
    "/127.0.0.1:41013/api/gateway/v2/events?afterCursor=c-1 due to access control checks.";
  expect(expectedOfflineTransportError(ok, base, paths)).toBe(true);
  expect(expectedOfflineTransportError(withQuery, base, paths)).toBe(true);
  for (const message of [
    "/127.0.0.1:41014/api/gateway/v2/events due to access control checks.",
    "/evil.example/api/gateway/v2/events due to access control checks.",
    "/127.0.0.1:41013/api/gateway/v2/queries due to access control checks.",
    "/127.0.0.1:41013/api/gateway/v2/events-extra due to access control checks.",
    "/127.0.0.1:41013/api/gateway/thread/v3/events-other due to access control checks.",
    "TypeError: /127.0.0.1:41013/api/gateway/v2/events failed",
    `prefix ${ok}`,
  ])
    expect(expectedOfflineTransportError(message, base, paths)).toBe(false);
});
