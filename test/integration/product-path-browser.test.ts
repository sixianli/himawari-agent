import { readFile, writeFile } from "node:fs/promises";
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

async function sendToolRequest(text: string) {
  const before = await toolAnswers().count();
  await send(text);
  const allow = page.getByRole("button", { name: "允许这一次" });
  await uiExpect
    .poll(async () => (await allow.count()) > 0 || (await toolAnswers().count()) > before, {
      timeout: 300_000,
    })
    .toBe(true);
  if ((await allow.count()) > 0) await allow.first().click();
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
