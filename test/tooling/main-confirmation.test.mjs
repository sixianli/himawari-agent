import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Mock expensive process boundaries; keep orchestration, report admission,
// artifact resolution, hashing and test-result validation real.
const state = vi.hoisted(() => ({ calls: [], fail: "", outcome: {}, report: "passed" }));
vi.mock("../../scripts/ci/main-evidence.mjs", () => ({
  main: async () => {
    state.calls.push("evidence");
    if (state.fail === "evidence") throw new Error("private diagnostic detail");
    return { mode: "light", pr: 42, runId: 123456, attempt: 2 };
  },
}));
vi.mock("../../scripts/ci/context.mjs", () => ({
  createContext: ({ base }) => ({ baseSha: base, headSha: "fixture-head" }),
}));
vi.mock("../../scripts/ci/install-tools.mjs", async (original) => ({
  ...(await original()),
  verifyInstalledTools: async () => {
    state.calls.push("tools");
    if (state.fail === "tools") throw new Error("MAIN_TOOLS_INVALID");
    return { executables: { node: process.execPath, python: "/fixture/python" } };
  },
}));
vi.mock("../../scripts/ci/run.mjs", () => ({
  runCheck: async ({ checkId, matrixKey, output, context }) => {
    state.calls.push(`${checkId}:${matrixKey}`);
    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, "context.json"), JSON.stringify(context));
    if (checkId === "build") writeFileSync(path.join(output, "artifact.tar.gz"), "fresh build");
    return {
      status: state.fail === checkId ? "failed" : "passed",
      artifacts: [{ path: state.fail === "artifact" ? "../escape.tar.gz" : "artifact.tar.gz" }],
    };
  },
}));
vi.mock("../../scripts/ci/publish.mjs", async (original) => ({
  ...(await original()),
  main: async (args) => {
    state.calls.push(`publish:${path.basename(args[1])}`);
  },
}));
vi.mock("../../scripts/ci/execute.mjs", async (original) => ({
  ...(await original()),
  execute: async (command, args, options) => {
    state.calls.push("smoke");
    state.process = { command, args, options };
    const name = path.join(options.cwd, "test/integration/installable-node-services.test.ts");
    const assertions = Array.from({ length: 4 }, () => ({ status: "passed" }));
    if (["failed", "pending"].includes(state.report)) assertions[0].status = state.report;
    const testResults = [{ name, assertionResults: assertions }];
    if (state.report === "wrong-file")
      testResults[0].name = path.join(options.cwd, "other.test.ts");
    if (state.report === "extra-file") testResults.push({ name, assertionResults: assertions });
    if (state.report !== "missing")
      writeFileSync(
        args.find((arg) => arg.startsWith("--outputFile=")).slice(13),
        JSON.stringify({
          success: !["failed", "pending"].includes(state.report),
          testResults,
        }),
      );
    return { exitCode: 0, ...state.outcome };
  },
}));

import { confirmMain } from "../../scripts/ci/main-confirm.mjs";

let root;
const readPublic = (name) =>
  JSON.parse(readFileSync(path.join(root, ".ci-output/main-public", name), "utf8"));
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "main-confirmation-"));
  Object.assign(state, { calls: [], fail: "", outcome: {}, report: "passed", process: undefined });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("先重新验证资格，再构建、扫描新产物并执行安装服务测试，发布可核对的结果", async () => {
  const result = await confirmMain({ root, base: "fixture-base" });
  expect(state.calls).toEqual([
    "evidence",
    "tools",
    "build:linux-x64",
    "publish:build",
    "security:default",
    "publish:security",
    "smoke",
  ]);
  expect(result).toEqual({
    schemaVersion: 1,
    kind: "main-confirmation",
    status: "passed",
    context: { baseSha: "fixture-base", headSha: "fixture-head" },
    priorPr: 42,
    priorRunId: 123456,
    priorAttempt: 2,
    artifactSha256: createHash("sha256").update("fresh build").digest("hex"),
    smoke: { files: 1, executed: 4, passed: 4, failed: 0, skipped: 0 },
  });
  expect(readPublic("summary.json")).toEqual(result);
  expect(readPublic("smoke.json").testResults[0].assertionResults).toHaveLength(4);
  expect(state.process.command).toBe(process.execPath);
  expect(state.process.args).toContain("test/integration/installable-node-services.test.ts");
  expect(
    state.process.args.slice(
      state.process.args.indexOf("--retry"),
      state.process.args.indexOf("--retry") + 2,
    ),
  ).toEqual(["--retry", "0"]);
  expect(state.process.options).toMatchObject({
    cwd: root,
    timeoutMs: 300_000,
    env: {
      HIMAWARI_TEST_ARTIFACT: path.join(root, ".ci-output/main-check/build/artifact.tar.gz"),
      HIMAWARI_TEST_CONTEXT: path.join(root, ".ci-output/main-check/build/context.json"),
      HIMAWARI_CI_PYTHON: "/fixture/python",
    },
  });
  expect(state.process.options.env.HOME).toContain("main-check/smoke/environment");
});

it.each([
  ["evidence", ["evidence"], "MAIN_CONFIRMATION_FAILED"],
  ["tools", ["evidence", "tools"], "MAIN_TOOLS_INVALID"],
  ["build", ["evidence", "tools", "build:linux-x64", "publish:build"], "MAIN_CHECK_FAILED:build"],
  [
    "security",
    [
      "evidence",
      "tools",
      "build:linux-x64",
      "publish:build",
      "security:default",
      "publish:security",
    ],
    "MAIN_CHECK_FAILED:security",
  ],
])("%s 失败后停止下一阶段，保留受控失败报告", async (fail, calls, reason) => {
  state.fail = fail;
  await expect(confirmMain({ root })).rejects.toThrow();
  expect(state.calls).toEqual(calls);
  expect(readPublic("failure.json")).toEqual({
    kind: "main-confirmation",
    status: "failed",
    reason,
  });
  expect(existsSync(path.join(root, ".ci-output/main-public/summary.json"))).toBe(false);
});

it.each([{ exitCode: 1 }, { error: "spawn failed" }, { termination: "timeout" }])(
  "拒绝失败或中止的测试进程 %j，即使测试报告声称成功",
  async (outcome) => {
    state.outcome = outcome;
    await expect(confirmMain({ root })).rejects.toThrow("MAIN_SMOKE_FAILED");
    expect(readPublic("smoke.json").success).toBe(true);
    expect(readPublic("failure.json").reason).toBe("MAIN_SMOKE_FAILED");
    expect(existsSync(path.join(root, ".ci-output/main-public/summary.json"))).toBe(false);
  },
);

it.each(["failed", "pending", "wrong-file", "extra-file", "missing"])(
  "拒绝不完整的安装服务测试证据：%s",
  async (report) => {
    state.report = report;
    await expect(confirmMain({ root })).rejects.toThrow(
      report === "missing" ? "ENOENT" : "MAIN_SMOKE_INCOMPLETE",
    );
    expect(readPublic("failure.json").status).toBe("failed");
    expect(existsSync(path.join(root, ".ci-output/main-public/summary.json"))).toBe(false);
  },
);

it("拒绝构建目录以外的产物，不启动安装服务测试", async () => {
  state.fail = "artifact";
  await expect(confirmMain({ root })).rejects.toThrow();
  expect(state.calls).not.toContain("smoke");
  expect(readPublic("failure.json").status).toBe("failed");
});
