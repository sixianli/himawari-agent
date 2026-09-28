import { execFileSync } from "node:child_process";
import { readdir, readFile, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
  expect as uiExpect,
} from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  installProductPath,
  type ModelScript,
  type ProductPathInstallation,
  publicHost,
  repositoryRoot,
} from "../fixtures/product-path-harness.ts";

const enabled = process.env["HIMAWARI_PRODUCT_PATH_E2E"] === "1";
const productDescribe = enabled ? describe : describe.skip;
const outputDirectory = path.resolve(
  repositoryRoot,
  process.env["HIMAWARI_PRODUCT_PATH_OUTPUT"] ?? ".ci-output/product-path",
);
const NOTE = "项目代号：向日葵";

const script: ModelScript = ({ lastUserText, toolResults, hasTools }) => {
  if (!hasTools) return { kind: "text", text: "工具恢复验证" };
  if (lastUserText.includes("连续读取两个文件") && toolResults.length < 2)
    return {
      kind: "tool",
      name: "read",
      arguments: { path: toolResults.length === 0 ? "notes.txt" : "second.txt" },
    };
  if (toolResults.length > 0) return { kind: "text", text: `工具返回：${toolResults.join("\n")}` };
  if (lastUserText.includes("运行中停止验证") || lastUserText.includes("执行中重启验证"))
    return {
      kind: "tool",
      name: "bash",
      arguments: {
        command: "printf 'running'; /bin/sleep 120; printf 'late-result'",
      },
    };
  if (lastUserText.includes("读取 notes.txt"))
    return { kind: "tool", name: "read", arguments: { path: "notes.txt" } };
  if (lastUserText.includes("读取 missing.txt"))
    return { kind: "tool", name: "read", arguments: { path: "missing.txt" } };
  if (lastUserText.includes("写入 hello.txt"))
    return {
      kind: "tool",
      name: "write",
      arguments: { path: "hello.txt", content: "你好，Himawari" },
    };
  if (lastUserText.includes("模型故障")) return { kind: "http-error", status: 500 };
  if (lastUserText.includes("慢一点"))
    return { kind: "text", text: "慢回答已完成", delayMs: 2_500 };
  return { kind: "text", text: "普通回答已完成" };
};

let installation: ProductPathInstallation;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const results: Array<{ scenario: string; status: "passed" | "failed"; error?: string }> = [];

async function capture(name: string) {
  await page.screenshot({ path: path.join(outputDirectory, `${name}.png`), fullPage: true });
  await writeFile(
    path.join(outputDirectory, `${name}.aria.yml`),
    await page.locator("body").ariaSnapshot(),
  );
}

async function scenario(name: string, body: () => Promise<void>) {
  try {
    await body();
    results.push({ scenario: name, status: "passed" });
    await capture(name);
  } catch (error) {
    results.push({ scenario: name, status: "failed", error: String(error) });
    await capture(`${name}-failed`).catch(() => undefined);
    throw error;
  }
}

function noteAnswer() {
  return toolAnswers().filter({ hasText: NOTE }).first();
}

function composer() {
  return page.getByPlaceholder("有什么想交给 Himawari？");
}

async function send(text: string) {
  const button = page.getByRole("button", { name: "发送", exact: true });
  await uiExpect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0, {
    timeout: 300_000,
  });
  await composer().fill(text);
  await uiExpect(button).toBeEnabled({ timeout: 20_000 });
  await button.click();
  await uiExpect(page.getByRole("article").filter({ hasText: text }).last()).toBeVisible({
    timeout: 20_000,
  });
}

function toolAnswers() {
  return page.getByText(/工具返回：/);
}

async function beginToolRequest(text: string) {
  const before = await toolAnswers().count();
  await send(text);
  const allow = page.getByRole("button", { name: "允许这一次" });
  await uiExpect
    .poll(async () => (await allow.count()) > 0 || (await toolAnswers().count()) > before, {
      timeout: 300_000,
    })
    .toBe(true);
  if ((await allow.count()) > 0) await allow.first().click();
  return before;
}

async function sendToolRequest(text: string) {
  const before = await beginToolRequest(text);
  await uiExpect(toolAnswers()).toHaveCount(before + 1, { timeout: 300_000 });
  return toolAnswers().nth(before);
}

function executionReadback() {
  const database = openQualifiedDatabase(installation.databasePath);
  try {
    return database
      .prepare(`SELECT resource.job_id AS jobId, resource.run_id AS runId,
      json_extract(resource.facts_json,'$.result.kind') AS result,
      json_extract(resource.facts_json,'$.resource.supervision') AS supervision,
      run.status AS runStatus,
      EXISTS(SELECT 1 FROM sandbox_release_receipts receipt WHERE receipt.job_id=resource.job_id) AS released,
      (SELECT COUNT(*) FROM sandbox_execution_intents intent WHERE intent.job_id=resource.job_id AND intent.kind='tool_result') AS intents
      FROM sandbox_execution_records resource JOIN runs run ON run.id=resource.run_id ORDER BY resource.job_id`)
      .all() as Array<{
      jobId: string;
      runId: string;
      result: string;
      supervision: string;
      runStatus: string;
      released: number;
      intents: number;
    }>;
  } finally {
    database.close();
  }
}

async function readJobHostStarts() {
  const jobsRoot = path.join(path.dirname(installation.stateRoot), "jobs");
  return Promise.all(
    (await readdir(jobsRoot))
      .filter((name) => name.startsWith("control-"))
      .map(async (name) => {
        const encoded = await readFile(path.join(jobsRoot, name, "started.json"), "utf8").catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          },
        );
        if (encoded === null) return null;
        return JSON.parse(JSON.parse(encoded).body) as {
          jobId: string;
          processId: number;
          taskProcessGroup: { processGroupId: number };
        };
      }),
  );
}

