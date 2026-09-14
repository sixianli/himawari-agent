import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, webkit, expect } from "@playwright/test";

// Exercise the built product through HTTP with isolated fixture data. Only read
// requests are delayed/failed; retries still execute the real browser client.
const profile = process.argv[2] ?? "chrome";
const output = path.resolve(process.argv[3] ?? `.ci-output/loading/focused-${profile}`);
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ["test/e2e/fixtures/control-center-browser-server.mjs"], {
  env: { ...process.env, HIMAWARI_BROWSER_FIXTURE_PORT: "0" },
  stdio: ["ignore", "pipe", "inherit"],
});
let browser;
const results = [];
let activePage;
try {
  const baseUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Fixture startup timeout")), 10000);
    let text = "";
    server.stdout.on("data", (chunk) => {
      text += chunk;
      const match = text.match(/CONTROL_CENTER_FIXTURE_READY (http:\/\/\S+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    server.once("error", reject);
    server.once("exit", () => reject(new Error("Fixture exited")));
  });
  browser = await (profile === "webkit" ? webkit : chromium).launch({
    headless: true,
    ...(profile === "chrome" ? { channel: "chrome" } : {}),
  });
  for (const locale of ["zh-CN", "en", "ja"]) {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ locale, viewport: { width, height: 850 } });
      const page = await context.newPage();
      activePage = page;
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const label = `${locale}-${width}`;
      // Each handler only intercepts one chosen query, so retry can proceed
      // while the first response remains blocked.
      async function hold(type, threadId) {
        let release;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        let seen = false;
        const handler = async (route) => {
          const body = route.request().postDataJSON();
          if (!seen && body.type === type && (!threadId || body.payload.threadId === threadId)) {
            seen = true;
            await gate;
          }
          await route.continue().catch(() => {});
        };
        await page.route("**/api/gateway/thread/v3/queries", handler);
        return { release, handler, seen: () => seen };
      }
      async function finish(held) {
        held.release();
        await page.unroute("**/api/gateway/thread/v3/queries", held.handler);
      }
      async function showSidebar() {
        await page.locator(".thread-sidebar-records").waitFor({ state: "attached" });
        if (!(await page.locator(".thread-sidebar-records").isVisible()))
          await page.locator(".mobile-sidebar-toggle").click();
      }
      const initial = await hold("thread.list");
      await page.goto(`${baseUrl}/threads`);
      await showSidebar();
      await expect(page.locator('.thread-loading-skeleton[data-scope="list"]')).toBeVisible();
      await expect(page.locator(".thread-load-feedback")).toHaveCount(0);
      await expect(page.locator(".thread-welcome")).toBeVisible();
      await expect(page.locator(".thread-content")).not.toContainText("正在加载权威状态");
      await expect(page.locator(".thread-load-feedback")).toBeVisible({ timeout: 6000 });
      await page.screenshot({ path: path.join(output, `${label}-slow.png`) });
      await page.locator(".thread-load-feedback button").click();
      await expect(page.locator('a[href="/threads/thread-main"]')).toBeVisible();
      await expect(page.locator(".thread-load-feedback")).toHaveCount(0);
      await finish(initial);
      results.push(
        `${label}: first-load skeleton, delayed feedback, retry supersedes blocked request`,
      );

      const background = await hold("thread.list");
      await page.locator(".thread-collection-heading button").click();
      await expect.poll(background.seen).toBe(true);
      await expect(page.locator('a[href="/threads/thread-main"]')).toBeVisible();
      await expect(page.locator(".thread-loading-skeleton")).toHaveCount(0);
      await expect(page.locator(".thread-load-feedback")).toHaveCount(0);
      await finish(background);
      await expect(page.locator('.thread-sidebar-records[aria-busy="false"]')).toBeVisible();
      results.push(`${label}: quiet background refresh preserves list`);

      const failing = async (route) => {
        if (route.request().postDataJSON().type === "thread.list")
          await route.fulfill({ status: 503, json: { error: "fixture-unavailable" } });
        else await route.continue();
      };
      await page.route("**/api/gateway/thread/v3/queries", failing);
      await page.locator(".thread-collection-heading button").click();
      await expect(page.locator(".thread-load-feedback")).toBeVisible();
      await expect(page.locator('a[href="/threads/thread-main"]')).toBeVisible();
      await page.unroute("**/api/gateway/thread/v3/queries", failing);
      await page.locator(".thread-load-feedback button").click();
      await expect(page.locator(".thread-load-feedback")).toHaveCount(0);
      results.push(`${label}: failed refresh preserves list and retries successfully`);

      // Navigate through the app, so route cleanup and request sequencing are exercised.
      const detail = await hold("thread.detail", "thread-main");
      await page.locator('a[href="/threads/thread-main"]').click();
      await expect(
        page.locator('.thread-loading-skeleton[data-scope="conversation"]'),
      ).toBeVisible();
      await expect(page.locator(".thread-welcome")).toHaveCount(0);
      await expect(page.locator(".thread-content .thread-load-feedback")).toBeVisible({
        timeout: 6000,
      });
      await page.locator(".thread-content .thread-load-feedback button").click();
      await expect(page.locator(".thread-content")).toContainText("计划处于实施阶段。");
      await finish(detail);
      const composer = page.locator(".composer textarea");
      await composer.fill("保留这段尚未发送的草稿");
      await showSidebar();
      const refreshDetail = await hold("thread.detail", "thread-main");
      await page.locator(".thread-collection-heading button").click();
      await expect.poll(refreshDetail.seen).toBe(true);
      await expect(composer).toHaveValue("保留这段尚未发送的草稿");
      await expect(page.locator(".thread-content")).toContainText("计划处于实施阶段。");
      await finish(refreshDetail);
      results.push(
        `${label}: selected conversation placeholder, slow retry, message and draft preservation`,
      );

      const stale = await hold("thread.detail", "thread-research");
      await page.locator('a[href="/threads/thread-research"]').click();
      await expect.poll(stale.seen).toBe(true);
      await showSidebar();
      await page.locator('a[href="/threads/thread-main"]').click();
      await expect(composer).toHaveValue("保留这段尚未发送的草稿");
      await finish(stale);
      await expect(page.locator(".thread-content")).toContainText("计划处于实施阶段。");
      results.push(
        `${label}: rapid navigation ignores stale response and restores per-thread draft`,
      );

      await showSidebar();
      await page.locator(".thread-search-disclosure > summary").click();
      await page.getByRole("searchbox").fill("计划");
      const search = await hold("thread.search");
      await page.locator(".thread-search button").click();
      await expect.poll(search.seen).toBe(true);
      await expect(page.locator(".thread-load-feedback")).toBeVisible({ timeout: 6000 });
      await page.locator(".thread-load-feedback button").click();
      await expect(page.locator(".thread-load-feedback")).toHaveCount(0);
      await finish(search);
      await expect(composer).toHaveValue("保留这段尚未发送的草稿");
      // Direct conversation URLs must expose errors in the main pane even
      // when the sidebar is hidden on a phone.
      await page.route("**/api/gateway/thread/v3/queries", failing);
      await page.goto(`${baseUrl}/threads/thread-main`);
      await expect(page.locator(".thread-content .thread-load-feedback")).toBeVisible();
      await expect(page.locator(".thread-welcome")).toHaveCount(0);
      await page.unroute("**/api/gateway/thread/v3/queries", failing);
      await page.locator(".thread-content .thread-load-feedback button").click();
      await expect(composer).toHaveValue("保留这段尚未发送的草稿");
      results.push(
        `${label}: failed direct conversation load has visible retry with sidebar closed`,
      );

      const empty = async (route) => {
        const response = await route.fetch();
        if (route.request().postDataJSON().type === "thread.list") {
          const data = await response.json();
          data.payload.threads = [];
          await route.fulfill({ response, json: data });
        } else await route.fulfill({ response });
      };
      await page.route("**/api/gateway/thread/v3/queries", empty);
      await page.goto(`${baseUrl}/threads`);
      await showSidebar();
      await expect(page.locator('.thread-sidebar-records[aria-busy="false"]')).toBeVisible();
      await expect(page.locator(".thread-loading-skeleton")).toHaveCount(0);
      const emptyRefresh = await hold("thread.list");
      await page.locator(".thread-collection-heading button").click();
      await expect.poll(emptyRefresh.seen).toBe(true);
      await expect(page.locator(".thread-loading-skeleton")).toHaveCount(0);
      await expect(page.locator(".thread-load-feedback")).toHaveCount(0);
      await finish(emptyRefresh);
      await page.unroute("**/api/gateway/thread/v3/queries", empty);
      await page.locator(".thread-collection-heading button").click();
      await expect(page.locator('a[href="/threads/thread-main"]')).toBeVisible();
      results.push(`${label}: successful empty list remains quiet on background refresh`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      expect(overflow).toBe(false);
      expect(errors).toEqual([]);
      await expect(page.locator(".connection-connected")).toBeVisible({ timeout: 15000 });
      await page.screenshot({ path: path.join(output, `${label}-complete.png`) });
      results.push(`${label}: search timeout retry, no page errors or horizontal overflow`);
      await context.close();
      process.stdout.write(`passed ${label}\n`);
    }
  }
  await writeFile(
    path.join(output, "report.json"),
    `${JSON.stringify({ status: "passed", profile, browser: browser.version(), checks: results }, null, 2)}\n`,
  );
} catch (error) {
  await activePage?.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  await writeFile(
    path.join(output, "report.json"),
    `${JSON.stringify({ status: "failed", checks: results, error: String(error) }, null, 2)}\n`,
  );
  throw error;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
