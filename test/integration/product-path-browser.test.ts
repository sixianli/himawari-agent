import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import {
  appendFile,
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer as createTcpServer } from "node:net";
import path from "node:path";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { readLinuxNamespaceState } from "@himawari-agent/runtime-sandbox/control";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
  type Request,
  type Route,
  expect as uiExpect,
} from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseMagpieModelList } from "../../apps/agent-service/src/production-magpie-models.ts";
import { ACCEPTANCE_SELECTABLE_MODELS } from "../../apps/control-center/test/release-walkthrough-models.ts";
import {
  RELEASE_WALKTHROUGH_UI as UI,
  type WalkthroughTarget,
} from "../../apps/control-center/test/release-walkthrough-ui.ts";
import {
  assertLoopbackMagpieUrl,
  installProductPath,
  type ModelScript,
  type ProductPathInstallation,
  publicHost,
  repositoryRoot,
} from "../fixtures/product-path-harness.ts";
import {
  linuxProcessIdentityPresent,
  type ProductPathJobHostStart,
  readLinuxHostProcessGroup,
  readLinuxJobProcesses,
  readResidentJobHostStart,
  readResidentTaskEnvironments,
} from "../fixtures/product-path-processes.ts";

const enabled = process.env["HIMAWARI_PRODUCT_PATH_E2E"] === "1";
const productDescribe = enabled ? describe : describe.skip;
const recoveryDescribe = enabled && process.platform === "linux" ? describe : describe.skip;
const outputDirectory = path.resolve(
  repositoryRoot,
  process.env["HIMAWARI_PRODUCT_PATH_OUTPUT"] ?? ".ci-output/product-path",
);
function shellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function buildR2T5Command(input: {
  workspace: string;
  parentPath: string;
  tmpPath: string;
  varTmpPath: string;
  homePath: string;
  trapPath: string;
}): string {
  const ws = shellSingleQuoted(input.workspace);
  const capture = (script: string, stem: string) =>
    `bash -c ${shellSingleQuoted(script)} >"$cap/${stem}.out" 2>"$cap/${stem}.err"; printf '%s\\n' "$?" > "$cap/${stem}.rc"`;
  return [
    `ws=${ws}`,
    `cap="$TMPDIR"`,
    "set +e",
    capture(`printf x > ${shellSingleQuoted(input.parentPath)}`, "r2t5-parent"),
    capture(`printf x > ${shellSingleQuoted(input.tmpPath)}`, "r2t5-tmp"),
    capture(`mkdir -p ${shellSingleQuoted(input.varTmpPath)}`, "r2t5-vartmp"),
    capture(`mkdir ${shellSingleQuoted(input.homePath)}`, "r2t5-home"),
    capture(`printf x > ${shellSingleQuoted(input.trapPath)}`, "r2t5-trap"),
    `printf 'workspace-ok\\n' 2>"$cap/r2t5-workspace.err" > "$ws/r2t5-workspace.txt"; printf '%s\\n' "$?" > "$cap/r2t5-workspace.rc"`,
    `python3 -c 'import tempfile,os; f=tempfile.mkstemp()[1]; print(f); print(os.environ["TMPDIR"])' > "$cap/r2t5-python.txt" 2>"$cap/r2t5-python.err"; printf '%s\\n' "$?" > "$cap/r2t5-python.rc"`,
    `git --version > "$cap/r2t5-git.txt" 2>"$cap/r2t5-git.err"; printf '%s\\n' "$?" > "$cap/r2t5-git.rc"`,
    capture("cat /etc/passwd", "r2t5-passwd"),
    `tmp_rc=$(cat "$cap/r2t5-tmp.rc")`,
    `if [ "$tmp_rc" -eq 0 ]; then printf '%s-%s\\n' R2T5-TMP WRITE-OK; fi`,
    `exit "$tmp_rc"`,
  ].join("\n");
}

const NOTE = "项目代号：向日葵";
const EDITABLE = "编辑前内容";
const EDITED = "编辑后内容";
const KEY_FIRST_LINE = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const PEM_FORMAT_NOTE = [
  "# PEM 私钥格式",
  "",
  "文件第一行是：",
  KEY_FIRST_LINE,
  "后面是 Base64 正文。",
  "",
].join("\n");
const keyNotes = (secondLine: string) =>
  [
    "deploy key:",
    secondLine,
    ...Array.from({ length: 4 }, (_, index) => `MIIEvR2T14EDITBODY${index}${"Qk".repeat(28)}`),
    "",
  ].join("\n");
const KEY_NOTES = keyNotes(KEY_FIRST_LINE);
const PLAIN_NOTES = keyNotes("(key kept elsewhere)");
const FULL_KEY = [
  KEY_FIRST_LINE,
  ...Array.from({ length: 4 }, (_, index) => `MIIEvR2T14FULLBODY${index}${"Qk".repeat(28)}`),
  "-----END PRIVATE KEY-----",
  "",
].join("\n");
const MISSING_TEXT_NOTE = "R2T14 原文：保持不变\n";
let escapeTrapPath = "";
let escapeNewPath = "";
let r2t5Command = "";
let r2t5Id = "";
let r2t5ParentPath = "";
let r2t5TmpPath = "";
let r2t5VarTmpPath = "";
let r2t5HomePath = "";
let r2t5TrapPath = "";
let networkPort = 0;
let networkConnections = 0;

const frontBashUsesOneShotSrt = process.platform !== "linux";
const oneShotForegroundSrtIsNonLinuxOnly =
  "Linux 上默认安装的前台 bash 走常驻任务环境，一次性准备协议由第 1、2 层测试覆盖";
const residentSessionsReportOneExitResult =
  "常驻会话每条命令只回报一份退出结果，没有可互相矛盾的退出事实；一次性路径的矛盾检查由第 1、2 层测试覆盖";
const residentFinishGateStageIsOneShotOnly =
  "常驻会话的重置、最终证据和会话结果都在命令结果之后，或者不存在；一次性路径的这些阶段由第 1、2 层测试覆盖，常驻路径的原始输出恢复由 before-end、after-end 和 restart=true 用例覆盖";

const script: ModelScript = ({ lastUserText, toolResults, hasTools }) => {
  if (!hasTools) return { kind: "text", text: "工具恢复验证" };
  if (lastUserText.includes("用命令连续读取两个文件") && toolResults.length < 2)
    return {
      kind: "tool",
      name: "bash",
      arguments: { command: toolResults.length === 0 ? "cat notes.txt" : "cat second.txt" },
    };
  if (lastUserText.includes("用命令读取 notes.txt") && toolResults.length === 0)
    return { kind: "tool", name: "bash", arguments: { command: "cat notes.txt" } };
  if (lastUserText.includes("用命令读取 durability.txt") && toolResults.length === 0)
    return { kind: "tool", name: "bash", arguments: { command: "cat durability.txt" } };
  if (lastUserText.includes("用命令写入 hello.txt") && toolResults.length === 0)
    return {
      kind: "tool",
      name: "bash",
      arguments: { command: "printf '%s' '你好，Himawari' > hello.txt" },
    };
  if (lastUserText.includes("连续读取两个文件") && toolResults.length < 2)
    return {
      kind: "tool",
      name: "read",
      arguments: { path: toolResults.length === 0 ? "notes.txt" : "second.txt" },
    };
  if (lastUserText.includes("自动批准验证")) {
    const step = toolResults.length;
    if (step === 0) return { kind: "tool", name: "ls", arguments: { path: "." } };
    if (step === 1) return { kind: "tool", name: "read", arguments: { path: "notes.txt" } };
    if (step === 2)
      return {
        kind: "tool",
        name: "write",
        arguments: { path: "auto.txt", content: "自动写入内容" },
      };
    if (step === 3)
      return {
        kind: "tool",
        name: "edit",
        arguments: { path: "editable.txt", edits: [{ oldText: EDITABLE, newText: EDITED }] },
      };
    if (step === 4)
      return {
        kind: "tool",
        name: "bash",
        arguments: {
          command:
            "mapfile -t lines < notes.txt; printf '%s notes.txt\\n' \"" + "$" + '{#lines[@]}"',
        },
      };
    return { kind: "text", text: `自动完成：${toolResults.length} 个操作` };
  }
  if (lastUserText.includes("R2T14 重复失败"))
    return toolResults.length < 16
      ? { kind: "tool", name: "bash", arguments: { command: "printf 'R2T14-SAME\\n'; exit 5" } }
      : { kind: "text", text: "R2T14 重复失败没有被拦下" };
  if (lastUserText.includes("R2T14") && toolResults.length === 0) {
    if (lastUserText.includes("非零退出"))
      return {
        kind: "tool",
        name: "bash",
        arguments: { command: "printf 'R2T14-OUT\\n'; printf 'R2T14-ERR\\n' >&2; exit 7" },
      };
    if (lastUserText.includes("写后失败"))
      return {
        kind: "tool",
        name: "bash",
        arguments: { command: `printf 'R2T14-WRITTEN' > "$TMPDIR/r2t14-written.txt"; exit 1` },
      };
    if (lastUserText.includes("输出超限"))
      return {
        kind: "tool",
        name: "bash",
        arguments: { command: "seq -f 'R2T14-LINE-%g' 1 400000" },
      };
    if (lastUserText.includes("命令超时"))
      return {
        kind: "tool",
        name: "bash",
        arguments: {
          command: "printf 'R2T14-BEFORE-TIMEOUT\\n'; /bin/sleep 30; printf 'R2T14-AFTER'",
          timeout: 2,
        },
      };
    if (lastUserText.includes("截断私钥"))
      return {
        kind: "tool",
        name: "bash",
        arguments: {
          command:
            "printf -- '-----%s PRIVATE KEY-----\\n' BEGIN; for i in $(seq 1 2100); do printf 'MIIEvR2T14E2E%s%04d%s\\n' KEYBODY \"$i\" QkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQk; done; printf -- '-----%s PRIVATE KEY-----\\n' END; exit 3",
        },
      };
    if (lastUserText.includes("讲解私钥格式"))
      return {
        kind: "tool",
        name: "write",
        arguments: { path: "pem-format.md", content: PEM_FORMAT_NOTE },
      };
    if (lastUserText.includes("编辑私钥旁边"))
      return {
        kind: "tool",
        name: "edit",
        arguments: {
          path: "key-notes.txt",
          edits: [{ oldText: "deploy key:", newText: "old deploy key:" }],
        },
      };
    if (lastUserText.includes("编辑找不到原文"))
      return {
        kind: "tool",
        name: "edit",
        arguments: {
          path: "r2t14-missing-text.txt",
          edits: [{ oldText: "R2T14-NOT-IN-FILE", newText: "R2T14-REPLACED" }],
        },
      };
    if (lastUserText.includes("写入完整私钥"))
      return {
        kind: "tool",
        name: "write",
        arguments: { path: "r2t14-full-key.pem", content: FULL_KEY },
      };
    if (lastUserText.includes("秘密输出"))
      return {
        kind: "tool",
        name: "bash",
        arguments: {
          command: `printf 'api_%s=%s\\n' key R2T14SECRETVALUE0001; exit ${lastUserText.includes("退出 2") ? 2 : 0}`,
        },
      };
  }
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
  if (lastUserText.includes("读取大文件"))
    return { kind: "tool", name: "read", arguments: { path: "big.txt" } };
  if (lastUserText.includes("输出大段内容"))
    return {
      kind: "tool",
      name: "bash",
      arguments: {
        command: "for i in {1..6000}; do printf 'line-%d-xxxxxxxxxxxxxxxxxxxx\\n' \"$i\"; done",
      },
    };
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
  if (lastUserText.includes("列出工作目录"))
    return { kind: "tool", name: "ls", arguments: { path: "." } };
  if (lastUserText.includes("按名字找文件"))
    return { kind: "tool", name: "find", arguments: { pattern: "nested.txt", path: "." } };
  if (lastUserText.includes("按内容搜索"))
    return { kind: "tool", name: "grep", arguments: { pattern: "向日葵", path: "." } };
  if (lastUserText.includes("编辑 editable.txt"))
    return {
      kind: "tool",
      name: "edit",
      arguments: { path: "editable.txt", edits: [{ oldText: EDITABLE, newText: EDITED }] },
    };
  if (lastUserText.includes("统计行数"))
    return {
      kind: "tool",
      name: "bash",
      arguments: {
        command: "mapfile -t lines < notes.txt; printf '%s notes.txt\\n' \"" + "$" + '{#lines[@]}"',
      },
    };
  if (lastUserText.includes("读取工作目录"))
    return { kind: "tool", name: "read", arguments: { path: "." } };
  if (lastUserText.includes("读取子目录"))
    return { kind: "tool", name: "read", arguments: { path: "subdir" } };
  if (lastUserText.includes("请运行系统命令"))
    return {
      kind: "tool",
      name: "bash",
      arguments: {
        command: `echo 'ls:'; ls; echo 'cat:'; cat notes.txt; echo; echo 'wc:'; wc -l editable.txt; echo 'git:'; git --version; echo 'py:'; python3 -c 'print("PYRESULT-" + str(6*7))'; true`,
      },
    };
  if (lastUserText.includes("请确认固定工具"))
    return {
      kind: "tool",
      name: "bash",
      arguments: { command: "command -v bash; command -v rg; command -v fd" },
    };
  if (lastUserText.includes("请尝试越界写入"))
    return {
      kind: "tool",
      name: "bash",
      arguments: {
        command: `printf 'escape' > '${escapeNewPath}'; printf 'escape' > '${escapeTrapPath}'`,
      },
    };
  if (lastUserText.includes("请核对其它路径的写入"))
    return {
      kind: "tool",
      name: "bash",
      arguments: { command: r2t5Command },
    };
  if (lastUserText.includes("请读取系统口令文件"))
    return {
      kind: "tool",
      name: "bash",
      arguments: { command: "cat /etc/passwd; echo PASSWD-END" },
    };
  if (lastUserText.includes("请测试联网"))
    return {
      kind: "tool",
      name: "bash",
      arguments: {
        command: `python3 -c "import socket; s=socket.socket(); s.settimeout(4); print('BLOCK' + 'ED' if s.connect_ex(('127.0.0.1',${networkPort}))!=0 else 'O' + 'PEN')"; true`,
      },
    };
  if (lastUserText.includes("模型故障")) return { kind: "http-error", status: 500 };
  if (lastUserText.includes("慢一点"))
    return { kind: "text", text: "慢回答已完成", delayMs: 2_500 };
  return { kind: "text", text: PLAIN_ANSWER };
};

let installation: ProductPathInstallation;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const results: Array<{
  scenario: string;
  status: "passed" | "failed";
  error?: string;
  answerMs?: number;
}> = [];

async function cleanupWithEvidence(
  filename: string,
  actions: ReadonlyArray<readonly [string, () => Promise<unknown>]>,
) {
  const failures: unknown[] = [];
  const stages: Array<{
    stage: string;
    status: "passed" | "failed";
    durationMs: number;
    error?: string;
  }> = [];
  const retain = async (record: unknown) => {
    try {
      await appendFile(
        path.join(outputDirectory, `${filename}.jsonl`),
        `${JSON.stringify(record)}\n`,
      );
    } catch (error) {
      failures.push(error);
    }
  };
  for (const [stage, action] of actions) {
    const started = process.hrtime.bigint();
    await retain({ event: "started", stage, atMonotonicNs: String(started) });
    try {
      await action();
      stages.push({
        stage,
        status: "passed",
        durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      });
    } catch (error) {
      failures.push(error);
      stages.push({
        stage,
        status: "failed",
        durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
        error: String(error),
      });
    }
    await retain({ event: "finished", ...stages[stages.length - 1] });
  }
  try {
    await writeFile(
      path.join(outputDirectory, `${filename}.json`),
      `${JSON.stringify({ stages, passed: failures.length === 0 }, null, 2)}\n`,
    );
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) throw new AggregateError(failures, "PRODUCT_PATH_TEARDOWN_FAILED");
}

async function capture(name: string) {
  await page.screenshot({ path: path.join(outputDirectory, `${name}.png`), fullPage: true });
  await writeFile(
    path.join(outputDirectory, `${name}.aria.yml`),
    await page.locator("body").ariaSnapshot(),
  );
}

const answerTimes = new Map<string, number>();

async function scenario(name: string, body: () => Promise<void>) {
  try {
    await body();
    const answerMs = answerTimes.get(name);
    results.push({
      scenario: name,
      status: "passed",
      ...(answerMs === undefined ? {} : { answerMs }),
    });
    await capture(name);
  } catch (error) {
    results.push({ scenario: name, status: "failed", error: String(error) });
    await capture(`${name}-failed`).catch(() => undefined);
    throw error;
  }
}

async function restoreServices() {
  await installation.stop();
  await installation.start();
  await page.reload();
}

function noteAnswer() {
  return toolAnswers().filter({ hasText: NOTE }).first();
}

function target(scope: Page | Locator, item: WalkthroughTarget) {
  return scope.getByRole(item.role, {
    ...(item.name === undefined ? {} : { name: item.name }),
    ...(item.exact ? { exact: true } : {}),
  });
}

function composer() {
  return target(page, UI.composer);
}

let activeTurn: Locator | undefined;

async function send(text: string) {
  const button = target(page, UI.send);
  await uiExpect(target(page, UI.stop)).toHaveCount(0, {
    timeout: 300_000,
  });
  await composer().fill(text);
  await uiExpect(button).toBeEnabled({ timeout: 20_000 });
  await uiExpect(page.locator(UI.conversationLoading)).toHaveCount(0);
  const before = await page.locator(UI.turn).count();
  await button.click();
  const turn = page.locator(UI.turn).nth(before);
  await uiExpect(turn).toHaveCount(1, { timeout: 20_000 });
  await uiExpect(target(turn, UI.message).filter({ hasText: text }).last()).toBeVisible({
    timeout: 20_000,
  });
  activeTurn = turn;
  return turn;
}

function toolAnswers() {
  return page.getByText(/工具返回：/);
}

async function beginToolRequest(text: string) {
  const turn = await send(text);
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

function currentTurn() {
  if (!activeTurn) throw new Error("CURRENT_TURN_UNAVAILABLE");
  return activeTurn;
}

async function expectToolRowPhase(phase: "已完成" | "失败") {
  const rows = currentTurn().getByRole("listitem");
  await uiExpect(rows.filter({ hasText: phase }).first()).toBeVisible({ timeout: 30_000 });
  await uiExpect(rows.filter({ hasText: "结果未确认" })).toHaveCount(0);
  await uiExpect(rows.filter({ hasText: "尚未派发" })).toHaveCount(0);
}

async function expectToolReason(label: string) {
  const process = page.locator(".turn-process").last();
  if ((await process.getAttribute("open")) === null)
    await process.locator(":scope > summary").click();
  await uiExpect(process.locator(".step-status").filter({ hasText: label })).toBeVisible({
    timeout: 30_000,
  });
}

async function executionEnvironmentReadback() {
  const configuration = (await page.evaluate(async () => {
    const response = await fetch("/api/control-center/v1/config", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    return response.json();
  })) as {
    ownerId: string;
    agentId: string;
    deploymentId: string;
    actorId: string;
    authorityEpoch: number;
    fencingToken: number;
  };
  return (await page.evaluate(async (value) => {
    const identifier = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;
    const response = await fetch("/api/gateway/thread/v3/queries", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "gateway.thread.v3",
        kind: "query",
        type: "thread.execution_environment",
        messageId: identifier("message"),
        correlationId: identifier("correlation"),
        causationId: null,
        scope: { ownerId: value.ownerId, agentId: value.agentId },
        authority: {
          deploymentId: value.deploymentId,
          authorityEpoch: value.authorityEpoch,
          fencingToken: value.fencingToken,
        },
        actor: { actorType: "owner", actorId: value.actorId },
        payload: {},
      }),
    });
    return { status: response.status, body: await response.json() };
  }, configuration)) as {
    status: number;
    body: {
      payload?: {
        environment?: { mode?: string; unavailableTools?: Array<{ toolName: string }> };
      };
    };
  };
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

function residentEnvironmentReleaseProof(runId: string) {
  const database = openQualifiedDatabase(installation.databasePath);
  try {
    return database
      .prepare(
        `SELECT e.environment_id AS environmentId, e.role, e.generation, e.state,
          r.basis AS basis, r.accepted_at AS acceptedAt
        FROM execution_environments e
        JOIN execution_jobs j ON j.execution_job_id=e.execution_job_id
        LEFT JOIN execution_environment_release_receipts r ON r.environment_id=e.environment_id
        WHERE j.run_id=? ORDER BY e.environment_id`,
      )
      .all(runId) as Array<{
      environmentId: string;
      role: string;
      generation: number;
      state: string;
      basis: string | null;
      acceptedAt: string | null;
    }>;
  } finally {
    database.close();
  }
}

