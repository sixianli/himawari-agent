import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { collectPageErrors } from "../../scripts/browser-page-errors.mjs";
import { qualifyExecutionChainFixture } from "../../scripts/test-execution-chain-browser.mjs";

export async function qualifySandboxBrowser(run, output) {
  const browser = await chromium.launch({ channel: "chrome" });
  let result;
  try {
    await qualifyExecutionChainFixture(browser, output, undefined, async (browser, baseUrl) => {
      const context = await browser.newContext({
        locale: "zh-CN",
        viewport: { width: 1280, height: 900 },
      });
      const page = await context.newPage();
      const errors = collectPageErrors(page);
      let readState;
      let lastState;
      let queries = 0;
      let runningQueries = 0;
      let contextClosed = false;
      let hints = 0;
      let hintTimer;
      const close = async () => {
        if (contextClosed) return;
        contextClosed = true;
        clearInterval(hintTimer);
        await context.unrouteAll({ behavior: "wait" });
        await context.close();
      };
      await page.route("**/api/gateway/thread/v3/queries", async (route) => {
        try {
          const message = route.request().postDataJSON();
          if (!["thread.execution_state", "thread.detail"].includes(message.type) || !readState)
            return route.continue();
          const response = await route.fetch();
          const envelope = await response.json();
          const state = await readState();
          if (message.type === "thread.execution_state") {
            envelope.payload.state = state;
            queries++;
          } else {
            envelope.payload.runs = envelope.payload.runs.map((run) =>
              run.runId === "run-01" ? { ...run, revision: state.runRevision } : run,
            );
          }
          await route.fulfill({ response, json: envelope });
        } catch (error) {
          if (!contextClosed)
            await route
              .fulfill({
                status: 409,
                json: { error: { code: error.code ?? "PORT_NOT_AUTHORITATIVE" } },
              })
              .catch(() => {});
        }
      });
      try {
        result = await run({
          async running(read) {
            try {
              readState = async () => {
                lastState = await read();
                return lastState;
              };
              await expect
                .poll(async () => (await readState()).reasonCode, { timeout: 5000 })
                .toBe("RESOURCE_EXECUTION_OBSERVED");
              const response = await page.request.post(`${baseUrl}/__fixture/execution`, {
                data: {
                  reset: true,
                  silent: true,
                  threadId: "thread-main",
                  runId: "run-01",
                  status: "running",
                  records: [],
                  state: await readState(),
                },
              });
              assert.equal(response.ok(), true);
              await page.goto(`${baseUrl}/threads/thread-main`);
              await expect(page.locator(".turn-activity output")).toContainText("正在执行");
              let announced = lastState.revision;
              hintTimer = setInterval(() => {
                void readState()
                  .then(async (state) => {
                    if (contextClosed || state.revision === announced) return;
                    announced = state.revision;
                    hints++;
                    await page.request.post(`${baseUrl}/__fixture/execution-changed`, {
                      data: { threadId: "thread-main", runId: "run-01" },
                    });
                  })
                  .catch(() => {});
              }, 500);
              runningQueries = queries;
              await expect(page.locator('a[aria-current="page"]')).toHaveCount(1);
              await expect(page.locator('a[aria-current="page"] .thread-attention')).toHaveCount(
                lastState.needsAttention ? 1 : 0,
              );
            } catch (error) {
              await close();
              throw error;
            }
          },
          async stopped() {
            try {
              await expect(page.locator(".turn-activity output")).toContainText("结果未确认", {
                timeout: 10000,
              });
              await expect(page.locator(".turn-activity .run-indicator")).toHaveCount(0);
              assert.ok(
                queries > runningQueries,
                "browser must read changed durable state after a pushed change hint",
              );
              assert.equal(new URL(page.url()).pathname, "/threads/thread-main");
              assert.equal(lastState.displayPhase, "unresolved");
              await expect(page.locator('a[aria-current="page"] .thread-attention')).toHaveCount(
                lastState.needsAttention ? 1 : 0,
              );
              await expect(page.getByRole("link", { name: "审批", exact: true })).toHaveCount(0);
              await page.screenshot({
                path: path.join(output, "revoked-unknown.png"),
                fullPage: true,
              });
              const beforeReload = structuredClone(lastState);
              await page.reload();
              await expect(page.locator(".turn-activity output")).toContainText("结果未确认");
              await expect(page.locator('a[aria-current="page"] .thread-attention')).toHaveCount(
                lastState.needsAttention ? 1 : 0,
              );
              assert.deepEqual(lastState.effectSummary, beforeReload.effectSummary);
            } finally {
              await close();
            }
          },
        });
        assert.deepEqual(errors, []);
        return [
          {
            passed: true,
            liveStateQueries: queries,
            realWorker: true,
            realSqliteProjection: true,
            injectedResourceEvents: 0,
            executionChangeHints: hints,
            fixtureBoundary:
              "navigation and gateway transport; no full production authentication or model loop",
            reload: true,
            sameConversation: true,
            attentionMatchesProductionState: true,
            noSeparateApprovalLink: true,
            effectsSurviveReload: true,
          },
        ];
      } catch (error) {
        await page
          .screenshot({ path: path.join(output, "failure.png"), fullPage: true })
          .catch(() => {});
        await writeFile(
          path.join(output, "failure.json"),
          JSON.stringify({ error: String(error), queries, errors, state: lastState }, null, 2),
        );
        throw error;
      } finally {
        await close();
      }
    });
    return result;
  } finally {
    await browser.close();
  }
}
