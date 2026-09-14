import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect, webkit } from "@playwright/test";
import { qualifyAuthorizationFeedback } from "./test-authorization-feedback-browser.mjs";

// Reuse the product HTTP fixture; configure the real composer with the controls
// installed in production. Mock only the gateway boundary, never layout or DOM.
export async function qualifyMobileComposer(browser, baseUrl, output) {
  const results = [];
  for (const locale of ["ja", "zh-CN", "en"]) {
    for (const width of [320, 393, 430]) {
      const context = await browser.newContext({
        locale,
        viewport: { width, height: 700 },
        isMobile: browser.browserType().name() !== "firefox",
        hasTouch: true,
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const label = `${locale}-${width}`;
      await context.route("**/api/control-center/v1/config", async (route) => {
        const response = await route.fetch();
        const config = await response.json();
        await route.fulfill({
          response,
          json: {
            ...config,
            canCancelRun: true,
            availableModels: [
              {
                ref: "model:fixture-primary:v1",
                model: "fixture-primary",
                name: "GLM 5.3 Flash",
                provider: "fixture",
                thinkingLevels: ["minimal", "high"],
              },
              {
                ref: "model:fixture-secondary:v1",
                model: "fixture-secondary",
                name: "Long model name for narrow mobile screens",
                provider: "fixture",
                thinkingLevels: ["minimal", "high"],
              },
            ],
            installedGatewayV2Operations: [
              ...config.installedGatewayV2Operations,
              "search.authorization.read",
              "search.authorization.set",
            ],
          },
        });
      });
      await context.route("**/api/gateway/v2/queries", async (route) => {
        const request = route.request().postDataJSON();
        if (request.type !== "search.authorization.read") return route.continue();
        await route.fulfill({
          json: {
            ...request,
            kind: "snapshot",
            type: "search.authorization.snapshot",
            payload: {
              revision: 1,
              enabled: true,
              available: true,
              recipient: "https://mcp.exa.ai",
              generatedAt: "2026-09-14T00:00:00.000Z",
            },
          },
        });
      });
      try {
        await page.goto(`${baseUrl}/threads/thread-main`);
        const composer = page.locator(".composer");
        const draft = composer.locator("textarea");
        const attach = composer.locator("button[title]");
        const execution = composer.locator(".search-authorization > summary");
        const model = composer.locator(".model-picker > summary");
        const send = composer.locator(".send-button");
        await expect(model).toContainText("GLM 5.3 Flash");
        await expect(execution).toBeVisible();
        await draft.fill("手机布局验收草稿 / モバイルテスト");
        await expect(send).toBeEnabled();
        async function toolbar() {
          const boxes = await Promise.all(
            [attach, execution, model, send].map((item) => item.boundingBox()),
          );
          for (const box of boxes) {
            assert.ok(
              box && box.x >= 0 && box.x + box.width <= width + 1,
              "toolbar control must stay inside viewport",
            );
            assert.ok(
              box.height >= 40 && box.width >= 40,
              "mobile controls must have usable touch targets",
            );
            assert.ok(
              Math.abs(box.y + box.height / 2 - (boxes[0].y + boxes[0].height / 2)) <= 1,
              "attachment, execution, model and send must share one toolbar row",
            );
          }
          for (let index = 1; index < boxes.length; index++)
            assert.ok(
              boxes[index - 1].x + boxes[index - 1].width <= boxes[index].x + 1,
              "toolbar controls must not overlap",
            );
          assert.ok(
            (await composer.boundingBox()).height <= 180,
            "empty mobile composer must stay compact like the approved prototype",
          );
        }
        async function panel(selector) {
          const box = await page.locator(selector).boundingBox();
          assert.ok(
            box &&
              box.x >= 0 &&
              box.x + box.width <= width + 1 &&
              box.y >= 0 &&
              box.y + box.height <= 700,
            "menu must remain inside the viewport",
          );
          assert.ok(
            box.y + box.height <= (await composer.boundingBox()).y + 1,
            "menu must open above, not cover the composer controls",
          );
        }
        await toolbar();
        await page.locator("#page-title").click();
        if (output) await page.screenshot({ path: path.join(output, `${label}-default.png`) });
        await execution.click();
        await expect(page.locator(".search-authorization-panel button")).toBeEnabled();
        await panel(".search-authorization-panel");
        await model.click();
        await expect(page.locator(".search-authorization-panel")).not.toBeVisible();
        await panel(".model-panel");
        await page
          .locator(".model-panel")
          .getByRole("button", { name: /Long model name/ })
          .click();
        await page
          .locator(".depth-choices")
          .getByRole("button", { name: "high", exact: true })
          .click();
        await model.press("Escape");
        await toolbar();
        await expect(draft).toHaveValue("手机布局验收草稿 / モバイルテスト");
        await page.locator("#page-title").click();
        if (output) await page.screenshot({ path: path.join(output, `${label}.png`) });
        await page.setViewportSize({ width, height: 360 });
        await draft.focus();
        const reducedSend = await send.boundingBox();
        assert.ok(
          reducedSend.y + reducedSend.height <= 360,
          "send must stay visible in a reduced visual viewport",
        );
        await model.click();
        const reducedPanel = await page.locator(".model-panel").boundingBox();
        assert.ok(
          reducedPanel.y >= 0 && reducedPanel.y + reducedPanel.height <= 360,
          "model menu must fit above a short viewport composer",
        );
        await model.press("Escape");
        await page.setViewportSize({ width, height: 700 });
        await context.route("**/api/gateway/thread/v3/queries", async (route) => {
          if (route.request().postDataJSON().type !== "thread.detail") return route.continue();
          const response = await route.fetch();
          const snapshot = await response.json();
          await route.fulfill({
            response,
            json: {
              ...snapshot,
              payload: {
                ...snapshot.payload,
                runs: snapshot.payload.runs.map((run) => ({ ...run, status: "running" })),
              },
            },
          });
        });
        await page.reload();
        const stop = composer.locator(".stop-button");
        await expect(stop).toBeEnabled();
        await expect(send).toHaveCount(0);
        const stopBox = await stop.boundingBox();
        const attachBox = await attach.boundingBox();
        assert.ok(
          Math.abs(stopBox.y - attachBox.y) <= 1 && stopBox.x + stopBox.width <= width,
          "stop must occupy the send slot without wrapping",
        );
        assert.deepEqual(errors, []);
        results.push({ locale, width, passed: true });
      } catch (error) {
        if (output) {
          await page.screenshot({ path: path.join(output, `${label}-failure.png`) });
          await writeFile(
            path.join(output, "failure.json"),
            JSON.stringify({ label, error: error.message, errors }, null, 2),
          );
        }
        throw error;
      } finally {
        await context.close();
      }
    }
  }
  results.push(...(await qualifyAuthorizationFeedback(browser, baseUrl, output)));
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const profile = process.argv[2] ?? "chrome";
  const output = path.resolve(process.argv[3] ?? `.ci-output/mobile-composer/${profile}`);
  await mkdir(output, { recursive: true });
  const server = spawn(process.execPath, ["test/e2e/fixtures/control-center-browser-server.mjs"], {
    env: { ...process.env, HIMAWARI_BROWSER_FIXTURE_PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let browser;
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
      ...(profile === "chrome" ? { channel: "chrome" } : {}),
    });
    const cases = await qualifyMobileComposer(browser, baseUrl, output);
    await writeFile(
      path.join(output, "result.json"),
      JSON.stringify({ profile, cases, scope: "fixture-only" }, null, 2),
    );
    console.log(JSON.stringify({ passed: true, profile, cases: cases.length }));
  } finally {
    await browser?.close();
    if (server.exitCode === null) {
      const exited = new Promise((resolve) => server.once("exit", resolve));
      server.kill("SIGTERM");
      await exited;
    }
  }
}