async function expectSingleResidentExecution(runId: string, jobId: string) {
  const database = openQualifiedDatabase(installation.databasePath);
  let environments: Array<{
    environmentId: string;
    role: string;
    generation: number;
    state: string;
  }>;
  let calls: Array<{ environmentId: string; invocationId: string }>;
  let records: Array<{ jobId: string; invocationId: string }>;
  try {
    environments = database
      .prepare(
        `SELECT e.environment_id AS environmentId, e.role, e.generation, e.state
        FROM execution_environments e
        JOIN execution_jobs j ON j.execution_job_id=e.execution_job_id
        WHERE j.run_id=? ORDER BY e.environment_id`,
      )
      .all(runId) as typeof environments;
    calls = database
      .prepare(
        `SELECT c.environment_id AS environmentId, c.invocation_id AS invocationId
        FROM execution_environment_calls c
        JOIN execution_environments e ON e.environment_id=c.environment_id
        JOIN execution_jobs j ON j.execution_job_id=e.execution_job_id
        WHERE j.run_id=? ORDER BY c.invocation_id`,
      )
      .all(runId) as typeof calls;
    records = database
      .prepare(
        `SELECT job_id AS jobId, json_extract(plan_json,'$.identity.invocationId') AS invocationId
        FROM sandbox_execution_records WHERE job_id=?`,
      )
      .all(jobId) as typeof records;
  } finally {
    database.close();
  }
  const primary = environments.filter((environment) => environment.role === "primary");
  expect(environments).toHaveLength(1);
  expect(primary).toHaveLength(1);
  expect(records).toHaveLength(1);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.invocationId).toBe(records[0]?.invocationId);
  expect(calls[0]?.environmentId).toBe(primary[0]?.environmentId);
  const resident = (await readResidentTaskEnvironments(installation.stateRoot)).filter(
    (environment) => environment.runId === runId,
  );
  expect(resident).toHaveLength(1);
  const identities = resident
    .flatMap((environment) => environment.sessions)
    .filter((session) => session.kind === "command")
    .map((session) => ({
      processId: session.residentProcessId,
      startToken: session.residentStartToken,
    }));
  expect(identities).toHaveLength(1);
  expect(identities[0]).toMatchObject({
    processId: expect.any(Number),
    startToken: expect.any(String),
  });
  return { environments, calls, records, resident };
}

async function readResidentHost(
  runId: string,
  group: "command" | "resident",
): Promise<ProductPathJobHostStart> {
  return await readResidentJobHostStart({ stateRoot: installation.stateRoot, runId, group });
}

