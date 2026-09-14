import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";

// Exercise the built application. Only HTTP responses at the existing gateway
// boundary are controlled; component state and DOM interactions remain real.
export async function qualifyAuthorizationFeedback(browser, baseUrl, output) {
  const results = [];
  for (const width of [393, 1280]) {
    const context = await browser.newContext({ locale: "zh-CN", viewport: { width, height: 850 } });
    const page = await context.newPage();
    const errors = [];
    const network = [];
    page.on("requestfailed", (request) =>
      network.push({ url: new URL(request.url()).pathname, failure: request.failure() }),
    );
    page.on("pageerror", (error) => errors.push(error.message));
    let failSearchRead = true;
    let searchReads = 0;
    let approvalReads = 0;
    let mutations = 0;
    await context.route("**/api/control-center/v1/config", async (route) => {
      const response = await route.fetch();
      const configuration = await response.json();
      await route.fulfill({
        response,
        json: {
          ...configuration,
          recentAuthenticationRef: null,
          installedGatewayV2Operations: [
            ...configuration.installedGatewayV2Operations,
            "search.authorization.read",
            "search.authorization.set",
          ],
        },
      });
    });
    await context.route("**/api/gateway/thread/v3/queries", async (route) => {
      const request = route.request().postDataJSON();
      if (request.type === "thread.execution") {
        await route.fulfill({
          json: {
            ...request,
            kind: "snapshot",
            type: "thread.execution_snapshot",
            payload: {
              threadId: request.payload.threadId,
              runId: request.payload.runId,
              records: [],
              nextSequence: null,
              generatedAt: "2026-09-14T00:00:00.000Z",
            },
          },
        });
        return;
      }
      if (request.type !== "thread.detail") return route.continue();
      const response = await route.fetch();
      const snapshot = await response.json();
      await route.fulfill({
        response,
        json: {
          ...snapshot,
          payload: {
            ...snapshot.payload,
            runs: snapshot.payload.runs.map((run) => ({ ...run, status: "awaiting_approval" })),
          },
        },
      });
    });
    await context.route("**/api/gateway/v2/queries", async (route) => {
      const request = route.request().postDataJSON();
      if (request.type === "search.authorization.read") {
        searchReads++;
        if (failSearchRead) {
          await route.fulfill({ status: 503, json: { code: "FIXTURE_TEMPORARY_UNAVAILABLE" } });
          return;
        }
        await route.fulfill({
          json: {
            ...request,
            kind: "snapshot",
            type: "search.authorization.snapshot",
            payload: {
              revision: 1,
              enabled: false,
              available: true,
              recipient: "https://mcp.exa.ai",
              generatedAt: "2026-09-14T00:00:00.000Z",
            },
          },
        });
        return;
      }
      if (request.type === "approval.list") {
        await route.fulfill({
          json: {
            ...request,
            kind: "snapshot",
            type: "collection.snapshot",
            payload: {
              category: "approvals",
              itemRefs: ["approval-recent-auth"],
              nextCursor: null,
              snapshotRef: "feedback-approvals",
              generatedAt: "2026-09-14T00:00:00.000Z",
            },
          },
        });
        return;
      }
      if (request.type === "approval.detail") approvalReads++;
      return route.continue();
    });
    page.on("request", (request) => {
      if (request.url().endsWith("/api/gateway/v2/commands")) mutations++;
    });
    try {
      await page.goto(`${baseUrl}/threads/thread-main`);
      const search = page.locator(".search-authorization");
      await search.locator(":scope > summary").click();
      await expect(search.getByRole("alert")).toBeVisible();
      await expect(search.getByRole("button")).toBeDisabled();
      const failedReads = searchReads;
      failSearchRead = false;
      // Control browser connectivity events at the environment boundary. On
      // headless Linux WebKit, setOffline(false) can still emit offline because
      // navigator.onLine follows the host OS hint. Keep the application mounted
      // so this checks its actual reconnect and stale-error recovery path.
      await page.evaluate(() => window.dispatchEvent(new Event("offline")));
      await expect(page.getByRole("status").filter({ hasText: "离线，正在恢复" })).toBeVisible();
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect.poll(() => searchReads).toBeGreaterThan(failedReads);
      await expect(search.getByRole("button")).toBeEnabled();
      await expect(search.getByRole("alert")).toHaveCount(0);
      await search.locator(":scope > summary").press("Escape");
      const approval = page.locator("#approval-run-01");
      await expect(approval).toBeVisible();
      const beforeApproval = approvalReads;
      await approval.getByRole("button", { name: "允许这一次", exact: true }).click();
      await expect.poll(() => approvalReads).toBeGreaterThan(beforeApproval);
      await expect(approval.getByRole("alert")).toHaveText("此操作需要近期重新认证。");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      assert.equal(mutations, 0, "missing recent authentication must not submit a command");
      assert.deepEqual(errors, []);
      if (output)
        await page.screenshot({ path: path.join(output, `authorization-feedback-${width}.png`) });
      results.push({
        locale: "zh-CN",
        width,
        scenario: "authorization-load-recovery-and-action-error",
        passed: true,
      });
    } catch (error) {
      if (output)
        await writeFile(
          path.join(output, `authorization-feedback-${width}-failure.json`),
          JSON.stringify(
            {
              searchReads,
              approvalReads,
              errors,
              network,
              browser: await page.evaluate(() => ({
                online: navigator.onLine,
                statuses: Array.from(document.querySelectorAll('[role="status"]')).map(
                  (node) => node.textContent,
                ),
              })),
            },
            null,
            2,
          ),
        );
      if (output)
        await page.screenshot({
          path: path.join(output, `authorization-feedback-${width}-failure.png`),
        });
      throw error;
    } finally {
      await context.close();
    }
  }
  return results;
}
