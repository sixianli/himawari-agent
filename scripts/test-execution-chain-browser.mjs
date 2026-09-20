import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, webkit, expect } from "@playwright/test";

export async function qualifyExecutionChain(browser, baseUrl, output) {
  const cases = [];
  for (const [locale, width] of [
    ["zh-CN", 1280],
    ["zh-CN", 320],
    ["ja", 393],
    ["en", 430],
  ]) {
    const context = await browser.newContext({
      locale,
      viewport: { width, height: 820 },
      isMobile: width < 600,
      hasTouch: width < 600,
    });
    if (width === 1280)
      await context.addInitScript(() =>
        Object.defineProperty(Navigator.prototype, "onLine", { get: () => false }),
      );
    const page = await context.newPage();
    const errors = [];
    const network = [];
    page.on("request", (req) => {
      network.push({ start: req.url().split("?")[0], type: req.resourceType() });
    });
    page.on("requestfailed", (req) =>
      network.push({ url: req.url().split("?")[0], failure: req.failure() }),
    );
    page.on("response", (res) => {
      if (res.url().includes("events"))
        network.push({ url: res.url().split("?")[0], status: res.status() });
    });
    page.on("pageerror", (error) => errors.push(error.message));
    let sequence = 0;
    const unique = `${locale}-${width}`;
    const record = (values) => {
      sequence += 1;
      return {
        id: `${unique}:${sequence}`,
        itemId: `${unique}:${sequence}`,
        sequence,
        kind: "status",
        phase: "updated",
        name: "runtime.turn_started",
        text: "",
        input: "",
        output: "",
        occurredAt: new Date(Date.UTC(2026, 8, 14, 5, 0, sequence)).toISOString(),
        ...values,
      };
    };
    const send = async (value) => {
      const response = await page.request.post(`${baseUrl}/__fixture/execution`, {
        data: { threadId: "thread-main", runId: "run-01", ...value },
      });
      assert.equal(response.ok(), true);
    };
    // Separate fixture thread histories by browser case using a fresh server-side record set.
    await send({
      reset: true,
      status: "running",
      records: [
        record({ name: "memory.query" }),
        record({ name: "memory.candidates" }),
        record({ name: "memory.selection" }),
        record({ name: "context.formed" }),
        record({ name: "runtime.model_started", phase: "started" }),
        record({
          name: "runtime.thinking.started",
          itemId: "thought-1",
          occurredAt: "2026-09-14T05:00:05.000Z",
        }),
        record({
          name: "runtime.thinking.ended",
          itemId: "thought-1",
          occurredAt: "2026-09-14T05:00:07.000Z",
        }),
        record({}),
        record({ kind: "message", itemId: "empty-call-message", phase: "completed" }),
        record({
          kind: "tool",
          itemId: "search-one",
          name: "web_search",
          input: JSON.stringify({ query: "Tokyo headlines", longValue: "long".repeat(400) }),
        }),
      ],
    });
    try {
      await page.goto(`${baseUrl}/threads/thread-main`);
      await expect(page.locator(".app-shell")).toHaveAttribute("data-connection", "connected");
      const process = page.locator(".turn-process").first();
      const tools = process.locator(".tool-record");
      await expect(process).toHaveAttribute("open", "");
      await expect(tools).toHaveCount(1);
      const turnBox = await page.locator(".chat-turn").first().boundingBox();
      const inputBox = await page.locator(".composer").boundingBox();
      assert(turnBox && inputBox && Math.abs(turnBox.x - inputBox.x) <= 1);
      await expect(process.locator(".execution-stage")).toHaveCount(1);
      await expect(process.locator(".execution-stage .step-status")).toHaveText("2s");
      const reviewText = {
        "zh-CN": ["正在检查这次操作", "自动审查已允许本次操作"],
        en: ["Checking this operation", "Automatic review allowed this operation"],
        ja: ["この操作を確認しています", "自動審査で今回の操作が許可されました"],
      }[locale];
      const reviewStart = record({
        itemId: "review-one",
        name: "runtime.authorization_review.started",
      });
      await send({ records: [reviewStart], replay: true });
      const review = process.locator(".authorization-review");
      await expect(review).toHaveCount(1);
      await expect(page.locator(".turn-activity").first()).toContainText(reviewText[0]);
      await expect(review.locator('[data-tool-category="review"]')).toHaveCount(1);
      const attentionBeforeReview = await page.locator(".thread-attention").count();
      await page.screenshot({ path: path.join(output, `${unique}-review-started.png`) });
      await send({
        records: [
          record({
            itemId: "review-one",
            name: "runtime.authorization_review.approved",
            occurredAt: new Date(Date.parse(reviewStart.occurredAt) + 1500).toISOString(),
          }),
        ],
        replay: true,
      });
      await expect(review).toHaveCount(1);
      await expect(review).toContainText(reviewText[1]);
      await expect(review.locator(".step-status")).toHaveText("1.5s");
      await expect(page.locator(".thread-attention")).toHaveCount(attentionBeforeReview);
      await expect(page.locator(".approval-inline")).toHaveCount(0);
      await page.screenshot({ path: path.join(output, `${unique}-review-approved.png`) });
      const first = tools.first();
      await first.locator(":scope > summary").click();
      await expect(first.locator("pre").first()).toContainText('"query":"Tokyo headlines"');
      await expect(first.locator(".call-lifecycle li")).toHaveCount(1);
      await send({
        records: [
          record({ kind: "tool", itemId: "search-one", phase: "started", name: "web_search" }),
          record({
            itemId: "search-one",
            name: "runtime.tool_execution.started",
            occurredAt: "2026-09-14T05:00:10.000Z",
          }),
        ],
        replay: true,
      });
      await expect(first.locator(".call-lifecycle li")).toHaveCount(2);
      await expect(first).toHaveAttribute("open", "");
      await send({
        records: [
          record({
            kind: "tool",
            itemId: "search-one",
            phase: "completed",
            name: "web_search",
            output: "Search result: Tokyo news",
          }),
          record({
            itemId: "search-one",
            name: "runtime.tool_execution.ended",
            occurredAt: "2026-09-14T05:00:16.000Z",
          }),
          record({}),
          record({
            kind: "tool",
            itemId: "search-two",
            phase: "updated",
            name: "web_search",
            input: '{"query":"second query"}',
          }),
        ],
      });
      await expect(tools).toHaveCount(2);
      await expect(first.locator(".call-lifecycle li")).toHaveCount(3);
      await expect(first).toContainText("Search result: Tokyo news");
      await expect(first.locator(".step-status")).toContainText("6s");
      await first.locator(":scope > summary").click();
      await send({
        records: [
          record({
            kind: "tool",
            itemId: "search-two",
            phase: "failed",
            name: "web_search",
            output: "Search provider unavailable",
          }),
        ],
      });
      await expect(first).not.toHaveAttribute("open", "");
      await tools.nth(1).locator(":scope > summary").focus();
      await page.keyboard.press("Enter");
      await expect(tools.nth(1)).toHaveAttribute("open", "");
      await expect(tools.nth(1)).toContainText("Search provider unavailable");
      const lifecycleText = {
        "zh-CN": ["尚未派发", "结果未确认"],
        en: ["Not dispatched", "Result unconfirmed"],
        ja: ["未送信", "結果未確認"],
      }[locale];
      await send({
        records: [record({ itemId: "search-two", name: "runtime.tool_outcome.not_dispatched" })],
      });
      await expect(tools.nth(1).locator(".step-status")).toContainText(lifecycleText[0]);
      await page.screenshot({ path: path.join(output, `${unique}-not-dispatched.png`) });
      await send({
        status: "reconciling_external_result",
        records: [record({ itemId: "search-two", name: "runtime.tool_outcome.unresolved" })],
      });
      await expect(tools.nth(1).locator(".step-status")).toContainText(lifecycleText[1]);
      await expect(page.locator(".turn-activity").first()).toContainText(lifecycleText[1]);
      await expect(page.locator(".turn-activity .run-indicator")).toHaveCount(0);
      await page.screenshot({ path: path.join(output, `${unique}-unresolved.png`) });
      await send({
        status: "completed",
        records: [
          record({
            kind: "message",
            itemId: "answer",
            name: "fixture-model",
            phase: "completed",
            text: "A visible response after the tool calls.",
          }),
          record({ name: "runtime.completed", phase: "completed" }),
        ],
      });
      await expect(tools).toHaveCount(2);
      await expect(process).toHaveAttribute("open", "");
      const title = `Tokyo headlines ${unique}`;
      await send({ title });
      await expect(page.locator("#page-title")).toHaveText(title);
      if (width === 1280)
        await expect(page.locator(".thread-sidebar-records")).toContainText(title);
      await page.evaluate(() => window.dispatchEvent(new Event("offline")));
      await expect(page.locator(".app-shell")).not.toHaveAttribute("data-connection", "connected");
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect(page.locator(".app-shell")).toHaveAttribute("data-connection", "connected");
      await page.reload();
      await expect(page.locator("#page-title")).toHaveText(title);
      await expect(page.locator(".app-shell")).toHaveAttribute("data-connection", "connected");
      await expect(process).toHaveAttribute("open", "");
      await expect(tools).toHaveCount(2);
      await expect(process.locator(".authorization-review")).toHaveCount(1);
      await expect(process.locator(".authorization-review")).toContainText(reviewText[1]);
      await expect(process.locator(".authorization-review .step-status")).toHaveText("1.5s");
      await process.locator(":scope > summary").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `${unique}-overview.png`) });
      await first.locator(":scope > summary").click();
      await expect(first).toContainText("Search result: Tokyo news");
      await expect(first.locator(".step-status")).toContainText("6s");
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.equal(await process.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
      await page.screenshot({ path: path.join(output, `${unique}.png`), fullPage: true });
      const result = first.locator("pre").last();
      await result.scrollIntoViewIfNeeded();
      await expect(result).toBeVisible();
      const resultBox = await result.boundingBox();
      const composerBox = await page.locator(".composer").boundingBox();
      assert(resultBox && composerBox && resultBox.y + resultBox.height <= composerBox.y + 1);
      await page.screenshot({ path: path.join(output, `${unique}-result.png`), fullPage: true });
      const phaseText = {
        "zh-CN": ["结果未确认", "尚未派发", "暂无时长"],
        en: ["Result unconfirmed", "Not dispatched", "Time not recorded"],
        ja: ["結果未確認", "未送信", "時刻の記録なし"],
      }[locale];
      for (const status of ["cancelled", "failed", "completed"]) {
        await send({
          reset: true,
          status,
          records: [
            record({
              kind: "tool",
              itemId: "pending-write",
              name: "write",
              phase: "updated",
              input: '{"path":"note.txt"}',
            }),
            record({ itemId: "pending-write", name: "runtime.tool_outcome.preparing" }),
            record({ kind: "tool", itemId: "rejected-write", name: "write", phase: "failed" }),
            record({ itemId: "rejected-write", name: "runtime.tool_outcome.not_dispatched" }),
          ],
        });
        // Each reset seeds a separate scenario; execution histories in a live
        // page are append-only and must not be treated as a resettable cache.
        const terminalPage = await context.newPage();
        terminalPage.on("pageerror", (error) => errors.push(error.message));
        try {
          await terminalPage.goto(`${baseUrl}/threads/thread-main`);
          const terminalTools = terminalPage
            .locator(".turn-process")
            .first()
            .locator(".tool-record");
          await expect(terminalTools).toHaveCount(2);
          await expect(terminalTools.first().locator(".step-status")).toContainText(phaseText[0]);
          await expect(terminalTools.first().locator(".step-status")).toContainText(phaseText[2]);
          await expect(terminalTools.last().locator(".step-status")).toContainText(phaseText[1]);
          await expect(terminalPage.locator(".turn-activity")).toHaveCount(0);
          await terminalPage.reload();
          await expect(terminalTools).toHaveCount(2);
          await expect(terminalTools.first().locator(".step-status")).toContainText(phaseText[0]);
          await expect(terminalTools.last().locator(".step-status")).toContainText(phaseText[1]);
          await terminalPage.screenshot({ path: path.join(output, `${unique}-${status}.png`) });
        } catch (error) {
          await terminalPage.screenshot({
            path: path.join(output, `${unique}-${status}-failure.png`),
          });
          throw error;
        } finally {
          await terminalPage.close();
        }
      }
      assert.deepEqual(errors, []);
      cases.push({
        locale,
        width,
        passed: true,
        terminalWithoutResult: ["cancelled", "failed", "completed"],
      });
    } catch (error) {
      await writeFile(
        path.join(output, `${unique}-network.json`),
        JSON.stringify({ errors, network }, null, 2),
      );
      await page.screenshot({ path: path.join(output, `${unique}-failure.png`), fullPage: true });
      throw error;
    } finally {
      await context.close();
    }
  }
  return cases;
}
export async function qualifyExecutionState(browser, baseUrl, output) {
  const cases = [];
  const at = "2026-09-20T00:00:00.000Z";
  for (const width of [320, 390, 1024, 1440]) {
    for (const colorScheme of ["light", "dark"]) {
      const context = await browser.newContext({
        locale: "zh-CN",
        viewport: { width, height: 900 },
        colorScheme,
      });
      await context.addInitScript(
        (theme) =>
          localStorage.setItem("himawari.control-center.v1.preferences", JSON.stringify({ theme })),
        colorScheme,
      );
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const state = {
        runRevision: 1,
        revision: "browser-state-1",
        lastObservedAt: at,
        displayPhase: "unresolved",
        reasonCode: "EXECUTION_RESULT_UNCONFIRMED",
        availableActions: [],
        needsAttention: false,
        timing: { reviewMilliseconds: null, executionMilliseconds: null },
        effectSummary: [
          { itemId: "saved", outcome: "succeeded" },
          { itemId: "pending", outcome: "unknown" },
        ],
        operations: [
          {
            itemId: "saved",
            displayPhase: "completed",
            reasonCode: "TOOL_SUCCEEDED",
            lastObservedAt: at,
            executionMilliseconds: null,
          },
          {
            itemId: "pending",
            displayPhase: "unresolved",
            reasonCode: "TOOL_RESULT_UNCONFIRMED",
            lastObservedAt: at,
            executionMilliseconds: null,
          },
        ],
      };
      const send = async (data) => {
        const response = await page.request.post(`${baseUrl}/__fixture/execution`, {
          data: { threadId: "thread-main", runId: "run-01", ...data },
        });
        assert.equal(response.ok(), true);
      };
      try {
        await send({
          reset: true,
          status: "running",
          state,
          records: [
            {
              id: "saved-record",
              sequence: 1,
              itemId: "saved",
              kind: "tool",
              phase: "completed",
              name: "write",
              text: "",
              input: "",
              output: "Saved result remains available",
              occurredAt: at,
            },
            {
              id: "pending-record",
              sequence: 2,
              itemId: "pending",
              kind: "tool",
              phase: "started",
              name: "edit",
              text: "",
              input: "",
              output: "",
              occurredAt: at,
            },
          ],
        });
        await page.goto(`${baseUrl}/threads/thread-main`);
        const process = page.locator(".turn-process").first();
        await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
        await expect(process.locator(".process-result")).toContainText("结果未确认");
        await expect(process.locator(".tool-record .step-status").nth(0)).toContainText("完成");
        await expect(process.locator(".tool-record .step-status").nth(1)).toContainText(
          "结果未确认",
        );
        await expect(page.locator(".turn-activity .run-indicator")).toHaveCount(0);
        await expect(page.locator(".turn-activity")).not.toContainText("可等待结果或停止本轮");
        await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
        await page
          .locator(".composer textarea")
          .fill("Keep this draft while the current Run is active");
        await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
        await page.screenshot({
          path: path.join(output, `state-${width}-${colorScheme}-unknown.png`),
        });
        // The backend conclusion can change independently of the trace cursor.
        await send({
          status: "completed",
          state: {
            ...state,
            revision: "browser-state-2",
            displayPhase: "completed",
            operations: state.operations.map((operation) => ({
              ...operation,
              displayPhase: "completed",
              reasonCode: "TOOL_SUCCEEDED",
            })),
            effectSummary: state.effectSummary.map((effect) => ({
              ...effect,
              outcome: "succeeded",
            })),
          },
        });
        await expect(process.locator(".process-result")).toContainText("完成");
        await context.setOffline(true);
        await page.evaluate(() => window.dispatchEvent(new Event("offline")));
        await expect(process.locator(".process-result")).toContainText("完成");
        await context.setOffline(false);
        await page.reload();
        await expect(page.locator(".turn-process .process-result").first()).toContainText("完成");
        await send({
          status: "cancelled",
          state: {
            ...state,
            revision: "browser-state-3",
            reasonCode: "RUN_CANCELLED_RESOURCE_STATE_UNCONFIRMED",
            availableActions: ["retry_cleanup"],
          },
        });
        await expect(page.locator(".turn-process .process-result").first()).toContainText(
          "结果未确认",
        );
        await expect(
          page.getByRole("button", { name: "再次停止并检查清理", exact: true }),
        ).toBeVisible();
        await expect(page.locator(".turn-process .tool-record .step-status").first()).toContainText(
          "完成",
        );
        await send({
          status: "cancelled",
          state: {
            ...state,
            revision: "browser-resource-stopping",
            reasonCode: "RESOURCE_STOP_IN_PROGRESS",
            operations: state.operations.map((operation) =>
              operation.itemId === "saved"
                ? {
                    ...operation,
                    displayPhase: "unresolved",
                    reasonCode: "RESOURCE_STOP_IN_PROGRESS",
                  }
                : operation,
            ),
            availableActions: [],
          },
        });
        await expect(page.locator(".turn-activity output")).toContainText("正在停止");
        await expect(page.locator(".turn-process .tool-record .step-status").first()).toContainText(
          "正在停止",
        );
        await expect(
          page.getByRole("button", { name: "再次停止并检查清理", exact: true }),
        ).toHaveCount(0);
        await expect(page.locator(".turn-process .tool-record .step-status").first()).toContainText(
          "完成",
        );
        await send({
          silent: true,
          state: {
            ...state,
            revision: "browser-resource-verifying",
            reasonCode: "RESOURCE_CHECK_IN_PROGRESS",
            availableActions: [],
          },
        });
        await expect(page.locator(".turn-activity output")).toContainText("正在核验原请求");
        await send({
          status: "cancelled",
          state: {
            ...state,
            revision: "browser-resource-expired",
            reasonCode: "RESOURCE_STATE_UNCONFIRMED",
            availableActions: ["retry_cleanup"],
          },
        });
        await expect(page.locator(".turn-activity output")).toContainText("结果未确认");
        await expect(page.locator(".turn-activity .run-indicator")).toHaveCount(0);
        await page.reload();
        await expect(page.locator(".turn-activity output")).toContainText("结果未确认");
        await page.screenshot({
          path: path.join(output, `state-${width}-${colorScheme}-resource-expired.png`),
        });
        await send({
          status: "cancelled",
          state: {
            ...state,
            revision: "browser-resource-released",
            displayPhase: "stopped",
            reasonCode: "RUN_CANCELLED_RESOURCES_RELEASED",
            availableActions: [],
          },
        });
        await expect(page.locator(".turn-process .process-result").first()).toContainText("已停止");
        await expect(page.locator(".turn-activity")).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "再次停止并检查清理", exact: true }),
        ).toHaveCount(0);
        assert.deepEqual(errors, []);
        cases.push({
          width,
          colorScheme,
          resourceRecovery: true,
          backendState: true,
          reconnect: true,
          noTraceReplay: true,
        });
      } finally {
        await context.close();
      }
    }
  }
  return cases;
}