async function waitForExpiredServiceLease() {
  await uiExpect
    .poll(
      () => {
        const database = openQualifiedDatabase(installation.databasePath);
        try {
          return database
            .prepare(
              "SELECT COUNT(*) AS count FROM authority_leases WHERE released_at IS NULL AND expires_at>?",
            )
            .get(new Date().toISOString());
        } finally {
          database.close();
        }
      },
      { timeout: 40_000 },
    )
    .toEqual({ count: 0 });
}

function observedToolReplies(userText: string) {
  return installation.modelRequests.flatMap(({ body }) => {
    if (!Array.isArray(body["tools"]) || !Array.isArray(body["messages"])) return [];
    const messages = body["messages"] as Array<{
      role?: string;
      content?: unknown;
      tool_call_id?: string;
    }>;
    const index = messages.findLastIndex((message) => message.role === "user");
    if (!JSON.stringify(messages[index]?.content).includes(userText)) return [];
    const results = messages.slice(index + 1).filter((message) => message.role === "tool");
    return results.length ? [results.map((message) => message.tool_call_id)] : [];
  });
}

async function newThread() {
  await page
    .getByRole("link", { name: "新建对话" })
    .or(page.getByRole("button", { name: "新建对话" }))
    .first()
    .click();
  await uiExpect(composer()).toBeVisible({ timeout: 20_000 });
}

