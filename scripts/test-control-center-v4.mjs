import { expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

async function qualifyImmediateStartup(browser, baseUrl, output) {
  const cases = [];
  for (const width of [1280, 320])
    for (const configFailure of [false, true]) {
      const context = await browser.newContext({
        locale: "zh-CN",
        viewport: { width, height: 820 },
      });
      const page = await context.newPage();
      const commands = [];
      const errors = [];
      let detailQuery;
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("request", (request) => {
        if (request.method() !== "POST") return;
        if (request.url().endsWith("/api/gateway/thread/v3/commands"))
          commands.push(request.postDataJSON());
        if (request.url().endsWith("/api/gateway/thread/v3/queries")) {
          const body = request.postDataJSON();
          if (body.type === "thread.detail") detailQuery = body;
        }
      });
      let releaseConfig, releaseEvents;
      let failConfig = configFailure;
      const configGate = new Promise((resolve) => {
        releaseConfig = resolve;
      });
      const eventGate = new Promise((resolve) => {
        releaseEvents = resolve;
      });
      await context.route("**/api/control-center/v1/config", async (route) => {
        await configGate;
        if (failConfig)
          await route.fulfill({ status: 503, json: { code: "FIXTURE_CONFIG_UNAVAILABLE" } });
        else await route.continue().catch(() => {});
      });
      await context.route("**/api/gateway/thread/v3/events*", async (route) => {
        await eventGate;
        await route.continue().catch(() => {});
      });
      const name = `${width}-${configFailure ? "config-retry" : "slow-config"}`;
      try {
        await page.goto(`${baseUrl}/threads`);
        const textarea = page.locator(".composer textarea");
        const send = page.getByRole("button", { name: "发送", exact: true });
        const text = `首次打开-${name}`;
        await textarea.fill(text);
        await expect(send).toBeDisabled();
        await textarea.press("Enter");
        await expect(textarea).toHaveValue(text);
        expect(commands).toEqual([]);
        await expect(page.locator(".composer-readiness")).toBeVisible();
        releaseConfig();
        if (configFailure) {
          await expect(page.getByRole("button", { name: "重试", exact: true })).toBeVisible();
          failConfig = false;
          await page.getByRole("button", { name: "重试", exact: true }).click();
        }
        await expect(send).toBeEnabled();
        await expect(page.locator(".app-shell")).toHaveAttribute("data-connection", "connecting");
        await send.click();
        await textarea.press("Enter");
        await expect(page.locator(".thread-message-owner")).toContainText(text);
        await expect(textarea).toHaveValue("");
        expect(commands.map((x) => x.type)).toEqual(["thread.create", "thread.message.submit"]);
        await expect(page.locator(".app-shell")).toHaveAttribute("data-connection", "connecting");
        await expect.poll(() => detailQuery?.payload.threadId).toBe(commands[0].payload.threadId);
        const snapshot = await (
          await page.request.post(`${baseUrl}/api/gateway/thread/v3/queries`, { data: detailQuery })
        ).json();
        expect(snapshot.payload.messages).toHaveLength(1);
        expect(snapshot.payload.runs).toHaveLength(1);
        if (output) await page.screenshot({ path: path.join(output, `${name}-before-stream.png`) });
        releaseEvents();
        await expect(page.locator(".app-shell")).toHaveAttribute("data-connection", "connected");
        await page.reload();
        await expect(page.locator(".thread-message-owner")).toContainText(text);
        await expect(page.locator(".thread-message-owner")).toHaveCount(1);
        expect(commands).toHaveLength(2);
        expect(errors).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
        cases.push({ width, configFailure, passed: true });
      } catch (error) {
        if (output)
          await page.screenshot({ path: path.join(output, `${name}-failure.png`) }).catch(() => {});
        throw error;
      } finally {
        releaseConfig();
        releaseEvents();
        await context.unrouteAll({ behavior: "wait" });
        await context.close();
      }
    }

  if (output)
    await writeFile(
      path.join(output, "immediate-startup.json"),
      JSON.stringify(
        { scope: "real browser with isolated HTTP fixture; no production model calls", cases },
        null,
        2,
      ),
    );
  return cases;
}

export async function qualifyControlCenterV4(browser, baseUrl, out) {
  if (out) await mkdir(out, { recursive: true });
  const immediateStartup = await qualifyImmediateStartup(browser, baseUrl, out);
  const context = await browser.newContext({
    viewport: { width: 1248, height: 810 },
    locale: "zh-CN",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let release = () => {};
  try {
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    await page.route("**/api/control-center/v1/config", async (route) => {
      await hold;
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: {
          ...(await response.json()),
          availableModels: [
            {
              ref: "model:fixture-primary:v1",
              provider: "fixture",
              model: "fixture-primary",
              name: "Configured primary",
              thinkingLevels: ["minimal", "medium", "high"],
            },
          ],
        },
      });
    });
    await page.goto(`${baseUrl}/threads`);
    await page.getByRole("button", { name: "新建对话", exact: true }).click();
    const textarea = page.locator(".composer textarea");
    await expect(textarea).toBeVisible();
    await textarea.fill("初始化期间的草稿");
    await expect(page.locator(".composer-readiness")).toBeVisible();
    if (out) await page.screenshot({ path: out + "/startup-draft.png" });
    release();
    await expect(page.locator(".composer-readiness")).toHaveCount(0);
    await expect(textarea).toHaveValue("初始化期间的草稿");
    await page.getByRole("button", { name: "新建对话", exact: true }).click();
    await expect(textarea).toHaveValue("初始化期间的草稿");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
    if (out) await page.screenshot({ path: out + "/settings.png" });
    await page.getByRole("button", { name: "关闭", exact: true }).last().click();
    await page.locator(".model-picker > summary").click();
    if (out) await page.screenshot({ path: out + "/model-picker.png" });
    const slider = page.getByRole("slider");
    await expect(slider).toBeVisible();
    await slider.press("End");
    await expect(slider).toHaveValue("2");
    await slider.press("Escape");
    if (out) await page.screenshot({ path: out + "/desktop.png" });
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page).toHaveURL(/\/threads\/thread/);
    await expect(textarea).toHaveValue("");
    await expect(page.locator(".thread-message-owner")).toContainText("初始化期间的草稿");
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 820 });
      if (out) await page.screenshot({ path: out + `/mobile-${width}.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    }
    expect(errors).toEqual([]);
    if (out)
      await writeFile(
        out + "/browser-v4.json",
        JSON.stringify(
          {
            scope: "real built UI with isolated fixture server; no real model call",
            status: "passed",
            errors,
          },
          null,
          2,
        ),
      );
  } catch (error) {
    if (out) await page.screenshot({ path: out + "/failure.png", fullPage: true });
    if (out) await writeFile(out + "/failure.txt", String(error));
    throw error;
  } finally {
    release();
    await context.unrouteAll({ behavior: "wait" });
    await context.close();
  }

  return { scenario: "startup-before-readiness", passed: true, immediateStartup };
}