async function residentHostReady(runId: string): Promise<boolean> {
  const environments = (await readResidentTaskEnvironments(installation.stateRoot)).filter(
    (environment) => environment.runId === runId,
  );
  if (environments.length !== 1) return false;
  const session = environments[0]?.sessions.find((candidate) => candidate.kind === "command");
  return Boolean(
    session &&
      session.pid !== null &&
      session.startToken !== null &&
      session.residentProcessId !== null &&
      session.residentStartToken !== null &&
      session.commandGroups.length === 1,
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

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("");
}

function parsedToolResult(raw: string) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function resultContentText(result: Record<string, unknown> | null): string {
  return Array.isArray(result?.["content"]) ? messageText(result["content"]) : "";
}

function lastToolResult(userText: string) {
  const raw = messageText(observedToolMessages(userText).at(-1)?.at(-1)?.content);
  const result = parsedToolResult(raw);
  return { raw, result, content: resultContentText(result) };
}

async function toolDeliveryAfter(before: ReadonlySet<string>) {
  const rows = executionReadback().filter((record) => !before.has(record.jobId));
  const [row] = rows;
  if (rows.length !== 1 || !row) throw new Error(`EXPECTED_ONE_NEW_TOOL_JOB:${rows.length}`);
  const database = openQualifiedDatabase(installation.databasePath);
  let plan: string;
  try {
    plan = (
      database
        .prepare("SELECT plan_json AS plan FROM sandbox_execution_records WHERE job_id=?")
        .get(row.jobId) as { plan: string }
    ).plan;
  } finally {
    database.close();
  }
  const delivery = (await installation.sandboxDelivery(
    row.runId,
    JSON.parse(plan).identity.invocationId,
  )) as { content?: Record<string, unknown> } | null;
  return { row, delivery: delivery?.content ?? null };
}

async function expectFinishedTurnShowsStep(turn: Locator, step: string) {
  await uiExpect(target(page, UI.stop)).toHaveCount(0, {
    timeout: 120_000,
  });
  const process = turn.locator(UI.turnProcess).last();
  if ((await process.getAttribute("open")) === null)
    await process.locator(UI.turnProcessToggle).click();
  await uiExpect(turn.getByText(step).first()).toBeVisible({ timeout: 30_000 });
  await uiExpect(page.getByText(UI.unreadableRecords)).toHaveCount(0);
  await uiExpect(page.getByText(UI.noProcessRecords)).toHaveCount(0);
}

async function newThread() {
  const [link, button] = UI.newThread;
  await target(page, link).or(target(page, button)).first().click();
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

recoveryDescribe("installed recovery probe", { timeout: 600_000 }, () => {
  it("[R2-L6] shares cleanup deadline across cleanup close and final cleanup", async () => {
    const controller = path.join(
      repositoryRoot,
      "test/qualification/sandbox-install-restart-controller.py",
    );
    const sourceSha256 = createHash("sha256")
      .update(await readFile(controller))
      .digest("hex");
    const evidence = path.join(outputDirectory, "r2-l6-cleanup-budget");
    await mkdir(evidence, { recursive: true, mode: 0o700 });
    const harness = String.raw`import ast
import hashlib
import json
import os
import sys
import time
from pathlib import Path

source_path = Path(sys.argv[1]).resolve(strict=True)
source_bytes = source_path.read_bytes()
source = ast.parse(source_bytes, filename=str(source_path))
definitions = []
for node in source.body:
    if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "controller" for target in node.targets):
        break
    definitions.append(node)
namespace = {"__name__": "r2_l6_controller_budget_regression"}
exec(compile(ast.Module(body=definitions, type_ignores=[]), str(source_path), "exec"), namespace)
controller = namespace["Controller"]()
original = namespace["snapshot"](os.getpid())
fd = os.pidfd_open(os.getpid(), 0)
controller.handles["originalBash"] = {"fd": fd, "identity": original, "frozen": False}
report = {
    "schemaVersion": "r2-l6-controller-cleanup-budget.v1",
    "nonProduction": True,
    "sourcePath": str(source_path),
    "sourceSha256": hashlib.sha256(source_bytes).hexdigest(),
    "controllerExecutable": sys.executable,
    "isolated": sys.flags.isolated,
    "identity": {key: original[key] for key in ("pid", "uid", "startTime", "parentPid")},
    "firstTimeoutMs": 100,
    "maximumTotalMs": 1000,
    "stages": [],
    "passed": False,
}
started = time.monotonic_ns()
try:
    for command in ("cleanup", "close", "finalCleanup"):
        before = time.monotonic_ns()
        result = controller.cleanup() if command == "finalCleanup" else controller.dispatch({"command": command, "timeoutMs": 100})
        elapsed_ms = (time.monotonic_ns() - before) / 1000000
        current = namespace["snapshot"](os.getpid())
        namespace["same_identity"](original, current)
        report["stages"].append({
            "command": command,
            "elapsedMs": elapsed_ms,
            "controllerElapsedMs": result["elapsedMs"],
            "originalProcessPresent": not namespace["exited"](fd),
            "originalIdentityUnchanged": True,
            "originalRoleRemaining": any(row["role"] == "originalBash" and row["pid"] == original["pid"] and row["startTime"] == original["startTime"] for row in result["processesRemaining"]),
            "errors": result["errors"],
        })
    report["totalElapsedMs"] = (time.monotonic_ns() - started) / 1000000
    report["passed"] = (
        report["totalElapsedMs"] <= report["maximumTotalMs"]
        and report["stages"][0]["elapsedMs"] >= 90
        and all(stage["originalProcessPresent"] and stage["originalIdentityUnchanged"] and stage["originalRoleRemaining"] and not stage["errors"] for stage in report["stages"])
    )
except BaseException as error:
    report["error"] = {"type": type(error).__name__, "message": str(error)}
finally:
    controller.close_fds()
print(json.dumps(report, separators=(",", ":")))
sys.exit(0 if report["passed"] else 1)
`;
    await writeFile(path.join(evidence, "regression.py"), harness, { mode: 0o600 });
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          "/usr/bin/python3",
          ["-I", "-c", harness, controller],
          { maxBuffer: 512 * 1024, timeout: 45_000 },
          (error, stdout, stderr) => {
            resolve({
              code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
              stdout,
              stderr,
            });
          },
        );
      },
    );
    await writeFile(path.join(evidence, "stdout.json"), result.stdout, { mode: 0o600 });
    await writeFile(path.join(evidence, "stderr.txt"), result.stderr, { mode: 0o600 });
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.schemaVersion).toBe("r2-l6-controller-cleanup-budget.v1");
    expect(report.nonProduction).toBe(true);
    expect(report.sourceSha256).toBe(sourceSha256);
    expect(report.controllerExecutable).toBe("/usr/bin/python3");
    expect(report.isolated).toBe(1);
    expect(report.stages.map((stage: { command: string }) => stage.command)).toEqual([
      "cleanup",
      "close",
      "finalCleanup",
    ]);
    expect(
      report.stages.every(
        (stage: {
          originalProcessPresent: boolean;
          originalIdentityUnchanged: boolean;
          originalRoleRemaining: boolean;
          errors: unknown[];
        }) =>
          stage.originalProcessPresent &&
          stage.originalIdentityUnchanged &&
          stage.originalRoleRemaining &&
          stage.errors.length === 0,
      ),
    ).toBe(true);
    expect(report.stages[0].elapsedMs).toBeGreaterThanOrEqual(90);
    expect(report.totalElapsedMs).toBeLessThanOrEqual(1000);
    expect(report.passed).toBe(true);
  });
  it("[R2-L6] retains unknown occupancy across real service restart until trusted release", async () => {
    const artifact = process.env["HIMAWARI_TEST_ARTIFACT"];
    const contextFile = process.env["HIMAWARI_TEST_CONTEXT"];
    const scratch = process.env["HIMAWARI_TEST_TEMP_ROOT"];
    if (!artifact || !contextFile || !scratch)
      throw new Error("R2_L6_REQUIRES_ARTIFACT_CONTEXT_AND_TEMP_ROOT");
    expect(Buffer.byteLength(scratch)).toBe(10);
    expect(await realpath(scratch)).toBe(scratch);
    const metadata = await stat(scratch);
    expect(metadata.uid).toBe(process.getuid?.());
    expect(metadata.mode & 0o777).toBe(0o700);
    const probe = path.join(repositoryRoot, "test/qualification/sandbox-install-restart-probe.mjs");
    await readFile(probe);
    const evidence = path.join(outputDirectory, "r2-l6");
    await mkdir(evidence, { recursive: true, mode: 0o700 });
    const prefix = path.join(scratch, "i");
    const execute = async (label: string, args: string[]) => {
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
        (resolve) => {
          execFile(process.execPath, args, { maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
            resolve({
              code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
              stdout,
              stderr,
            });
          });
        },
      );
      await writeFile(path.join(evidence, `${label}.stdout`), result.stdout, { mode: 0o600 });
      await writeFile(path.join(evidence, `${label}.stderr`), result.stderr, { mode: 0o600 });
      expect(result.code, result.stderr).toBe(0);
    };
    await execute("install", [
      path.join(repositoryRoot, "scripts/install-node-runtime.mjs"),
      "--prefix",
      prefix,
      "--artifact",
      artifact,
      "--context",
      contextFile,
    ]);
    const runtime = path.join(prefix, "lib/himawari-agent");
    const bash = path.join(runtime, "pi-tools/bin/bash");
    await mkdir(path.dirname(bash), { recursive: true, mode: 0o755 });
    await copyFile("/bin/bash", bash, constants.COPYFILE_EXCL);
    expect(await readFile(bash)).toEqual(await readFile("/bin/bash"));
    execFileSync("/bin/chmod", ["-R", "a-w", runtime]);
    expect((await stat(runtime)).mode & 0o222).toBe(0);
    expect((await stat(bash)).mode & 0o222).toBe(0);
    const fileDigest = async (filename: string) =>
      createHash("sha256")
        .update(await readFile(filename))
        .digest("hex");
    const expectedDigests = {
      jobHostDigest: await fileDigest(
        path.join(runtime, "node_modules/@himawari-agent/runtime-sandbox/dist/job-host-main.js"),
      ),
      agentServiceMainDigest: await fileDigest(
        path.join(runtime, "node_modules/@himawari-agent/agent-service/dist/main.js"),
      ),
      bashDigest: await fileDigest(bash),
    };
    await writeFile(
      path.join(evidence, "readonly-runtime-preparation.json"),
      JSON.stringify({ installedRuntime: await realpath(runtime), ...expectedDigests }),
      { mode: 0o600 },
    );
    await execute("probe", [
      probe,
      "--runtime",
      runtime,
      "--scratch",
      scratch,
      "--output",
      evidence,
      "--audit-script",
      path.join(repositoryRoot, "scripts/operations/workspace-lifecycle-audit.mjs"),
      "--artifact",
      artifact,
      "--context",
      contextFile,
    ]);
    const report = JSON.parse(await readFile(path.join(evidence, "report.json"), "utf8"));
    expect(report.schemaVersion).toBe("r2-l6-installed-recovery.v1");
    expect(report.nonProduction).toBe(true);
    expect(report.productionQualificationIssued).toBe(false);
    expect(report.installedRuntime).toBe(await realpath(runtime));
    expect(report.runtimeDigestBefore).toMatch(/^[a-f0-9]{64}$/);
    expect(report.runtimeDigestAfter).toBe(report.runtimeDigestBefore);
    expect(report.qualification.runtimeDigest).toBe(report.runtimeDigestBefore);
    expect(report.jobHostDigest).toBe(expectedDigests.jobHostDigest);
    expect(report.agentServiceMainDigest).toBe(expectedDigests.agentServiceMainDigest);
    expect(report.bashDigest).toBe(expectedDigests.bashDigest);
    expect((await stat(runtime)).mode & 0o222).toBe(0);
    expect((await stat(bash)).mode & 0o222).toBe(0);
    expect(report.input.artifactSha256).toBe(await fileDigest(artifact));
    expect(report.input.contextSha256).toBe(await fileDigest(contextFile));
    expect(report.controller.executable).toBe("/usr/bin/python3");
    expect(report.controller.isolated).toBe(1);
    expect(report.controller.pidfdOpen).toBe(true);
    expect(report.controller.pidfdSendSignal).toBe(true);
    expect(report.fault.freezeDurationMs).toBeLessThanOrEqual(250);
    expect(Number.isFinite(report.fault.observationAgeMs)).toBe(true);
    expect(report.fault.observationAgeGate).toBe("disabled-by-reply-06");
    expect(report.fault.observationAgeMeasurementPoint).toBe("before-first-SIGSTOP");
    expect(report.fault.remainingDeadlineMs).toBeGreaterThanOrEqual(1500);
    expect(report.fault.remainingDeadlineMeasurementPoint).toBe("both-processes-state-T");
    expect(report.fault.preflight.directProcesses.passed).toBe(true);
    expect(report.fault.preflight.directMarker.passed).toBe(true);
    expect(report.fault.preflight.frozenProduct.passed).toBe(true);
    expect(report.fault.preflight.frozenProduct.execution.preparation).toBe("bound");
    expect(report.fault.preflight.frozenProduct.execution.supervision).toBe("initializing");
    expect(report.fault.preflight.frozenProduct.execution.activeClaims).toBeGreaterThan(0);
    expect(report.fault.preflight.frozenProduct.execution.releaseReceiptPresent).toBe(false);
    expect(report.fault.preflight.frozenProduct.finalPresent).toBe(false);
    expect(report.fault.preflight.frozenProduct.finalWitness.present).toBe(false);
    expect(report.fault.preflight.frozenProduct.newNonrunningObservations).toEqual([]);
    expect(report.oldPair.agent.exited).toBe(true);
    expect(report.oldPair.worker.exited).toBe(true);
    expect(report.restartPreflight.method).toBe("fixed-agent-lease-expiry-upper-bound");
    expect(report.restartPreflight.leaseDurationMs).toBe(30000);
    expect(report.restartPreflight.elapsedMonotonicMs).toBeGreaterThanOrEqual(30000);
    expect(report.restartPreflight.elapsedUtcMs).toBeGreaterThanOrEqual(30000);
    expect(report.restartPreflight.passed).toBe(true);
    expect(report.newPair.agent.pid).not.toBe(report.oldPair.agent.pid);
    expect(report.newPair.worker.pid).not.toBe(report.oldPair.worker.pid);
    expect(report.newPair.agent.bootId).not.toBe(report.oldPair.agent.bootId);
    expect(report.newPair.worker.bootId).not.toBe(report.oldPair.worker.bootId);
    expect(report.newPair.database).toEqual(report.oldPair.database);
    expect(report.afterRestart.original.supervision).toBe("lost");
    expect(report.afterRestart.original.cleanup).toBe("unknown");
    expect(report.afterRestart.original.activeClaims).toBeGreaterThan(0);
    expect(report.afterRestart.original.releaseReceiptPresent).toBe(false);
    expect(report.afterRestart.conflict.status).toBe("queued");
    expect(report.afterRestart.conflict.admissionPresent).toBe(false);
    expect(report.afterRestart.conflict.invocationReceiptPresent).toBe(false);
    expect(report.cancelledConflict.status).toBe("cancelled");
    expect(report.markers.afterRestart).toEqual(report.markers.before);
    expect(report.markers.afterRelease).toEqual(report.markers.before);
    expect(report.originalHostStartCount).toBe(1);
    expect(report.afterRelease.original.supervision).toBe("released");
    expect(report.afterRelease.original.releaseReceiptPresent).toBe(true);
    expect(report.afterRelease.original.activeClaims).toBe(0);
    expect(report.afterRelease.original.activeBarriers).toBe(0);
    expect(report.afterRelease.newRequest.admissionPresent).toBe(true);
    expect(report.afterRelease.newRequest.invocationReceiptPresent).toBe(true);
    expect(report.cleanup.ownedProcessesRemaining).toEqual([]);
    expect(report.cleanup.completed).toBe(true);
    expect(report.assertions.map((entry: { id: string }) => entry.id)).toEqual([
      "original_started",
      "old_pair_exited",
      "new_pair_same_state",
      "cleanup_unknown_occupied",
      "conflict_queued_not_admitted",
      "conflict_cancelled",
      "original_not_replayed",
      "trusted_release",
      "new_admission",
      "owned_cleanup",
    ]);
    expect(report.assertions.every((entry: { passed: boolean }) => entry.passed)).toBe(true);
    expect(report.passed).toBe(true);
  });
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
        approval: "ask",
      });
      installation.setModelScript(script);
      await writeFile(path.join(installation.workspace, "notes.txt"), NOTE, { mode: 0o600 });
      await writeFile(path.join(installation.workspace, "second.txt"), "第二份结果", {
        mode: 0o600,
      });
      await writeFile(path.join(installation.workspace, "editable.txt"), `${EDITABLE}\n`, {
        mode: 0o600,
      });
      await mkdir(path.join(installation.workspace, "subdir"), { recursive: true, mode: 0o700 });
      await writeFile(path.join(installation.workspace, "subdir", "nested.txt"), "嵌套文件内容\n", {
        mode: 0o600,
      });
      await writeFile(
        path.join(installation.workspace, "big.txt"),
        Array.from(
          { length: 6000 },
          (_, index) => `第${index + 1}行 内容内容内容内容内容内容内容内容`,
        ).join("\n"),
        { mode: 0o600 },
      );
      escapeTrapPath = path.join(path.dirname(installation.workspace), "r2t3-escape.txt");
      escapeNewPath = path.join(path.dirname(installation.workspace), "r2t3-new.txt");
      await writeFile(escapeTrapPath, "HOST-ORIGINAL", { mode: 0o600 });
      await rm(escapeNewPath, { force: true });
      r2t5Id = randomBytes(4).toString("hex");
      r2t5ParentPath = path.join(path.dirname(installation.workspace), `r2t5-parent-${r2t5Id}`);
      r2t5TmpPath = `/tmp/r2t5-${r2t5Id}`;
      r2t5VarTmpPath = `/var/tmp/r2t5-${r2t5Id}`;
      r2t5HomePath = `/home/r2t5-${r2t5Id}`;
      r2t5TrapPath = path.join(path.dirname(installation.workspace), `r2t5-trap-${r2t5Id}`);
      await writeFile(r2t5TrapPath, "HOST-ORIGINAL", { mode: 0o600 });
      await rm(r2t5ParentPath, { force: true });
      await rm(r2t5TmpPath, { force: true });
      await rm(r2t5VarTmpPath, { force: true });
      r2t5Command = buildR2T5Command({
        workspace: installation.workspace,
        parentPath: r2t5ParentPath,
        tmpPath: r2t5TmpPath,
        varTmpPath: r2t5VarTmpPath,
        homePath: r2t5HomePath,
        trapPath: r2t5TrapPath,
      });
      await installation.start();
      browser = await chromium.launch({
        channel: process.env["HIMAWARI_PRODUCT_PATH_BROWSER_CHANNEL"] ?? "chrome",
        tracesDir: path.join(outputDirectory, "traces", "main"),
        args: [`--host-resolver-rules=MAP ${publicHost}:443 127.0.0.1:${installation.frontPort}`],
      });
      context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "zh-CN" });
      await context.tracing.start({
        name: "main",
        live: true,
        screenshots: true,
        snapshots: true,
      });
      page = await context.newPage();
      await scenario("00-sign-in", async () => {
        await page.goto(`${installation.origin}/`);
        await uiExpect(composer()).toBeVisible({ timeout: 30_000 });
      });
    }, 400_000);

    afterAll(async () => {
      await cleanupWithEvidence("teardown", [
        [
          "report",
          async () =>
            writeFile(
              path.join(outputDirectory, "report.json"),
              `${JSON.stringify({ results, modelRequests: installation?.modelRequests.map(({ path: route, model }) => ({ route, model })), traceFormat: "playwright-live", tracesDirectory: path.join(outputDirectory, "traces", "main") }, null, 2)}\n`,
            ),
        ],
        ["installation", async () => installation?.close()],
        ["trace", async () => context?.tracing.stop()],
        ["browser", async () => browser?.close()],
      ]);
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

    it("keeps an already open page working after the service restarts", async () => {
      await scenario("04b-open-page-after-restart", async () => {
        await newThread();
        await installation.stop();
        await installation.start();
        const readAnswers = await beginToolRequest("重启后请读取 notes.txt");
        await uiExpect(readAnswers).toHaveCount(1, { timeout: 60_000 });
        await expectFinishedTurnShowsStep(currentTurn(), "读取文件");
        const write = await send("重启后请写入 hello.txt");
        const allow = write.getByRole("button", { name: "允许这一次" });
        await uiExpect(allow).toBeVisible({ timeout: 60_000 });
        await allow.click();
        await uiExpect(write.getByText(/工具返回：/)).toHaveCount(1, { timeout: 60_000 });
        await expectFinishedTurnShowsStep(write, "写入文件");
      });
    });

    it("keeps every step of a turn visible over a slow connection", async () => {
      await scenario("04c-slow-connection", async () => {
        await newThread();
        await page.route("**/api/gateway/**", async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 400));
          await route.continue().catch(() => undefined);
        });
        try {
          const turn = await send("慢速网络下请写入 hello.txt");
          const allow = turn.getByRole("button", { name: "允许这一次" });
          await uiExpect(allow).toBeVisible({ timeout: 60_000 });
          await allow.click();
          await uiExpect(turn.getByText(/工具返回：/)).toHaveCount(1, { timeout: 120_000 });
          await expectFinishedTurnShowsStep(turn, "写入文件");
        } finally {
          await page.unrouteAll({ behavior: "ignoreErrors" });
        }
      });
    });

    it("[R2-T1] lists the workspace with ls and shows a real entry", async () => {
      await scenario("r2t1-ls", async () => {
        const answer = await sendToolRequest("请列出工作目录");
        await uiExpect(answer).toContainText("notes.txt");
      });
    });

    it("[R2-T1] finds a file by name inside a subdirectory", async () => {
      await scenario("r2t1-find", async () => {
        const answer = await sendToolRequest("请按名字找文件");
        await uiExpect(answer).toContainText("nested.txt");
      });
    });

    it("[R2-T1] searches file contents with grep and shows the matching file", async () => {
      await scenario("r2t1-grep", async () => {
        const answer = await sendToolRequest("请按内容搜索");
        await uiExpect(answer).toContainText("notes.txt");
      });
    });

    it("[R2-T1] edits an existing file and the file on disk really changes", async () => {
      await scenario("r2t1-edit", async () => {
        await sendToolRequest("请编辑 editable.txt");
        expect(await readFile(path.join(installation.workspace, "editable.txt"), "utf8")).toBe(
          `${EDITED}\n`,
        );
      });
    });

    it("[R2-T1] runs a sandboxed bash command and shows its real output", async () => {
      await scenario("r2t1-bash", async () => {
        const answer = await sendToolRequest("请统计行数");
        await uiExpect(answer).toContainText("1 notes.txt");
      });
    });

    it("[R2-T9] reads a large file and shows the truncated body with a continuation hint", async () => {
      await scenario("r2t9-read-big", async () => {
        const answer = await sendToolRequest("请读取大文件");
        await uiExpect(answer).toContainText("Use offset=");
        await uiExpect(answer).not.toContainText("PI_RESULT_OUTPUT_LIMIT");
      });
    });

    it("[R2-T9] keeps the tail of a large bash output instead of failing", async () => {
      await scenario("r2t9-bash-big", async () => {
        const answer = await sendToolRequest("请输出大段内容");
        await uiExpect(answer).toContainText("line-");
        await uiExpect(answer).toContainText("line-6000");
        await uiExpect(answer).not.toContainText("PI_RESULT_OUTPUT_LIMIT");
        await uiExpect(answer).not.toContainText("PI_RUNNER_EXECUTION_FAILED");
        await expectToolRowPhase("已完成");
      });
    });

    it("[R2-T1] reports reading the workspace itself as a directory, not outside scope", async () => {
      await scenario("r2t1-read-workdir", async () => {
        const answer = await sendToolRequest("请读取工作目录");
        await uiExpect(answer).toContainText("是目录");
        await uiExpect(answer).not.toContainText("超出授权");
      });
    });

    it("[R2-T1] reports reading a subdirectory as a directory, not outside scope", async () => {
      await scenario("r2t1-read-subdir", async () => {
        const answer = await sendToolRequest("请读取子目录");
        await uiExpect(answer).toContainText("是目录");
        await uiExpect(answer).not.toContainText("超出授权");
      });
    });

    it("[R2-T1] lists the seven coding tools as available in the thread environment", async () => {
      await scenario("r2t1-environment", async () => {
        const snapshot = await executionEnvironmentReadback();
        expect(snapshot.status).toBe(200);
        const environment = snapshot.body.payload?.environment;
        expect(environment?.mode).toBe("srt");
        const unavailable = (environment?.unavailableTools ?? []).map((tool) => tool.toolName);
        for (const tool of ["read", "write", "edit", "ls", "find", "grep", "bash"])
          expect(unavailable).not.toContain(tool);
      });
    });

    it("[R2-P1] reads an existing file in the trusted host process", async () => {
      await scenario("r2p1-read-existing", async () => {
        const answer = await sendToolRequest("请读取 notes.txt");
        await uiExpect(answer).toContainText(NOTE);
        await expectToolRowPhase("已完成");
      });
    });

    it("[R2-P1] reports a missing file in the trusted host process", async () => {
      await scenario("r2p1-read-missing", async () => {
        const answer = await sendToolRequest("请读取 missing.txt");
        await uiExpect(answer).toContainText(/missing\.txt|不存在|ENOENT|not found/i);
        await expectToolRowPhase("失败");
      });
    });

    it("[R2-P1] lists, finds and greps in the trusted host process", async () => {
      await scenario("r2p1-search-tools", async () => {
        const listing = await sendToolRequest("请列出工作目录");
        await uiExpect(listing).toContainText("notes.txt");
        await expectToolRowPhase("已完成");
        const found = await sendToolRequest("请按名字找文件");
        await uiExpect(found).toContainText("nested.txt");
        await expectToolRowPhase("已完成");
        const grepped = await sendToolRequest("请按内容搜索");
        await uiExpect(grepped).toContainText("notes.txt");
        await expectToolRowPhase("已完成");
      });
    });

    it("[R2-P1] measures host read latency for existing and missing files over five runs", async () => {
      await scenario("r2p1-read-latency", async () => {
        const measure = async (text: string) => {
          const samples: number[] = [];
          for (let index = 0; index < 5; index++) {
            await newThread();
            const started = performance.now();
            await sendToolRequest(text);
            samples.push(performance.now() - started);
          }
          const sorted = [...samples].sort((left, right) => left - right);
          return {
            samples,
            median: sorted[Math.floor(sorted.length / 2)],
            max: Math.max(...samples),
          };
        };
        const existing = await measure("请读取 notes.txt");
        const missing = await measure("请读取 missing.txt");
        await writeFile(
          path.join(outputDirectory, "r2p1-read-latency.json"),
          `${JSON.stringify({ existing, missing }, null, 2)}\n`,
        );
      });
    });

    it("[R2-T3] runs system commands inside the sandboxed bash", async () => {
      await scenario("r2t3-system-commands", async () => {
        const answer = await sendToolRequest("请运行系统命令");
        await uiExpect(answer).toContainText("second.txt");
        await uiExpect(answer).toContainText(NOTE);
        await uiExpect(answer).toContainText("1 editable.txt");
        await uiExpect(answer).toContainText(/git version \d+\.\d+/);
        await uiExpect(answer).toContainText("PYRESULT-42");
      });
    });

    it("[R2-T3] keeps the verified tool directory first on the sandbox command path", async () => {
      await scenario("r2t3-fixed-tools-first", async () => {
        const answer = await sendToolRequest("请确认固定工具");
        for (const name of ["bash", "rg", "fd"])
          await uiExpect(answer).toContainText(`/pi-tools/bin/${name}`);
      });
    });

    it("[R2-T3] refuses a sandboxed write outside the authorized workspace", async () => {
      await scenario("r2t3-escape-write", async () => {
        const answer = await sendToolRequest("请尝试越界写入");
        await uiExpect(answer).toContainText("命令执行失败");
        await uiExpect(answer).toContainText("Read-only file system");
        await uiExpect(answer).not.toContainText('"commandExitCode":0');
        const readback = {
          newPath: escapeNewPath,
          newPathExists: await stat(escapeNewPath).then(
            () => true,
            () => false,
          ),
          trapPath: escapeTrapPath,
          trapContent: await readFile(escapeTrapPath, "utf8"),
        };
        await writeFile(
          path.join(outputDirectory, "r2t3-escape-readback.json"),
          JSON.stringify(readback, null, 2),
        );
        expect(readback.newPathExists).toBe(false);
        expect(readback.trapContent).toBe("HOST-ORIGINAL");
      });
    });

    it("[R2-T5] writes inside the authorized workspace and rejects writes outside it and the private directory", async () => {
      await scenario("r2t5-write-boundary", async () => {
        const answer = await sendToolRequest("请核对其它路径的写入");
        const jobsRoot = path.join(path.dirname(installation.stateRoot), "jobs");
        const captureHits: string[] = [];
        for (const name of await readdir(jobsRoot)) {
          if (name.startsWith("control-")) continue;
          const candidate = path.join(jobsRoot, name, "r2t5-tmp.rc");
          try {
            await stat(candidate);
            captureHits.push(path.join(jobsRoot, name));
          } catch (error) {
            const code =
              error && typeof error === "object" && "code" in error ? error.code : undefined;
            if (code !== "ENOENT") throw error;
          }
        }
        expect(captureHits).toHaveLength(1);
        const captureDir = captureHits[0];
        if (captureDir === undefined) throw new Error("R2T5_CAPTURE_MISSING");
        const readText = (name: string) => readFile(path.join(captureDir, name), "utf8");
        const exists = (target: string) =>
          stat(target).then(
            () => true,
            () => false,
          );
        const workspaceFile = path.join(installation.workspace, "r2t5-workspace.txt");
        const readback = {
          answer: await answer.innerText(),
          captureDir,
          parentRc: await readText("r2t5-parent.rc"),
          parentErr: await readText("r2t5-parent.err"),
          parentExists: await exists(r2t5ParentPath),
          tmpRc: await readText("r2t5-tmp.rc"),
          tmpErr: await readText("r2t5-tmp.err"),
          tmpExists: await exists(r2t5TmpPath),
          varTmpRc: await readText("r2t5-vartmp.rc"),
          varTmpErr: await readText("r2t5-vartmp.err"),
          varTmpExists: await exists(r2t5VarTmpPath),
          homeRc: await readText("r2t5-home.rc"),
          homeErr: await readText("r2t5-home.err"),
          homeExists: await exists(r2t5HomePath),
          trapRc: await readText("r2t5-trap.rc"),
          trapErr: await readText("r2t5-trap.err"),
          trapContent: await readFile(r2t5TrapPath, "utf8"),
          workspaceRc: await readText("r2t5-workspace.rc"),
          workspaceErr: await readText("r2t5-workspace.err"),
          workspaceExists: await exists(workspaceFile),
          pythonRc: await readText("r2t5-python.rc"),
          pythonOut: await readText("r2t5-python.txt"),
          pythonErr: await readText("r2t5-python.err"),
          gitRc: await readText("r2t5-git.rc"),
          gitOut: await readText("r2t5-git.txt"),
          passwdRc: await readText("r2t5-passwd.rc"),
          passwdOut: await readText("r2t5-passwd.out"),
          passwdErr: await readText("r2t5-passwd.err"),
        };
        await writeFile(
          path.join(outputDirectory, "r2t5-write-boundary-readback.json"),
          JSON.stringify(readback, null, 2),
        );
        await uiExpect(answer).not.toContainText("R2T5-TMP-WRITE-OK");
        await uiExpect(answer).toContainText("命令执行失败");
        await uiExpect(answer).toContainText(`命令以退出码 ${readback.tmpRc.trim()} 结束`);
        expect(readback.tmpRc.trim()).not.toBe("0");
        expect(readback.tmpErr).toContain("Read-only file system");
        expect(readback.tmpExists).toBe(false);
        expect(readback.parentRc.trim()).not.toBe("0");
        expect(readback.parentErr).toContain("Read-only file system");
        expect(readback.parentExists).toBe(false);
        expect(readback.varTmpRc.trim()).not.toBe("0");
        expect(readback.varTmpErr).toContain("Read-only file system");
        expect(readback.varTmpExists).toBe(false);
        expect(readback.homeRc.trim()).not.toBe("0");
        expect(readback.homeErr).toContain("Read-only file system");
        expect(readback.homeExists).toBe(false);
        expect(readback.trapRc.trim()).not.toBe("0");
        expect(readback.trapErr).toContain("Read-only file system");
        expect(readback.trapContent).toBe("HOST-ORIGINAL");
        expect(readback.workspaceRc.trim()).toBe("0");
        expect(readback.workspaceExists).toBe(true);
        expect(readback.answer).toMatch(/工作目录改动：[^\n]*新建[^\n；]*r2t5-workspace\.txt/);
        expect(readback.pythonRc.trim()).toBe("0");
        const [created, privateDir] = readback.pythonOut.trim().split("\n");
        expect(created && privateDir).toBeTruthy();
        if (created === undefined || privateDir === undefined) {
          throw new Error("python output missing created path or private directory");
        }
        expect(privateDir).not.toBe("/tmp");
        expect(readback.captureDir).toBe(privateDir);
        expect(created.startsWith(`${privateDir}/`)).toBe(true);
        expect(privateDir === jobsRoot || privateDir.startsWith(`${jobsRoot}/`)).toBe(true);
        expect(await exists(created)).toBe(true);
        expect(readback.gitRc.trim()).toBe("0");
        expect(readback.gitOut).toMatch(/git version \d+\.\d+/);
        expect(readback.passwdRc.trim()).not.toBe("0");
        expect(`${readback.passwdOut}\n${readback.passwdErr}`).not.toMatch(/root:.*:0:0/);
      });
    });

    it("[R2-T3] does not broaden the sandbox read boundary to system files", async () => {
      await scenario("r2t3-read-boundary", async () => {
        const answer = await sendToolRequest("请读取系统口令文件");
        await uiExpect(answer).toContainText(
          /No such file or directory|Permission denied|Read-only file system/,
        );
        await uiExpect(answer).not.toContainText(/root:.*:0:0/);
      });
    });

    it("[R2-T3] refuses a sandbox network connection to a local TCP port", async () => {
      await scenario("r2t3-network", async () => {
        const server = createTcpServer((connection) => {
          networkConnections += 1;
          connection.destroy();
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
        });
        try {
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("NETWORK_PORT_UNAVAILABLE");
          networkPort = address.port;
          const answer = await sendToolRequest("请测试联网");
          await uiExpect(answer).toContainText("BLOCKED");
          await uiExpect(answer).not.toContainText("OPEN");
          await writeFile(
            path.join(outputDirectory, "r2t3-network-connections.json"),
            JSON.stringify({ port: networkPort, connections: networkConnections }, null, 2),
          );
          expect(networkConnections).toBe(0);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      });
    });

    it("[R2-T14] shows the model the output tail and exit code of a failed command", async () => {
      await scenario("r2t14-nonzero-exit", async () => {
        const text = "请运行 R2T14 非零退出命令";
        const before = new Set(executionReadback().map((record) => record.jobId));
        const answer = await sendToolRequest(text);
        await expectToolRowPhase("失败");
        const observed = lastToolResult(text);
        const { delivery } = await toolDeliveryAfter(before);
        await writeFile(
          path.join(outputDirectory, "r2t14-nonzero-exit-readback.json"),
          JSON.stringify({ toolMessage: observed.raw, delivery }, null, 2),
        );
        expect(observed.content).toContain("R2T14-OUT");
        expect(observed.content).toContain("R2T14-ERR");
        expect(observed.content).toContain("Command exited with code 7");
        expect(Object.keys(observed.result ?? {})[0]).toBe("effectNotice");
        expect(observed.result?.["effectNotice"]).toContain("命令以退出码 7 结束");
        expect(observed.result?.["effectNotice"]).toContain("没有核验这条命令是否改动了工作区");
        expect(observed.result).toMatchObject({
          schemaVersion: "pi-result.v1",
          tool: "bash",
          isError: true,
          commandExitCode: 7,
        });
        await uiExpect(answer).toContainText("命令以退出码 7 结束");
        expect(delivery).toMatchObject({
          outcome: "failed",
          errorCode: "SANDBOX_COMMAND_EFFECT_UNVERIFIED",
          outputRef: expect.any(String),
          processExitCode: 7,
        });
      });
    });

    it("[R2-T14] keeps the effect warning when a failed command already wrote a file", async () => {
      await scenario("r2t14-write-then-fail", async () => {
        const text = "请运行 R2T14 写后失败命令";
        const before = new Set(executionReadback().map((record) => record.jobId));
        await sendToolRequest(text);
        await expectToolRowPhase("失败");
        const observed = lastToolResult(text);
        const { delivery } = await toolDeliveryAfter(before);
        const jobsRoot = path.join(path.dirname(installation.stateRoot), "jobs");
        const written: Array<{ path: string; content: string }> = [];
        for (const name of await readdir(jobsRoot)) {
          if (name.startsWith("control-")) continue;
          const candidate = path.join(jobsRoot, name, "r2t14-written.txt");
          const content = await readFile(candidate, "utf8").catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            },
          );
          if (content !== null) written.push({ path: candidate, content });
        }
        await writeFile(
          path.join(outputDirectory, "r2t14-write-then-fail-readback.json"),
          JSON.stringify({ toolMessage: observed.raw, delivery, written }, null, 2),
        );
        expect(written).toEqual([{ path: expect.any(String), content: "R2T14-WRITTEN" }]);
        expect(observed.content).toContain("Command exited with code 1");
        expect(observed.result?.["effectNotice"]).toContain("命令以退出码 1 结束");
        expect(observed.result).toMatchObject({ tool: "bash", isError: true, commandExitCode: 1 });
        expect(delivery).toMatchObject({
          outcome: "failed",
          errorCode: "SANDBOX_COMMAND_EFFECT_UNVERIFIED",
          processExitCode: 1,
        });
      });
    });

    it("[R2-T14] shows the output tail when a command is stopped for exceeding the output limit", async () => {
      await scenario("r2t14-output-limit", async () => {
        const text = "请运行 R2T14 输出超限命令";
        const before = new Set(executionReadback().map((record) => record.jobId));
        await sendToolRequest(text);
        await expectToolRowPhase("失败");
        const observed = lastToolResult(text);
        const { delivery } = await toolDeliveryAfter(before);
        await writeFile(
          path.join(outputDirectory, "r2t14-output-limit-readback.json"),
          JSON.stringify({ toolMessage: observed.raw, delivery }, null, 2),
        );
        expect(observed.content).toMatch(/R2T14-LINE-\d+/);
        expect(observed.content).toContain("命令输出上限");
        expect(observed.raw).not.toContain("PI_RUNNER_EXECUTION_FAILED");
        expect(observed.result?.["effectNotice"]).toContain("命令没有正常结束");
        expect(observed.result).toMatchObject({
          tool: "bash",
          isError: true,
          commandExitCode: null,
        });
        expect(delivery).toMatchObject({
          outcome: "failed",
          errorCode: "SANDBOX_COMMAND_EFFECT_UNVERIFIED",
          processExitCode: 1,
        });
      });
    });

    it("[R2-T14] reports a command timeout in Pi's words with the output before it", async () => {
      await scenario("r2t14-command-timeout", async () => {
        const text = "请运行 R2T14 命令超时验证";
        const before = new Set(executionReadback().map((record) => record.jobId));
        await sendToolRequest(text);
        await expectToolRowPhase("失败");
        const observed = lastToolResult(text);
        const { delivery } = await toolDeliveryAfter(before);
        await writeFile(
          path.join(outputDirectory, "r2t14-command-timeout-readback.json"),
          JSON.stringify({ toolMessage: observed.raw, delivery }, null, 2),
        );
        expect(observed.content).toContain("R2T14-BEFORE-TIMEOUT");
        expect(observed.content).toContain("Command timed out after 2 seconds");
        expect(observed.content).not.toContain("R2T14-AFTER");
        expect(observed.result?.["effectNotice"]).toContain("命令没有正常结束");
        expect(observed.result).toMatchObject({
          tool: "bash",
          isError: true,
          commandExitCode: null,
        });
        expect(delivery).toMatchObject({
          outcome: "failed",
          errorCode: "SANDBOX_COMMAND_EFFECT_UNVERIFIED",
          processExitCode: 1,
        });
      });
    });

    it("[R2-T14] masks machine secrets in the output sent to the model and keeps the real command exit status", async () => {
      await scenario("r2t14-secret-output", async () => {
        const cases = [
          { text: "请运行 R2T14 秘密输出命令，退出 0", exitCode: 0, phase: "已完成" },
          { text: "请运行 R2T14 秘密输出命令，退出 2", exitCode: 2, phase: "失败" },
        ] as const;
        for (const entry of cases) {
          const before = new Set(executionReadback().map((record) => record.jobId));
          await sendToolRequest(entry.text);
          await expectToolRowPhase(entry.phase);
          const observed = lastToolResult(entry.text);
          const { delivery } = await toolDeliveryAfter(before);
          await writeFile(
            path.join(outputDirectory, `r2t14-secret-output-exit-${entry.exitCode}-readback.json`),
            JSON.stringify({ toolMessage: observed.raw, delivery }, null, 2),
          );
          expect(observed.content).not.toContain("R2T14SECRETVALUE0001");
          expect(observed.content).toContain("[密钥]");
          expect(observed.result).toMatchObject({
            schemaVersion: "pi-result.v1",
            tool: "bash",
            isError: entry.exitCode !== 0,
            commandExitCode: entry.exitCode,
          });
          expect(observed.result?.["source"]).toHaveProperty("parameters");
          if (entry.exitCode === 0) {
            expect(observed.result).not.toHaveProperty("effectNotice");
            expect(delivery).toMatchObject({ outcome: "succeeded" });
          } else {
            expect(observed.result?.["effectNotice"]).toContain("命令以退出码 2 结束");
            expect(delivery).toMatchObject({
              outcome: "failed",
              errorCode: "SANDBOX_COMMAND_EFFECT_UNVERIFIED",
              processExitCode: 2,
            });
          }
        }
      });
    });

    it("[R2-T14] masks a private key whose first line truncation cut off", async () => {
      await scenario("r2t14-truncated-key", async () => {
        const text = "请运行 R2T14 截断私钥命令";
        const before = new Set(executionReadback().map((record) => record.jobId));
        const answer = await sendToolRequest(text);
        await expectToolRowPhase("失败");
        const observed = lastToolResult(text);
        const { delivery } = await toolDeliveryAfter(before);
        await writeFile(
          path.join(outputDirectory, "r2t14-truncated-key-readback.json"),
          JSON.stringify({ toolMessage: observed.raw, delivery }, null, 2),
        );
        expect(observed.raw).not.toContain("R2T14E2EKEYBODY");
        expect(observed.content).toContain("[密钥]");
        expect(observed.result).toMatchObject({
          schemaVersion: "pi-result.v1",
          tool: "bash",
          isError: true,
          commandExitCode: 3,
        });
        expect(observed.result?.["effectNotice"]).toContain("命令以退出码 3 结束");
        await uiExpect(answer).not.toContainText("R2T14E2EKEYBODY");
        expect(delivery).toMatchObject({
          outcome: "failed",
          errorCode: "SANDBOX_COMMAND_EFFECT_UNVERIFIED",
          processExitCode: 3,
        });
      });
    });

    it("[R2-T14] writes a document that shows a private key's first line and reports success", async () => {
      await scenario("r2t14-pem-note-write", async () => {
        await newThread();
        const file = path.join(installation.workspace, "pem-format.md");
        await rm(file, { force: true });
        const text = "请运行 R2T14 讲解私钥格式写入";
        await sendToolRequest(text);
        const observed = lastToolResult(text);
        const written = await readFile(file, "utf8").catch(() => null);
        await writeFile(
          path.join(outputDirectory, "r2t14-pem-note-write-readback.json"),
          JSON.stringify({ toolMessage: observed.raw, written }, null, 2),
        );
        expect(written).toBe(PEM_FORMAT_NOTE);
        expect(observed.raw).not.toContain("PI_RESULT_SECRET_REJECTED");
        expect(observed.result).toMatchObject({
          schemaVersion: "pi-result.v1",
          tool: "write",
          isError: false,
        });
        await expectToolRowPhase("已完成");
      });
    });

    it("[R2-T14] applies an edit beside a private key and masks the part of it the diff shows", async () => {
      await scenario("r2t14-key-notes-edit", async () => {
        await newThread();
        const file = path.join(installation.workspace, "key-notes.txt");
        const text = "请运行 R2T14 编辑私钥旁边";
        await writeFile(file, PLAIN_NOTES);
        await sendToolRequest(text);
        const control = lastToolResult(text);
        const controlAfter = await readFile(file, "utf8");
        await writeFile(file, KEY_NOTES);
        const before = new Set(executionReadback().map((record) => record.jobId));
        const answer = await sendToolRequest(text);
        await expectToolRowPhase("已完成");
        const observed = lastToolResult(text);
        const after = await readFile(file, "utf8");
        const { delivery } = await toolDeliveryAfter(before);
        await writeFile(
          path.join(outputDirectory, "r2t14-key-notes-edit-readback.json"),
          JSON.stringify(
            {
              controlToolMessage: control.raw,
              controlAfter,
              toolMessage: observed.raw,
              after,
              delivery,
            },
            null,
            2,
          ),
        );
        expect(controlAfter).toBe(PLAIN_NOTES.replace("deploy key:", "old deploy key:"));
        expect(control.result).toMatchObject({ tool: "edit", isError: false });
        expect(control.raw).not.toContain("[密钥]");
        expect(after).toBe(KEY_NOTES.replace("deploy key:", "old deploy key:"));
        expect(observed.raw).not.toContain("R2T14EDITBODY");
        expect(observed.raw).toContain("[密钥]");
        expect(observed.result).toMatchObject({
          schemaVersion: "pi-result.v1",
          tool: "edit",
          isError: false,
          verifiedWrite: expect.any(Object),
        });
        await uiExpect(answer).not.toContainText("R2T14EDITBODY");
        expect(delivery).toMatchObject({ outcome: "succeeded" });
      });
    });

    it("[R2-T14] gives the model Pi's error when an edit's old text is missing and keeps the file", async () => {
      await scenario("r2t14-edit-missing-text", async () => {
        await newThread();
        const file = path.join(installation.workspace, "r2t14-missing-text.txt");
        await writeFile(file, MISSING_TEXT_NOTE);
        const text = "请运行 R2T14 编辑找不到原文";
        const before = new Set(executionReadback().map((record) => record.jobId));
        const answer = await sendToolRequest(text);
        await expectToolRowPhase("失败");
        const observed = lastToolResult(text);
        const after = await readFile(file, "utf8");
        const { delivery } = await toolDeliveryAfter(before);
        const job = () => executionReadback().find((record) => !before.has(record.jobId));
        await uiExpect.poll(() => job()?.runStatus, { timeout: 60_000 }).toBe("completed");
        await writeFile(
          path.join(outputDirectory, "r2t14-edit-missing-text-readback.json"),
          JSON.stringify({ toolMessage: observed.raw, after, job: job(), delivery }, null, 2),
        );
        expect(after).toBe(MISSING_TEXT_NOTE);
        expect(observed.content).toContain("Could not find the exact text");
        expect(observed.result).toMatchObject({
          schemaVersion: "pi-result.v1",
          tool: "edit",
          isError: true,
          writeNotStarted: true,
        });
        expect(observed.result?.["verifiedWrite"] ?? null).toBeNull();
        await uiExpect(answer).toContainText("Could not find the exact text");
        await expectToolReason("文件操作没有成功，文件没有被修改");
        expect(job()).toMatchObject({
          result: "error",
          reasonCode: "FILE_WRITE_NOT_STARTED",
          released: 1,
          intents: 1,
        });
        expect(delivery).toMatchObject({
          outcome: "failed",
          errorCode: "FILE_WRITE_NOT_STARTED",
          outputRef: expect.any(String),
        });
      });
    });

    it("[R2-T14] warns the model once when a written file's result is refused", async () => {
      await scenario("r2t14-full-key-write", async () => {
        await newThread();
        const file = path.join(installation.workspace, "r2t14-full-key.pem");
        await rm(file, { force: true });
        const text = "请运行 R2T14 写入完整私钥";
        const before = new Set(executionReadback().map((record) => record.jobId));
        await beginToolRequest(text);
        const jobs = () => executionReadback().filter((record) => !before.has(record.jobId));
        try {
          await uiExpect
            .poll(() => ["completed", "failed", "cancelled"].includes(jobs()[0]?.runStatus ?? ""), {
              timeout: 300_000,
            })
            .toBe(true);
        } finally {
          await writeFile(
            path.join(outputDirectory, "r2t14-full-key-write-readback.json"),
            JSON.stringify(
              {
                jobs: jobs(),
                written: await readFile(file, "utf8").catch(() => null),
                modelMessages: observedToolMessages(text),
              },
              null,
              2,
            ),
          );
        }
        const { delivery } = await toolDeliveryAfter(before);
        expect(jobs()).toHaveLength(1);
        expect(jobs()[0]).toMatchObject({
          result: "error",
          reasonCode: "SANDBOX_WRITE_EFFECT_UNVERIFIED",
          released: 1,
          intents: 1,
        });
        expect(delivery).toMatchObject({
          outcome: "failed",
          errorCode: "SANDBOX_WRITE_EFFECT_UNVERIFIED",
          outputRef: null,
        });
        const messages = JSON.stringify(observedToolMessages(text));
        expect(messages).toContain("文件可能已被修改");
        expect(messages).not.toContain("R2T14FULLBODY");
        await uiExpect(page.getByText("R2T14FULLBODY")).toHaveCount(0);
        await uiExpect(page.getByText(/结果未确认|结果仍未确认/)).toHaveCount(0);
        await expectToolReason("文件操作失败；文件可能已被修改，具体效果尚未核验");
      });
    });

    it("[R2-T14] still stops a repeated failing command that makes no progress", async () => {
      await scenario("r2t14-repeated-failure", async () => {
        await newThread();
        const before = new Set(executionReadback().map((record) => record.jobId));
        const text = "请运行 R2T14 重复失败命令";
        const requests = () =>
          installation.modelRequests.flatMap(({ body }) => {
            if (!Array.isArray(body["messages"])) return [];
            const messages = body["messages"] as Array<{ role?: string; content?: unknown }>;
            const index = messages.findLastIndex((message) => message.role === "user");
            if (!JSON.stringify(messages[index]?.content).includes(text)) return [];
            return [
              {
                toolCount: Array.isArray(body["tools"]) ? body["tools"].length : -1,
                results: messages
                  .slice(index + 1)
                  .filter((message) => message.role === "tool")
                  .map((message) => messageText(message.content)),
              },
            ];
          });
        await send(text);
        await uiExpect
          .poll(
            async () => {
              if (requests().at(-1)?.toolCount === 0) return true;
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
        const observed = requests();
        const jobs = executionReadback().filter((record) => !before.has(record.jobId));
        await writeFile(
          path.join(outputDirectory, "r2t14-repeated-failure-readback.json"),
          JSON.stringify(
            {
              note: "This scenario guards the loop detector against the R2-T14 result change; it passes before and after that change.",
              requests: observed,
              jobs,
            },
            null,
            2,
          ),
        );
        const final = observed.at(-1);
        expect(final?.toolCount).toBe(0);
        expect(final?.results).toHaveLength(4);
        expect(observed.filter((request) => request.toolCount > 0)).toHaveLength(4);
        expect(jobs).toHaveLength(4);
        expect(new Set(jobs.map((record) => record.runId)).size).toBe(1);
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

    it("[R2-T11] delivers both sequential tool results in one turn exactly once", async () => {
      await scenario("08-two-tools", async () => {
        await newThread();
        const before = new Set(executionReadback().map((record) => record.jobId));
        const text = "请用命令连续读取两个文件";
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

    it("[R2-T11] completes thirty repeated reads without stranding a result or replaying a tool", async () => {
      await scenario("09-thirty-reads", async () => {
        await newThread();
        const before = new Set(executionReadback().map((record) => record.jobId));
        for (let index = 1; index <= 30; index++) {
          const text = `第 ${index} 次用命令读取 notes.txt`;
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

    it.for([false, true])(
      "[R2-T11] handles a preparation transport failure across paired restart (legacy=%s)",
      async (legacy, testContext) => {
        testContext.skip(legacy && !frontBashUsesOneShotSrt, oneShotForegroundSrtIsNonLinuxOnly);
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
            approval: "ask",
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
          await uiExpect(composer()).toBeVisible({ timeout: 30_000 });
        } else await page.reload();
        try {
          await scenario(name, async () => {
            await newThread();
            const before = new Set(executionReadback().map((record) => record.jobId));
            const text = "准备传输失败验证：请用命令读取 notes.txt";
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
                      "SELECT preparation_state AS phase, started_at AS startedAt, reservation_stopped_at AS stopRequestedAt, plan_json AS plan, recovery_json AS recovery FROM sandbox_execution_records WHERE job_id=?",
                    )
                    .get(job.jobId) as {
                    phase: string;
                    startedAt: string | null;
                    stopRequestedAt: string | null;
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
              const resident = plan.backendRef === "srt-task-environment";
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
                if (process.platform === "linux")
                  expect(plan.backendRef).toBe("srt-task-environment");
                if (resident) expect(Object.hasOwn(plan, "preparationProtocol")).toBe(false);
                else expect(plan.preparationProtocol).toBe("launch-or-block.v2");
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
                  basis: resident ? "task_environment_bind_fenced" : "preparation_not_authorized",
                });
                if (resident) {
                  expect(readback().execution.stopRequestedAt).toEqual(expect.any(String));
                  expect(readback().controlArtifacts).toEqual([]);
                } else {
                  expect(readback().controlArtifacts).toHaveLength(1);
                }
                expect(readback().occupancy).not.toEqual([]);
                expect(readback().occupancy).not.toContainEqual({ released_at: null });
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
                run: { status: string };
                diagnostics: Array<{ content: unknown }>;
              };
              if (resident) expect(diagnostic.run.status).toBe("completed");
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

    it("[R2-T11][R2-D4] releases an accepted preparation after its ACK is lost without starting or replaying the tool", async (testContext) => {
      testContext.skip(!frontBashUsesOneShotSrt, oneShotForegroundSrtIsNonLinuxOnly);
      await installation.stop();
      await installation.setRunDeadline(90_000);
      await installation.start();
      await page.reload();
      try {
        await scenario("33-preparation-ack-loss", async () => {
          await newThread();
          const before = new Set(executionReadback().map((record) => record.jobId));
          const text = "准备登记确认丢失验证：请用命令读取 notes.txt";
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

    it("[R2-T11][R2-L4][prod-sandbox-D2] retries an unproved disconnected preparation and resumes its workspace after the original signed final returns", async (testContext) => {
      testContext.skip(!frontBashUsesOneShotSrt, oneShotForegroundSrtIsNonLinuxOnly);
      await scenario("34-preparation-final-recovery", async () => {
        await newThread();
        const before = new Set(executionReadback().map((record) => record.jobId));
        const file = path.join(installation.workspace, "hello.txt");
        const baseline = "恢复前原工具不得写入";
        const text = "准备终态延迟验证：请用命令写入 hello.txt";
        await writeFile(file, baseline);
        let fault: Awaited<ReturnType<ProductPathInstallation["preparationFinalHold"]>> = null;
        let restored = false;
        let originalFinal: Buffer | undefined;
        let socketError: string | undefined;
        const hostAlive = () => {
          if (!fault) return null;
          try {
            process.kill(fault.pid, 0);
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
            throw error;
          }
        };
        const readback = () => {
          const database = openQualifiedDatabase(installation.databasePath);
          const jobId = fault?.jobId ?? "";
          try {
            return {
              at: new Date().toISOString(),
              rows: executionReadback().filter((row) => row.jobId === jobId),
              execution: database
                .prepare(
                  "SELECT preparation_state AS phase,started_at AS startedAt,reservation_stopped_at AS stopRequestedAt,plan_json AS plan,recovery_json AS recovery FROM sandbox_execution_records WHERE job_id=?",
                )
                .get(jobId) as
                | {
                    phase: string;
                    startedAt: string | null;
                    stopRequestedAt: string | null;
                    plan: string;
                    recovery: string | null;
                  }
                | undefined,
              reservationReleases: database
                .prepare(
                  "SELECT accepted_at,verification_json FROM sandbox_reservation_release_receipts WHERE job_id=?",
                )
                .all(jobId) as Array<{ accepted_at: string; verification_json: string }>,
              occupancy: database
                .prepare("SELECT released_at FROM sandbox_workspace_occupancy WHERE job_id=?")
                .all(jobId) as Array<{ released_at: string | null }>,
              replies: observedToolReplies(text),
              hostAlive: hostAlive(),
              socketError,
              quickCheck: database.pragma("quick_check"),
            };
          } finally {
            database.close();
          }
        };
        const snapshots: unknown[] = [];
        const record = async (stage: string, observation = readback(), extra = {}) => {
          snapshots.push({
            stage,
            ...observation,
            fault: await installation.preparationFinalHold(),
            ...extra,
          });
          await writeFile(
            path.join(outputDirectory, "34-preparation-final-recovery-readback.json"),
            JSON.stringify({ snapshots }, null, 2),
          );
        };
        await installation.armPreparationFinalHold();
        try {
          await send(text);
          const allow = page.getByRole("button", { name: "允许这一次" });
          await uiExpect
            .poll(
              async () =>
                (await allow.count()) > 0 || (await installation.preparationFinalHold()) !== null,
              { timeout: 60_000 },
            )
            .toBe(true);
          if ((await allow.count()) > 0) await allow.first().click();
          await uiExpect
            .poll(() => installation.preparationFinalHold(), { timeout: 40_000 })
            .not.toBeNull();
          fault = await installation.preparationFinalHold();
          if (!fault) throw new Error("PRODUCT_PATH_PREPARATION_FINAL_HOLD_MISSING");
          const heldFault = fault;
          originalFinal = await readFile(path.join(fault.directory, "final-held.json"));
          await writeFile(
            path.join(outputDirectory, "34-preparation-final-recovery-original-final.json"),
            originalFinal,
            { mode: 0o600 },
          );
          expect(createHash("sha256").update(originalFinal).digest("hex")).toBe(fault.sha256);
          expect(originalFinal.byteLength).toBe(fault.byteLength);
          expect(JSON.parse(JSON.parse(originalFinal.toString("utf8")).body)).toMatchObject({
            jobId: fault.jobId,
            attemptId: fault.attemptId,
            processId: fault.pid,
            phase: "finished",
            taskStarted: false,
            srtReset: true,
          });
          await expect(readFile(path.join(fault.directory, "final.json"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          await uiExpect.poll(hostAlive, { timeout: 40_000 }).toBe(false);
          socketError = await new Promise<string>((resolve, reject) => {
            const socket = createConnection(path.join(heldFault.directory, "control.sock"));
            socket.once("connect", () => {
              socket.destroy();
              resolve("connected");
            });
            socket.once("error", (error: NodeJS.ErrnoException) =>
              resolve(error.code ?? "unknown"),
            );
            socket.setTimeout(2000, () => {
              socket.destroy();
              reject(new Error("PRODUCT_PATH_PREPARATION_SOCKET_PROBE_TIMED_OUT"));
            });
          });
          expect(["ENOENT", "ECONNREFUSED"]).toContain(socketError);
          let occupied: ReturnType<typeof readback> | undefined;
          await uiExpect
            .poll(
              () => {
                const observation = readback();
                const recovery = JSON.parse(observation.execution?.recovery ?? "null");
                if (
                  observation.rows[0]?.runStatus !== "reconciling_external_result" ||
                  recovery?.status !== "scheduled" ||
                  recovery.action !== "stop" ||
                  recovery.attempts < 1
                )
                  return false;
                occupied = observation;
                return true;
              },
              { timeout: 40_000 },
            )
            .toBe(true);
          if (!occupied) throw new Error("PRODUCT_PATH_PREPARATION_RETRY_MISSING");
          await record("host-exited-final-unavailable-retry-scheduled", occupied);
          expect(occupied.execution).toMatchObject({ phase: "reserved", startedAt: null });
          expect(occupied.execution?.stopRequestedAt).toEqual(expect.any(String));
          const recovery = JSON.parse(occupied.execution?.recovery ?? "null");
          expect(Number.isFinite(Date.parse(recovery.nextAttemptAt))).toBe(true);
          expect(occupied.reservationReleases).toEqual([]);
          expect(occupied.occupancy.length).toBeGreaterThan(0);
          expect(occupied.occupancy.every((claim) => claim.released_at === null)).toBe(true);
          expect(occupied.rows).toHaveLength(1);
          expect(occupied.rows[0]).toMatchObject({ intents: 0, definiteOperations: 0 });
          expect(occupied.replies).toEqual([]);
          expect((await installation.preparationFinalHold())?.hostForks).toHaveLength(1);
          expect(await readFile(file, "utf8")).toBe(baseline);
          await installation.releasePreparationFinalHold();
          restored = true;
          expect(await readFile(path.join(fault.directory, "final.json"))).toEqual(originalFinal);
          await record("same-signed-final-restored");
          await uiExpect
            .poll(() => readback().rows[0]?.runStatus, { timeout: 40_000 })
            .toBe("completed");
          const done = readback();
          await record("verified-release-run-completed", done);
          expect(done.reservationReleases).toHaveLength(1);
          const release = done.reservationReleases[0];
          if (!release) throw new Error("PRODUCT_PATH_PREPARATION_RELEASE_MISSING");
          expect(JSON.parse(release.verification_json)).toMatchObject({
            basis: "host_never_started",
          });
          expect(done.occupancy.every((claim) => claim.released_at !== null)).toBe(true);
          expect(done.execution).toMatchObject({ phase: "reserved", startedAt: null });
          expect(done.rows[0]).toMatchObject({
            runStatus: "completed",
            intents: 0,
            definiteOperations: 0,
          });
          expect(done.replies.map((ids) => ids.length)).toEqual([1]);
          expect((await installation.preparationFinalHold())?.hostForks).toHaveLength(1);
          expect(executionReadback().filter((row) => !before.has(row.jobId))).toHaveLength(1);
          expect(await readFile(file, "utf8")).toBe(baseline);
          await uiExpect(toolAnswers().last()).toContainText("工具未启动");
          await uiExpect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
          await newThread();
          const nextRead = "释放占用后新对话：请用命令读取 notes.txt";
          await uiExpect(await sendToolRequest(nextRead)).toContainText(NOTE);
          const nextWrite = "释放占用后新对话：请写入 hello.txt";
          await sendToolRequest(nextWrite);
          await uiExpect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
          expect(await readFile(file, "utf8")).toBe("你好，Himawari");
          const nextRows = executionReadback().filter(
            (row) => !before.has(row.jobId) && row.jobId !== heldFault.jobId,
          );
          await record("same-workspace-new-read-write-completed", readback(), { nextRows });
          expect(nextRows).toHaveLength(2);
          for (const row of nextRows) {
            expect(row.runId).not.toBe(done.rows[0]?.runId);
            expect(row).toMatchObject({
              result: "result",
              runStatus: "completed",
              released: 1,
              intents: 1,
            });
          }
          expect(readback().reservationReleases).toEqual(done.reservationReleases);
          expect(readback().replies.map((ids) => ids.length)).toEqual([1]);
          expect(await readFile(path.join(fault.directory, "final.json"))).toEqual(originalFinal);
        } finally {
          fault ??= await installation.preparationFinalHold();
          if (fault && !restored) {
            const held = await readFile(path.join(fault.directory, "final-held.json"));
            await writeFile(
              path.join(outputDirectory, "34-preparation-final-recovery-original-final.json"),
              held,
              { mode: 0o600 },
            );
            await installation.releasePreparationFinalHold();
          }
          await record("final-observation");
        }
      });
    });

    it("[R2-T11][R2-L6][prod-sandbox-admin] ends an unproved reservation offline without replay and admits a new workspace request", async (testContext) => {
      testContext.skip(!frontBashUsesOneShotSrt, oneShotForegroundSrtIsNonLinuxOnly);
      await scenario("35-reservation-administrator-cleanup", async () => {
        await newThread();
        const before = new Set(executionReadback().map((record) => record.jobId));
        const file = path.join(installation.workspace, "hello.txt");
        const baseline = "管理员处置不得重放原工具";
        const text = "管理员处置验证：请用命令写入 hello.txt";
        await writeFile(file, baseline);
        let cleanupFault: Awaited<ReturnType<ProductPathInstallation["preparationFinalHold"]>> =
          null;
        let failureReadback: (() => unknown) | undefined;
        try {
          await installation.armPreparationFinalHold();
          await send(text);
          const allow = page.getByRole("button", { name: "允许这一次" });
          await uiExpect
            .poll(
              async () =>
                (await allow.count()) > 0 || (await installation.preparationFinalHold()) !== null,
              {
                timeout: 60_000,
              },
            )
            .toBe(true);
          if ((await allow.count()) > 0) await allow.first().click();
          await uiExpect
            .poll(() => installation.preparationFinalHold(), { timeout: 40_000 })
            .not.toBeNull();
          const fault = await installation.preparationFinalHold();
          if (!fault) throw new Error("PRODUCT_PATH_PREPARATION_FINAL_HOLD_MISSING");
          cleanupFault = fault;
          const originalFinal = await readFile(path.join(fault.directory, "final-held.json"));
          await writeFile(
            path.join(outputDirectory, "35-original-final-held.json"),
            originalFinal,
            {
              mode: 0o600,
            },
          );
          expect(createHash("sha256").update(originalFinal).digest("hex")).toBe(fault.sha256);
          const hostAlive = () => {
            try {
              process.kill(fault.pid, 0);
              return true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
              throw error;
            }
          };
          const hostGroupAlive = () => {
            try {
              process.kill(-fault.pid, 0);
              return true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
              throw error;
            }
          };
          await uiExpect.poll(hostAlive, { timeout: 40_000 }).toBe(false);
          await uiExpect.poll(hostGroupAlive, { timeout: 40_000 }).toBe(false);
          const snapshots: unknown[] = [];
          const readback = () => {
            const database = openQualifiedDatabase(installation.databasePath);
            try {
              return {
                at: new Date().toISOString(),
                rows: executionReadback().filter((row) => row.jobId === fault.jobId),
                execution: database
                  .prepare(
                    "SELECT preparation_state,started_at,reservation_stopped_at,recovery_json FROM sandbox_execution_records WHERE job_id=?",
                  )
                  .get(fault.jobId) as Record<string, unknown>,
                releases: database
                  .prepare("SELECT * FROM sandbox_reservation_release_receipts WHERE job_id=?")
                  .all(fault.jobId) as Array<{ verification_json: string }>,
                occupancy: database
                  .prepare("SELECT released_at FROM sandbox_workspace_occupancy WHERE job_id=?")
                  .all(fault.jobId) as Array<{ released_at: string | null }>,
                checkpoint: database
                  .prepare(
                    "SELECT c.phase,c.terminal_status,c.diagnostic_code FROM run_coordination_checkpoints c JOIN sandbox_execution_records r ON r.run_id=c.run_id WHERE r.job_id=?",
                  )
                  .get(fault.jobId),
                audits: database
                  .prepare(
                    "SELECT * FROM audit_records WHERE action='sandbox.reservation_cleanup_confirmed' AND target_ref=?",
                  )
                  .all(fault.jobId),
                observations: database
                  .prepare(
                    "SELECT * FROM sandbox_execution_observations WHERE job_id=? ORDER BY sequence",
                  )
                  .all(fault.jobId),
                replies: observedToolReplies(text),
                hostAlive: hostAlive(),
                hostGroupAlive: hostGroupAlive(),
              };
            } finally {
              database.close();
            }
          };
          failureReadback = readback;
          const record = async (stage: string) => {
            const observation = readback();
            snapshots.push({ stage, ...observation });
            await writeFile(
              path.join(outputDirectory, "35-reservation-administrator-cleanup-readback.json"),
              JSON.stringify({ snapshots }, null, 2),
            );
            return observation;
          };
          await uiExpect
            .poll(() => readback().rows[0]?.runStatus, { timeout: 40_000 })
            .toBe("reconciling_external_result");
          await uiExpect
            .poll(
              async () =>
                (
                  await installation.sandboxReservationAdministration(
                    "inspect-reservation",
                    fault.jobId,
                  )
                ).code,
              { timeout: 40_000 },
            )
            .toBe(0);
          const occupied = await record("host-exited-no-final");
          expect(occupied.execution).toMatchObject({
            preparation_state: "reserved",
            started_at: null,
          });
          expect(occupied.execution["reservation_stopped_at"]).toEqual(expect.any(String));
          expect(occupied.releases).toEqual([]);
          expect(occupied.occupancy.length).toBeGreaterThan(0);
          expect(occupied.occupancy.every((row) => row.released_at === null)).toBe(true);
          expect(occupied.replies).toEqual([]);
          await expect(readFile(path.join(fault.directory, "final.json"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          const siteReportPath = path.join(outputDirectory, "35-admin-cleanup-site-report.json");
          await writeFile(
            siteReportPath,
            JSON.stringify({
              pid: fault.pid,
              processGroupId: fault.pid,
              hostAlive: false,
              hostGroupAlive: false,
              finalAbsent: true,
              originalFinalSha256: fault.sha256,
            }),
          );
          const evidence = `sha256:${createHash("sha256")
            .update(await readFile(siteReportPath))
            .digest("hex")}`;
          const inspect = async () => {
            const result = await installation.sandboxReservationAdministration(
              "inspect-reservation",
              fault.jobId,
            );
            expect(result).toMatchObject({ code: 0, error: "" });
            return JSON.parse(result.output.trim().split("\n").at(-1) ?? "null") as {
              digest: string;
              confirmation: string;
            };
          };
          const parameters = (digest: string, confirmation: string) => [
            "--digest",
            digest,
            "--administrator",
            "operator-product-path",
            "--evidence",
            evidence,
            "--confirm",
            confirmation,
          ];
          const livePreview = await inspect();
          const locked = await installation.sandboxReservationAdministration(
            "confirm-reservation-cleanup",
            fault.jobId,
            parameters(livePreview.digest, livePreview.confirmation),
          );
          expect(locked.code).toBe(1);
          expect(locked.error).toContain("ADMIN_TARGET_NOT_STOPPED");
          expect((await record("running-service-refused")).releases).toEqual([]);
          await installation.stop();
          const preview = await inspect();
          expect(preview.confirmation).toBe(
            "HOST_GROUP_ABSENT_FINAL_ABSENT_RELATED_PROCESSES_ABSENT",
          );
          const confirmed = await installation.sandboxReservationAdministration(
            "confirm-reservation-cleanup",
            fault.jobId,
            parameters(preview.digest, preview.confirmation),
          );
          expect(confirmed).toMatchObject({ code: 0, error: "" });
          const failed = await record("administrator-confirmed-offline");
          expect(failed.rows[0]).toMatchObject({
            runStatus: "failed",
            intents: 0,
            definiteOperations: 0,
          });
          expect(failed.checkpoint).toMatchObject({
            phase: "failed",
            terminal_status: "failed",
            diagnostic_code: "SANDBOX_ADMINISTRATOR_CONFIRMED_CLEANUP",
          });
          expect(failed.releases).toHaveLength(1);
          expect(JSON.parse(failed.releases[0]?.verification_json ?? "null")).toMatchObject({
            schemaVersion: "sandbox-admin-reservation-release.v1",
            basis: "administrator_confirmed_cleanup",
            evidenceDigest: evidence,
          });
          expect(failed.audits).toHaveLength(1);
          expect(failed.occupancy.every((row) => row.released_at !== null)).toBe(true);
          expect(failed.observations).toEqual(occupied.observations);
          expect(failed.replies).toEqual([]);
          expect(await readFile(file, "utf8")).toBe(baseline);
          const repeated = await installation.sandboxReservationAdministration(
            "confirm-reservation-cleanup",
            fault.jobId,
            parameters(preview.digest, preview.confirmation),
          );
          expect(repeated).toMatchObject({ code: 0, error: "" });
          const afterRepeat = await record("same-confirmation-repeated");
          expect(afterRepeat.releases).toEqual(failed.releases);
          expect(afterRepeat.audits).toEqual(failed.audits);
          await installation.start();
          await page.reload();
          await uiExpect(
            page.getByText("本轮执行失败。已保存的消息和过程记录仍可查看。"),
          ).toBeVisible();
          await uiExpect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
          expect(
            (await record("service-reopened-original-run-still-failed")).rows[0]?.runStatus,
          ).toBe("failed");
          expect((await installation.preparationFinalHold())?.hostForks).toHaveLength(1);
          expect(executionReadback().filter((row) => !before.has(row.jobId))).toHaveLength(1);
          expect(await readFile(file, "utf8")).toBe(baseline);
          await newThread();
          await uiExpect(
            await sendToolRequest("管理员释放后新对话：请用命令读取 notes.txt"),
          ).toContainText(NOTE);
          await sendToolRequest("管理员释放后新对话：请写入 hello.txt");
          await uiExpect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
          expect(await readFile(file, "utf8")).toBe("你好，Himawari");
          const nextRows = executionReadback().filter(
            (row) => !before.has(row.jobId) && row.jobId !== fault.jobId,
          );
          expect(nextRows).toHaveLength(2);
          for (const row of nextRows)
            expect(row).toMatchObject({
              result: "result",
              runStatus: "completed",
              released: 1,
              intents: 1,
            });
          const final = await record("same-workspace-new-read-write-completed");
          expect(final.releases).toHaveLength(1);
          expect(final.audits).toHaveLength(1);
          expect(final.replies).toEqual([]);
          await expect(readFile(path.join(fault.directory, "final.json"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        } catch (error) {
          const failures: unknown[] = [error];
          const failureSnapshots: unknown[] = [];
          let failureReadbackRetained = false;
          const readReservation = (jobId: string) => {
            const database = openQualifiedDatabase(installation.databasePath);
            try {
              return {
                releases: database
                  .prepare("SELECT * FROM sandbox_reservation_release_receipts WHERE job_id=?")
                  .all(jobId),
                occupancy: database
                  .prepare("SELECT released_at FROM sandbox_workspace_occupancy WHERE job_id=?")
                  .all(jobId) as Array<{ released_at: string | null }>,
              };
            } finally {
              database.close();
            }
          };
          const recordFailure = async (stage: string) => {
            failureSnapshots.push({
              stage,
              at: new Date().toISOString(),
              running: installation.running(),
              fault: cleanupFault,
              observation: failureReadback?.() ?? {
                rows: executionReadback().filter((row) => !before.has(row.jobId)),
                reservation: cleanupFault ? readReservation(cleanupFault.jobId) : null,
              },
            });
            await writeFile(
              path.join(outputDirectory, "35-reservation-administrator-cleanup-failure.json"),
              JSON.stringify(
                {
                  error: String(error),
                  cleanupErrors: failures.slice(1).map(String),
                  snapshots: failureSnapshots,
                },
                null,
                2,
              ),
            );
          };
          try {
            cleanupFault ??= await installation.preparationFinalHold();
          } catch (cleanupError) {
            failures.push(cleanupError);
          }
          try {
            await recordFailure("failed-before-cleanup");
            failureReadbackRetained = true;
          } catch (cleanupError) {
            failures.push(cleanupError);
          }
          try {
            if (!failureReadbackRetained)
              throw new Error("PRODUCT_PATH_ADMIN_FAILURE_EVIDENCE_NOT_RETAINED");
            const fault = cleanupFault;
            if (!fault) throw new Error("PRODUCT_PATH_PREPARATION_FINAL_HOLD_MISSING");
            if (readReservation(fault.jobId).releases.length === 0) {
              const held = await readFile(path.join(fault.directory, "final-held.json"));
              expect(held.byteLength).toBe(fault.byteLength);
              expect(createHash("sha256").update(held).digest("hex")).toBe(fault.sha256);
              await writeFile(path.join(outputDirectory, "35-original-final-held.json"), held, {
                mode: 0o600,
              });
              for (const pid of [fault.pid, -fault.pid]) {
                let present = true;
                try {
                  process.kill(pid, 0);
                } catch (processError) {
                  if ((processError as NodeJS.ErrnoException).code !== "ESRCH") throw processError;
                  present = false;
                }
                expect(present).toBe(false);
              }
              if (!installation.running()) await installation.start();
              expect(readReservation(fault.jobId).releases).toEqual([]);
              await installation.releasePreparationFinalHold();
              await uiExpect
                .poll(
                  () => {
                    const state = readReservation(fault.jobId);
                    return (
                      state.releases.length === 1 &&
                      state.occupancy.length > 0 &&
                      state.occupancy.every((row) => row.released_at !== null)
                    );
                  },
                  { timeout: 40_000 },
                )
                .toBe(true);
            } else if (!installation.running()) await installation.start();
            await page.reload();
          } catch (cleanupError) {
            failures.push(cleanupError);
          }
          try {
            await recordFailure("failed-after-cleanup");
          } catch (cleanupError) {
            failures.push(cleanupError);
          }
          if (failures.length === 1) throw error;
          throw new AggregateError(failures, "PRODUCT_PATH_ADMIN_SCENARIO_AND_CLEANUP_FAILED", {
            cause: error,
          });
        }
      });
    });

    it("[R2-T11][R2-L4][prod-sandbox-D3] delivers a verified preparation failure with safe service diagnostics", async () => {
      await scenario("12-preparation-failure", async () => {
        await newThread();
        const before = new Set(executionReadback().map((record) => record.jobId));
        const file = path.join(installation.workspace, "hello.txt");
        await writeFile(file, "原文件必须保持不变");
        await installation.armPreparationFailure(process.platform === "linux" ? 2 : 1);
        const text = "准备失败验证：请用命令写入 hello.txt";
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
        let proof: {
          phase: string;
          startedAt: string | null;
          basis: string;
          backendRef: string | null;
        };
        try {
          proof = database
            .prepare(`SELECT r.preparation_state AS phase,r.started_at AS startedAt,
          json_extract(receipt.verification_json,'$.basis') AS basis,
          json_extract(r.plan_json,'$.backendRef') AS backendRef FROM sandbox_execution_records r
          JOIN sandbox_reservation_release_receipts receipt ON receipt.job_id=r.job_id WHERE r.job_id=?`)
            .get(row.jobId) as typeof proof;
        } finally {
          database.close();
        }
        if (process.platform === "linux") expect(proof.backendRef).toBe("srt-task-environment");
        const resident = proof.backendRef === "srt-task-environment";
        expect(proof).toMatchObject({
          phase: "reserved",
          startedAt: null,
          basis: resident ? "task_environment_bind_fenced" : "host_never_started",
        });
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
        const preparationDiagnostics = (
          diagnostic.diagnostics as Array<{ operationKey: string; content: unknown }>
        ).filter((entry) => entry.operationKey.endsWith(":diagnostic:preparation-failure"));
        expect(preparationDiagnostics).toHaveLength(1);
        const controlRef = preparationDiagnostics[0]?.operationKey.slice(
          0,
          -":diagnostic:preparation-failure".length,
        );
        expect(controlRef).toMatch(/^sandbox-control:[a-f0-9]{64}$/);
        let safeServiceDiagnostics: Array<Record<string, unknown>> = [];
        await uiExpect
          .poll(async () => {
            const logFiles = (await readdir(installation.logDirectory)).filter((name) =>
              /^agent-\d+\.log$/.test(name),
            );
            const logs = await Promise.all(
              logFiles.map((name) => readFile(path.join(installation.logDirectory, name), "utf8")),
            );
            safeServiceDiagnostics = logs
              .flatMap((log) => log.split("\n"))
              .filter((line) => line.includes('"event":"sandbox.preparation.failed"'))
              .map((line) => JSON.parse(line) as Record<string, unknown>)
              .filter((event) => event["controlRef"] === controlRef);
            return safeServiceDiagnostics;
          })
          .toHaveLength(1);
        expect(safeServiceDiagnostics[0]).toEqual({
          timestamp: expect.any(String),
          component: "agent-service",
          event: "sandbox.preparation.failed",
          controlRef,
          stage: "prepare",
          reasonCode: "SANDBOX_PREPARATION_FAILED",
          hostStage: "sdk_initialize",
          systemCode: "EIO",
          hostDetailCode: "UNKNOWN",
          hostCommand: "prepare",
          hostPhase: "preparing",
          hostSteps: expect.arrayContaining([
            expect.stringMatching(/^sdk_initialize:\d+:running$/),
          ]),
        });
        const safeOutput = JSON.stringify(safeServiceDiagnostics);
        for (const privateValue of [
          row.jobId,
          row.runId,
          installation.workspace,
          installation.stateRoot,
          file,
          text,
          "private fixture preparation input",
        ])
          expect(safeOutput).not.toContain(privateValue);
        expect(observedToolReplies(text).map((ids) => ids.length)).toEqual([1]);
        await writeFile(
          path.join(outputDirectory, "12-preparation-failure-readback.json"),
          JSON.stringify(
            {
              rows,
              proof,
              diagnostic,
              safeServiceDiagnostics,
              modelReplies: observedToolReplies(text),
            },
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

    it("[R2-S1][R2-U4] stops a running tool, releases only with proof, never revives the cancelled run, and keeps sending closed until the reloaded conversation has loaded", async () => {
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
          .poll(() => residentHostReady(job.runId), {
            timeout: 60_000,
          })
          .toBe(true);
        const host = await readResidentHost(job.runId, "command");
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
          const stopReleaseProof = residentEnvironmentReleaseProof(job.runId);
          expect(stopReleaseProof).toHaveLength(1);
          expect(stopReleaseProof[0]).toMatchObject({
            state: "released",
            basis: "process_group_gone",
            acceptedAt: expect.any(String),
          });
          expect(stopped.occupancy.length).toBeGreaterThan(0);
          for (const entry of stopped.occupancy)
            expect(entry).toMatchObject({ releasedAt: expect.any(String) });
          expect(stopped.replies).toEqual([]);
          let releaseDetail = () => {};
          const detailReleased = new Promise<void>((resolve) => {
            releaseDetail = resolve;
          });
          let heldDetailQueries = 0;
          const holdDetail = async (route: Route) => {
            if (route.request().postDataJSON()?.type === "thread.detail") {
              heldDetailQueries++;
              await detailReleased;
            }
            await route.continue();
          };
          let sendRequestsWhileLoading = 0;
          const countSendRequest = (request: Request) => {
            const { pathname } = new URL(request.url());
            if (
              pathname === "/api/payload/v1/text" ||
              pathname === "/api/gateway/thread/v3/commands"
            )
              sendRequestsWhileLoading++;
          };
          await page.route("**/api/gateway/thread/v3/queries", holdDetail);
          page.on("request", countSendRequest);
          try {
            try {
              await page.reload();
              await uiExpect(composer()).toBeVisible();
              await uiExpect.poll(() => heldDetailQueries, { timeout: 20_000 }).toBeGreaterThan(0);
              await uiExpect(
                page.locator('.thread-loading-skeleton[data-scope="conversation"]'),
              ).toBeVisible();
              await composer().fill("停止后继续");
              await uiExpect(
                page.getByRole("button", { name: "发送", exact: true }),
              ).toBeDisabled();
              await composer().press("Enter");
            } finally {
              releaseDetail();
              await page.unrouteAll({ behavior: "wait" });
            }
            await uiExpect(
              page.locator('.thread-loading-skeleton[data-scope="conversation"]'),
            ).toHaveCount(0, { timeout: 20_000 });
            await uiExpect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled({
              timeout: 20_000,
            });
          } finally {
            page.off("request", countSendRequest);
          }
          expect(sendRequestsWhileLoading).toBe(0);
          await uiExpect(composer()).toHaveValue("停止后继续");
          await uiExpect(page.getByText("正在提交，尚未接纳")).toHaveCount(0);
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
        let runId: string | undefined;
        let child:
          | {
              pid: number;
              ppid: number;
              pgid: number;
              marker: string;
              stdoutDescriptor: string;
            }
          | undefined;
        let hostIdentity: ProductPathJobHostStart | undefined;
        let linuxChild: Awaited<ReturnType<typeof waitForRunningLinuxTask>> | undefined;
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
          const startedRow = executionReadback().find((record) => !before.has(record.jobId));
          jobId = startedRow?.jobId;
          runId = startedRow?.runId;
          if (!jobId || !runId) throw new Error("B3_JOB_MISSING");
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
                      process.platform === "linux" ? "/usr/bin/lsof" : "/usr/sbin/lsof",
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
          if (process.platform === "linux") {
            expect(child.stdoutDescriptor).toBe(
              `p${child.pid}\nf1\ntsock\nnprotocol: UNIX-STREAM\n`,
            );
          } else {
            expect(child.stdoutDescriptor).toMatch(/(?:^|\n)t(?:PIPE|FIFO|unix)(?:\n|$)/);
          }
          expect(processRow(child.pid)?.command).toContain(marker);
          if (!runId) throw new Error("B3_RUN_MISSING");
          const residentRunId = runId;
          await uiExpect
            .poll(() => residentHostReady(residentRunId), {
              timeout: 30_000,
            })
            .toBe(true);
          const host = await readResidentHost(residentRunId, "command");
          if (!host) throw new Error("B3_HOST_MISSING");
          hostIdentity = host;
          expect(child.pgid).not.toBe(host.taskProcessGroup.processGroupId);
          if (process.platform === "linux") {
            if (!host.linuxNamespace) throw new Error("B3_LINUX_NAMESPACE_MISSING");
            const snapshot = await readLinuxJobProcesses(host);
            const children = snapshot.processes.filter((row) => row.pid === child?.pid);
            expect(children).toHaveLength(1);
            const runningChild = children[0];
            if (!runningChild) throw new Error("B3_LINUX_CHILD_MISSING");
            expect(runningChild).toMatchObject({
              stable: true,
              descendantOfRecordedHost: true,
              pidNamespace: host.linuxNamespace.namespaceId,
            });
            expect(runningChild.argv).toEqual([
              "/usr/bin/perl",
              "-MPOSIX",
              "-e",
              detachedProgram,
              marker,
            ]);
            expect(snapshot.recordedHostPresent).toBe(true);
            expect(snapshot.namespaceInitIdentityPresent).toBe(true);
            const init = snapshot.namespaceMembers.find(
              (row) => row.pid === host.linuxNamespace?.initPid,
            );
            expect(init).toMatchObject({
              stable: true,
              descendantOfRecordedHost: true,
              starttime: host.linuxNamespace.initStartTicks,
              pidNamespace: host.linuxNamespace.namespaceId,
            });
            expect(init?.namespacePids?.at(-1)).toBe(1);
            linuxChild = { pid: runningChild.pid, starttime: runningChild.starttime };
            expect(await linuxProcessIdentityPresent(linuxChild)).toBe(true);
            await writeFile(
              path.join(outputDirectory, "33-detached-output-processes-before.json"),
              JSON.stringify({ taskIdentity: linuxChild, snapshot }, null, 2),
            );
          }
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
          const releasedPlan = JSON.parse((released.execution as { plan: string }).plan) as {
            backendRef: string;
          };
          if (process.platform === "linux")
            expect(releasedPlan.backendRef).toBe("srt-task-environment");
          const residentPath = releasedPlan.backendRef === "srt-task-environment";
          expect(released.receipts).toEqual([
            expect.objectContaining({
              cleanup: residentPath ? "process_group_gone" : "confirmed",
            }),
          ]);
          if (residentPath) {
            expect(released.childProcess).toBeNull();
          } else {
            expect(released.hostProcess).toBeNull();
            expect(released.originalGroupMembers).toEqual([]);
            if (process.platform === "linux") {
              if (!linuxChild) throw new Error("B3_LINUX_CHILD_IDENTITY_MISSING");
              expect(released.childProcess).toBeNull();
              await assertLinuxTaskReleased(host, linuxChild, "33-detached-output");
            } else {
              expect(released.childProcess?.command).toContain(marker);
            }
          }
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
          await expectSingleResidentExecution(residentRunId, jobId);
          await save("model-completed");
          await uiExpect
            .poll(() => residentEnvironmentReleaseProof(residentRunId), { timeout: 60_000 })
            .toContainEqual(expect.objectContaining({ state: "released" }));
          const hostReleaseProof = residentEnvironmentReleaseProof(residentRunId);
          await writeFile(
            path.join(outputDirectory, "33-detached-output-host-release.json"),
            JSON.stringify(hostReleaseProof, null, 2),
          );
          expect(hostReleaseProof).toHaveLength(1);
          expect(hostReleaseProof[0]).toMatchObject({
            state: "released",
            basis: "process_group_gone",
            acceptedAt: expect.any(String),
          });
          if (residentPath) {
            await uiExpect.poll(() => readback().hostProcess, { timeout: 30_000 }).toBeNull();
            expect(readback().originalGroupMembers).toEqual([]);
            if (!linuxChild) throw new Error("B3_LINUX_CHILD_IDENTITY_MISSING");
            await assertLinuxTaskReleased(host, linuxChild, "33-later-stage");
          }
          const releasedStatus =
            process.platform === "linux"
              ? page.getByRole("button", { name: "默认模式 · 没有后台程序在运行", exact: true })
              : page.getByText(/停止未经严格确认/).first();
          await uiExpect(releasedStatus).toBeVisible({ timeout: 10_000 });
          await releasedStatus.scrollIntoViewIfNeeded();
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
        let servicesRestored = mode !== "recovery";
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
              .poll(() => residentHostReady(job.runId), {
                timeout: 60_000,
              })
              .toBeTruthy();
            const host = await readResidentHost(job.runId, "command");
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
                servicesRestored = true;
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
              await expectSingleResidentExecution(job.runId, job.jobId);
              const deadlineReleaseProof = residentEnvironmentReleaseProof(job.runId);
              expect(deadlineReleaseProof).toHaveLength(1);
              expect(deadlineReleaseProof[0]).toMatchObject({
                state: "released",
                basis: "process_group_gone",
                acceptedAt: expect.any(String),
              });
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
          } else if (!servicesRestored) await restoreServices();
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
        await uiExpect.poll(() => residentHostReady(job.runId), { timeout: 60_000 }).toBeTruthy();
        const host = await readResidentHost(job.runId, "command");
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
        const rows = () => executionReadback().filter((record) => !before.has(record.jobId));
        let servicesRestored = false;
        try {
          await installation.crash();
          await waitForExpiredServiceLease();
          await installation.start();
          servicesRestored = true;
          await page.reload();
          await uiExpect(composer()).toBeVisible({ timeout: 30_000 });
          await uiExpect
            .poll(() => rows()[0], { timeout: 60_000 })
            .toMatchObject({ jobId: job.jobId, released: 1 });
          expect(rows()).toHaveLength(1);
          if (process.platform === "linux") {
            if (!linuxTask) throw new Error("RESTART_TEST_LINUX_TASK_MISSING");
            await assertLinuxTaskReleased(host, linuxTask, "14-restart-running");
          }
          await expectSingleResidentExecution(job.runId, job.jobId);
          const restartReleaseProof = residentEnvironmentReleaseProof(job.runId);
          expect(restartReleaseProof).toHaveLength(1);
          expect(restartReleaseProof[0]).toMatchObject({
            state: "released",
            basis: "process_group_gone",
            acceptedAt: expect.any(String),
          });
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
          servicesRestored = false;
          await installation.stop();
          await installation.start();
          servicesRestored = true;
          await page.reload();
          expect(rows()).toEqual(settled);
          assertLostReply();
          await expectSingleResidentExecution(job.runId, job.jobId);
        } finally {
          try {
            await writeFile(
              path.join(outputDirectory, "14-restart-running-after.json"),
              JSON.stringify(
                {
                  rows: rows(),
                  residentEnvironments: await readResidentTaskEnvironments(installation.stateRoot),
                  replies: observedToolReplies(text),
                },
                null,
                2,
              ),
            );
          } finally {
            if (!servicesRestored) await restoreServices();
          }
        }
      });
    });

    it.each([false, true])(
      "[R2-T11] preserves original foreground output through host cleanup: restart=%s",
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
          const text = `收尾重启 ${restart}：请用命令读取 durability.txt`;
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
          let servicesRestored = !restart;
          try {
            if (restart) await installation.crash();
            await writeFile(source, changed);
            await installation.releaseFinishGate();
            if (restart) {
              await waitForExpiredServiceLease();
              await installation.start();
              servicesRestored = true;
              await page.reload();
            }
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
            const durabilityRow = rows()[0];
            if (!durabilityRow) throw new Error("DURABILITY_ROW_MISSING");
            await expectSingleResidentExecution(durabilityRow.runId, durabilityRow.jobId);
            expect(observedToolReplies(text).map((ids) => ids.length)).toEqual([1]);
          } finally {
            try {
              await writeFile(
                path.join(outputDirectory, `${name}-after.json`),
                JSON.stringify(
                  {
                    rows: rows(),
                    sourceContent: await readFile(source, "utf8"),
                    residentEnvironments: await readResidentTaskEnvironments(
                      installation.stateRoot,
                    ),
                    replies: observedToolReplies(text),
                  },
                  null,
                  2,
                ),
              );
            } finally {
              if (!servicesRestored) await restoreServices();
            }
          }
        });
      },
    );

    it("[R2-T11][R2-T12] rejects contradictory host completion instead of recovering the earlier success", async (testContext) => {
      testContext.skip(!frontBashUsesOneShotSrt, residentSessionsReportOneExitResult);
      const name = "20-contradictory-completion";
      await scenario(name, async () => {
        await newThread();
        const before = new Set(executionReadback().map((record) => record.jobId));
        const rows = () => executionReadback().filter((record) => !before.has(record.jobId));
        const original = `矛盾退出验证-${crypto.randomUUID()}`;
        await writeFile(path.join(installation.workspace, "durability.txt"), original);
        await installation.armFinishGate("contradict-result");
        const text = "矛盾退出事实：请用命令读取 durability.txt";
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
          const contradictionRow = rows()[0];
          if (!contradictionRow) throw new Error("CONTRADICTION_ROW_MISSING");
          await expectSingleResidentExecution(contradictionRow.runId, contradictionRow.jobId);
        } finally {
          await writeFile(
            path.join(outputDirectory, `${name}-after.json`),
            JSON.stringify(
              {
                rows: rows(),
                residentEnvironments: await readResidentTaskEnvironments(installation.stateRoot),
                modelMessages: observedToolMessages(text),
              },
              null,
              2,
            ),
          );
        }
      });
    });

    it("[R2-T11][R2-S2] keeps an offline Worker result pending until paired service restart settles LOST", async () => {
      const name = "19-worker-offline-recovery";
      await scenario(name, async () => {
        await newThread();
        const before = new Set(executionReadback().map((record) => record.jobId));
        const rows = () => executionReadback().filter((record) => !before.has(record.jobId));
        const resident = !frontBashUsesOneShotSrt;
        let servicesRestored = false;
        const original = `离线恢复验证-${crypto.randomUUID()}`;
        await writeFile(path.join(installation.workspace, "durability.txt"), original);
        await installation.armFinishGate("before-end");
        const text = "Worker 离线后成对恢复：请用命令读取 durability.txt";
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
              released: resident ? 0 : 1,
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
          servicesRestored = true;
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
          const offlineRow = rows()[0];
          if (!offlineRow) throw new Error("OFFLINE_ROW_MISSING");
          await expectSingleResidentExecution(offlineRow.runId, offlineRow.jobId);
        } finally {
          try {
            await writeFile(
              path.join(outputDirectory, `${name}-after.json`),
              JSON.stringify(
                {
                  rows: rows(),
                  residentEnvironments: await readResidentTaskEnvironments(installation.stateRoot),
                  modelMessages: observedToolMessages(text),
                },
                null,
                2,
              ),
            );
          } finally {
            if (!servicesRestored) await restoreServices();
          }
        }
      });
    });

    it.for([
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
      "[R2-T11] recovers original foreground bytes after $target exits at $stage",
      async ({ stage, target }, testContext) => {
        testContext.skip(
          !frontBashUsesOneShotSrt && stage !== "before-end" && stage !== "after-end",
          residentFinishGateStageIsOneShotOnly,
        );
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
          const text = `${stage}/${target}：请用命令读取 durability.txt`;
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
          let servicesRestored = false;
          try {
            if (target === "worker") {
              await installation.crashWorker();
              await installation.stop();
            } else await installation.crash();
            await writeFile(source, changed);
            await installation.releaseFinishGate();
            if (target === "services") await waitForExpiredServiceLease();
            await installation.start();
            servicesRestored = true;
            await page.reload();
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
            const streamRow = rows()[0];
            if (!streamRow) throw new Error("STREAM_ROW_MISSING");
            await expectSingleResidentExecution(streamRow.runId, streamRow.jobId);
          } finally {
            try {
              await writeFile(
                path.join(outputDirectory, `${name}-after.json`),
                JSON.stringify(
                  {
                    rows: rows(),
                    residentEnvironments: await readResidentTaskEnvironments(
                      installation.stateRoot,
                    ),
                    replies: observedToolReplies(text),
                    modelMessages: observedToolMessages(text),
                    sourceContent: await readFile(source, "utf8"),
                  },
                  null,
                  2,
                ),
              );
            } finally {
              if (!servicesRestored) await restoreServices();
            }
          }
        });
      },
    );

    it.for([
      "before-reset",
      "after-reset",
      "before-final",
      "after-final",
      "before-result",
      "after-result",
    ] as const)(
      "[R2-T11][R2-S4] recovers saved output after Job Host crashes during cleanup at %s",
      async (stage, testContext) => {
        testContext.skip(!frontBashUsesOneShotSrt, residentFinishGateStageIsOneShotOnly);
        const name = `16-finish-crash-${stage}`;
        await scenario(name, async () => {
          await newThread();
          const before = new Set(executionReadback().map((record) => record.jobId));
          const text = `${stage} 崩溃：请用命令读取 notes.txt`;
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
          const crashRow = rows()[0];
          if (!crashRow) throw new Error("FINISH_CRASH_ROW_MISSING");
          const host = await readResidentHost(crashRow.runId, "resident");
          expect(host.processId).toBe(entered.pid);
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
          let servicesRestored = false;
          try {
            await installation.crash();
            process.kill(entered.pid, "SIGKILL");
            await waitForExpiredServiceLease();
            await installation.start();
            servicesRestored = true;
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
            await expectSingleResidentExecution(crashRow.runId, crashRow.jobId);
          } finally {
            const captures = await Promise.allSettled([
              (async () => {
                await writeFile(
                  path.join(outputDirectory, `${name}-after.json`),
                  JSON.stringify(
                    {
                      rows: rows(),
                      residentEnvironments: await readResidentTaskEnvironments(
                        installation.stateRoot,
                      ),
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
            if (!servicesRestored) await restoreServices();
          }
          if (crashEvidenceFailure) throw crashEvidenceFailure;
        });
      },
    );

    it.each(["read", "write"] as const)(
      "[R2-T11] recovers the original tool result after a process crash during durable delivery: %s",
      async (tool) => {
        const name = `10-delivery-crash-${tool}`;
        await scenario(name, async () => {
          await newThread();
          const before = new Set(executionReadback().map((record) => record.jobId));
          await installation.armDeliveryCrash();
          const text =
            tool === "read" ? "交付中重启：请用命令读取 notes.txt" : "交付中重启：请写入 hello.txt";
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
          let servicesRestored = false;
          try {
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
            servicesRestored = true;
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
          } finally {
            if (!servicesRestored) await restoreServices();
          }
        });
      },
    );

    it("shows the connection loss while the service restarts and recovers afterwards", async () => {
      await scenario("07-service-restart", async () => {
        await newThread();
        const answer = await sendToolRequest("服务重启前：请读取 notes.txt");
        await uiExpect(answer).toContainText(NOTE);
        await capture("07-service-restart-before");
        let servicesRestored = false;
        try {
          await installation.stop();
          await uiExpect(page.getByText(/连接中断|离线/).first()).toBeVisible({ timeout: 60_000 });
          await installation.start();
          servicesRestored = true;
          await uiExpect(page.getByText(/连接中断|离线/)).toHaveCount(0, { timeout: 300_000 });
          await uiExpect(noteAnswer()).toBeVisible();
          await send("重启后继续");
          await uiExpect(page.getByText("普通回答已完成").last()).toBeVisible({ timeout: 300_000 });
        } finally {
          if (!servicesRestored) await restoreServices();
        }
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
        approval: "ask",
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

productDescribe("[R2-T2] workspace auto approval", { timeout: 600_000 }, () => {
  let autoInstallation: ProductPathInstallation;
  let autoBrowser: Browser;
  let autoContext: BrowserContext;
  let autoPage: Page;

  const autoComposer = () => autoPage.getByRole("textbox", { name: "消息草稿", exact: true });
  async function newAutoThread() {
    await autoPage
      .getByRole("link", { name: "新建对话" })
      .or(autoPage.getByRole("button", { name: "新建对话" }))
      .first()
      .click();
    await uiExpect(autoComposer()).toBeVisible({ timeout: 20_000 });
  }
  async function autoSend(text: string) {
    const button = autoPage.getByRole("button", { name: "发送", exact: true });
    await uiExpect(autoPage.getByRole("button", { name: "停止", exact: true })).toHaveCount(0, {
      timeout: 300_000,
    });
    await autoComposer().fill(text);
    await uiExpect(button).toBeEnabled({ timeout: 20_000 });
    await button.click();
    await uiExpect(autoPage.getByRole("article").filter({ hasText: text }).last()).toBeVisible({
      timeout: 20_000,
    });
  }
  function autoTurn(text: string) {
    return autoPage
      .locator(".chat-turn")
      .filter({
        has: autoPage.locator(".thread-message-owner").filter({
          has: autoPage.getByText(text, { exact: true }),
        }),
      })
      .last();
  }
  function auditCount(action: string): number {
    const database = openQualifiedDatabase(autoInstallation.databasePath);
    try {
      return (
        database
          .prepare("SELECT COUNT(*) AS count FROM audit_records WHERE action = ?")
          .get(action) as { count: number }
      ).count;
    } finally {
      database.close();
    }
  }

  beforeAll(async () => {
    const artifact = process.env["HIMAWARI_TEST_ARTIFACT"];
    const contextFile = process.env["HIMAWARI_TEST_CONTEXT"];
    if (!artifact || !contextFile)
      throw new Error(
        "PRODUCT_PATH_REQUIRES_ARTIFACT: set HIMAWARI_TEST_ARTIFACT and HIMAWARI_TEST_CONTEXT",
      );
    autoInstallation = await installProductPath({
      artifact,
      context: contextFile,
      logDirectory: path.join(outputDirectory, "auto-service-logs"),
      ...(process.env["HIMAWARI_TEST_SOURCE_ROOT"]
        ? { sourceRoot: process.env["HIMAWARI_TEST_SOURCE_ROOT"] }
        : {}),
    });
    autoInstallation.setModelScript(script);
    await writeFile(path.join(autoInstallation.workspace, "notes.txt"), `${NOTE}\n`, {
      mode: 0o600,
    });
    await writeFile(path.join(autoInstallation.workspace, "editable.txt"), `${EDITABLE}\n`, {
      mode: 0o600,
    });
    await autoInstallation.start();
    autoBrowser = await chromium.launch({
      channel: process.env["HIMAWARI_PRODUCT_PATH_BROWSER_CHANNEL"] ?? "chrome",
      tracesDir: path.join(outputDirectory, "traces", "auto"),
      args: [`--host-resolver-rules=MAP ${publicHost}:443 127.0.0.1:${autoInstallation.frontPort}`],
    });
    autoContext = await autoBrowser.newContext({ ignoreHTTPSErrors: true, locale: "zh-CN" });
    await autoContext.tracing.start({
      name: "auto",
      live: true,
      screenshots: true,
      snapshots: true,
    });
    autoPage = await autoContext.newPage();
    await autoPage.goto(`${autoInstallation.origin}/`);
    await uiExpect(autoComposer()).toBeVisible({ timeout: 30_000 });
  }, 400_000);

  afterAll(async () => {
    await cleanupWithEvidence("auto-teardown", [
      ["installation", async () => autoInstallation?.close()],
      ["trace", async () => autoContext?.tracing.stop()],
      ["browser", async () => autoBrowser?.close()],
    ]);
  }, 120_000);

  it("[R2-T2] runs ls, read, write, edit and an offline bash in one turn without any approval request", async () => {
    const request = "自动批准验证：列目录 读文件 写文件 编辑文件 统计行数";
    await newAutoThread();
    await autoSend(request);
    const turn = autoTurn(request);
    await uiExpect(turn.getByText(/自动完成/)).toBeVisible({ timeout: 300_000 });
    await uiExpect(turn.getByRole("button", { name: "允许这一次" })).toHaveCount(0);
    await uiExpect(turn).toContainText("1 notes.txt");

    expect(await readFile(path.join(autoInstallation.workspace, "auto.txt"), "utf8")).toBe(
      "自动写入内容",
    );
    expect(await readFile(path.join(autoInstallation.workspace, "editable.txt"), "utf8")).toBe(
      `${EDITED}\n`,
    );
    expect(auditCount("workspace.authorization.policy_applied")).toBe(5);
    expect(auditCount("workspace.authorization.enabled")).toBe(1);

    await autoInstallation.stop();
    await autoInstallation.setCodingApproval("ask");
    await autoInstallation.start();
    await autoPage.reload();
    await uiExpect(autoComposer()).toBeVisible({ timeout: 30_000 });

    await newAutoThread();
    await autoSend("请列出工作目录");
    const asking = autoTurn("请列出工作目录");
    await uiExpect(asking.getByRole("button", { name: "允许这一次" })).toBeVisible({
      timeout: 300_000,
    });
    await asking.getByRole("button", { name: "允许这一次" }).click();
    await uiExpect(asking.getByText(/工具返回：/)).toBeVisible({ timeout: 300_000 });
    expect(auditCount("workspace.authorization.revoked")).toBe(1);
  }, 1_500_000);
});

const RELEASE_ACCEPTANCE_SCENARIOS = [
  "accept-homepage",
  "accept-search-approval",
  "accept-search-toggle",
  "accept-news-search",
  "accept-long-answer",
  "accept-run-command",
  "accept-unrelated-no-memory",
  "accept-model-switch",
  "accept-conversation-search",
  "accept-reminders-page",
  "accept-files-page",
  "accept-slow-memory-search",
  "accept-file-writing-progress",
  "accept-progress-without-state",
  "accept-memory-page",
  "accept-memory-export",
  "accept-export-requires-login",
  "accept-phone-layout",
  "accept-phone-send",
  "accept-after-restart",
] as const;
const RUN_COMMAND_REQUEST = "请统计行数";
const SEARCH_TOKEN = "蓝鲸搜索验收";
const SEARCH_TOKEN_REQUEST = `这是一条用来搜索的消息：${SEARCH_TOKEN}`;
const SEARCH_BATCH_REQUEST = "请查东京和大阪今天的天气";
const APPROVAL_FOLLOW_UP_LIMIT_MS = 10_000;
const RUN_COMMAND_OUTPUT = "lines=37";
const UNRELATED_REQUEST = "写到一个pdf文件";
const PLAIN_ANSWER = "普通回答已完成";
const SLOW_MEMORY_SEARCH_DELAY_MS = 3_500;
const WRITE_GAME_REQUEST = "写一个简易小游戏";
const WRITE_GAME_STREAM_MS = 12_000;
const WRITING_PROGRESS_FIRST_SHOWN_MS = 2_000;
const SLOW_EXECUTION_STATE_MS = 4_000;
const GAME_FILE = {
  path: "game.html",
  content: Array.from(
    { length: 400 },
    (_, index) => `<p data-row="${index + 1}">${"接咖啡".repeat(8)}</p>`,
  ).join("\n"),
};
const LONG_ANSWER_END = "长回答验收到此结束";
const LONG_ANSWER = [
  ...Array.from(
    { length: 600 },
    (_, index) => `第${index + 1}段：这一段用来检查很长的回答能否从头到尾完整显示。`,
  ),
  LONG_ANSWER_END,
].join("\n\n");
const releaseAcceptanceScript: ModelScript = ({ lastUserText, toolResults }) => {
  if (lastUserText.includes(WRITE_GAME_REQUEST) && toolResults.length === 0)
    return { kind: "tool", name: "write", arguments: GAME_FILE, streamMs: WRITE_GAME_STREAM_MS };
  if (lastUserText.includes(SEARCH_BATCH_REQUEST) && toolResults.length === 0)
    return {
      kind: "tools",
      calls: [
        { name: "web_search", arguments: { query: "Tokyo weather today", limit: 3 } },
        { name: "web_search", arguments: { query: "Osaka weather today", limit: 3 } },
      ],
    };
  if (lastUserText.includes("联网搜索今天的新闻") && toolResults.length === 0)
    return {
      kind: "tool",
      name: "web_search",
      arguments: { query: "today top world news headlines", limit: 5 },
    };
  if (lastUserText.includes(RUN_COMMAND_REQUEST) && toolResults.length === 0)
    return {
      kind: "tool",
      name: "bash",
      arguments: { command: `printf 'lines=%s\\n' "$(seq 1 37 | wc -l | tr -d ' ')"` },
    };
  if (toolResults.length > 0) return { kind: "text", text: `工具返回：${toolResults.join("\n")}` };
  if (lastUserText.includes("长回答")) return { kind: "text", text: LONG_ANSWER };
  return { kind: "text", text: PLAIN_ANSWER };
};

async function openToolsSettings() {
  const dialog = target(page, UI.settingsDialog);
  if (!(await dialog.isVisible())) await target(page, UI.openSettings).first().click();
  await uiExpect(dialog).toBeVisible({ timeout: 20_000 });
  await target(dialog, UI.settingsToolsTab).click();
  return dialog;
}

async function closeSettings() {
  const dialog = target(page, UI.settingsDialog);
  if (await dialog.isVisible()) await target(dialog, UI.closeSettings).first().click();
  await uiExpect(dialog).toHaveCount(0, { timeout: 20_000 });
}

const PHONE_VIEWPORT = { width: 393, height: 852 } as const;
const PHONE_MINIMUM_INPUT_FONT_PX = 16;

async function expectPhoneLayout(phone: Page, where: string) {
  const problems = await phone.locator("html").evaluate((root, minimum) => {
    const document = root.ownerDocument;
    const view = document.defaultView;
    if (!view) return ["no window"];
    const found: string[] = [];
    if (root.scrollWidth > root.clientWidth)
      found.push(`page wider than screen ${root.scrollWidth}>${root.clientWidth}`);
    const notTyped = ["checkbox", "radio", "range", "file", "color", "hidden", "button", "submit"];
    for (const field of document.querySelectorAll("input, textarea, select")) {
      if (field.tagName === "INPUT" && notTyped.includes(field.getAttribute("type") ?? "text"))
        continue;
      if (field.getClientRects().length === 0) continue;
      const focusable = field as unknown as {
        focus: (options: { preventScroll: boolean }) => void;
        blur: () => void;
      };
      focusable.focus({ preventScroll: true });
      const size = Number.parseFloat(view.getComputedStyle(field).fontSize);
      focusable.blur();
      const name = field.getAttribute("aria-label") ?? field.getAttribute("placeholder") ?? "";
      if (size < minimum)
        found.push(`${field.tagName.toLowerCase()} "${name}" focused at ${size}px`);
    }
    const dialog = document.querySelector("dialog[open]");
    if (dialog) {
      const box = dialog.getBoundingClientRect();
      if (box.top < 0 || box.bottom > view.innerHeight)
        found.push(
          `dialog ${Math.round(box.top)}..${Math.round(box.bottom)} outside 0..${view.innerHeight}`,
        );
      const close = dialog.querySelector(".dialog-heading button")?.getBoundingClientRect();
      if (!close || close.top < 0 || close.bottom > view.innerHeight)
        found.push("dialog close button off screen");
    }
    return found;
  }, PHONE_MINIMUM_INPUT_FONT_PX);
  expect(problems, `phone layout: ${where}`).toEqual([]);
}

async function searchToggleUsable(toggle: WalkthroughTarget) {
  await uiExpect
    .poll(
      async () => {
        const dialog = await openToolsSettings();
        return target(dialog, toggle)
          .isEnabled({ timeout: 1_000 })
          .catch(() => false);
      },
      { timeout: 60_000, intervals: [1_000] },
    )
    .toBe(true);
  return target(target(page, UI.settingsDialog), toggle);
}

async function expectFileWritingProgress() {
  await newThread();
  const streamsBefore = installation.toolStreamStartedAt;
  const turn = await send(WRITE_GAME_REQUEST);
  await uiExpect
    .poll(() => installation.toolStreamStartedAt !== streamsBefore, { timeout: 120_000 })
    .toBe(true);
  const streamStartedAt = installation.toolStreamStartedAt ?? Date.now();
  const progress = turn.getByText(UI.writingProgress).first();
  await uiExpect(progress).toBeVisible({ timeout: 30_000 });
  const shownAfter = Date.now() - streamStartedAt;
  expect(shownAfter).toBeLessThanOrEqual(WRITING_PROGRESS_FIRST_SHOWN_MS + 1_000);
  const linesNow = async () =>
    Number(UI.writingProgress.exec((await progress.textContent()) ?? "")?.[1] ?? 0);
  const first = await linesNow();
  await uiExpect.poll(linesNow, { timeout: WRITE_GAME_STREAM_MS }).toBeGreaterThan(first);
  await uiExpect(page.getByText(UI.unreadableRecords)).toHaveCount(0);
  const allow = target(turn, UI.approveOnce);
  const answer = turn.getByText(/工具返回：/);
  await uiExpect
    .poll(async () => (await allow.count()) > 0 || (await answer.count()) > 0, {
      timeout: 120_000,
    })
    .toBe(true);
  if ((await allow.count()) > 0) await allow.first().click();
  await uiExpect(answer).toHaveCount(1, { timeout: 120_000 });
  await uiExpect(target(page, UI.stop)).toHaveCount(0, { timeout: 120_000 });
  await uiExpect(page.getByText(UI.failedConversation)).toHaveCount(0);
}

async function expectNewsSearchResults(text: string) {
  await newThread();
  const turn = await send(text);
  const answer = turn.getByText(/工具返回：/);
  await uiExpect(answer).toHaveCount(1, { timeout: 120_000 });
  await uiExpect(answer).toContainText("https://");
  await uiExpect(target(turn, UI.approveOnce)).toHaveCount(0);
  await uiExpect(target(turn, UI.approveSearch)).toHaveCount(0);
  await uiExpect(page.getByText(UI.stillLoading)).toHaveCount(0);
  await expectFinishedTurnShowsStep(turn, UI.searchStep);
}

productDescribe("product path: release acceptance in a real browser", { timeout: 900_000 }, () => {
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
      logDirectory: path.join(outputDirectory, "acceptance-service-logs"),
      approval: "ask",
      webSearch: true,
      selectableModels: true,
    });
    installation.setModelScript(releaseAcceptanceScript);
    await installation.start();
    browser = await chromium.launch({
      channel: process.env["HIMAWARI_PRODUCT_PATH_BROWSER_CHANNEL"] ?? "chrome",
      tracesDir: path.join(outputDirectory, "traces", "acceptance"),
      args: [`--host-resolver-rules=MAP ${publicHost}:443 127.0.0.1:${installation.frontPort}`],
    });
    context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "zh-CN" });
    await context.tracing.start({
      name: "acceptance",
      live: true,
      screenshots: true,
      snapshots: true,
    });
    page = await context.newPage();
  }, 400_000);

  afterAll(async () => {
    const artifact = process.env["HIMAWARI_TEST_ARTIFACT"];
    await cleanupWithEvidence("acceptance-teardown", [
      [
        "browser-acceptance",
        async () =>
          writeFile(
            path.join(outputDirectory, "browser-acceptance.json"),
            `${JSON.stringify(
              {
                schema: "himawari-browser-acceptance.v1",
                artifact: artifact ? path.basename(artifact) : null,
                artifactSha256: artifact
                  ? createHash("sha256")
                      .update(await readFile(artifact))
                      .digest("hex")
                  : null,
                completedAt: new Date().toISOString(),
                results: results.filter(({ scenario: name }) =>
                  (RELEASE_ACCEPTANCE_SCENARIOS as readonly string[]).includes(name),
                ),
              },
              null,
              2,
            )}\n`,
          ),
      ],
      ["installation", async () => installation?.close()],
      ["trace", async () => context?.tracing.stop()],
      ["browser", async () => browser?.close()],
    ]);
  }, 120_000);

  it("walks the release checks and keeps them working after a service restart", async () => {
    await scenario("accept-homepage", async () => {
      const response = await page.goto(`${installation.origin}/`);
      expect(response?.status()).toBe(200);
      await uiExpect(composer()).toBeVisible({ timeout: 30_000 });
    });
    await scenario("accept-news-search", async () => {
      await expectNewsSearchResults("请联网搜索今天的新闻");
    });
    await scenario("accept-search-toggle", async () => {
      const toggle = await searchToggleUsable(UI.searchRevoke);
      await uiExpect(toggle).toBeChecked();
      await toggle.click();
      const revoked = target(target(page, UI.settingsDialog), UI.searchEnable);
      await uiExpect(revoked).not.toBeChecked({ timeout: 30_000 });
      await uiExpect(revoked).toBeEnabled();
      await closeSettings();
    });
    await scenario("accept-search-approval", async () => {
      await newThread();
      const turn = await send(SEARCH_BATCH_REQUEST);
      await uiExpect(turn.getByText(UI.searchBatch)).toBeVisible({ timeout: 120_000 });
      const allow = target(turn, UI.approveSearch);
      await uiExpect(allow).toHaveCount(1);
      await target(turn, UI.rememberSearch).uncheck();
      const approvedAt = Date.now();
      await allow.click();
      const answer = turn.getByText(/工具返回：/);
      await uiExpect(answer).toHaveCount(1, { timeout: APPROVAL_FOLLOW_UP_LIMIT_MS });
      expect(Date.now() - approvedAt).toBeLessThan(APPROVAL_FOLLOW_UP_LIMIT_MS);
      await uiExpect(target(turn, UI.approveSearch)).toHaveCount(0);
      await uiExpect(turn.getByText(UI.approvalContinuing)).toHaveCount(0);
      await uiExpect(page.getByText(UI.stillLoading)).toHaveCount(0);
      await expectFinishedTurnShowsStep(turn, UI.searchStep);
    });
    await scenario("accept-long-answer", async () => {
      await newThread();
      const turn = await send("请给一个长回答");
      await uiExpect(turn.getByText(LONG_ANSWER_END)).toBeVisible({ timeout: 120_000 });
      await uiExpect(turn.getByText("第1段：", { exact: false })).toHaveCount(1);
      await uiExpect(turn.getByText("第600段：", { exact: false })).toHaveCount(1);
      await uiExpect(page.getByText(UI.unreadableRecords)).toHaveCount(0);
    });
    await scenario("accept-run-command", async () => {
      await newThread();
      const startedAt = Date.now();
      const turn = await send(RUN_COMMAND_REQUEST);
      const answer = turn.getByText(/工具返回：/);
      const allow = target(turn, UI.approveOnce);
      await uiExpect
        .poll(async () => (await allow.count()) > 0 || (await answer.count()) > 0, {
          timeout: 300_000,
        })
        .toBe(true);
      if ((await allow.count()) > 0) await allow.first().click();
      await uiExpect(answer).toHaveCount(1, { timeout: 300_000 });
      answerTimes.set("accept-run-command", Date.now() - startedAt);
      await uiExpect(answer).toContainText(RUN_COMMAND_OUTPUT);
      await expectFinishedTurnShowsStep(turn, UI.commandStep);
    });
    await scenario("accept-unrelated-no-memory", async () => {
      await newThread();
      const startedAt = Date.now();
      const turn = await send(UNRELATED_REQUEST);
      await uiExpect(turn.getByText(PLAIN_ANSWER)).toBeVisible({ timeout: 120_000 });
      answerTimes.set("accept-unrelated-no-memory", Date.now() - startedAt);
      await uiExpect(target(page, UI.stop)).toHaveCount(0, { timeout: 120_000 });
      const process = turn.locator(UI.turnProcess).last();
      if ((await process.getAttribute("open")) === null)
        await process.locator(UI.turnProcessToggle).click();
      await uiExpect(turn.getByText(UI.memoryFoundStep)).toHaveCount(0);
      await uiExpect(page.getByText(UI.unreadableRecords)).toHaveCount(0);
    });
    await scenario("accept-model-switch", async () => {
      await newThread();
      for (const chosen of ACCEPTANCE_SELECTABLE_MODELS) {
        const picker = page.locator(UI.modelPickerRoot);
        if (!(await picker.evaluate((element) => element.hasAttribute("open"))))
          await page.locator(UI.modelPicker).click();
        await page.locator(UI.modelChooser).click();
        const options = page.locator(UI.modelOption);
        await uiExpect(options).toHaveCount(ACCEPTANCE_SELECTABLE_MODELS.length + 1, {
          timeout: 20_000,
        });
        await options.filter({ hasText: chosen.name }).click();
        const before = installation.modelRequests.length;
        const prompt = `请用${chosen.name}回答`;
        const turn = await send(prompt);
        await uiExpect(turn.getByText(PLAIN_ANSWER)).toBeVisible({ timeout: 120_000 });
        await uiExpect(target(page, UI.stop)).toHaveCount(0, { timeout: 120_000 });
        await uiExpect(turn.getByText(/本轮执行失败/)).toHaveCount(0);
        await uiExpect(target(page, UI.pageError)).toHaveCount(0);
        const answering = installation.modelRequests
          .slice(before)
          .filter(
            (request) =>
              request.path !== "/v1/embeddings" &&
              JSON.stringify(request.body["messages"] ?? []).includes(prompt),
          );
        expect(answering.length).toBeGreaterThan(0);
        expect(answering[0]?.model).toBe(chosen.model);
        for (const other of ACCEPTANCE_SELECTABLE_MODELS)
          if (other.model !== chosen.model)
            expect(answering.map((request) => request.model)).not.toContain(other.model);
      }
    });
    await scenario("accept-conversation-search", async () => {
      await newThread();
      const turn = await send(SEARCH_TOKEN_REQUEST);
      await uiExpect(turn.getByText(PLAIN_ANSWER)).toBeVisible({ timeout: 120_000 });
      await uiExpect(target(page, UI.stop)).toHaveCount(0, { timeout: 120_000 });
      const box = target(target(page, UI.sidebarNavigation), UI.threadSearch);
      const searchFinished = () =>
        page.waitForResponse(
          (response) =>
            response.url().includes("/api/gateway/thread/v3/queries") &&
            response.request().postDataJSON()?.type === "thread.search",
          { timeout: 30_000 },
        );
      const found = searchFinished();
      await box.fill(SEARCH_TOKEN);
      await box.press("Enter");
      expect((await found).ok()).toBe(true);
      await uiExpect(page.locator(UI.threadSearchResult).first()).toBeVisible({ timeout: 30_000 });
      const missed = searchFinished();
      await box.fill("毫无关联xqzvk");
      await box.press("Enter");
      expect((await missed).ok()).toBe(true);
      await uiExpect(page.locator(UI.threadSearchResult)).toHaveCount(0, { timeout: 30_000 });
      await box.fill("");
      await uiExpect(page.locator(UI.threadSearchResult)).toHaveCount(0);
    });
    await scenario("accept-reminders-page", async () => {
      await target(target(page, UI.sidebarNavigation), UI.openReminders).click();
      const reminders = target(page, UI.remindersPage);
      await uiExpect(reminders).toBeVisible({ timeout: 30_000 });
      await uiExpect(target(reminders, UI.pageError)).toHaveCount(0);
      await newThread();
      await uiExpect(reminders).toHaveCount(0, { timeout: 20_000 });
    });
    await scenario("accept-slow-memory-search", async () => {
      await newThread();
      const embeddingsBefore = installation.modelRequests.filter(
        (request) => request.path === "/v1/embeddings",
      ).length;
      installation.delayNextEmbedding(SLOW_MEMORY_SEARCH_DELAY_MS);
      const turn = await send(UNRELATED_REQUEST);
      await uiExpect(turn.getByText(PLAIN_ANSWER)).toBeVisible({ timeout: 120_000 });
      await uiExpect(target(page, UI.stop)).toHaveCount(0, { timeout: 120_000 });
      await uiExpect(turn.getByText(/本轮执行失败/)).toHaveCount(0);
      expect(
        installation.modelRequests.filter((request) => request.path === "/v1/embeddings").length -
          embeddingsBefore,
      ).toBeGreaterThanOrEqual(2);
    });
    await scenario("accept-file-writing-progress", async () => {
      await expectFileWritingProgress();
    });
    await scenario("accept-progress-without-state", async () => {
      const slowState = async (route: Route) => {
        if (route.request().postDataJSON()?.type === "thread.execution_state")
          await new Promise((resolve) => setTimeout(resolve, SLOW_EXECUTION_STATE_MS));
        await route.continue().catch(() => undefined);
      };
      await page.route("**/api/gateway/thread/v3/queries", slowState);
      try {
        await expectFileWritingProgress();
      } finally {
        await page.unroute("**/api/gateway/thread/v3/queries", slowState);
      }
    });
    await scenario("accept-files-page", async () => {
      await target(target(page, UI.sidebarNavigation), UI.openFiles).click();
      const files = target(page, UI.filesPage);
      await uiExpect(files).toBeVisible({ timeout: 30_000 });
      const library = files.locator(UI.filesLibrary);
      await uiExpect(library).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
      await uiExpect(target(files, UI.pageError)).toHaveCount(0);
      await newThread();
      await uiExpect(files).toHaveCount(0, { timeout: 20_000 });
    });
    await scenario("accept-memory-page", async () => {
      await target(target(page, UI.sidebarNavigation), UI.openMemory).click();
      const memory = target(page, UI.memoryPage);
      await uiExpect(memory.getByText(UI.memoryCount)).toBeVisible({
        timeout: 30_000,
      });
      await uiExpect(target(memory, UI.pageError)).toHaveCount(0);
      await newThread();
      await uiExpect(memory).toHaveCount(0, { timeout: 20_000 });
    });
    await scenario("accept-memory-export", async () => {
      await target(target(page, UI.sidebarNavigation), UI.openMemory).click();
      const memory = target(page, UI.memoryPage);
      await uiExpect(memory.getByText(UI.memoryCount)).toBeVisible({ timeout: 30_000 });
      await target(memory, UI.openExport).click();
      const downloading = page.waitForEvent("download", { timeout: 60_000 });
      await target(memory, UI.downloadExport).click();
      const download = await downloading;
      expect(download.suggestedFilename()).toMatch(/^himawari-export-\d{4}-\d{2}-\d{2}\.zip$/u);
      const file = await download.path();
      const head = readFileSync(file).subarray(0, 4);
      expect([...head]).toEqual([0x50, 0x4b, 0x03, 0x04]);
      await uiExpect(memory.getByText(UI.exportDone)).toBeVisible({ timeout: 30_000 });
      await uiExpect(target(memory, UI.pageError)).toHaveCount(0);
      await newThread();
      await uiExpect(memory).toHaveCount(0, { timeout: 20_000 });
    });
    await scenario("accept-export-requires-login", async () => {
      const archive = (host: Page) =>
        host.evaluate(async () => {
          const response = await fetch("/api/data-export/v1/archive", { credentials: "include" });
          const status = response.status;
          const contentType = response.headers.get("content-type");
          let bytes = -1;
          if (status === 200) await response.body?.cancel();
          else bytes = (await response.arrayBuffer()).byteLength;
          return { status, contentType, bytes };
        });
      const stranger = await browser.newContext({ ignoreHTTPSErrors: true });
      try {
        const strangerPage = await stranger.newPage();
        await strangerPage.route("**/api/identity/v1/sessions", (route) => route.abort());
        await strangerPage.goto(`${installation.origin}/`);
        const refused = await archive(strangerPage);
        expect(refused.status).toBe(401);
        expect(refused.bytes).toBe(0);
        expect((await stranger.cookies()).length).toBe(0);
        const allowed = await archive(page);
        expect(allowed.status).toBe(200);
        expect(allowed.contentType).toBe("application/zip");
      } finally {
        await stranger.close();
      }
    });
    await scenario("accept-phone-layout", async () => {
      const phoneContext = await browser.newContext({
        ignoreHTTPSErrors: true,
        locale: "zh-CN",
        viewport: PHONE_VIEWPORT,
        isMobile: true,
        hasTouch: true,
        storageState: await context.storageState(),
      });
      try {
        const phone = await phoneContext.newPage();
        await phone.goto(`${installation.origin}/`);
        await uiExpect(target(phone, UI.composer)).toBeVisible({ timeout: 30_000 });
        await expectPhoneLayout(phone, "chat");
        await target(phone, UI.showList).click();
        await uiExpect(target(phone, UI.sidebarNavigation)).toBeVisible({ timeout: 20_000 });
        await target(phone, UI.openSettings).first().click();
        const dialog = target(phone, UI.settingsDialog);
        const settingsTabs = target(target(dialog, UI.settingsTabs), UI.settingsTab);
        await uiExpect(settingsTabs.first()).toBeVisible({ timeout: 20_000 });
        for (let index = 0; index < (await settingsTabs.count()); index += 1) {
          await settingsTabs.nth(index).click();
          await expectPhoneLayout(phone, `settings tab ${index + 1}`);
        }
        await target(dialog, UI.closeSettings).first().click();
        await uiExpect(dialog).toHaveCount(0, { timeout: 20_000 });
        await target(target(phone, UI.sidebarNavigation), UI.openMemory).click();
        const memory = target(phone, UI.memoryPage);
        await uiExpect(memory.getByText(UI.memoryCount)).toBeVisible({ timeout: 30_000 });
        await uiExpect(target(memory, UI.memoryCarry)).toBeVisible();
        const memoryTabs = target(target(memory, UI.memoryTabs), UI.memoryTab);
        for (let index = 0; index < (await memoryTabs.count()); index += 1) {
          await memoryTabs.nth(index).click();
          await expectPhoneLayout(phone, `memory tab ${index + 1}`);
        }
      } finally {
        await phoneContext.close();
      }
    });
    await scenario("accept-phone-send", async () => {
      const phoneContext = await browser.newContext({
        ignoreHTTPSErrors: true,
        locale: "zh-CN",
        viewport: PHONE_VIEWPORT,
        isMobile: true,
        hasTouch: true,
        storageState: await context.storageState(),
      });
      try {
        const phone = await phoneContext.newPage();
        await phone.goto(`${installation.origin}/`);
        const draft = target(phone, UI.composer);
        await uiExpect(draft).toBeVisible({ timeout: 30_000 });
        const text = "手机上发一条消息";
        const answers = phone.getByText(PLAIN_ANSWER);
        let answersBefore = await answers.count();
        for (let steady = 0; steady < 3; ) {
          await phone.waitForTimeout(500);
          const current = await answers.count();
          steady = current === answersBefore ? steady + 1 : 0;
          answersBefore = current;
        }
        await draft.fill(text);
        await uiExpect(target(phone, UI.send)).toBeEnabled({ timeout: 20_000 });
        await target(phone, UI.send).click();
        await uiExpect(phone.getByText(text).last()).toBeVisible({ timeout: 20_000 });
        await uiExpect(phone.getByText(PLAIN_ANSWER)).toHaveCount(answersBefore + 1, {
          timeout: 120_000,
        });
        await uiExpect(target(phone, UI.stop)).toHaveCount(0, { timeout: 120_000 });
        await expectPhoneLayout(phone, "after sending");
      } finally {
        await phoneContext.close();
      }
    });
    await scenario("accept-after-restart", async () => {
      await installation.stop();
      await installation.start();
      const toggle = await searchToggleUsable(UI.searchEnable);
      await uiExpect(toggle).not.toBeChecked();
      await toggle.click();
      await uiExpect(target(target(page, UI.settingsDialog), UI.searchRevoke)).toBeChecked({
        timeout: 30_000,
      });
      await closeSettings();
      await expectNewsSearchResults("重启后请联网搜索今天的新闻");
    });
  });
});

const realMagpieUrl = process.env["HIMAWARI_REAL_MAGPIE_URL"];
const realMagpieKeyFile = process.env["HIMAWARI_REAL_MAGPIE_KEY_FILE"];
const realMagpieDescribe = enabled && realMagpieUrl && realMagpieKeyFile ? describe : describe.skip;
const REAL_MAGPIE_PROMPT = "只回复 ok";
const REAL_MAGPIE_PRIMARY_NAME = "Product path primary";
const REAL_MAGPIE_OK_LINE = /(?:^|\n)[\s"'“”`*]*ok[\s.。!！"'“”`*]*(?:\n|$)/i;
const REAL_MAGPIE_PRIMARY_MODEL = "deepseek/deepseek-v4.1-flash";

async function openFullModelList() {
  const picker = page.locator(UI.modelPickerRoot);
  if (!(await picker.evaluate((element) => element.hasAttribute("open"))))
    await page.locator(UI.modelPicker).click();
  await page.locator(UI.modelChooser).click();
  const more = page.locator(UI.modelMore);
  if ((await more.count()) > 0) await more.click();
  return page.locator(UI.modelOption);
}

realMagpieDescribe(
  "product path: every Magpie model through the real page",
  { timeout: 3_600_000 },
  () => {
    const sweep: Array<{
      name: string;
      status: "answered" | "failed";
      answerMs: number;
      detail?: string;
      exception?: true;
    }> = [];
    let listedIds: string[] = [];
    let selectable: ReturnType<typeof parseMagpieModelList> = [];
    let optionNames: string[] = [];
    let realKey = "";
    const redact = (text: string) =>
      (realKey ? text.split(realKey).join("<key>") : text)
        .replace(/Bearer\s+\S+/gi, "Bearer <key>")
        .replace(/sk-[A-Za-z0-9_-]+/g, "<key>");

    beforeAll(async () => {
      const artifact = process.env["HIMAWARI_TEST_ARTIFACT"];
      const contextFile = process.env["HIMAWARI_TEST_CONTEXT"];
      if (!artifact || !contextFile)
        throw new Error(
          "PRODUCT_PATH_REQUIRES_ARTIFACT: set HIMAWARI_TEST_ARTIFACT and HIMAWARI_TEST_CONTEXT",
        );
      if (!realMagpieUrl || !realMagpieKeyFile) throw new Error("REAL_MAGPIE_MUST_BE_LOOPBACK");
      assertLoopbackMagpieUrl(realMagpieUrl);
      const key = (await readFile(realMagpieKeyFile, "utf8")).trim();
      realKey = key;
      const listing = await fetch(`${realMagpieUrl}/models`, {
        headers: { authorization: `Bearer ${key}` },
        redirect: "error",
      });
      if (!listing.ok) throw new Error(`REAL_MAGPIE_LIST_FAILED ${listing.status}`);
      const entries = parseMagpieModelList(await listing.json());
      listedIds = entries.map((entry) => entry.id);
      selectable = entries.filter(
        (entry) =>
          !entry.id.startsWith("group/") &&
          !entry.id.startsWith("auto/") &&
          entry.id !== REAL_MAGPIE_PRIMARY_MODEL &&
          entry.toolCall &&
          entry.acceptsText,
      );
      await mkdir(outputDirectory, { recursive: true });
      installation = await installProductPath({
        artifact,
        context: contextFile,
        logDirectory: path.join(outputDirectory, "real-magpie-service-logs"),
        approval: "ask",
        realMagpie: { url: realMagpieUrl, keyFile: realMagpieKeyFile },
      });
      await installation.start();
      browser = await chromium.launch({
        channel: process.env["HIMAWARI_PRODUCT_PATH_BROWSER_CHANNEL"] ?? "chrome",
        args: [`--host-resolver-rules=MAP ${publicHost}:443 127.0.0.1:${installation.frontPort}`],
      });
      context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "zh-CN" });
      page = await context.newPage();
    }, 400_000);

    afterAll(async () => {
      await cleanupWithEvidence("real-magpie-teardown", [
        [
          "sweep-record",
          async () =>
            writeFile(
              path.join(outputDirectory, "real-magpie-sweep.json"),
              `${JSON.stringify(
                { schema: "himawari-real-magpie-sweep.v1", listedIds, optionNames, sweep },
                null,
                2,
              )}\n`,
            ),
        ],
        ["installation", async () => installation?.close()],
        ["browser", async () => browser?.close()],
      ]);
    }, 120_000);

    it("sends one message with every selectable model and gets a reply from each", async () => {
      const response = await page.goto(`${installation.origin}/`);
      expect(response?.status()).toBe(200);
      await uiExpect(composer()).toBeVisible({ timeout: 30_000 });
      await newThread();
      const options = await openFullModelList();
      const names = (await options.allInnerTexts()).map(
        (text) => text.split("\n")[0]?.trim() ?? "",
      );
      optionNames = names;
      expect(names.length, JSON.stringify({ names, listedIds })).toBe(selectable.length + 1);
      expect(names).toContain(REAL_MAGPIE_PRIMARY_NAME);
      for (const entry of selectable) expect(names).toContain(entry.label);
      await page.keyboard.press("Escape");
      const order = names
        .map((name, index) => ({ name, index }))
        .sort(
          (left, right) =>
            Number(left.name === REAL_MAGPIE_PRIMARY_NAME) -
            Number(right.name === REAL_MAGPIE_PRIMARY_NAME),
        );
      for (const { name, index } of order) {
        const started = Date.now();
        try {
          await newThread();
          const list = await openFullModelList();
          await list.nth(index).click();
          await uiExpect(page.locator(`${UI.modelPicker} .model-name`)).toHaveText(name, {
            timeout: 20_000,
          });
          const turn = await send(REAL_MAGPIE_PROMPT);
          const agent = turn.locator(".thread-message-agent");
          let outcome: "answered" | "failed" | "timeout" = "timeout";
          let last = "";
          const deadline = Date.now() + 180_000;
          while (Date.now() < deadline) {
            last =
              (await agent
                .last()
                .innerText()
                .catch(() => "")) ?? "";
            if (REAL_MAGPIE_OK_LINE.test(last)) {
              outcome = "answered";
              break;
            }
            if ((await turn.getByText(/本轮执行失败/).count()) > 0) {
              outcome = "failed";
              break;
            }
            await page.waitForTimeout(500);
          }
          await uiExpect(target(page, UI.stop)).toHaveCount(0, { timeout: 180_000 });
          sweep.push({
            name,
            status: outcome === "answered" ? "answered" : "failed",
            answerMs: Date.now() - started,
            ...(outcome === "answered"
              ? {}
              : {
                  detail: redact(
                    outcome === "failed" ? "turn-failed" : `no-reply reply=${last.slice(0, 120)}`,
                  ),
                  ...(outcome === "timeout" ? { exception: true as const } : {}),
                }),
          });
        } catch (error) {
          const send = target(page, UI.send);
          const state = await Promise.all([
            send.isEnabled().catch(() => "unknown"),
            composer()
              .inputValue()
              .catch(() => "unknown"),
            page
              .locator("body")
              .innerText()
              .catch(() => ""),
          ]);
          await capture(`real-magpie-failed-${index}`).catch(() => undefined);
          sweep.push({
            name,
            status: "failed",
            answerMs: Date.now() - started,
            detail: redact(
              `${String(error).slice(0, 200)} | send=${state[0]} draft=${String(state[1]).slice(0, 40)} page=${String(state[2]).replace(/\s+/g, " ").slice(0, 300)}`,
            ),
            exception: true,
          });
        }
      }
      const unexpected = sweep.filter(
        (entry) => entry.status === "failed" && entry.name !== REAL_MAGPIE_PRIMARY_NAME,
      );
      expect(unexpected, JSON.stringify(unexpected)).toEqual([]);
      const negative = sweep.find((entry) => entry.name === REAL_MAGPIE_PRIMARY_NAME);
      expect(negative?.status).toBe("failed");
      expect(negative?.exception, JSON.stringify(negative)).toBeUndefined();
    });
  },
);