productDescribe(
  "product path: real browser, installed service, sandboxed Pi tools",
  { timeout: 600_000 },
  () => {
    beforeAll(async () => {
      const artifact = process.env["HIMAWARI_TEST_ARTIFACT"];
      const contextFile = process.env["HIMAWARI_TEST_CONTEXT"];
      if (!artifact || !contextFile)
        throw new Error(
          "PRODUCT_PATH_REQUIRES_ARTIFACT: set HIMAWARI_TEST_ARTIFACT and HIMAWARI_TEST_CONTEXT",
        );
      installation = await installProductPath({
        artifact,
        context: contextFile,
        logDirectory: path.join(outputDirectory, "service-logs"),
      });
      installation.setModelScript(script);
      await writeFile(path.join(installation.workspace, "notes.txt"), NOTE, { mode: 0o600 });
      await writeFile(path.join(installation.workspace, "second.txt"), "第二份结果", {
        mode: 0o600,
      });
      await installation.start();
      browser = await chromium.launch({
        channel: process.env["HIMAWARI_PRODUCT_PATH_BROWSER_CHANNEL"] ?? "chrome",
        args: [`--host-resolver-rules=MAP ${publicHost}:443 127.0.0.1:${installation.frontPort}`],
      });
      context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "zh-CN" });
      await context.tracing.start({ screenshots: true, snapshots: true });
      page = await context.newPage();
      await scenario("00-sign-in", async () => {
        await page.goto(`${installation.origin}/`);
        await page.getByRole("button", { name: "登录 Himawari" }).click();
        await uiExpect(composer()).toBeVisible({ timeout: 30_000 });
      });
    }, 400_000);

    afterAll(async () => {
      await context?.tracing
        .stop({ path: path.join(outputDirectory, "trace.zip") })
        .catch(() => undefined);
      await browser?.close().catch(() => undefined);
      await writeFile(
        path.join(outputDirectory, "report.json"),
        `${JSON.stringify({ results, modelRequests: installation?.modelRequests.map(({ path: route, model }) => ({ route, model })) }, null, 2)}\n`,
      );
      await installation?.close();
    }, 120_000);

    it("shows the waiting stage, then the answer, for an ordinary turn", async () => {
      await scenario("01-ordinary-turn", async () => {
        await newThread();
        await send("请慢一点回答");
        await uiExpect(page.getByText("等待模型响应").first()).toBeVisible({ timeout: 10_000 });
        await uiExpect(page.getByText("慢回答已完成")).toBeVisible({ timeout: 30_000 });
        await uiExpect(page.getByText("等待模型响应")).toHaveCount(0);
      });
    });

    it("reads an existing file through the sandboxed read tool and shows its content", async () => {
      await scenario("02-read-existing-file", async () => {
        const answer = await sendToolRequest("请读取 notes.txt");
        await uiExpect(answer).toContainText(NOTE);
      });
    });

    it("tells the user and the model when the file does not exist", async () => {
      await scenario("03-read-missing-file", async () => {
        const answer = await sendToolRequest("请读取 missing.txt");
        await uiExpect(answer).toContainText(/missing\.txt|不存在|ENOENT|not found/i);
      });
    });

    it("writes a file only after approval and the file really exists afterwards", async () => {
      await scenario("04-write-file", async () => {
        await sendToolRequest("请写入 hello.txt");
        expect(await readFile(path.join(installation.workspace, "hello.txt"), "utf8")).toBe(
          "你好，Himawari",
        );
      });
    });

    it("explains a memory lookup failure, keeps serving, and accepts a resend", async () => {
      await scenario("05-memory-lookup-failure", async () => {
        installation.setEmbeddingAvailable(false);
        try {
          await send("记忆失败时这一轮");
          await uiExpect(
            page.getByText(
              "查找相关记忆时，连接模型服务失败。本轮没有调用对话模型，也没有执行任何工具。",
            ),
          ).toBeVisible({ timeout: 300_000 });
          await uiExpect(
            page.getByText("本轮没有执行任何工具操作，可以直接重新发送。"),
          ).toBeVisible();
          await uiExpect(page.getByText(/结果未确认|结果仍未确认/)).toHaveCount(0);
          expect(installation.running()).toBe(true);
        } finally {
          installation.setEmbeddingAvailable(true);
        }
        await send("记忆恢复后重新发送");
        await uiExpect(page.getByText("普通回答已完成").last()).toBeVisible({ timeout: 300_000 });
      });
    });

    it("shows a model failure as a failure, not as an unconfirmed result", async () => {
      await scenario("06-model-failure", async () => {
        await send("请制造模型故障");
        await uiExpect(page.getByText(/模型服务|本轮执行失败/).last()).toBeVisible({
          timeout: 90_000,
        });
        await uiExpect(page.getByText(/结果未确认|结果仍未确认/)).toHaveCount(0);
        expect(installation.running()).toBe(true);
      });
    });

    it("delivers both sequential tool results in one turn exactly once", async () => {
      await scenario("08-two-tools", async () => {
        await newThread();
        const before = new Set(executionReadback().map((record) => record.jobId));
        const text = "请连续读取两个文件";
        await send(text);
        await uiExpect
          .poll(
            async () => {
              if (
                await page
                  .getByText(/工具返回：/)
                  .filter({ hasText: "第二份结果" })
                  .count()
              )
                return true;
              const allow = page.getByRole("button", { name: "允许这一次" }).first();
              if (await allow.isVisible()) await allow.click();
              return false;
            },
            { timeout: 300_000 },
          )
          .toBe(true);
        await uiExpect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0, {
          timeout: 300_000,
        });
        const rows = executionReadback().filter((record) => !before.has(record.jobId));
        await writeFile(
          path.join(outputDirectory, "08-two-tools-readback.json"),
          JSON.stringify({ rows, modelReplies: observedToolReplies(text) }, null, 2),
        );
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((record) => record.runId)).size).toBe(1);
        for (const row of rows)
          expect(row).toMatchObject({
            result: "result",
            supervision: "released",
            runStatus: "completed",
            released: 1,
            intents: 1,
          });
        const replies = observedToolReplies(text);
        expect(replies.map((ids) => ids.length)).toEqual([1, 2]);
        expect(new Set(replies[1]).size).toBe(2);
      });
    });

    it("completes thirty repeated reads without stranding a result or replaying a tool", async () => {
      await scenario("09-thirty-reads", async () => {
        await newThread();
        const before = new Set(executionReadback().map((record) => record.jobId));
        for (let index = 1; index <= 30; index++) {
          const text = `第 ${index} 次读取 notes.txt`;
          await uiExpect(await sendToolRequest(text)).toContainText(NOTE);
          await uiExpect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0, {
            timeout: 300_000,
          });
          const rows = executionReadback().filter((record) => !before.has(record.jobId));
          await writeFile(
            path.join(outputDirectory, "09-thirty-reads-readback.json"),
            JSON.stringify(
              { completed: index, rows, modelReplies: observedToolReplies(text) },
              null,
              2,
            ),
          );
          expect(rows).toHaveLength(index);
          for (const row of rows)
            expect(row).toMatchObject({
              result: "result",
              supervision: "released",
              runStatus: "completed",
              released: 1,
              intents: 1,
            });
          expect(observedToolReplies(text).map((ids) => ids.length)).toEqual([1]);
          await uiExpect(page.getByText(/结果未确认|结果仍未确认/)).toHaveCount(0);
        }
      });
    }, 1_800_000);

    it("delivers a verified preparation failure and exposes its private diagnostic through the CLI", async () => {
      await scenario("12-preparation-failure", async () => {
        await newThread();
        const before = new Set(executionReadback().map((record) => record.jobId));
        const file = path.join(installation.workspace, "hello.txt");
        await writeFile(file, "原文件必须保持不变");
        await installation.armPreparationFailure();
        const text = "准备失败验证：请写入 hello.txt";
        await uiExpect(await sendToolRequest(text)).toContainText("工具未启动");
        await uiExpect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0, {
          timeout: 300_000,
        });
        expect(await readFile(file, "utf8")).toBe("原文件必须保持不变");
        const rows = executionReadback().filter((record) => !before.has(record.jobId));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ runStatus: "completed", intents: 0 });
        const row = rows[0];
        if (!row) throw new Error("Preparation job missing");
        const database = openQualifiedDatabase(installation.databasePath);
        let proof: unknown;
        try {
          proof = database
            .prepare(`SELECT r.preparation_state AS phase,r.started_at AS startedAt,
          json_extract(receipt.verification_json,'$.basis') AS basis FROM sandbox_execution_records r
          JOIN sandbox_reservation_release_receipts receipt ON receipt.job_id=r.job_id WHERE r.job_id=?`)
            .get(row.jobId);
        } finally {
          database.close();
        }
        expect(proof).toEqual({ phase: "reserved", startedAt: null, basis: "host_never_started" });
        const diagnostic = installation.diagnose(row.runId) as {
          diagnostics: Array<{ content: unknown }>;
        };
        expect(diagnostic.diagnostics).toContainEqual(
          expect.objectContaining({
            content: expect.objectContaining({
              stage: "prepare",
              hostStage: "sdk_initialize",
              systemCode: "EIO",
              reasonCode: "SANDBOX_PREPARATION_FAILED",
            }),
          }),
        );
        expect(JSON.stringify(diagnostic)).not.toContain("private fixture preparation input");
        expect(observedToolReplies(text).map((ids) => ids.length)).toEqual([1]);
        await writeFile(
          path.join(outputDirectory, "12-preparation-failure-readback.json"),
          JSON.stringify(
            { rows, proof, diagnostic, modelReplies: observedToolReplies(text) },
            null,
            2,
          ),
        );
      });
    });

    it("measures thirty approved writes without stranding or replaying a tool", async () => {
      await scenario("11-thirty-writes", async () => {
        await newThread();
        const before = new Set(executionReadback().map((record) => record.jobId));
        const timings: Array<{
          jobId: string;
          requestedAt: string;
          acknowledgedAt: string;
          durationMs: number;
        }> = [];
        for (let index = 1; index <= 30; index++) {
          const text = `第 ${index} 次写入 hello.txt`;
          await sendToolRequest(text);
          await uiExpect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0, {
            timeout: 300_000,
          });
          expect(await readFile(path.join(installation.workspace, "hello.txt"), "utf8")).toBe(
            "你好，Himawari",
          );
          const rows = executionReadback().filter((record) => !before.has(record.jobId));
          const database = openQualifiedDatabase(installation.databasePath);
          try {
            for (const row of rows) {
              if (timings.some((item) => item.jobId === row.jobId)) continue;
              const timing = database
                .prepare(`SELECT json_extract(r.plan_json,'$.requestedAt') AS requestedAt,
                i.acknowledged_at AS acknowledgedAt FROM sandbox_execution_records r
                JOIN sandbox_execution_intents i ON i.job_id=r.job_id AND i.kind='tool_result' WHERE r.job_id=?`)
                .get(row.jobId) as { requestedAt: string; acknowledgedAt: string };
              expect(timing.acknowledgedAt).toBeTypeOf("string");
              const durationMs = Date.parse(timing.acknowledgedAt) - Date.parse(timing.requestedAt);
              expect(durationMs).toBeGreaterThanOrEqual(0);
              timings.push({ jobId: row.jobId, ...timing, durationMs });
            }
          } finally {
            database.close();
          }
          const sorted = timings.map((item) => item.durationMs).sort((a, b) => a - b);
          const lower = sorted[Math.floor((sorted.length - 1) / 2)];
          const upper = sorted[Math.floor(sorted.length / 2)];
          if (lower === undefined || upper === undefined) throw new Error("Tool timing missing");
          await writeFile(
            path.join(outputDirectory, "11-thirty-writes-readback.json"),
            JSON.stringify(
              {
                completed: index,
                rows,
                timings,
                modelReplies: observedToolReplies(text),
                medianMs: (lower + upper) / 2,
                maximumMs: sorted.at(-1),
              },
              null,
              2,
            ),
          );
          expect(rows).toHaveLength(index);
          for (const row of rows)
            expect(row).toMatchObject({
              result: "result",
              supervision: "released",
              runStatus: "completed",
              released: 1,
              intents: 1,
            });
          expect(observedToolReplies(text).map((ids) => ids.length)).toEqual([1]);
          await uiExpect(page.getByText(/结果未确认|结果仍未确认/)).toHaveCount(0);
        }
      });
    }, 1_800_000);

    it("stops a running tool, releases only with proof, and never revives the cancelled run", async () => {
      await scenario("13-stop-running", async () => {
        await newThread();
        const before = new Set(executionReadback().map((record) => record.jobId));
        const text = "运行中停止验证";
        await beginToolRequest(text);
        await uiExpect
          .poll(() => executionReadback().filter((record) => !before.has(record.jobId)), {
            timeout: 60_000,
          })
          .toHaveLength(1);
        const current = executionReadback().filter((record) => !before.has(record.jobId));
        expect(current).toHaveLength(1);
        const job = current[0];
        if (!job) throw new Error("STOP_TEST_JOB_MISSING");
        expect(job).toMatchObject({ released: 0, runStatus: "running", intents: 0 });
        await uiExpect
          .poll(
            async () => (await readJobHostStarts()).some((entry) => entry?.jobId === job.jobId),
            {
              timeout: 60_000,
            },
          )
          .toBe(true);
        const host = (await readJobHostStarts()).find((entry) => entry?.jobId === job.jobId);
        expect(host).toBeDefined();
        if (!host) throw new Error("STOP_TEST_HOST_MISSING");
        const taskProcesses = () =>
          execFileSync("/bin/ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" })
            .split("\n")
            .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
            .filter((match) => match && Number(match[2]) === host.taskProcessGroup.processGroupId)
            .map((match) => ({ pid: Number(match?.[1]), command: match?.[3] ?? "" }));
        await uiExpect
          .poll(() => taskProcesses().some(({ command }) => command === "/bin/sleep 120"), {
            timeout: 60_000,
          })
          .toBe(true);
        const shellPid = taskProcesses().find(({ command }) => command === "/bin/sleep 120")?.pid;
        if (!shellPid) throw new Error("STOP_TEST_TASK_MISSING");
        const alive = (pid: number) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
            if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
            throw error;
          }
        };
        expect(alive(host.processId)).toBe(true);
        expect(alive(shellPid)).toBe(true);
        const readback = () => {
          const database = openQualifiedDatabase(installation.databasePath);
          try {
            return {
              rows: executionReadback().filter((record) => record.jobId === job.jobId),
              occupancy: database
                .prepare(
                  "SELECT released_at AS releasedAt FROM sandbox_workspace_occupancy WHERE job_id=?",
                )
                .all(job.jobId),
              receipts: database
                .prepare(
                  "SELECT accepted_at AS acceptedAt, verification_json AS verification FROM sandbox_release_receipts WHERE job_id=?",
                )
                .all(job.jobId),
              hostAlive: alive(host.processId),
              groupAlive: alive(-host.taskProcessGroup.processGroupId),
              shellAlive: alive(shellPid),
              replies: observedToolReplies(text),
            };
          } finally {
            database.close();
          }
        };
        await writeFile(
          path.join(outputDirectory, "13-stop-running-before.json"),
          JSON.stringify(readback(), null, 2),
        );
        try {
          await page.getByRole("button", { name: "停止", exact: true }).click();
          await uiExpect.poll(() => readback().hostAlive, { timeout: 40_000 }).toBe(false);
          await uiExpect
            .poll(() => readback().rows[0], { timeout: 40_000 })
            .toMatchObject({
              released: 1,
              runStatus: "cancelled",
              intents: 0,
            });
          const stopped = readback();
          expect(stopped.groupAlive).toBe(false);
          expect(stopped.shellAlive).toBe(false);
          expect(stopped.receipts).toHaveLength(1);
          expect(stopped.occupancy.length).toBeGreaterThan(0);
          for (const entry of stopped.occupancy)
            expect(entry).toMatchObject({ releasedAt: expect.any(String) });
          expect(stopped.replies).toEqual([]);
          await page.reload();
          await uiExpect(composer()).toBeVisible();
          await send("停止后继续");
          await uiExpect(page.getByText("普通回答已完成").last()).toBeVisible({ timeout: 60_000 });
          expect(readback()).toEqual(stopped);
        } finally {
          await writeFile(
            path.join(outputDirectory, "13-stop-running-after.json"),
            JSON.stringify(readback(), null, 2),
          );
        }
      });
    });

    it("reclaims an interrupted running tool after restarting the test services without replay", async () => {
      await scenario("14-restart-running", async () => {
        await newThread();
        const before = new Set(executionReadback().map((record) => record.jobId));
        const text = "执行中重启验证";
        await beginToolRequest(text);
        await uiExpect
          .poll(() => executionReadback().filter((record) => !before.has(record.jobId)), {
            timeout: 60_000,
          })
          .toHaveLength(1);
        const job = executionReadback().find((record) => !before.has(record.jobId));
        if (!job) throw new Error("RESTART_TEST_JOB_MISSING");
        await uiExpect
          .poll(
            async () => (await readJobHostStarts()).find((entry) => entry?.jobId === job.jobId),
            { timeout: 60_000 },
          )
          .toBeTruthy();
        const host = (await readJobHostStarts()).find((entry) => entry?.jobId === job.jobId);
        if (!host) throw new Error("RESTART_TEST_HOST_MISSING");
        await uiExpect
          .poll(
            () =>
              execFileSync("/bin/ps", ["-axo", "pgid=,command="], { encoding: "utf8" })
                .split("\n")
                .some(
                  (line) =>
                    line.trim() === `${host.taskProcessGroup.processGroupId} /bin/sleep 120`,
                ),
            { timeout: 60_000 },
          )
          .toBe(true);
        await writeFile(
          path.join(outputDirectory, "14-restart-running-before.json"),
          JSON.stringify({ host, rows: executionReadback() }, null, 2),
        );
        await installation.crash();
        await waitForExpiredServiceLease();
        await installation.start();
        await page.reload();
        await uiExpect(composer()).toBeVisible({ timeout: 30_000 });
        const rows = () => executionReadback().filter((record) => !before.has(record.jobId));
        try {
          await uiExpect
            .poll(() => rows()[0], { timeout: 60_000 })
            .toMatchObject({ jobId: job.jobId, released: 1 });
          expect(rows()).toHaveLength(1);
          expect(
            (await readJobHostStarts()).filter((entry) => entry?.jobId === job.jobId),
          ).toHaveLength(1);
          expect(observedToolReplies(text)).toEqual([]);
          await uiExpect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible({
            timeout: 30_000,
          });
          await page.getByRole("button", { name: "停止", exact: true }).click();
          await uiExpect
            .poll(() => rows()[0], { timeout: 40_000 })
            .toMatchObject({ runStatus: "cancelled", released: 1, intents: 0 });
        } finally {
          await writeFile(
            path.join(outputDirectory, "14-restart-running-after.json"),
            JSON.stringify(
              {
                rows: rows(),
                starts: await readJobHostStarts(),
                replies: observedToolReplies(text),
              },
              null,
              2,
            ),
          );
        }
      });
    });

    it.each([false, true])(
      "settles host cleanup with the accepted result contract: restart=%s",
      async (restart) => {
        const name = `15-restart-cleanup-${restart}`;
        await scenario(name, async () => {
          await newThread();
          const before = new Set(executionReadback().map((record) => record.jobId));
          await installation.armFinishGate();
          const text = `收尾重启 ${restart}：请读取 notes.txt`;
          await beginToolRequest(text);
          await uiExpect
            .poll(() => installation.finishGateEntered(), { timeout: 60_000 })
            .not.toBeNull();
          const entered = await installation.finishGateEntered();
          const output = await installation.finishGateOutput();
          expect(output).toContain(NOTE);
          await writeFile(
            path.join(outputDirectory, `${name}-before.json`),
            JSON.stringify({ entered, output, rows: executionReadback() }, null, 2),
          );
          if (restart) await installation.crash();
          await installation.releaseFinishGate();
          if (restart) {
            await waitForExpiredServiceLease();
            await installation.start();
            await page.reload();
          }
          const rows = () => executionReadback().filter((record) => !before.has(record.jobId));
          try {
            await uiExpect
              .poll(() => rows()[0], { timeout: 90_000 })
              .toMatchObject({
                runStatus: "completed",
                released: 1,
                intents: 1,
                result: restart ? "error" : "result",
              });
            expect(rows()).toHaveLength(1);
            if (restart) {
              await uiExpect(page.getByText(/SANDBOX_TOOL_RESULT_LOST/).last()).toBeVisible({
                timeout: 10_000,
              });
              await uiExpect(page.getByText(/结果仍未确认/)).toHaveCount(0);
              expect(
                (await readJobHostStarts()).filter((host) => host?.jobId === rows()[0]?.jobId),
              ).toHaveLength(1);
            } else await uiExpect(noteAnswer()).toBeVisible({ timeout: 10_000 });
            expect(observedToolReplies(text).map((ids) => ids.length)).toEqual([1]);
          } finally {
            await writeFile(
              path.join(outputDirectory, `${name}-after.json`),
              JSON.stringify(
                {
                  rows: rows(),
                  starts: await readJobHostStarts(),
                  replies: observedToolReplies(text),
                },
                null,
                2,
              ),
            );
          }
        });
      },
    );

    it.each([
      "before-reset",
      "after-reset",
      "before-final",
      "after-final",
      "before-result",
      "after-result",
    ] as const)("keeps crash recovery bounded by signed task exit at %s", async (stage) => {
      const name = `16-finish-crash-${stage}`;
      await scenario(name, async () => {
        await newThread();
        const before = new Set(executionReadback().map((record) => record.jobId));
        const text = `${stage} 崩溃：请读取 notes.txt`;
        await installation.armFinishGate(stage);
        await beginToolRequest(text);
        await uiExpect
          .poll(() => installation.finishGateEntered(), { timeout: 60_000 })
          .not.toBeNull();
        const entered = await installation.finishGateEntered();
        if (!entered) throw new Error("FINISH_CRASH_GATE_MISSING");
        expect(await installation.finishGateOutput()).toContain(NOTE);
        if (stage === "after-result")
          await uiExpect.poll(() => installation.finishGateResultReceived()).not.toBeNull();
        const resultReceivedAt = await installation.finishGateResultReceived();
        if (stage === "before-result") expect(resultReceivedAt).toBeNull();
        const rows = () => executionReadback().filter((record) => !before.has(record.jobId));
        expect(rows()[0]?.result).toBeNull();
        await writeFile(
          path.join(outputDirectory, `${name}-before.json`),
          JSON.stringify({ entered, resultReceivedAt, rows: rows() }, null, 2),
        );
        await installation.crash();
        process.kill(entered.pid, "SIGKILL");
        await waitForExpiredServiceLease();
        await installation.start();
        await page.reload();
        const signedExit = ["after-final", "before-result", "after-result"].includes(stage);
        try {
          await uiExpect.poll(() => rows()[0], { timeout: 90_000 }).toMatchObject({ released: 1 });
          if (signedExit) {
            await uiExpect
              .poll(() => rows()[0], { timeout: 90_000 })
              .toMatchObject({ runStatus: "completed", result: "error", intents: 1 });
            await uiExpect(page.getByText(/SANDBOX_TOOL_RESULT_LOST/).last()).toBeVisible();
            expect(observedToolReplies(text).map((ids) => ids.length)).toEqual([1]);
          } else {
            expect(rows()[0]).toMatchObject({ result: null, intents: 0 });
            expect(observedToolReplies(text)).toEqual([]);
            await page.getByRole("button", { name: "停止", exact: true }).click();
            await uiExpect
              .poll(() => rows()[0], { timeout: 40_000 })
              .toMatchObject({ runStatus: "cancelled", released: 1, intents: 0 });
          }
          expect(rows()).toHaveLength(1);
          expect(
            (await readJobHostStarts()).filter((host) => host?.jobId === rows()[0]?.jobId),
          ).toHaveLength(1);
        } finally {
          await writeFile(
            path.join(outputDirectory, `${name}-after.json`),
            JSON.stringify(
              {
                rows: rows(),
                starts: await readJobHostStarts(),
                replies: observedToolReplies(text),
              },
              null,
              2,
            ),
          );
        }
      });
    });

    it.each(["read", "write"] as const)(
      "recovers the original tool result after a process crash during durable delivery: %s",
      async (tool) => {
        const name = `10-delivery-crash-${tool}`;
        await scenario(name, async () => {
          await newThread();
          const before = new Set(executionReadback().map((record) => record.jobId));
          await installation.armDeliveryCrash();
          const text =
            tool === "read" ? "交付中重启：请读取 notes.txt" : "交付中重启：请写入 hello.txt";
          await send(text);
          await uiExpect
            .poll(
              async () => {
                const allow = page.getByRole("button", { name: "允许这一次" }).first();
                if (await allow.isVisible()) await allow.click();
                return installation.deliveryCrashEntered();
              },
              { timeout: 300_000 },
            )
            .not.toBeNull();
          const entered = await installation.deliveryCrashEntered();
          await installation.crash();
          await uiExpect
            .poll(
              () => {
                const database = openQualifiedDatabase(installation.databasePath);
                try {
                  return database
                    .prepare(
                      "SELECT COUNT(*) AS count FROM authority_leases WHERE released_at IS NULL AND expires_at>?",
                    )
                    .get(new Date().toISOString());
                } finally {
                  database.close();
                }
              },
              { timeout: 40_000 },
            )
            .toEqual({ count: 0 });
          const interrupted = executionReadback().filter((record) => !before.has(record.jobId));
          await writeFile(
            path.join(outputDirectory, `${name}-before.json`),
            JSON.stringify({ entered, interrupted }, null, 2),
          );
          expect(interrupted).toHaveLength(1);
          expect(interrupted[0]).toMatchObject({ result: "result", released: 1, intents: 1 });
          if (tool === "write")
            expect(await readFile(path.join(installation.workspace, "hello.txt"), "utf8")).toBe(
              "你好，Himawari",
            );
          await installation.start();
          await page.reload();
          await uiExpect(toolAnswers().last()).toBeVisible({ timeout: 300_000 });
          if (tool === "read") await uiExpect(noteAnswer()).toBeVisible();
          if (tool === "write")
            expect(await readFile(path.join(installation.workspace, "hello.txt"), "utf8")).toBe(
              "你好，Himawari",
            );
          await uiExpect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0, {
            timeout: 300_000,
          });
          const rows = executionReadback().filter((record) => !before.has(record.jobId));
          const replies = observedToolReplies(text);
          await writeFile(
            path.join(outputDirectory, `${name}-after.json`),
            JSON.stringify({ entered, rows, replies }, null, 2),
          );
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            result: "result",
            released: 1,
            intents: 1,
            runStatus: "completed",
          });
          expect(replies.map((ids) => ids.length)).toEqual([1]);
        });
      },
    );

    it("shows the connection loss while the service restarts and recovers afterwards", async () => {
      await scenario("07-service-restart", async () => {
        await installation.stop();
        await uiExpect(page.getByText(/连接中断|离线/).first()).toBeVisible({ timeout: 60_000 });
        await installation.start();
        await uiExpect(page.getByText(/连接中断|离线/)).toHaveCount(0, { timeout: 300_000 });
        await uiExpect(noteAnswer()).toBeVisible();
        await send("重启后继续");
        await uiExpect(page.getByText("普通回答已完成").last()).toBeVisible({ timeout: 300_000 });
      });
    });
  },
);

