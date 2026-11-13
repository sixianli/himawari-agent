import { EventEmitter } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { collectPageErrors } from "../../scripts/browser-page-errors.mjs";

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

it("[webkit-teardown] 浏览器测试脚本一律经 browser-page-errors.mjs 收页面报错", async () => {
  const scripts = path.resolve(import.meta.dirname, "../../scripts");
  const allowed = new Set([
    "browser-page-errors.mjs",
    "ci/browser-observation.mjs",
    "test-browser-page-errors-browser.mjs",
  ]);
  const entries = await readdir(scripts, { recursive: true, withFileTypes: true });
  const offenders = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:mjs|js|ts)$/u.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(scripts, file).split(path.sep).join("/");
    if (allowed.has(relative)) continue;
    if (
      /\.(?:on|once|addListener|prependListener)\(\s*["']pageerror["']/u.test(
        await readFile(file, "utf8"),
      )
    )
      offenders.push(relative);
  }
  expect(offenders).toEqual([]);
});
