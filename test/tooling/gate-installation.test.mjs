import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ calls: [], fail: false }));
vi.mock("node:child_process", async (original) => ({
  ...(await original()),
  execFileSync: (command, args, options) => {
    state.calls.push({ command, args, options });
    if (state.fail) throw new Error("fixture npm failure");
    const directory = args[args.indexOf("--prefix") + 1];
    mkdirSync(path.join(directory, "node_modules"), { recursive: true });
    writeFileSync(path.join(directory, "node_modules/installed.txt"), "npm boundary completed");
  },
}));

import { gateLock, installGateDependencies } from "../../scripts/ci/install-gate-dependencies.mjs";

let root;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "gate-installation-"));
  copyFileSync("package-lock.json", path.join(root, "package-lock.json"));
  state.calls = [];
  state.fail = false;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("从锁定工具运行隔离的 npm ci，只发布成功安装的最小依赖目录", () => {
  const result = installGateDependencies({ root, tools: ".ci-output/locked-tools" });
  const directory = path.join(root, ".ci-output/gate-runtime");
  const projected = JSON.parse(readFileSync(path.join(directory, "package-lock.json"), "utf8"));
  const source = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  expect(result).toEqual({ packages: 7 });
  expect(
    JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")).dependencies,
  ).toEqual({
    ajv: source.packages["node_modules/ajv"].version,
    typescript: source.packages["node_modules/typescript"].version,
    yaml: source.packages["node_modules/yaml"].version,
  });
  for (const [location, entry] of Object.entries(projected.packages)) {
    if (location) expect(entry).toEqual(source.packages[location]);
  }
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]).toMatchObject({
    command: path.join(root, ".ci-output/locked-tools/bin/node"),
    args: [
      path.join(root, ".ci-output/locked-tools/npm/package/bin/npm-cli.js"),
      "ci",
      "--prefix",
      directory,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      path.join(root, ".ci-output/npm-cache"),
    ],
    options: {
      cwd: root,
      stdio: "inherit",
      timeout: 120_000,
      env: { HOME: path.join(directory, "environment/home"), CI: "true" },
    },
  });
  expect(realpathSync(path.join(root, "node_modules"))).toBe(path.join(directory, "node_modules"));
  expect(readFileSync(path.join(root, "node_modules/installed.txt"), "utf8")).toBe(
    "npm boundary completed",
  );
});

it.each([
  ["node_modules", "GATE_REQUIRES_CLEAN_DEPENDENCIES"],
  [".ci-output/gate-runtime", "GATE_RUNTIME_EXISTS"],
])("拒绝覆盖现有 %s", (location, reason) => {
  const directory = path.join(root, location);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "keep.txt"), "existing work");
  expect(() => installGateDependencies({ root })).toThrow(reason);
  expect(readFileSync(path.join(directory, "keep.txt"), "utf8")).toBe("existing work");
  expect(state.calls).toHaveLength(0);
});

it("npm 失败时不暴露依赖入口，保留安装输入供诊断且拒绝重用残留目录", () => {
  state.fail = true;
  expect(() => installGateDependencies({ root })).toThrow("fixture npm failure");
  expect(existsSync(path.join(root, "node_modules"))).toBe(false);
  expect(existsSync(path.join(root, ".ci-output/gate-runtime/package-lock.json"))).toBe(true);
  expect(() => installGateDependencies({ root })).toThrow("GATE_RUNTIME_EXISTS");
  expect(state.calls).toHaveLength(1);
});

it("共享依赖和循环依赖只投影一次，嵌套依赖按最近父目录解析", () => {
  const entry = (dependencies = {}) => ({
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz",
    integrity: "fixture-integrity",
    dependencies,
  });
  const lock = {
    lockfileVersion: 3,
    packages: {
      "node_modules/ajv": entry({ a: "1.0.0", shared: "1.0.0" }),
      "node_modules/ajv/node_modules/a": entry({ b: "1.0.0" }),
      "node_modules/ajv/node_modules/b": entry({ a: "1.0.0" }),
      "node_modules/typescript": entry({ shared: "1.0.0" }),
      "node_modules/yaml": entry(),
      "node_modules/shared": entry(),
    },
  };
  const result = gateLock(lock);
  expect(Object.keys(result.lock.packages)).toHaveLength(7);
  for (const [location, value] of Object.entries(lock.packages))
    expect(result.lock.packages[location]).toEqual(value);
});
