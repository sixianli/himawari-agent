import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { collectPageErrors } from "../../scripts/browser-page-errors.mjs";

class Page extends EventEmitter {
  frame = {};
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

const repositoryRoot = join(import.meta.dirname, "../..");
const directPageErrorListener = /\.on\(\s*["']pageerror["']/u;
const OBSERVE_ONLY = new Set([
  "scripts/ci/browser-observation.mjs",
  "test/qualification/sandbox-production-browser.mjs",
  "scripts/demo/record-email-decision.mjs",
  "scripts/render-brand-assets.mjs",
  "scripts/test-control-center-visual-v4.mjs",
]);

const browserSources = () =>
  execFileSync("git", ["ls-files", "-z", "--", "scripts/*.mjs", "test/qualification/*.mjs"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => path !== "" && path !== "scripts/browser-page-errors.mjs");

it("[webkit-teardown] 浏览器检查脚本都经 watchPageErrors 收页面报错，不直接监听 pageerror", () => {
  const direct = browserSources().filter(
    (path) =>
      !OBSERVE_ONLY.has(path) &&
      directPageErrorListener.test(readFileSync(join(repositoryRoot, path), "utf8")),
  );
  expect(direct).toEqual([]);
});

it("[webkit-teardown] 启动浏览器的脚本都调用 watchPageErrors，除非明确列为只观察或只截图", () => {
  const missing = browserSources().filter((path) => {
    const source = readFileSync(join(repositoryRoot, path), "utf8");
    return (
      /\.launch\(/u.test(source) &&
      !OBSERVE_ONLY.has(path) &&
      !/watchPageErrors|collectPageErrors/u.test(source)
    );
  });
  expect(missing).toEqual([]);
});

it("[webkit-teardown] 反向：直接监听 pageerror 的写法会被认出来", () => {
  expect(directPageErrorListener.test('page.on("pageerror", (e) => errors.push(e.message));')).toBe(
    true,
  );
  expect(directPageErrorListener.test('page.waitForEvent("pageerror")')).toBe(false);
});
