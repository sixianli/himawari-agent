import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { gateLock } from "../../scripts/ci/install-gate-dependencies.mjs";
import { confirmMain, publishMainMetadata } from "../../scripts/ci/main-confirm.mjs";
import { validateMainWorkflow } from "../../scripts/ci/main-workflow.mjs";

const temporary = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
const scratch = () => {
  const root = mkdtempSync(path.join(tmpdir(), "main-report-test-"));
  temporary.push(root);
  return root;
};

it("main 确认保留受控失败报告，不把缺少资格写成成功", async () => {
  const root = scratch();
  await expect(confirmMain({ root })).rejects.toThrow("MAIN_EVIDENCE_NO_LONGER_VALID");
  const result = JSON.parse(readFileSync(path.join(root, ".ci-output/main-public/failure.json")));
  expect(result).toEqual({
    kind: "main-confirmation",
    status: "failed",
    reason: "MAIN_EVIDENCE_NO_LONGER_VALID",
  });
  expect(existsSync(path.join(root, ".ci-output/main-public/summary.json"))).toBe(false);
});

it("main 报告只在公开输出检查通过后发布", async () => {
  const root = scratch();
  await publishMainMetadata({ root, name: "summary.json", value: { status: "passed", count: 4 } });
  expect(JSON.parse(readFileSync(path.join(root, ".ci-output/main-public/summary.json")))).toEqual({
    status: "passed",
    count: 4,
  });
  await expect(publishMainMetadata({ root, name: "../escape.json", value: {} })).rejects.toThrow(
    "MAIN_METADATA_NAME",
  );
  expect(existsSync(path.join(root, ".ci-output/escape.json"))).toBe(false);
});

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
describe("CI 最小依赖安装", () => {
  it("保留锁文件中的版本和完整性，只安装报告校验依赖", () => {
    const result = gateLock(lock);
    expect(Object.keys(result.manifest.dependencies).sort()).toEqual(["ajv", "typescript", "yaml"]);
    expect(Object.keys(result.lock.packages).length).toBeLessThan(15);
    for (const [location, entry] of Object.entries(result.lock.packages)) {
      if (location) expect(entry).toEqual(lock.packages[location]);
    }
    expect(result.lock.packages["node_modules/better-sqlite3"]).toBeUndefined();
    expect(result.lock.packages["node_modules/ajv/node_modules/fast-uri"]).toBeDefined();
  });
  it.each(["hasInstallScript", "link"])("拒绝需要额外执行的依赖：%s", (field) => {
    const value = structuredClone(lock);
    value.packages["node_modules/ajv"][field] = true;
    expect(() => gateLock(value)).toThrow("GATE_DEPENDENCY_UNSAFE");
  });
  it("拒绝缺失的传递依赖", () => {
    const value = structuredClone(lock);
    delete value.packages["node_modules/json-schema-traverse"];
    expect(() => gateLock(value)).toThrow("GATE_DEPENDENCY_MISSING");
  });
});
it("完整 CI 使用缓存与最小汇总依赖，并保留全部检查", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  expect(workflow.on.push).toBeUndefined();
  expect(workflow.on.workflow_call).toBeDefined();
  expect(Object.keys(workflow.jobs)).toHaveLength(9);
  expect(
    workflow.jobs.required.steps.some((s) => s.run?.includes("install-gate-dependencies.mjs")),
  ).toBe(true);
  expect(
    workflow.jobs.required.steps.some((s) => s.run?.includes("install-dependencies.mjs")),
  ).toBe(false);
  for (const job of Object.values(workflow.jobs)) {
    expect(job.steps.some((s) => s.uses?.startsWith("actions/cache@"))).toBe(true);
  }
});

it("main 工作流不能隐藏检查失败或关闭完整 CI 回退", () => {
  const text = readFileSync(".github/workflows/main.yml", "utf8");
  const tools = JSON.parse(readFileSync("ci/toolchain-lock.json", "utf8"));
  expect(validateMainWorkflow(text, tools)).toEqual({ jobs: 3 });
  expect(() =>
    validateMainWorkflow(
      text.replace("always() && (needs.plan.result", "(needs.plan.result"),
      tools,
    ),
  ).toThrow("fallback");
  expect(() =>
    validateMainWorkflow(
      text.replace("run: .ci-output/tools/bin/node scripts/ci/main-confirm.mjs", "run: true"),
      tools,
    ),
  ).toThrow();
});
