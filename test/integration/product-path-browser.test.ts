import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { readLinuxNamespaceState } from "@himawari-agent/runtime-sandbox/control";
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
import {
  linuxProcessIdentityPresent,
  readLinuxHostProcessGroup,
  type ProductPathJobHostStart,
  readLinuxJobProcesses,
} from "../fixtures/product-path-processes.ts";

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
  if (lastUserText.includes("原执行期限验证"))
    return {
      kind: "tool",
      name: "bash",
      arguments: { command: "printf 'deadline-running'; /bin/sleep 600; printf 'deadline-late'" },
    };
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
  if (lastUserText.includes("读取 durability.txt"))
    return { kind: "tool", name: "read", arguments: { path: "durability.txt" } };
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
  await send(text);
  const turn = page
    .locator(".chat-turn")
    .filter({
      has: page.locator(".thread-message-owner").filter({
        has: page.getByText(text, { exact: true }),
      }),
    })
    .last();
  const answers = turn.getByText(/工具返回：/);
  const allow = turn.getByRole("button", { name: "允许这一次" });
  await uiExpect
    .poll(async () => (await allow.count()) > 0 || (await answers.count()) > 0, {
      timeout: 300_000,
    })
    .toBe(true);
  if ((await allow.count()) > 0) await allow.first().click();
  return answers;
}

async function sendToolRequest(text: string) {
  const answers = await beginToolRequest(text);
  await uiExpect(answers).toHaveCount(1, { timeout: 300_000 });
  return answers;
}

function executionReadback() {
  const database = openQualifiedDatabase(installation.databasePath);
  try {
    return database
      .prepare(`SELECT resource.job_id AS jobId, resource.run_id AS runId,
      json_extract(resource.facts_json,'$.result.kind') AS result,
      json_extract(resource.facts_json,'$.result.reasonCode') AS reasonCode,
      json_extract(resource.facts_json,'$.resource.supervision') AS supervision,
      run.status AS runStatus,
      EXISTS(SELECT 1 FROM sandbox_release_receipts receipt WHERE receipt.job_id=resource.job_id) AS released,
      (SELECT COUNT(*) FROM sandbox_operation_observations operation WHERE operation.job_id=resource.job_id
        AND json_extract(operation.operation_json,'$.result.kind') IN ('result','error')) AS definiteOperations,
      (SELECT COUNT(*) FROM run_payload_artifacts artifact WHERE artifact.run_id=resource.run_id AND artifact.purpose='trace' AND artifact.operation_key LIKE 'sandbox-stream-end:%') AS streamEnds,
      (SELECT COUNT(*) FROM sandbox_execution_intents intent WHERE intent.job_id=resource.job_id AND intent.kind='tool_result') AS intents
      FROM sandbox_execution_records resource JOIN runs run ON run.id=resource.run_id ORDER BY resource.job_id`)
      .all() as Array<{
      jobId: string;
      runId: string;
      result: string;
      reasonCode: string | null;
      supervision: string;
      runStatus: string;
      released: number;
      definiteOperations: number;
      streamEnds: number;
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
        return JSON.parse(JSON.parse(encoded).body) as ProductPathJobHostStart;
      }),
  );
}

