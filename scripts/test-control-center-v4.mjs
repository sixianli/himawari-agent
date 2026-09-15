import { expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
export async function qualifyControlCenterV4(browser, baseUrl, out) {
  if (out) await mkdir(out, { recursive: true });
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

  return { scenario: "startup-before-readiness", passed: true };
}