export async function qualifyExecutionChainFixture(browser, output, staticRoot) {
  await mkdir(output, { recursive: true });
  const server = spawn(process.execPath, ["test/e2e/fixtures/control-center-browser-server.mjs"], {
    env: {
      ...process.env,
      HIMAWARI_BROWSER_FIXTURE_PORT: "0",
      HIMAWARI_EXECUTION_FIXTURE: "1",
      ...(staticRoot ? { HIMAWARI_BROWSER_STATIC_ROOT: staticRoot } : {}),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const baseUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture startup timeout")), 10000);
      let text = "";
      server.stdout.on("data", (chunk) => {
        text += chunk;
        const match = text.match(/CONTROL_CENTER_FIXTURE_READY (http:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      server.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      server.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Fixture exited"));
      });
    });
    const cases = await qualifyExecutionChain(browser, baseUrl, output);
    cases.push(...(await qualifyExecutionState(browser, baseUrl, output)));
    await writeFile(
      path.join(output, "result.json"),
      JSON.stringify(
        { cases, scope: "real browser with isolated HTTP fixture; no production model calls" },
        null,
        2,
      ),
    );
    return cases;
  } finally {
    if (server.exitCode === null) {
      const exited = new Promise((resolve) => server.once("exit", resolve));
      server.kill("SIGTERM");
      await exited;
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const profile = process.argv[2] ?? "chromium";
  const output = path.resolve(process.argv[3] ?? `.ci-output/execution-chain/${profile}`);
  const browser = await (profile === "webkit" ? webkit : chromium).launch(
    profile === "chrome" ? { channel: "chrome" } : {},
  );
  try {
    const cases = await qualifyExecutionChainFixture(browser, output);
    console.log(JSON.stringify({ passed: true, profile, cases: cases.length }));
  } finally {
    await browser.close();
  }
}