async function waitForRunningLinuxTask(
  host: ProductPathJobHostStart,
  sleepSeconds: string,
  name: string,
) {
  let task: { pid: number; starttime: string } | undefined;
  let snapshot: Awaited<ReturnType<typeof readLinuxJobProcesses>> | undefined;
  await uiExpect
    .poll(
      async () => {
        const current = await readLinuxJobProcesses(host);
        await appendFile(
          path.join(outputDirectory, `${name}-processes.jsonl`),
          `${JSON.stringify(current)}\n`,
        );
        const tasks = current.processes.filter(
          (row) =>
            row.stable &&
            row.descendantOfRecordedHost &&
            row.pidNamespace === host.linuxNamespace?.namespaceId &&
            row.argv?.length === 2 &&
            row.argv[0] === "/bin/sleep" &&
            row.argv[1] === sleepSeconds,
        );
        const running = tasks[0];
        if (tasks.length !== 1 || !running) return false;
        task = { pid: running.pid, starttime: running.starttime };
        snapshot = current;
        return true;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  if (!task || !snapshot || !host.linuxNamespace)
    throw new Error("PRODUCT_PATH_LINUX_TASK_IDENTITY_MISSING");
  expect(snapshot.recordedHostPresent).toBe(true);
  expect(snapshot.namespaceInitIdentityPresent).toBe(true);
  const init = snapshot.namespaceMembers.find((row) => row.pid === host.linuxNamespace?.initPid);
  expect(init).toMatchObject({
    stable: true,
    descendantOfRecordedHost: true,
    starttime: host.linuxNamespace.initStartTicks,
    pidNamespace: host.linuxNamespace.namespaceId,
  });
  expect(init?.namespacePids?.at(-1)).toBe(1);
  expect(await linuxProcessIdentityPresent(task)).toBe(true);
  await writeFile(
    path.join(outputDirectory, `${name}-processes-before.json`),
    JSON.stringify({ taskIdentity: task, snapshot }, null, 2),
  );
  return task;
}

async function assertLinuxTaskReleased(
  host: ProductPathJobHostStart,
  task: Awaited<ReturnType<typeof waitForRunningLinuxTask>>,
  name: string,
) {
  if (!host.linuxNamespace) throw new Error("PRODUCT_PATH_LINUX_NAMESPACE_MISSING");
  const snapshot = await readLinuxJobProcesses(host);
  const taskIdentityPresent = await linuxProcessIdentityPresent(task);
  const namespaceState = await readLinuxNamespaceState(host.linuxNamespace);
  const hostGroup = await readLinuxHostProcessGroup(host);
  await writeFile(
    path.join(outputDirectory, `${name}-processes-after.json`),
    JSON.stringify({ taskIdentityPresent, namespaceState, snapshot, hostGroup }, null, 2),
  );
  expect(taskIdentityPresent).toBe(false);
  expect(snapshot.namespaceInitIdentityPresent).toBe(false);
  expect(snapshot.namespaceMembers).toEqual([]);
  expect(namespaceState).toBe("released");
  expect(hostGroup.members).toEqual([]);
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

function observedToolMessages(userText: string) {
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
    return results.length ? [results] : [];
  });
}

function observedToolReplies(userText: string) {
  return observedToolMessages(userText).map((messages) =>
    messages.map((message) => message.tool_call_id),
  );
}

async function newThread() {
  await page
    .getByRole("link", { name: "新建对话" })
    .or(page.getByRole("button", { name: "新建对话" }))
    .first()
    .click();
  await uiExpect(composer()).toBeVisible({ timeout: 20_000 });
}

productDescribe("product path tool request helper", () => {
  it("ignores restored history and approves only the current turn before waiting for its result", async () => {
    await mkdir(outputDirectory, { recursive: true });
    const fixtureBrowser = await chromium.launch({
      channel: process.env["HIMAWARI_PRODUCT_PATH_BROWSER_CHANNEL"] ?? "chrome",
    });
    const fixtureContext = await fixtureBrowser.newContext();
    await fixtureContext.tracing.start({ screenshots: true, snapshots: true });
    page = await fixtureContext.newPage();
    let status = "failed";
    try {
      await page.setContent(`
        <div class="chat-turn">
          <article class="thread-message-owner"><pre>请写入 hello.txt</pre></article>
          <article><p>工具返回：已有 notes 结果</p><button id="old-approval">允许这一次</button></article>
        </div>
        <div class="chat-turn">
          <article class="thread-message-owner"><pre>请读取 missing.txt</pre></article>
          <article><p id="history-result">…</p></article>
        </div>
        <form><textarea name="message" placeholder="有什么想交给 Himawari？"></textarea><button>发送</button></form>
      `);
      await page.locator("form").evaluate((form) => {
        const document = form.ownerDocument;
        const input = document.querySelector("textarea");
        const historicalResult = document.getElementById("history-result");
        const oldApproval = document.getElementById("old-approval");
        if (!input || !historicalResult || !oldApproval) throw new Error("HELPER_FIXTURE_MISSING");
        oldApproval.addEventListener("click", () => {
          oldApproval.dataset["approved"] = "true";
        });
        form.addEventListener("submit", (event: { preventDefault(): void }) => {
          event.preventDefault();
          const turn = document.createElement("div");
          turn.className = "chat-turn";
          turn.id = "current-turn";
          const owner = document.createElement("article");
          owner.className = "thread-message-owner";
          const userText = document.createElement("pre");
          userText.textContent = input.value;
          owner.append(userText);
          const assistant = document.createElement("article");
          const answer = document.createElement("p");
          answer.id = "current-result";
          const allow = document.createElement("button");
          allow.textContent = "允许这一次";
          allow.addEventListener("click", () => {
            turn.dataset["approved"] = "true";
            allow.remove();
          });
          assistant.append(allow, answer);
          turn.append(owner, assistant);
          form.before(turn);
          historicalResult.textContent = "工具返回：恢复的 missing 结果";
        });
      });
      let completed = false;
      const completion = sendToolRequest("请写入 hello.txt").then((answer) => {
        completed = true;
        return answer;
      });
      const first = await Promise.race([
        completion.then(() => "completed"),
        uiExpect(page.locator("#current-turn"))
          .toHaveAttribute("data-approved", "true")
          .then(() => "approved"),
      ]);
      expect(first).toBe("approved");
      expect(completed).toBe(false);
      await uiExpect(page.locator("#old-approval")).not.toHaveAttribute("data-approved", "true");
      await uiExpect(page.locator("#history-result")).toHaveText("工具返回：恢复的 missing 结果");
      await uiExpect(page.locator("#current-result")).toBeEmpty();
      await page.locator("#current-result").evaluate((element) => {
        element.textContent = "工具返回：本次写入结果";
      });
      await uiExpect(await completion).toHaveText("工具返回：本次写入结果");
      await uiExpect(toolAnswers()).toHaveCount(3);
      status = "passed";
    } finally {
      await writeFile(
        path.join(outputDirectory, "helper-scope-readback.json"),
        JSON.stringify(
          {
            status,
            ...(await page.locator("body").evaluate((body) => {
              const document = body.ownerDocument;
              return {
                oldApprovalClicked:
                  document.getElementById("old-approval")?.dataset["approved"] === "true",
                currentApprovalClicked:
                  document.getElementById("current-turn")?.dataset["approved"] === "true",
                currentResult: document.getElementById("current-result")?.textContent,
                historicalResult: document.getElementById("history-result")?.textContent,
              };
            })),
          },
          null,
          2,
        ),
      );
      await page.screenshot({
        path: path.join(outputDirectory, "helper-scope.png"),
        fullPage: true,
      });
      await fixtureContext.tracing.stop({
        path: path.join(outputDirectory, "helper-scope-trace.zip"),
      });
      await fixtureBrowser.close();
    }
  }, 30_000);
});

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
        ...(process.env["HIMAWARI_TEST_SOURCE_ROOT"]
          ? { sourceRoot: process.env["HIMAWARI_TEST_SOURCE_ROOT"] }
          : {}),
        timing: process.env["HIMAWARI_TEST_TIMING_DIAGNOSTICS"] === "1",
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

    it.each([false, true])(
      "handles a preparation transport failure across paired restart (legacy=%s)",
      async (legacy) => {
        const name = legacy ? "32-legacy-preparation-upgrade" : "31-preparation-transport-recovery";
        const original = { installation, browser, context, page };
        await installation.stop();
        if (legacy) {
          const artifact = process.env["HIMAWARI_TEST_ARTIFACT"];
          const contextFile = process.env["HIMAWARI_TEST_CONTEXT"];
          if (!artifact || !contextFile) throw new Error("PRODUCT_PATH_REQUIRES_ARTIFACT");
          installation = await installProductPath({
            artifact,
            context: contextFile,
            logDirectory: path.join(outputDirectory, "legacy-service-logs"),
          });
          installation.setModelScript(script);
          await writeFile(path.join(installation.workspace, "notes.txt"), NOTE);
        }
        await installation.setRunDeadline(90_000);
        await installation.start();
        if (legacy) {
          browser = await chromium.launch({
            channel: process.env["HIMAWARI_PRODUCT_PATH_BROWSER_CHANNEL"] ?? "chrome",
            args: [
              `--host-resolver-rules=MAP ${publicHost}:443 127.0.0.1:${installation.frontPort}`,
            ],
          });
          context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "zh-CN" });
          await context.tracing.start({ screenshots: true, snapshots: true });
          page = await context.newPage();
          await page.goto(`${installation.origin}/`);
          await page.getByRole("button", { name: "登录 Himawari" }).click();
          await uiExpect(composer()).toBeVisible({ timeout: 30_000 });
        } else await page.reload();
        try {
          await scenario(name, async () => {
            await newThread();
            const before = new Set(executionReadback().map((record) => record.jobId));
            const text = "准备传输失败验证：请读取 notes.txt";
            await installation.armPreparationTransportFailure(legacy);
            await send(text);
            const allow = page.getByRole("button", { name: "允许这一次" });
            await uiExpect
              .poll(
                async () =>
                  (await allow.count()) > 0 ||
                  (await installation.preparationTransportFailure()) !== null,
                { timeout: 60_000 },
              )
              .toBe(true);
            if ((await allow.count()) > 0) await allow.first().click();
            await uiExpect
              .poll(() => installation.preparationTransportFailure(), { timeout: 60_000 })
              .not.toBeNull();
            const fault = await installation.preparationTransportFailure();
            await uiExpect
              .poll(() => executionReadback().filter((record) => !before.has(record.jobId)), {
                timeout: 40_000,
              })
              .toHaveLength(1);
            const job = executionReadback().find((record) => !before.has(record.jobId));
            if (!job) throw new Error("Preparation failure job missing");
            const readback = () => {
              const database = openQualifiedDatabase(installation.databasePath);
              try {
                return {
                  observedAt: new Date().toISOString(),
                  rows: executionReadback().filter((record) => record.jobId === job.jobId),
                  execution: database
                    .prepare(
                      "SELECT preparation_state AS phase, started_at AS startedAt, plan_json AS plan, recovery_json AS recovery FROM sandbox_execution_records WHERE job_id=?",
                    )
                    .get(job.jobId) as {
                    phase: string;
                    startedAt: string | null;
                    plan: string;
                    recovery: string | null;
                  },
                  reservationReleases: database
                    .prepare(
                      "SELECT accepted_at, verification_json FROM sandbox_reservation_release_receipts WHERE job_id=?",
                    )
                    .all(job.jobId),
                  occupancy: database
                    .prepare("SELECT released_at FROM sandbox_workspace_occupancy WHERE job_id=?")
                    .all(job.jobId),
                  controlArtifacts: database
                    .prepare(
                      "SELECT operation_key FROM run_payload_artifacts WHERE run_id=? AND operation_key LIKE 'sandbox-control:%:preparation'",
                    )
                    .all(job.runId),
                  checkpoint: database
                    .prepare(
                      "SELECT phase, terminal_status, diagnostic_code FROM run_coordination_checkpoints WHERE run_id=?",
                    )
                    .get(job.runId),
                  replies: observedToolReplies(text),
                  modelMessages: observedToolMessages(text),
                  quickCheck: database.pragma("quick_check"),
                };
              } finally {
                database.close();
              }
            };
            const snapshots: unknown[] = [];
            const record = async (stage: string) => {
              const snapshot = readback();
              const invocationId = JSON.parse(snapshot.execution.plan).identity.invocationId;
              snapshots.push({
                stage,
                ...snapshot,
                delivery: await installation.sandboxDelivery(job.runId, invocationId),
              });
              await writeFile(
                path.join(outputDirectory, `${name}-readback.json`),
                JSON.stringify({ fault, snapshots }, null, 2),
              );
            };
            try {
              expect(readback().execution).toMatchObject({ phase: "reserved", startedAt: null });
              const plan = JSON.parse(readback().execution.plan);
              const deadline = Date.parse(plan.originalDeadlineAt);
              if (legacy) {
                expect(Object.hasOwn(plan, "preparationProtocol")).toBe(false);
                await uiExpect
                  .poll(() => JSON.parse(readback().execution.recovery ?? "null")?.status, {
                    timeout: 40_000,
                  })
                  .toBe("unresolved");
                expect(readback().controlArtifacts).toEqual([]);
              } else {
                expect(plan.preparationProtocol).toBe("launch-or-block.v2");
                await uiExpect
                  .poll(() => readback().rows[0]?.runStatus, { timeout: 40_000 })
                  .toBe("completed");
                expect(Date.now()).toBeLessThan(deadline);
                const releases = readback().reservationReleases as Array<{
                  accepted_at: string;
                  verification_json: string;
                }>;
                expect(releases).toHaveLength(1);
                expect(JSON.parse(releases[0]?.verification_json ?? "null")).toMatchObject({
                  basis: "preparation_not_authorized",
                });
                expect(readback().occupancy).not.toEqual([]);
                expect(readback().occupancy).not.toContainEqual({ released_at: null });
                expect(readback().controlArtifacts).toHaveLength(1);
                expect(readback().replies.map((ids) => ids.length)).toEqual([1]);
                expect(JSON.stringify(readback().modelMessages)).toContain(
                  "工具未启动：准备阶段失败，已确认清理完成。",
                );
                const delivery = await installation.sandboxDelivery(
                  job.runId,
                  plan.identity.invocationId,
                );
                expect(delivery).toMatchObject({
                  content: {
                    outcome: "failed",
                    errorCode: "SANDBOX_TOOL_NOT_STARTED",
                    outputRef: null,
                  },
                });
                expect(readback().rows[0]).toMatchObject({ runStatus: "completed", intents: 0 });
              }
              const diagnostic = installation.diagnose(job.runId) as {
                diagnostics: Array<{ content: unknown }>;
              };
              expect(diagnostic.diagnostics).toContainEqual(
                expect.objectContaining({
                  content: expect.objectContaining({
                    stage: "prepare",
                    reasonCode: "SANDBOX_PREPARATION_FAILED",
                  }),
                }),
              );
              await record("before-paired-restart");
              await installation.crash();
              await waitForExpiredServiceLease();
              await installation.start();
              await page.reload();
              await record("after-paired-restart");
              if (legacy) {
                await uiExpect
                  .poll(() => Date.now() >= deadline, {
                    timeout: Math.max(1, deadline - Date.now()) + 5_000,
                  })
                  .toBe(true);
                await record("original-run-deadline-reached");
                expect(readback().rows[0]?.runStatus).toBe("reconciling_external_result");
                expect(readback().reservationReleases).toEqual([]);
                expect(readback().occupancy).toContainEqual({ released_at: null });
                expect(readback().controlArtifacts).toEqual([]);
                expect(readback().replies).toEqual([]);
                expect(JSON.stringify(readback().modelMessages)).not.toContain("工具未启动");
                expect(
                  await installation.sandboxDelivery(job.runId, plan.identity.invocationId),
                ).toBeNull();
              } else {
                expect(readback().rows[0]?.runStatus).toBe("completed");
                expect(readback().replies.map((ids) => ids.length)).toEqual([1]);
              }
            } finally {
              await record("final-observation");
              await writeFile(
                path.join(outputDirectory, `${name}-diagnose.json`),
                JSON.stringify(installation.diagnose(job.runId), null, 2),
              );
            }
          });
        } finally {
          await installation.stop();
          if (legacy) {
            await context.tracing.stop({ path: path.join(outputDirectory, "legacy-trace.zip") });
            await browser.close();
            await installation.close();
            ({ installation, browser, context, page } = original);
          } else await installation.setRunDeadline(900_000);
          await installation.start();
          await page.reload();
        }
      },
    );

    it("[R2-D4] releases an accepted preparation after its ACK is lost without starting or replaying the tool", async () => {
      await installation.stop();
      await installation.setRunDeadline(90_000);
      await installation.start();
      await page.reload();
      try {
        await scenario("33-preparation-ack-loss", async () => {
          await newThread();
          const before = new Set(executionReadback().map((record) => record.jobId));
          const text = "准备登记确认丢失验证：请读取 notes.txt";
          const baseline = await readFile(path.join(installation.workspace, "notes.txt"), "utf8");
          await installation.armPreparationAckLoss();
          await send(text);
          const allow = page.getByRole("button", { name: "允许这一次" });
          await uiExpect
            .poll(
              async () =>
                (await allow.count()) > 0 || (await installation.preparationAckLoss()) !== null,
              { timeout: 60_000 },
            )
            .toBe(true);
          if ((await allow.count()) > 0) await allow.first().click();
          await uiExpect
            .poll(() => installation.preparationAckLoss(), { timeout: 40_000 })
            .not.toBeNull();
          const fault = await installation.preparationAckLoss();
          if (!fault) throw new Error("Preparation ACK loss missing");
          const readback = () => {
            const database = openQualifiedDatabase(installation.databasePath);
            try {
              return {
                at: new Date().toISOString(),
                fault,
                rows: executionReadback().filter((row) => row.jobId === fault.jobId),
                execution: database
                  .prepare(
                    "SELECT preparation_state AS phase,started_at AS startedAt,plan_json AS plan,recovery_json AS recovery FROM sandbox_execution_records WHERE job_id=?",
                  )
                  .get(fault.jobId) as {
                  phase: string;
                  startedAt: string | null;
                  plan: string;
                  recovery: string | null;
                },
                reservationReleases: database
                  .prepare(
                    "SELECT accepted_at,verification_json FROM sandbox_reservation_release_receipts WHERE job_id=?",
                  )
                  .all(fault.jobId) as Array<{ accepted_at: string; verification_json: string }>,
                occupancy: database
                  .prepare("SELECT released_at FROM sandbox_workspace_occupancy WHERE job_id=?")
                  .all(fault.jobId),
                controlArtifacts: database
                  .prepare(
                    "SELECT operation_key,payload_ref,content_digest FROM run_payload_artifacts WHERE run_id=(SELECT run_id FROM sandbox_execution_records WHERE job_id=?) AND operation_key LIKE 'sandbox-control:%'",
                  )
                  .all(fault.jobId),
                replies: observedToolReplies(text),
                modelMessages: observedToolMessages(text),
                quickCheck: database.pragma("quick_check"),
              };
            } finally {
              database.close();
            }
          };
          const snapshots: unknown[] = [];
          const record = async (stage: string) => {
            snapshots.push({
              stage,
              ...readback(),
              currentFault: await installation.preparationAckLoss(),
            });
            await writeFile(
              path.join(outputDirectory, "33-preparation-ack-loss-readback.json"),
              JSON.stringify({ snapshots }, null, 2),
            );
          };
          try {
            const accepted = readback();
            expect(accepted.fault.acceptedBeforeAckLoss).toBe(true);
            expect(accepted.execution).toMatchObject({ phase: "reserved", startedAt: null });
            expect(accepted.controlArtifacts).toContainEqual(
              expect.objectContaining({ operation_key: expect.stringMatching(/:preparation$/) }),
            );
            await record("accepted-without-ack");
            await uiExpect
              .poll(() => readback().rows[0]?.runStatus, { timeout: 40_000 })
              .toBe("completed");
            const done = readback();
            const plan = JSON.parse(done.execution.plan);
            expect(plan.preparationProtocol).toBe("launch-or-block.v2");
            expect(Date.now()).toBeLessThan(Date.parse(plan.originalDeadlineAt));
            expect(done.rows).toHaveLength(1);
            expect(executionReadback().filter((row) => !before.has(row.jobId))).toHaveLength(1);
            expect(done.rows[0]).toMatchObject({ runStatus: "completed", intents: 0 });
            expect(done.execution.startedAt).toBeNull();
            expect(done.reservationReleases).toHaveLength(1);
            expect(
              JSON.parse(done.reservationReleases[0]?.verification_json ?? "null"),
            ).toMatchObject({ basis: "preparation_launch_blocked" });
            expect(done.occupancy).not.toEqual([]);
            expect(done.occupancy).not.toContainEqual({ released_at: null });
            expect(done.replies.map((ids) => ids.length)).toEqual([1]);
            expect(JSON.stringify(done.modelMessages)).toContain(
              "工具未启动：准备阶段失败，已确认清理完成。",
            );
            expect((await installation.preparationAckLoss())?.hostForks).toEqual([]);
            expect(await readFile(path.join(installation.workspace, "notes.txt"), "utf8")).toBe(
              baseline,
            );
            await record("released-before-deadline");
            await installation.crash();
            await waitForExpiredServiceLease();
            await installation.start();
            await page.reload();
            expect(readback().reservationReleases).toEqual(done.reservationReleases);
            expect(readback().replies.map((ids) => ids.length)).toEqual([1]);
            expect(readback().execution.startedAt).toBeNull();
            expect((await installation.preparationAckLoss())?.hostForks).toEqual([]);
            await record("after-paired-restart");
          } finally {
            await record("final-observation");
          }
        });
      } finally {
        await installation.stop();
        await installation.setRunDeadline(900_000);
        await installation.start();
        await page.reload();
      }
    });

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

    it("[R2-S1] stops a running tool, releases only with proof, and never revives the cancelled run", async () => {
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
        let linuxTask: { pid: number; starttime: string } | undefined;
        let linuxBefore: Awaited<ReturnType<typeof readLinuxJobProcesses>> | undefined;
        await uiExpect
          .poll(
            async () => {
              if (process.platform === "linux") {
                const snapshot = await readLinuxJobProcesses(host);
                await appendFile(
                  path.join(outputDirectory, "13-stop-running-processes.jsonl"),
                  `${JSON.stringify(snapshot)}\n`,
                );
                const tasks = snapshot.processes.filter(
                  (row) =>
                    row.stable &&
                    row.descendantOfRecordedHost &&
                    row.pidNamespace === host.linuxNamespace?.namespaceId &&
                    row.argv?.length === 2 &&
                    row.argv[0] === "/bin/sleep" &&
                    row.argv[1] === "120",
                );
                const task = tasks[0];
                if (tasks.length !== 1 || !task) return false;
                linuxTask = { pid: task.pid, starttime: task.starttime };
                linuxBefore = snapshot;
                return true;
              }
              return taskProcesses().some(({ command }) => command === "/bin/sleep 120");
            },
            { timeout: 60_000 },
          )
          .toBe(true);
        const shellPid =
          process.platform === "linux"
            ? linuxTask?.pid
            : taskProcesses().find(({ command }) => command === "/bin/sleep 120")?.pid;
        if (!shellPid) throw new Error("STOP_TEST_TASK_MISSING");
        if (process.platform === "linux") {
          if (!linuxTask || !linuxBefore || !host.linuxNamespace)
            throw new Error("STOP_TEST_LINUX_IDENTITY_MISSING");
          expect(linuxBefore.recordedHostPresent).toBe(true);
          expect(linuxBefore.namespaceInitIdentityPresent).toBe(true);
          const init = linuxBefore.namespaceMembers.find(
            (row) => row.pid === host.linuxNamespace?.initPid,
          );
          expect(init).toMatchObject({
            stable: true,
            descendantOfRecordedHost: true,
            starttime: host.linuxNamespace.initStartTicks,
            pidNamespace: host.linuxNamespace.namespaceId,
          });
          expect(init?.namespacePids?.at(-1)).toBe(1);
          expect(await linuxProcessIdentityPresent(linuxTask)).toBe(true);
          await writeFile(
            path.join(outputDirectory, "13-stop-running-processes-before.json"),
            JSON.stringify({ taskIdentity: linuxTask, snapshot: linuxBefore }, null, 2),
          );
        }
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
        let stopEvidenceFailure: AggregateError | undefined;
        try {
          await page.getByRole("button", { name: "停止", exact: true }).click();
          await uiExpect.poll(() => readback().hostAlive, { timeout: 40_000 }).toBe(false);
          await uiExpect
            .poll(() => readback().rows[0], { timeout: 40_000 })
            .toMatchObject({
              released: 1,
              runStatus: "cancelled",
              intents: 0,
              result: expect.any(String),
            });
          const stopped = readback();
          expect(stopped.rows[0]?.result).toBe("unknown");
          expect(stopped.rows[0]?.reasonCode).toBe("SANDBOX_EXIT_UNKNOWN");
          await writeFile(
            path.join(outputDirectory, "13-stop-running-baseline.json"),
            JSON.stringify(stopped, null, 2),
          );
          if (process.platform === "linux") {
            if (!linuxTask || !host.linuxNamespace)
              throw new Error("STOP_TEST_LINUX_IDENTITY_MISSING");
            const snapshot = await readLinuxJobProcesses(host);
            const taskIdentityPresent = await linuxProcessIdentityPresent(linuxTask);
            const namespaceState = await readLinuxNamespaceState(host.linuxNamespace);
            await writeFile(
              path.join(outputDirectory, "13-stop-running-processes-stopped.json"),
              JSON.stringify({ taskIdentityPresent, namespaceState, snapshot }, null, 2),
            );
            expect(taskIdentityPresent).toBe(false);
            expect(snapshot.namespaceInitIdentityPresent).toBe(false);
            expect(snapshot.namespaceMembers).toEqual([]);
            expect(namespaceState).toBe("released");
          }
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
          const captures = await Promise.allSettled([
            (async () => {
              await writeFile(
                path.join(outputDirectory, "13-stop-running-after.json"),
                JSON.stringify(readback(), null, 2),
              );
            })(),
            (async () => {
              if (process.platform === "linux")
                await writeFile(
                  path.join(outputDirectory, "13-stop-running-processes-after.json"),
                  JSON.stringify(await readLinuxJobProcesses(host), null, 2),
                );
            })(),
          ]);
          const errors = captures.flatMap((capture) =>
            capture.status === "rejected" ? [capture.reason] : [],
          );
          if (errors.length > 0) {
            stopEvidenceFailure = new AggregateError(errors, "STOP_TEST_EVIDENCE_CAPTURE_FAILED");
            console.error(stopEvidenceFailure);
          }
        }
        if (stopEvidenceFailure) throw stopEvidenceFailure;
      });
    });

    it("records process-group release for a detached child holding foreground output", async () => {
      await scenario("33-detached-output", async () => {
        await newThread();
        const text = "脱离进程组输出管道验证";
        const marker = `B3_DETACHED_OUTPUT_${path.basename(path.dirname(installation.workspace))}`;
        expect(marker).toMatch(/^[A-Za-z0-9_-]+$/);
        const detachedProgram = [
          'POSIX::setsid() >= 0 or die "setsid failed"',
          "$|=1",
          'print "b3-detached-output\\n"',
          "sleep 120",
        ].join("; ");
        const command = `printf 'b3-before-background\\n'; /usr/bin/perl -MPOSIX -e '${detachedProgram}' '${marker}' & while [ ! -f b3-parent-release ]; do /bin/sleep 0.05; done; printf 'b3-parent-exited\\n'`;
        let parentReleasedAt: number | undefined;
        let modelReceivedAt: number | undefined;
        installation.setModelScript((input) => {
          if (input.lastUserText.includes(text) && input.toolResults.length > 0)
            modelReceivedAt ??= Date.now();
          return input.hasTools &&
            input.lastUserText.includes(text) &&
            input.toolResults.length === 0
            ? { kind: "tool", name: "bash", arguments: { command } }
            : script(input);
        });
        const startedAt = Date.now();
        const before = new Set(executionReadback().map((record) => record.jobId));
        let jobId: string | undefined;
        let child:
          | {
              pid: number;
              ppid: number;
              pgid: number;
              marker: string;
              stdoutDescriptor: string;
            }
          | undefined;
        let hostIdentity:
          | { processId: number; taskProcessGroup: { processGroupId: number } }
          | undefined;
        const processRows = () =>
          execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat=,command="], {
            encoding: "utf8",
          })
            .split("\n")
            .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
            .flatMap((match) =>
              match
                ? [
                    {
                      pid: Number(match[1]),
                      ppid: Number(match[2]),
                      pgid: Number(match[3]),
                      state: match[4],
                      command: match[5] ?? "",
                    },
                  ]
                : [],
            );
        const processRow = (pid: number) => processRows().find((row) => row.pid === pid) ?? null;
        const readback = () => {
          const database = openQualifiedDatabase(installation.databasePath);
          try {
            const receipts = database
              .prepare(
                "SELECT accepted_at AS acceptedAt,verification_json AS verification,json_extract(verification_json,'$.facts.resource.cleanup') AS cleanup FROM sandbox_release_receipts WHERE job_id=?",
              )
              .all(jobId ?? "");
            const processes = processRows();
            const observedChild = child;
            const observedHost = hostIdentity;
            return {
              observedAt: new Date().toISOString(),
              elapsedMs: Date.now() - startedAt,
              parentReleasedAt,
              modelReceivedAt,
              modelResultDelayMs:
                parentReleasedAt !== undefined && modelReceivedAt !== undefined
                  ? modelReceivedAt - parentReleasedAt
                  : null,
              child,
              childProcess: observedChild
                ? (processes.find((row) => row.pid === observedChild.pid) ?? null)
                : null,
              hostProcess: observedHost
                ? (processes.find((row) => row.pid === observedHost.processId) ?? null)
                : null,
              originalGroupMembers: observedHost
                ? processes.filter(
                    (row) => row.pgid === observedHost.taskProcessGroup.processGroupId,
                  )
                : [],
              rows: executionReadback().filter((record) => record.jobId === jobId),
              execution: jobId
                ? database
                    .prepare(
                      "SELECT plan_json AS plan,facts_json AS facts,started_at AS startedAt FROM sandbox_execution_records WHERE job_id=?",
                    )
                    .get(jobId)
                : null,
              receipts,
              occupancy: database
                .prepare(
                  "SELECT released_at AS releasedAt FROM sandbox_workspace_occupancy WHERE job_id=?",
                )
                .all(jobId ?? ""),
              modelMessages: observedToolMessages(text),
              modelReplies: observedToolReplies(text),
            };
          } finally {
            database.close();
          }
        };
        const save = async (stage: string, observation = readback()) => {
          await writeFile(
            path.join(outputDirectory, `33-detached-output-${stage}.json`),
            JSON.stringify(observation, null, 2),
          );
          return observation;
        };
        try {
          await beginToolRequest(text);
          await uiExpect
            .poll(() => executionReadback().filter((record) => !before.has(record.jobId)), {
              timeout: 60_000,
            })
            .toHaveLength(1);
          jobId = executionReadback().find((record) => !before.has(record.jobId))?.jobId;
          if (!jobId) throw new Error("B3_JOB_MISSING");
          await uiExpect
            .poll(
              () => {
                const candidate = processRows().find(
                  (row) =>
                    row.pgid === row.pid &&
                    row.command.includes(marker) &&
                    /^perl(?:\d+(?:\.\d+)*)?$/.test(
                      path
                        .basename(
                          execFileSync("/bin/ps", ["-p", String(row.pid), "-o", "comm="], {
                            encoding: "utf8",
                          }).trim(),
                        )
                        .toLowerCase(),
                    ),
                );
                if (candidate)
                  child = {
                    pid: candidate.pid,
                    ppid: candidate.ppid,
                    pgid: candidate.pgid,
                    marker,
                    stdoutDescriptor: execFileSync(
                      "/usr/sbin/lsof",
                      ["-a", "-p", String(candidate.pid), "-d", "1", "-F", "pftn"],
                      { encoding: "utf8" },
                    ),
                  };
                return child?.marker;
              },
              { timeout: 30_000 },
            )
            .toBe(marker);
          if (!child) throw new Error("B3_CHILD_MISSING");
          expect(child.pgid).toBe(child.pid);
          expect(child.stdoutDescriptor).toMatch(/(?:^|\n)t(?:PIPE|FIFO|unix)(?:\n|$)/);
          expect(processRow(child.pid)?.command).toContain(marker);
          await uiExpect
            .poll(async () => (await readJobHostStarts()).some((entry) => entry?.jobId === jobId), {
              timeout: 30_000,
            })
            .toBe(true);
          const host = (await readJobHostStarts()).find((entry) => entry?.jobId === jobId);
          if (!host) throw new Error("B3_HOST_MISSING");
          hostIdentity = host;
          expect(child.pgid).not.toBe(host.taskProcessGroup.processGroupId);
          await writeFile(
            path.join(outputDirectory, "33-detached-output-start.json"),
            JSON.stringify({ host, command, ...readback() }, null, 2),
          );
          parentReleasedAt = Date.now();
          await writeFile(path.join(installation.workspace, "b3-parent-release"), "exit\n");
          let released: ReturnType<typeof readback> | undefined;
          await uiExpect
            .poll(
              () => {
                const observation = readback();
                if (observation.receipts.length > 0) released ??= observation;
                return released !== undefined;
              },
              { timeout: 10_000 },
            )
            .toBe(true);
          if (!released) throw new Error("B3_RELEASE_MISSING");
          await save("release-accepted", released);
          expect(released.receipts).toEqual([
            expect.objectContaining({ cleanup: "process_group_gone" }),
          ]);
          expect(released.hostProcess).toBeNull();
          expect(released.originalGroupMembers).toEqual([]);
          expect(released.childProcess?.command).toContain(marker);
          expect(released.occupancy).toEqual([
            expect.objectContaining({ releasedAt: expect.any(String) }),
          ]);
          await uiExpect
            .poll(() => readback().rows[0], { timeout: 10_000 })
            .toMatchObject({
              runStatus: "completed",
              result: "result",
              reasonCode: null,
              definiteOperations: 1,
              intents: 1,
            });
          expect(modelReceivedAt).toBeDefined();
          expect((modelReceivedAt ?? Infinity) - parentReleasedAt).toBeLessThan(10_000);
          const modelOutput = observedToolMessages(text)
            .flat()
            .map((message) => message.content);
          expect(modelOutput).toHaveLength(1);
          const result = JSON.parse(String(modelOutput[0]));
          expect(result).toMatchObject({ commandExitCode: 0, isError: false });
          expect(JSON.stringify(result.content)).toContain("b3-before-background");
          expect(JSON.stringify(result.content)).toContain("b3-detached-output");
          expect(JSON.stringify(result.content)).toContain("b3-parent-exited");
          expect(JSON.stringify(result.content)).toContain(
            "仍有后台程序占用这次命令的输出，它之后的输出不会显示在这次结果里；如果它继续往这里写输出，会被系统结束。需要长期运行的程序，请把输出重定向到文件，例如 `npm run dev > dev.log 2>&1 &`。",
          );
          expect(observedToolReplies(text).map((ids) => ids.length)).toEqual([1]);
          expect(
            (await readJobHostStarts()).filter((entry) => entry?.jobId === jobId),
          ).toHaveLength(1);
          await save("model-completed");
          const jobsRoot = path.join(path.dirname(installation.stateRoot), "jobs");
          const finalRecords = [];
          for (const name of (await readdir(jobsRoot)).filter((name) =>
            name.startsWith("control-"),
          )) {
            const encoded = await readFile(path.join(jobsRoot, name, "final.json"), "utf8");
            const final = JSON.parse(JSON.parse(encoded).body);
            if (final.jobId === jobId) finalRecords.push(final);
          }
          await writeFile(
            path.join(outputDirectory, "33-detached-output-host-final.json"),
            JSON.stringify(finalRecords, null, 2),
          );
          expect(finalRecords).toHaveLength(1);
          expect(finalRecords[0]).toMatchObject({ stdioClosed: true });
          await uiExpect(page.getByText(/停止未经严格确认/).first()).toBeVisible({
            timeout: 10_000,
          });
          await page
            .getByText(/停止未经严格确认/)
            .first()
            .scrollIntoViewIfNeeded();
          await writeFile(
            path.join(outputDirectory, "33-detached-output-after-release-aria.txt"),
            await page.locator("body").ariaSnapshot(),
          );
          await page.screenshot({
            path: path.join(outputDirectory, "33-detached-output-after-release.png"),
            fullPage: true,
          });
        } finally {
          await save("before-fixture-cleanup");
          await writeFile(path.join(installation.workspace, "b3-parent-release"), "exit\n");
          const remaining = child ? processRow(child.pid) : null;
          if (child && remaining?.pgid === child.pgid && remaining.command.includes(marker)) {
            process.kill(child.pid, "SIGKILL");
            const pid = child.pid;
            await uiExpect.poll(() => processRow(pid), { timeout: 10_000 }).toBeNull();
          }
          await save("after-fixture-cleanup");
          installation.setModelScript(script);
        }
      });
    });

    it.each(["worker", "recovery", "run"] as const)(
      "[R2-S3] terminates a running tool at its original deadline with authenticated cleanup: %s",
      async (mode) => {
        const name = `30-original-deadline-${mode}`;
        const runExpiry = mode === "run";
        if (runExpiry) {
          await installation.stop();
          await installation.setRunDeadline(90_000);
          await installation.start();
          await page.reload();
        }
        try {
          await scenario(name, async () => {
            await newThread();
            const before = new Set(executionReadback().map((record) => record.jobId));
            const text = `原执行期限验证-${mode}`;
            if (mode === "recovery") await installation.armFinishGate("after-end");
            await beginToolRequest(text);
            await uiExpect
              .poll(() => executionReadback().filter((record) => !before.has(record.jobId)), {
                timeout: 60_000,
              })
              .toHaveLength(1);
            const job = executionReadback().find((record) => !before.has(record.jobId));
            if (!job) throw new Error("DEADLINE_TEST_JOB_MISSING");
            await uiExpect
              .poll(
                async () => (await readJobHostStarts()).find((entry) => entry?.jobId === job.jobId),
                {
                  timeout: 60_000,
                },
              )
              .toBeTruthy();
            const host = (await readJobHostStarts()).find((entry) => entry?.jobId === job.jobId);
            if (!host) throw new Error("DEADLINE_TEST_HOST_MISSING");
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
            const readback = () => {
              const database = openQualifiedDatabase(installation.databasePath);
              try {
                return {
                  observedAt: new Date().toISOString(),
                  rows: executionReadback().filter((record) => record.jobId === job.jobId),
                  execution: database
                    .prepare(
                      "SELECT plan_json AS plan, started_at AS startedAt, facts_json AS facts FROM sandbox_execution_records WHERE job_id=?",
                    )
                    .get(job.jobId) as { plan: string; startedAt: string; facts: string },
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
                  replies: observedToolReplies(text),
                  modelMessages: observedToolMessages(text),
                };
              } finally {
                database.close();
              }
            };
            let linuxTask: Awaited<ReturnType<typeof waitForRunningLinuxTask>> | undefined;
            if (process.platform === "linux") {
              linuxTask = await waitForRunningLinuxTask(host, "600", name);
            } else {
              await uiExpect
                .poll(
                  () =>
                    execFileSync("/bin/ps", ["-axo", "pgid=,command="], { encoding: "utf8" })
                      .split("\n")
                      .some(
                        (line) =>
                          line.trim() === `${host.taskProcessGroup.processGroupId} /bin/sleep 600`,
                      ),
                  { timeout: 60_000 },
                )
                .toBe(true);
            }
            const running = readback();
            const plan = JSON.parse(running.execution.plan) as {
              originalDeadlineAt: string;
              effectiveDeadlineAt: string;
            };
            expect(running.rows[0]).toMatchObject({
              released: 0,
              runStatus: "running",
              intents: 0,
            });
            expect(running.hostAlive).toBe(true);
            const remaining = Date.parse(plan.effectiveDeadlineAt) - Date.now();
            expect(remaining).toBeGreaterThan(runExpiry ? 45_000 : 240_000);
            expect(remaining).toBeLessThanOrEqual(runExpiry ? 90_000 : 300_000);
            if (runExpiry) expect(plan.effectiveDeadlineAt).toBe(plan.originalDeadlineAt);
            await writeFile(
              path.join(outputDirectory, `${name}-before.json`),
              JSON.stringify({ host, ...running }, null, 2),
            );
            try {
              if (mode === "recovery") {
                await uiExpect
                  .poll(() => installation.finishGateEntered(), { timeout: remaining + 40_000 })
                  .not.toBeNull();
                await uiExpect.poll(() => readback().rows[0]?.streamEnds).toBe(1);
                await installation.crash();
                await installation.releaseFinishGate();
                await waitForExpiredServiceLease();
                await installation.start();
                await page.reload();
              }
              await uiExpect
                .poll(() => readback().hostAlive, { timeout: remaining + 40_000 })
                .toBe(false);
              const stoppedAt = Date.now();
              expect(stoppedAt).toBeGreaterThanOrEqual(Date.parse(plan.effectiveDeadlineAt));
              await uiExpect.poll(() => readback().rows[0]?.released, { timeout: 40_000 }).toBe(1);
              await uiExpect
                .poll(
                  () =>
                    ["completed", "failed", "cancelled"].includes(
                      readback().rows[0]?.runStatus ?? "",
                    ),
                  { timeout: 40_000 },
                )
                .toBe(true);
              const ended = readback();
              if (runExpiry) {
                expect(ended.rows[0]).toMatchObject({ runStatus: "failed", intents: 0 });
                expect(observedToolReplies(text)).toEqual([]);
                await uiExpect(
                  page.getByText("本轮执行期限已到，清理已完成，本轮已结束", { exact: true }),
                ).toBeVisible();
              } else {
                expect(ended.rows[0]).toMatchObject({
                  runStatus: "completed",
                  result: "error",
                  reasonCode: "SANDBOX_TOOL_DEADLINE_EXCEEDED",
                  definiteOperations: 1,
                  intents: 1,
                });
                expect(observedToolReplies(text).map((ids) => ids.length)).toEqual([1]);
                const deadlineMessage =
                  "SANDBOX_TOOL_DEADLINE_EXCEEDED：工具运行超过期限，已被终止并完成清理，没有重新执行。它在终止前可能已经修改了工作区，部分输出不可用；请先检查当前状态再决定下一步。";
                expect(JSON.stringify(observedToolMessages(text))).toContain(deadlineMessage);
                const process = page.locator(".turn-process").last();
                if ((await process.getAttribute("open")) === null)
                  await process.locator(":scope > summary").click();
                await uiExpect(
                  process
                    .locator(".step-status")
                    .filter({ hasText: "工具执行超时，已终止并完成清理" }),
                ).toBeVisible();
              }
              expect(ended.groupAlive).toBe(false);
              if (process.platform === "linux") {
                if (!linuxTask) throw new Error("DEADLINE_TEST_LINUX_TASK_MISSING");
                await assertLinuxTaskReleased(host, linuxTask, name);
              }
              expect(ended.execution.plan).toBe(running.execution.plan);
              expect(ended.receipts).toHaveLength(1);
              expect(ended.occupancy.length).toBeGreaterThan(0);
              for (const entry of ended.occupancy)
                expect(entry).toMatchObject({ releasedAt: expect.any(String) });
              expect(
                (await readJobHostStarts()).filter((entry) => entry?.jobId === job.jobId),
              ).toHaveLength(1);
              if (!runExpiry)
                await uiExpect(page.getByText(/结果未确认|结果仍未确认/)).toHaveCount(0);
              expect(JSON.stringify(observedToolMessages(text))).not.toContain("deadline-late");
              expect(JSON.stringify(observedToolMessages(text))).not.toContain("deadline-running");
            } finally {
              await writeFile(
                path.join(outputDirectory, `${name}-after.json`),
                JSON.stringify(readback(), null, 2),
              );
            }
          });
        } finally {
          if (runExpiry) {
            await installation.stop();
            await installation.setRunDeadline(900_000);
            await installation.start();
            await page.reload();
          }
        }
      },
    );

    it("[R2-S2] reclaims an interrupted running tool after restarting the test services without replay", async () => {
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
        let linuxTask: Awaited<ReturnType<typeof waitForRunningLinuxTask>> | undefined;
        if (process.platform === "linux") {
          linuxTask = await waitForRunningLinuxTask(host, "120", "14-restart-running");
        } else {
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
        }
        await writeFile(
          path.join(outputDirectory, "14-restart-running-before.json"),
          JSON.stringify({ host, rows: executionReadback() }, null, 2),
        );
        expect(executionReadback().filter((record) => !before.has(record.jobId))).toEqual([
          expect.objectContaining({ result: null, released: 0, intents: 0 }),
        ]);
        expect(observedToolReplies(text)).toEqual([]);
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
          if (process.platform === "linux") {
            if (!linuxTask) throw new Error("RESTART_TEST_LINUX_TASK_MISSING");
            await assertLinuxTaskReleased(host, linuxTask, "14-restart-running");
          }
          expect(
            (await readJobHostStarts()).filter((entry) => entry?.jobId === job.jobId),
          ).toHaveLength(1);
          await uiExpect
            .poll(() => rows()[0], { timeout: 40_000 })
            .toMatchObject({
              runStatus: "completed",
              result: "error",
              reasonCode: "SANDBOX_TOOL_RESULT_LOST",
              released: 1,
              definiteOperations: 1,
              streamEnds: 0,
              intents: 1,
            });
          const expectedMessage =
            "SANDBOX_TOOL_RESULT_LOST：工具已运行并结束，但输出和退出结果在服务重启时丢失；没有重新执行。它可能已经产生了效果，是否重做请先确认。";
          const assertLostReply = () => {
            const messages = observedToolMessages(text);
            expect(messages.map((batch) => batch.map((message) => message.content))).toEqual([
              [expectedMessage],
            ]);
            expect(observedToolReplies(text).map((ids) => ids.length)).toEqual([1]);
          };
          assertLostReply();
          await uiExpect(toolAnswers().filter({ hasText: expectedMessage })).toHaveCount(1, {
            timeout: 30_000,
          });
          const settled = rows();
          await installation.stop();
          await installation.start();
          await page.reload();
          expect(rows()).toEqual(settled);
          assertLostReply();
          expect(
            (await readJobHostStarts()).filter((entry) => entry?.jobId === job.jobId),
          ).toHaveLength(1);
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
      "preserves original foreground output through host cleanup: restart=%s",
      async (restart) => {
        const name = `15-restart-cleanup-${restart}`;
        await scenario(name, async () => {
          await newThread();
          const before = new Set(executionReadback().map((record) => record.jobId));
          const original = `原始工具内容-${restart}-${crypto.randomUUID()}`;
          const changed = `修改后的文件-${crypto.randomUUID()}`;
          const source = path.join(installation.workspace, "durability.txt");
          await writeFile(source, original);
          await installation.armFinishGate();
          const text = `收尾重启 ${restart}：请读取 durability.txt`;
          await beginToolRequest(text);
          await uiExpect
            .poll(() => installation.finishGateEntered(), { timeout: 60_000 })
            .not.toBeNull();
          const entered = await installation.finishGateEntered();
          const output = await installation.finishGateOutput();
          expect(output).toContain(original);
          const rows = () => executionReadback().filter((record) => !before.has(record.jobId));
          await uiExpect.poll(() => rows()[0]?.streamEnds).toBe(1);
          await writeFile(
            path.join(outputDirectory, `${name}-before.json`),
            JSON.stringify(
              { entered, output, original, changed, source, rows: executionReadback() },
              null,
              2,
            ),
          );
          if (restart) await installation.crash();
          await writeFile(source, changed);
          await installation.releaseFinishGate();
          if (restart) {
            await waitForExpiredServiceLease();
            await installation.start();
            await page.reload();
          }
          try {
            await uiExpect
              .poll(() => rows()[0], { timeout: 90_000 })
              .toMatchObject({
                runStatus: "completed",
                released: 1,
                intents: 1,
                definiteOperations: 1,
                result: "result",
              });
            expect(rows()).toHaveLength(1);
            await uiExpect(toolAnswers().filter({ hasText: original })).toHaveCount(1, {
              timeout: 10_000,
            });
            await uiExpect(toolAnswers().filter({ hasText: changed })).toHaveCount(0);
            await uiExpect(page.getByText(/结果仍未确认/)).toHaveCount(0);
            expect(
              (await readJobHostStarts()).filter((host) => host?.jobId === rows()[0]?.jobId),
            ).toHaveLength(1);
            expect(observedToolReplies(text).map((ids) => ids.length)).toEqual([1]);
          } finally {
            await writeFile(
              path.join(outputDirectory, `${name}-after.json`),
              JSON.stringify(
                {
                  rows: rows(),
                  sourceContent: await readFile(source, "utf8"),
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

    it("rejects contradictory host completion instead of recovering the earlier success", async () => {
      const name = "20-contradictory-completion";
      await scenario(name, async () => {
        await newThread();
        const before = new Set(executionReadback().map((record) => record.jobId));
        const rows = () => executionReadback().filter((record) => !before.has(record.jobId));
        const original = `矛盾退出验证-${crypto.randomUUID()}`;
        await writeFile(path.join(installation.workspace, "durability.txt"), original);
        await installation.armFinishGate("contradict-result");
        const text = "矛盾退出事实：请读取 durability.txt";
        await beginToolRequest(text);
        await uiExpect
          .poll(() => installation.finishGateEntered(), { timeout: 60_000 })
          .not.toBeNull();
        await uiExpect.poll(() => rows()[0]?.streamEnds).toBe(1);
        await writeFile(
          path.join(outputDirectory, `${name}-before.json`),
          JSON.stringify(
            { rows: rows(), original, gate: await installation.finishGateEntered() },
            null,
            2,
          ),
        );
        await installation.releaseFinishGate();
        try {
          await uiExpect
            .poll(() => rows()[0], { timeout: 90_000 })
            .toMatchObject({
              runStatus: "completed",
              released: 1,
              definiteOperations: 1,
              intents: 1,
            });
          expect(rows()[0]).toMatchObject({
            result: "error",
            reasonCode: "SANDBOX_HOST_COMPLETION_CONTRADICTED",
          });
          const expectedMessage =
            "SANDBOX_HOST_COMPLETION_CONTRADICTED：执行宿主报告的退出结果前后不一致，本次结果按失败处理，没有重新执行。工具可能已经运行，是否重做请先确认。";
          const assertModelFailure = () => {
            const messages = observedToolMessages(text);
            expect(messages.map((batch) => batch.map((message) => message.content))).toEqual([
              [expectedMessage],
            ]);
            expect(JSON.stringify(messages)).not.toContain(original);
            expect(
              messages
                .flat()
                .map((message) => message.content)
                .join("\n"),
            ).not.toMatch(/"isError"\s*:\s*false/);
          };
          assertModelFailure();
          expect(observedToolReplies(text).map((ids) => ids.length)).toEqual([1]);
          await installation.stop();
          await installation.start();
          await page.reload();
          expect(rows()[0]).toMatchObject({
            runStatus: "completed",
            result: "error",
            reasonCode: "SANDBOX_HOST_COMPLETION_CONTRADICTED",
            definiteOperations: 1,
            intents: 1,
          });
          assertModelFailure();
          expect(observedToolReplies(text).map((ids) => ids.length)).toEqual([1]);
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
                modelMessages: observedToolMessages(text),
              },
              null,
              2,
            ),
          );
        }
      });
    });

    it("[R2-S2] keeps an offline Worker result pending until paired service restart settles LOST", async () => {
      const name = "19-worker-offline-recovery";
      await scenario(name, async () => {
        await newThread();
        const before = new Set(executionReadback().map((record) => record.jobId));
        const rows = () => executionReadback().filter((record) => !before.has(record.jobId));
        const original = `离线恢复验证-${crypto.randomUUID()}`;
        await writeFile(path.join(installation.workspace, "durability.txt"), original);
        await installation.armFinishGate("before-end");
        const text = "Worker 离线后成对恢复：请读取 durability.txt";
        await beginToolRequest(text);
        await uiExpect
          .poll(() => installation.finishGateEntered(), { timeout: 60_000 })
          .not.toBeNull();
        expect(rows()[0]).toMatchObject({ result: null, streamEnds: 0, intents: 0 });
        await installation.crashWorker();
        await installation.releaseFinishGate();
        try {
          await uiExpect
            .poll(() => rows()[0], { timeout: 40_000 })
            .toMatchObject({
              runStatus: "reconciling_external_result",
              released: 1,
              result: null,
              streamEnds: 0,
              definiteOperations: 0,
              intents: 0,
            });
          const http = await page.evaluate(async () => {
            const response = await fetch("/api/control-center/v1/config");
            return { status: response.status, body: await response.json() };
          });
          await writeFile(
            path.join(outputDirectory, `${name}-before.json`),
            JSON.stringify(
              {
                rows: rows(),
                original,
                http,
                modelMessages: observedToolMessages(text),
              },
              null,
              2,
            ),
          );
          expect(http).toEqual({ status: 503, body: { error: "SERVICE_NOT_READY" } });
          expect(rows()[0]).toMatchObject({
            runStatus: "reconciling_external_result",
            result: null,
            intents: 0,
          });
          expect(observedToolReplies(text)).toEqual([]);
          await installation.stop();
          await installation.start();
          await page.reload();
          await uiExpect
            .poll(() => rows()[0], { timeout: 90_000 })
            .toMatchObject({
              runStatus: "completed",
              released: 1,
              result: "error",
              definiteOperations: 1,
              intents: 1,
            });
          await uiExpect(toolAnswers().filter({ hasText: "SANDBOX_TOOL_RESULT_LOST" })).toHaveCount(
            1,
          );
          expect(observedToolReplies(text).map((ids) => ids.length)).toEqual([1]);
          expect(JSON.stringify(observedToolMessages(text))).toContain("SANDBOX_TOOL_RESULT_LOST");
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
                modelMessages: observedToolMessages(text),
              },
              null,
              2,
            ),
          );
        }
      });
    });

    it.each([
      ...(
        [
          "before-end",
          "after-end",
          "after-reset",
          "before-final",
          "after-final",
          "before-result",
          "after-result",
        ] as const
      ).flatMap((stage) => (["worker", "services"] as const).map((target) => ({ stage, target }))),
    ])(
      "recovers original foreground bytes after $target exits at $stage",
      async ({ stage, target }) => {
        const name = `18-stream-${stage}-${target}`;
        await scenario(name, async () => {
          await newThread();
          const before = new Set(executionReadback().map((record) => record.jobId));
          const rows = () => executionReadback().filter((record) => !before.has(record.jobId));
          const original = `原始分块内容-${crypto.randomUUID()}`;
          const changed = `已修改内容-${crypto.randomUUID()}`;
          const source = path.join(installation.workspace, "durability.txt");
          await writeFile(source, original);
          await installation.armFinishGate(stage);
          const text = `${stage}/${target}：请读取 durability.txt`;
          await beginToolRequest(text);
          await uiExpect
            .poll(() => installation.finishGateEntered(), { timeout: 60_000 })
            .not.toBeNull();
          if (stage !== "before-end") await uiExpect.poll(() => rows()[0]?.streamEnds).toBe(1);
          else expect(rows()[0]?.streamEnds).toBe(0);
          if (stage === "after-result")
            await uiExpect.poll(() => installation.finishGateResultReceived()).not.toBeNull();
          expect(rows()[0]?.result).toBeNull();
          await writeFile(
            path.join(outputDirectory, `${name}-before.json`),
            JSON.stringify(
              { original, changed, rows: rows(), gate: await installation.finishGateEntered() },
              null,
              2,
            ),
          );
          if (target === "worker") {
            await installation.crashWorker();
            await installation.stop();
          } else await installation.crash();
          await writeFile(source, changed);
          await installation.releaseFinishGate();
          if (target === "services") await waitForExpiredServiceLease();
          await installation.start();
          await page.reload();
          try {
            await uiExpect
              .poll(() => rows()[0], { timeout: 90_000 })
              .toMatchObject({
                runStatus: "completed",
                released: 1,
                definiteOperations: 1,
                intents: 1,
                result: stage === "before-end" ? "error" : "result",
              });
            const expectedContent = stage === "before-end" ? "SANDBOX_TOOL_RESULT_LOST" : original;
            await uiExpect(toolAnswers().filter({ hasText: expectedContent })).toHaveCount(1);
            expect(JSON.stringify(observedToolMessages(text))).toContain(expectedContent);
            expect(JSON.stringify(observedToolMessages(text))).not.toContain(changed);
            await uiExpect(toolAnswers().filter({ hasText: changed })).toHaveCount(0);
            expect(observedToolReplies(text).map((ids) => ids.length)).toEqual([1]);
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
                  modelMessages: observedToolMessages(text),
                  sourceContent: await readFile(source, "utf8"),
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
    ] as const)(
      "[R2-S4] recovers saved output after Job Host crashes during cleanup at %s",
      async (stage) => {
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
          await uiExpect.poll(() => rows()[0]?.streamEnds).toBe(1);
          expect(rows()[0]?.result).toBeNull();
          const host = (await readJobHostStarts()).find(
            (entry) => entry?.processId === entered.pid && entry?.jobId === rows()[0]?.jobId,
          );
          if (!host) throw new Error("FINISH_CRASH_HOST_IDENTITY_MISSING");
          const hostGroupBefore =
            process.platform === "linux" ? await readLinuxHostProcessGroup(host) : undefined;
          if (hostGroupBefore) expect(hostGroupBefore.recordedHostPresent).toBe(true);
          await writeFile(
            path.join(outputDirectory, `${name}-before.json`),
            JSON.stringify(
              { entered, resultReceivedAt, rows: rows(), host, hostGroupBefore },
              null,
              2,
            ),
          );
          let crashEvidenceFailure: AggregateError | undefined;
          try {
            await installation.crash();
            process.kill(entered.pid, "SIGKILL");
            await waitForExpiredServiceLease();
            await installation.start();
            await page.reload();
            await uiExpect
              .poll(() => rows()[0], { timeout: 90_000 })
              .toMatchObject({
                released: 1,
                runStatus: "completed",
                result: "result",
                definiteOperations: 1,
                intents: 1,
              });
            if (process.platform === "linux") {
              const hostGroup = await readLinuxHostProcessGroup(host);
              await writeFile(
                path.join(outputDirectory, `${name}-host-group-after-release.json`),
                JSON.stringify(hostGroup, null, 2),
              );
              expect(hostGroup.recordedHostPresent).toBe(false);
              expect(hostGroup.members).toEqual([]);
            }
            await uiExpect(toolAnswers().filter({ hasText: NOTE })).toHaveCount(1);
            expect(observedToolReplies(text).map((ids) => ids.length)).toEqual([1]);
            expect(JSON.stringify(observedToolMessages(text))).toContain(NOTE);
            expect(rows()).toHaveLength(1);
            expect(
              (await readJobHostStarts()).filter((host) => host?.jobId === rows()[0]?.jobId),
            ).toHaveLength(1);
          } finally {
            const captures = await Promise.allSettled([
              (async () => {
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
              })(),
              (async () => {
                if (process.platform === "linux")
                  await writeFile(
                    path.join(outputDirectory, `${name}-host-group-after.json`),
                    JSON.stringify(await readLinuxHostProcessGroup(host), null, 2),
                  );
              })(),
            ]);
            const errors = captures.flatMap((capture) =>
              capture.status === "rejected" ? [capture.reason] : [],
            );
            if (errors.length > 0) {
              crashEvidenceFailure = new AggregateError(
                errors,
                "FINISH_CRASH_EVIDENCE_CAPTURE_FAILED",
              );
              console.error(crashEvidenceFailure);
            }
          }
          if (crashEvidenceFailure) throw crashEvidenceFailure;
        });
      },
    );

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
            const answer = await beginToolRequest(text);
            let baselineFailure: (typeof failures)[number] | undefined;
            await uiExpect
              .poll(
                async () => {
                  if ((await answer.count()) > 0) return true;
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
            await uiExpect(answer).toHaveCount(1, { timeout: 300_000 });
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