const profileDescribe =
  enabled && process.env["HIMAWARI_BASELINE_ARTIFACT"] ? describe : describe.skip;
profileDescribe("alternating installed tool profiling", () => {
  it("compares thirty successful writes per version with the same timing probes", async () => {
    const sampleCount = Number(process.env["HIMAWARI_PROFILE_SAMPLE_COUNT"] ?? 30);
    expect(Number.isInteger(sampleCount) && sampleCount >= 1 && sampleCount <= 30).toBe(true);
    type Session = {
      side: "before" | "after";
      directory: string;
      installation: ProductPathInstallation;
      browser: Browser;
      context: BrowserContext;
      page: Page;
    };
    const sessions: Session[] = [];
    const created: ProductPathInstallation[] = [];
    const closed = new Set<ProductPathInstallation>();
    const samples: Array<{
      side: string;
      directory: string;
      index: number;
      row: ReturnType<typeof executionReadback>[number];
      requestedAt: string;
      acknowledgedAt: string;
      durationMs: number;
    }> = [];
    const failures: Array<{
      directory: string;
      index: number;
      row: ReturnType<typeof executionReadback>[number];
      reason:
        | "baseline_synchronous_npm_discovery"
        | "baseline_initial_heartbeat_gap"
        | "baseline_prepare_envelope_expired";
      npmDurationMs: number | null;
    }> = [];
    const close = async (current: Session) => {
      if (closed.has(current.installation)) return;
      await current.page
        .screenshot({
          path: path.join(outputDirectory, `${current.directory}-final.png`),
          fullPage: true,
        })
        .catch(() => undefined);
      await current.context.tracing
        .stop({ path: path.join(outputDirectory, `${current.directory}-trace.zip`) })
        .catch(() => undefined);
      await current.browser.close();
      await current.installation.close();
      closed.add(current.installation);
    };
    const create = async (side: "before" | "after") => {
      const capacity = await statfs(repositoryRoot);
      if (capacity.bavail * capacity.bsize < 1_500_000_000)
        throw new Error("PRODUCT_PROFILE_DISK_CAPACITY");
      const ordinal = sessions.filter((current) => current.side === side).length + 1;
      const directory = ordinal === 1 ? side : `${side}-${ordinal}`;
      const artifact =
        process.env[side === "before" ? "HIMAWARI_BASELINE_ARTIFACT" : "HIMAWARI_TEST_ARTIFACT"];
      const buildContext =
        process.env[side === "before" ? "HIMAWARI_BASELINE_CONTEXT" : "HIMAWARI_TEST_CONTEXT"];
      if (!artifact || !buildContext) throw new Error("PRODUCT_PROFILE_ARTIFACT_REQUIRED");
      const sourceRoot = side === "before" ? process.env["HIMAWARI_BASELINE_SOURCE"] : undefined;
      installation = await installProductPath({
        artifact,
        context: buildContext,
        timing: true,
        ...(sourceRoot ? { sourceRoot } : {}),
        logDirectory: path.join(outputDirectory, directory, "service-logs"),
      });
      created.push(installation);
      installation.setModelScript(script);
      await installation.start();
      browser = await chromium.launch({
        channel: process.env["HIMAWARI_PRODUCT_PATH_BROWSER_CHANNEL"] ?? "chrome",
        args: [`--host-resolver-rules=MAP ${publicHost}:443 127.0.0.1:${installation.frontPort}`],
      });
      context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "zh-CN" });
      await context.tracing.start({ screenshots: true, snapshots: true });
      page = await context.newPage();
      const current: Session = { side, directory, installation, browser, context, page };
      sessions.push(current);
      await page.goto(`${installation.origin}/`);
      await page.getByRole("button", { name: "登录 Himawari" }).click();
      await uiExpect(composer()).toBeVisible({ timeout: 30_000 });
      await newThread();
      return current;
    };
    try {
      const active = { before: await create("before"), after: await create("after") };
      for (let index = 1; index <= sampleCount; index++) {
        const order: Array<"before" | "after"> =
          index % 2 ? ["before", "after"] : ["after", "before"];
        for (const side of order) {
          for (;;) {
            const current = active[side];
            ({ installation, browser, context, page } = current);
            const before = new Set(executionReadback().map((row) => row.jobId));
            const text = `交替样本 ${index} 写入 hello.txt`;
            const beforeAnswers = await beginToolRequest(text);
            let baselineFailure: (typeof failures)[number] | undefined;
            await uiExpect
              .poll(
                async () => {
                  if ((await toolAnswers().count()) > beforeAnswers) return true;
                  const rows = executionReadback().filter((row) => !before.has(row.jobId));
                  const row = rows[0];
                  if (rows.length !== 1 || !row || row.result !== null || row.intents !== 0)
                    return false;
                  const events = (
                    await readFile(
                      path.join(
                        outputDirectory,
                        current.directory,
                        "service-logs/tool-timing.jsonl",
                      ),
                      "utf8",
                    )
                  )
                    .trim()
                    .split("\n")
                    .map((line) => JSON.parse(line) as Record<string, unknown>)
                    .filter((event) => event["jobId"] === row.jobId);
                  if (side !== "before") return false;
                  const npm = events.find(
                    (event) => event["stage"] === "host.npm_global_discovery",
                  );
                  const cancel = events.find(
                    (event) => event["kind"] === "ipc_send" && event["type"] === "cancel",
                  );
                  const firstReply = events.find((event) => event["kind"] === "ipc_receive");
                  const initialGap =
                    !!npm &&
                    !!cancel &&
                    !!firstReply &&
                    Number(firstReply["at"]) > Number(cancel["at"]) &&
                    Number(firstReply["at"]) - Number(firstReply["startedAt"]) > 1500;
                  const blockedDiscovery =
                    !!npm &&
                    Number(npm["durationMs"]) > 1500 &&
                    events.some(
                      (event) =>
                        event["kind"] === "host_machine_code" &&
                        event["code"] === "JOB_HOST_WORKER_LEASE_INVALID",
                    );
                  const expiredPrepare =
                    !events.some((event) => event["stage"] === "host.prepare") &&
                    events.some(
                      (event) =>
                        event["kind"] === "host_ipc_receive" &&
                        event["type"] === "prepare" &&
                        Number(event["ageMs"]) > 1500,
                    ) &&
                    events.some(
                      (event) =>
                        event["kind"] === "host_machine_code" &&
                        event["code"] === "JOB_HOST_WORKER_LEASE_INVALID",
                    );
                  if (
                    (!initialGap && !blockedDiscovery && !expiredPrepare) ||
                    !events.some((event) => event["kind"] === "host_close") ||
                    events.some(
                      (event) => event["kind"] === "ipc_receive" && event["type"] === "started",
                    )
                  )
                    return false;
                  const db = openQualifiedDatabase(installation.databasePath);
                  try {
                    expect(
                      db
                        .prepare(
                          "SELECT preparation_state AS phase, started_at AS started FROM sandbox_execution_records WHERE job_id=?",
                        )
                        .get(row.jobId),
                    ).toEqual({ phase: "reserved", started: null });
                  } finally {
                    db.close();
                  }
                  baselineFailure = {
                    directory: current.directory,
                    index,
                    row,
                    reason: blockedDiscovery
                      ? "baseline_synchronous_npm_discovery"
                      : expiredPrepare
                        ? "baseline_prepare_envelope_expired"
                        : "baseline_initial_heartbeat_gap",
                    npmDurationMs: npm ? Number(npm["durationMs"]) : null,
                  };
                  return true;
                },
                { timeout: 300_000 },
              )
              .toBe(true);
            if (baselineFailure) {
              failures.push(baselineFailure);
              await writeFile(
                path.join(outputDirectory, "baseline-failures.json"),
                JSON.stringify(failures, null, 2),
              );
              await close(current);
              await close(active.after);
              expect(failures.length).toBeLessThan(10);
              active.before = await create("before");
              active.after = await create("after");
              continue;
            }
            const answer = toolAnswers().nth(beforeAnswers);
            await uiExpect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0, {
              timeout: 300_000,
            });
            const rows = executionReadback().filter((row) => !before.has(row.jobId));
            const row = rows[0];
            await writeFile(
              path.join(outputDirectory, `${side}-${index}-readback.json`),
              JSON.stringify(
                {
                  side,
                  index,
                  directory: current.directory,
                  rows,
                  answer: await answer.innerText(),
                  diagnostics: row ? installation.diagnose(row.runId) : null,
                },
                null,
                2,
              ),
            );
            expect(rows).toHaveLength(1);
            expect(row).toMatchObject({
              result: "result",
              supervision: "released",
              runStatus: "completed",
              released: 1,
              intents: 1,
            });
            if (!row) throw new Error("PRODUCT_PROFILE_RESULT_MISSING");
            expect(await readFile(path.join(installation.workspace, "hello.txt"), "utf8")).toBe(
              "你好，Himawari",
            );
            expect(observedToolReplies(text).map((ids) => ids.length)).toEqual([1]);
            const db = openQualifiedDatabase(installation.databasePath);
            try {
              const times = db
                .prepare(`SELECT json_extract(r.plan_json,'$.requestedAt') AS requestedAt,
                i.acknowledged_at AS acknowledgedAt FROM sandbox_execution_records r JOIN sandbox_execution_intents i ON i.job_id=r.job_id AND i.kind='tool_result' WHERE r.job_id=?`)
                .get(row.jobId) as { requestedAt: string; acknowledgedAt: string };
              expect(times?.acknowledgedAt).toBeTypeOf("string");
              samples.push({
                side,
                directory: current.directory,
                index,
                row,
                ...times,
                durationMs: Date.parse(times.acknowledgedAt) - Date.parse(times.requestedAt),
              });
            } finally {
              db.close();
            }
            await writeFile(
              path.join(outputDirectory, "samples.json"),
              JSON.stringify(samples, null, 2),
            );
            break;
          }
        }
      }
      expect(samples.filter((sample) => sample.side === "before")).toHaveLength(sampleCount);
      expect(samples.filter((sample) => sample.side === "after")).toHaveLength(sampleCount);
    } finally {
      for (const current of sessions) await close(current);
      for (const current of created) if (!closed.has(current)) await current.close();
    }
  }, 1_800_000);
});
