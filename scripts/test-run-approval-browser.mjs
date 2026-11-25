import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect, webkit } from "@playwright/test";
import { qualifyExecutionChainFixture } from "./test-execution-chain-browser.mjs";
import { collectPageErrors } from "./browser-page-errors.mjs";

const THREAD = "thread-main";
const RUN = "run-01";
const FOLLOW_UP_LIMIT_MS = 10_000;
const STALLED_READ_LIMIT_MS = 25_000;

async function qualifyRunApproval(browser, baseUrl, output) {
  const cases = [];
  const scenarios = [
    { name: "two-searches-one-card", searches: 2, decision: "approved", stalledReads: 0 },
    { name: "one-search-one-card", searches: 1, decision: "approved", stalledReads: 0 },
    { name: "deny-runs-nothing", searches: 2, decision: "denied", stalledReads: 0 },
    { name: "unanswered-read-recovers", searches: 2, decision: "approved", stalledReads: 1 },
  ];
  for (const scenario of scenarios) {
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = collectPageErrors(page);
    const post = async (route, data) => {
      const response = await page.request.post(`${baseUrl}${route}`, { data });
      assert.equal(response.ok(), true, route);
    };
    const fixture = async () =>
      (await page.request.get(`${baseUrl}/__fixture/run-approvals`)).json();
    let sequence = 0;
    const record = (values) => {
      sequence += 1;
      return {
        id: `${scenario.name}:${sequence}`,
        itemId: `${scenario.name}:${sequence}`,
        sequence,
        kind: "status",
        phase: "updated",
        name: "runtime.turn_started",
        text: "",
        input: "",
        output: "",
        activity: "",
        activityIcon: "",
        occurredAt: new Date(Date.UTC(2026, 9, 29, 15, 8, sequence)).toISOString(),
        ...values,
      };
    };
    const cities = ["Tokyo", "Osaka"].slice(0, scenario.searches);
    const approvalIds = cities.map((city) => `approval-${scenario.name}-${city}`);
    const answer = `天气回答：${scenario.name}`;
    try {
      await post("/__fixture/execution", {
        threadId: THREAD,
        runId: RUN,
        reset: true,
        status: "awaiting_approval",
        records: [
          record({ name: "runtime.model_started", phase: "started" }),
          ...cities.map((city) =>
            record({
              kind: "tool",
              itemId: `search-${scenario.name}-${city}`,
              name: "web_search",
              phase: "started",
              input: JSON.stringify({ query: `${city} weather today` }),
            }),
          ),
        ],
      });
      await post("/__fixture/run-approvals", {
        threadId: THREAD,
        runId: RUN,
        operation: "web_search",
        approvalRequestIds: approvalIds,
      });
      await page.goto(`${baseUrl}/threads/${THREAD}`);
      await expect(page.locator(".app-shell")).toHaveAttribute("data-connection", "connected");
      const allow = page.getByRole("button", { name: "允许联网搜索", exact: true });
      await expect(allow).toHaveCount(1, { timeout: 15_000 });
      const batch = page.getByText(/这一步要搜索 \d+ 次，一次允许就都放行。/);
      if (scenario.searches > 1)
        await expect(batch).toHaveText(`这一步要搜索 ${scenario.searches} 次，一次允许就都放行。`);
      else await expect(batch).toHaveCount(0);
      await expect(page.locator(".approval-input")).toHaveCount(scenario.searches);
      await page.getByRole("checkbox", { name: "记住我的选择，之后允许联网搜索" }).uncheck();
      await page.screenshot({ path: path.join(output, `${scenario.name}-card.png`) });
      if (scenario.stalledReads) await post("/__fixture/stall-detail-reads", { count: 1 });
      const clickedAt = Date.now();
      if (scenario.decision === "approved") await allow.click();
      else await page.getByRole("button", { name: "拒绝", exact: true }).click();
      await expect
        .poll(
          async () =>
            (await fixture()).approvals
              .filter(({ runId }) => runId === RUN)
              .map(({ status }) => status),
          { timeout: 10_000 },
        )
        .toEqual(approvalIds.map(() => scenario.decision));
      const decidedMs = Date.now() - clickedAt;
      if (scenario.decision === "approved") {
        await post("/__fixture/execution", {
          threadId: THREAD,
          runId: RUN,
          status: "completed",
          records: [
            ...cities.map((city) =>
              record({
                kind: "tool",
                itemId: `search-${scenario.name}-${city}`,
                name: "web_search",
                phase: "completed",
                output: `${city}: sunny`,
              }),
            ),
            record({ name: "runtime.completed", phase: "completed" }),
          ],
          answer,
        });
        const limit = scenario.stalledReads ? STALLED_READ_LIMIT_MS : FOLLOW_UP_LIMIT_MS;
        await expect(page.getByText(answer)).toBeVisible({ timeout: limit });
      } else {
        await post("/__fixture/execution", {
          threadId: THREAD,
          runId: RUN,
          status: "failed",
          records: [record({ name: "runtime.failed", phase: "failed" })],
        });
        await expect(page.getByText(answer)).toHaveCount(0);
      }
      const answeredMs = Date.now() - clickedAt;
      await expect(allow).toHaveCount(0, { timeout: 10_000 });
      await expect(page.getByText("正在加载…")).toHaveCount(0);
      const state = await fixture();
      assert.equal(state.stalledReads >= scenario.stalledReads, true);
      await page.screenshot({ path: path.join(output, `${scenario.name}-after.png`) });
      assert.deepEqual(errors, []);
      cases.push({
        scenario: scenario.name,
        searches: scenario.searches,
        decision: scenario.decision,
        cards: 1,
        decidedMs,
        answeredMs: scenario.decision === "approved" ? answeredMs : null,
        stalledReadsSoFar: state.stalledReads,
      });
    } finally {
      await context.close();
    }
  }
  return cases;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const profile = process.argv[2] ?? "chromium";
  const output = path.resolve(process.argv[3] ?? `.ci-output/run-approval/${profile}`);
  const staticRoot = process.argv[4];
  process.env.HIMAWARI_MEMORY_FIXTURE = "1";
  await mkdir(output, { recursive: true });
  const executablePath = process.env.HIMAWARI_CHROMIUM_PATH;
  const browser = await (profile === "webkit" ? webkit : chromium).launch(
    executablePath ? { executablePath } : {},
  );
  try {
    const cases = await qualifyExecutionChainFixture(
      browser,
      output,
      staticRoot,
      qualifyRunApproval,
    );
    await writeFile(path.join(output, "run-approval.json"), JSON.stringify(cases, null, 2));
    console.log(JSON.stringify({ passed: true, profile, cases }, null, 2));
  } finally {
    await browser.close();
  }
}
