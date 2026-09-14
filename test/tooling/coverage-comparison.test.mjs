import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ missingObject: false, snapshots: [] }));
vi.mock("node:child_process", async (original) => {
  const actual = await original();
  return {
    ...actual,
    execFileSync: (exe, args, opts) => {
      if (state.missingObject && args[0] === "cat-file") throw new Error("missing object");
      return actual.execFileSync(exe, args, opts);
    },
  };
});
vi.mock("../../scripts/ci/context.mjs", () => ({
  createContext: ({ root, base, env }) => ({ testedSha: base, root, hosted: env.GITHUB_ACTIONS }),
}));
vi.mock("../../scripts/ci/check-coverage.mjs", async (original) => ({
  ...(await original()),
  createSnapshot: (options) => {
    state.snapshots.push(options);
    return { bound: options.context.testedSha };
  },
}));

import { collectSources, sourceTreeDigest } from "../../scripts/ci/check-coverage.mjs";
import { readJson, repositoryRoot } from "../../scripts/ci/contracts.mjs";
import {
  prepareCoverageComparison,
  repairBaselineHarness,
  retainComparisonEvidence,
} from "../../scripts/ci/coverage-comparison.mjs";

const directories = [];
afterEach(() => {
  state.missingObject = false;
  state.snapshots = [];
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const parent = mkdtempSync(path.join(os.tmpdir(), "coverage-comparison-test-"));
  directories.push(parent);
  const root = path.join(parent, "candidate");
  mkdirSync(root);
  const put = (name, value) => {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  };
  const policy = {
    ...readJson(path.join(repositoryRoot, "ci/coverage-policy.json")),
    baseline: null,
  };
  put(".gitignore", ".ci-output/\n");
  put("packages/example/src/index.ts", "export const value = 1;\n");
  put("ci/coverage-policy.json", policy);
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q");
  git("config", "user.name", "Comparison fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("add", ".");
  git("commit", "-qm", "baseline");
  const sourceSha = git("rev-parse", "HEAD");
  const acceptedPolicy = {
    ...policy,
    baseline: { sourceSha, sourceTreeSha256: sourceTreeDigest(collectSources(root, policy)) },
  };
  const output = path.join(root, ".ci-output/report");
  mkdirSync(output, { recursive: true });
  const owned = [],
    calls = [];
  const options = {
    root,
    context: { repository: "sixianli/himawari-agent" },
    policy,
    acceptedPolicy,
    tools: { node: process.execPath },
    toolsDirectory: path.join(parent, "tools"),
    env: { GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "123", TMPDIR: os.tmpdir() },
    output,
    own: (dir) => owned.push(dir),
    command: async (name, exe, args, opts) => {
      calls.push({ name, exe, args, opts });
      if (["comparison-clone", "comparison-checkout"].includes(name))
        execFileSync(exe, args, { cwd: opts.cwd, stdio: "pipe" });
      if (name === "comparison-fetch") throw new Error("offline fetch failure");
      if (name === "comparison-build") {
        const dir = args[args.indexOf("--output") + 1];
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "runtime.tar.gz"), "synthetic archive");
      }
      if (name === "comparison-tests") {
        const dir = args[args.indexOf("--coverage.reportsDirectory") + 1];
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "coverage-final.json"), "{}");
        writeFileSync(path.join(dir, "lcov.info"), "TN:fixture\n");
        writeFileSync(path.join(path.dirname(dir), "tests.json"), "{}");
      }
    },
  };
  return { options, calls, owned, put };
}
describe("旧基线独立采集与证据保留", () => {
  it("运行旧源码自己的构建并传入同一归档与context，保留四项目测量证据", async () => {
    const f = fixture();
    const result = await prepareCoverageComparison(f.options);
    expect(f.calls.map((c) => c.name)).toEqual([
      "comparison-clone",
      "comparison-checkout",
      "comparison-install",
      "comparison-build",
      "comparison-tests",
    ]);
    const checkout = JSON.parse(readFileSync(result.filename, "utf8")).root;
    expect(checkout.startsWith(f.options.root)).toBe(false);
    const install = f.calls.find((c) => c.name === "comparison-install");
    expect(install.args[install.args.indexOf("--tools") + 1]).toBe(f.options.toolsDirectory);
    const build = f.calls.find((c) => c.name === "comparison-build");
    expect(build.args[0]).toBe(path.join(checkout, "scripts/ci/build.mjs"));
    const collection = f.calls.at(-1);
    expect(collection.args.filter((a) => a === "--project")).toHaveLength(4);
    expect(collection.opts.env.GITHUB_ACTIONS).toBe("false");
    expect(collection.opts.env).not.toHaveProperty("GITHUB_RUN_ID");
    expect(collection.opts.env.HIMAWARI_TEST_ARTIFACT).toBe(
      path.join(result.evidence, "build/runtime.tar.gz"),
    );
    expect(
      JSON.parse(readFileSync(collection.opts.env.HIMAWARI_TEST_CONTEXT, "utf8")).testedSha,
    ).toBe(f.options.acceptedPolicy.baseline.sourceSha);
    expect(state.snapshots[0].root).toBe(checkout);
    const retained = retainComparisonEvidence(result.evidence, f.options.output);
    expect(retained).toHaveLength(6);
    for (const dir of f.owned) rmSync(dir, { recursive: true });
    expect(retained.every((item) => existsSync(item.path))).toBe(true);
  });
  it("对冻结历史测试执行实际patch，保持生产源码且记录两个精确摘要", () => {
    const f = fixture();
    for (const [name, ref] of [
      ["policy.test.mjs", "b1baf8e43f7d7dc138acc6ff488ad2c4a414ea40"],
      ["artifact.test.mjs", "f2ce494fa8d7ee1e7f67bbe4093befabe4f2cbcb"],
    ]) {
      f.put(
        `test/tooling/${name}`,
        execFileSync("git", ["show", `${ref}:test/tooling/${name}`], {
          cwd: repositoryRoot,
          encoding: "utf8",
          stdio: "pipe",
        }),
      );
    }
    execFileSync("git", ["add", "test"], { cwd: f.options.root });
    execFileSync("git", ["commit", "-qm", "frozen harness fixtures"], { cwd: f.options.root });
    const before = sourceTreeDigest(collectSources(f.options.root, f.options.policy));
    const receipt = repairBaselineHarness(
      f.options.root,
      "c9723c9054f1552b3c2356f26e86ddc9efca61ad",
    );
    expect(receipt).toHaveLength(2);
    expect(sourceTreeDigest(collectSources(f.options.root, f.options.policy))).toBe(before);
    const policyTest = readFileSync(
      path.join(f.options.root, "test/tooling/policy.test.mjs"),
      "utf8",
    );
    expect(policyTest).toContain("it.each(actualTests)");
    expect(policyTest).toContain("expect(inspected.emptySuites).toEqual([])");
    expect(
      readFileSync(path.join(f.options.root, "test/tooling/artifact.test.mjs"), "utf8"),
    ).toContain("normalizeModes: true");
    expect(() =>
      repairBaselineHarness(f.options.root, "c9723c9054f1552b3c2356f26e86ddc9efca61ad"),
    ).toThrow("HARNESS_SOURCE_CHANGED");
  });
  it("历史修复只适用于已记录的基线及完整原始测试文件", () => {
    const f = fixture();
    expect(
      repairBaselineHarness(f.options.root, f.options.acceptedPolicy.baseline.sourceSha),
    ).toEqual([]);
    f.put("test/tooling/policy.test.mjs", "changed fixture");
    expect(() =>
      repairBaselineHarness(f.options.root, "c9723c9054f1552b3c2356f26e86ddc9efca61ad"),
    ).toThrow("HARNESS_SOURCE_CHANGED");
  });
  it("拒绝没有基线的比较，不创建临时checkout", async () => {
    const f = fixture();
    f.options.acceptedPolicy = null;
    await expect(prepareCoverageComparison(f.options)).rejects.toThrow("BASELINE_REQUIRED");
    expect(f.owned).toEqual([]);
  });
  it("旧源码摘要不匹配时不安装依赖或执行测试", async () => {
    const f = fixture();
    f.options.acceptedPolicy.baseline.sourceTreeSha256 = "0".repeat(64);
    await expect(prepareCoverageComparison(f.options)).rejects.toThrow("SOURCE_MISMATCH");
    expect(f.calls.map((c) => c.name)).toEqual(["comparison-clone", "comparison-checkout"]);
  });
  it.each(["comparison-install", "comparison-build", "comparison-tests"])(
    "%s失败不返回可通过的清单，并交还临时目录所有权",
    async (stage) => {
      const f = fixture();
      const original = f.options.command;
      f.options.command = async (...args) => {
        if (args[0] === stage) throw new Error("controlled failure");
        return original(...args);
      };
      await expect(prepareCoverageComparison(f.options)).rejects.toThrow("controlled failure");
      expect(f.owned).toHaveLength(1);
      expect(existsSync(path.join(f.options.output, "comparison-manifest.json"))).toBe(false);
      expect(
        retainComparisonEvidence(
          path.join(f.owned[0], "source/.ci-output/comparison"),
          f.options.output,
        ).length,
      ).toBeGreaterThan(0);
    },
  );
  it("旧merge对象缺失时只请求已接受源码的完整SHA，保留fetch失败", async () => {
    const f = fixture();
    state.missingObject = true;
    await expect(prepareCoverageComparison(f.options)).rejects.toThrow("offline fetch failure");
    expect(f.calls.at(-1).args).toEqual([
      "fetch",
      "--no-tags",
      "https://github.com/sixianli/himawari-agent.git",
      f.options.acceptedPolicy.baseline.sourceSha,
    ]);
  });
  it("拒绝不合法的远程仓库标识", async () => {
    const f = fixture();
    state.missingObject = true;
    f.options.context.repository = "../escape/repo";
    await expect(prepareCoverageComparison(f.options)).rejects.toThrow("REPOSITORY_INVALID");
    expect(f.calls).toHaveLength(1);
  });
  it("拒绝漏失构建归档及采集源范围变化", async () => {
    const f = fixture();
    const original = f.options.command;
    f.options.command = async (...args) => {
      await original(...args);
      if (args[0] === "comparison-build")
        rmSync(path.join(f.owned[0], "source/.ci-output/comparison/build/runtime.tar.gz"));
    };
    await expect(prepareCoverageComparison(f.options)).rejects.toThrow("ARTIFACT_REQUIRED");
    const other = fixture();
    other.options.policy = { ...other.options.policy, exclude: [] };
    await expect(prepareCoverageComparison(other.options)).rejects.toThrow(
      "COLLECTION_DIFFERS:exclude",
    );
  });
});
