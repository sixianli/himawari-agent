import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { observeResources } from "../../scripts/ci/resources.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "himawari-resource-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("node:child_process");
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("记录实际分配磁盘的采样峰值下界，不重复计入仓库内工具", async () => {
  const root = fixture();
  const toolsDirectory = path.join(root, "tools");
  mkdirSync(toolsDirectory);
  writeFileSync(path.join(root, "input"), Buffer.alloc(4096, 1));
  const { stop } = await observeResources({ root, toolsDirectory, intervalMs: 2 });
  writeFileSync(path.join(toolsDirectory, "download"), Buffer.alloc(128 * 1024, 2));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const report = await stop();
  expect(report.status).toBe("measured");
  expect(report.peakIsLowerBound).toBe(true);
  expect(report.scopes).toHaveLength(1);
  expect(report.scopes[0].samples).toBeGreaterThanOrEqual(2);
  expect(report.scopes[0].peakBytes).toBeGreaterThan(report.scopes[0].firstBytes);
  expect(report.scopes[0].lastBytes).toBe(report.scopes[0].peakBytes);
  expect(report.hardware.cpus).toBeGreaterThan(0);
  expect(JSON.stringify(report)).not.toContain(root);
});

it("仓库外的工具单独计量，缺失目录明确记录不完整", async () => {
  const root = fixture();
  const toolsDirectory = fixture();
  const { stop } = await observeResources({ root, toolsDirectory });
  rmSync(toolsDirectory, { recursive: true });
  const report = await stop();
  expect(report.status).toBe("incomplete");
  expect(report.scopes.map((scope) => scope.label)).toEqual(["workspace", "tools"]);
  expect(report.schemaVersion).toBe(2);
  expect(report.failureCount).toBe(1);
  expect(report.droppedFailureCount).toBe(0);
  expect(report.errors).toHaveLength(1);
  expect(report.errors[0]).toMatchObject({
    scope: "tools",
    phase: "final",
    exitCode: 1,
    errorCode: null,
    signal: null,
    killed: false,
    stderr: { truncated: false },
  });
  expect(report.errors[0].stderr.text).toContain("<tools>");
  expect(JSON.stringify(report)).not.toContain(toolsDirectory);
  expect(report.scopes[1]).toMatchObject({ attempts: 2, samples: 1, failedSamples: 1 });
});

it("未提供工具目录仍有完整起止采样", async () => {
  const { stop } = await observeResources({ root: fixture() });
  const report = await stop();
  expect(report.scopes[0].samples).toBe(2);
  expect(Date.parse(report.completedAt)).toBeGreaterThanOrEqual(Date.parse(report.startedAt));
});

async function controlledDu(outcomes) {
  vi.resetModules();
  const execute = vi.fn(async () => {
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome ?? { stdout: "4 root\n", stderr: "" };
  });
  const command = () => {};
  command[promisify.custom] = execute;
  vi.doMock("node:child_process", () => ({ execFile: command }));
  return { observe: (await import("../../scripts/ci/resources.mjs")).observeResources, execute };
}

it("保留失败后成功的首次诊断，区分进程退出、解析失败和超时", async () => {
  vi.useFakeTimers();
  const { observe, execute } = await controlledDu([
    Object.assign(new Error("du failed"), {
      code: 1,
      stdout: "8 partial\n",
      stderr: "Permission denied\n",
    }),
    { stdout: "not a sample", stderr: "parse diagnostic" },
    Object.assign(new Error("timeout"), {
      code: null,
      signal: "SIGTERM",
      killed: true,
      stdout: "",
      stderr: "",
    }),
    { stdout: "16 complete\n", stderr: "" },
  ]);
  const { stop } = await observe({ root: fixture(), intervalMs: 10 });
  await vi.advanceTimersByTimeAsync(20);
  const result = await stop();
  expect(execute).toHaveBeenCalledTimes(4);
  expect(result.status).toBe("incomplete");
  expect(result.failureCount).toBe(3);
  expect(result.scopes[0]).toMatchObject({
    attempts: 4,
    samples: 1,
    failedSamples: 3,
    peakBytes: 16384,
  });
  expect(
    result.errors.map(({ exitCode, errorCode, signal, killed }) => ({
      exitCode,
      errorCode,
      signal,
      killed,
    })),
  ).toEqual([
    { exitCode: 1, errorCode: null, signal: null, killed: false },
    { exitCode: 0, errorCode: "INVALID_DISK_SAMPLE", signal: null, killed: false },
    { exitCode: null, errorCode: null, signal: "SIGTERM", killed: true },
  ]);
  expect(result.errors[0]).toMatchObject({
    phase: "initial",
    sampleId: 1,
    stdout: { text: "8 partial\n" },
    stderr: { text: "Permission denied\n" },
  });
  for (const error of result.errors) {
    expect(Date.parse(error.completedAt)).toBeGreaterThanOrEqual(Date.parse(error.startedAt));
    expect(error.durationMs).toBeGreaterThanOrEqual(0);
  }
});

it("诊断在截断前复用脱敏且有界保留首次失败与失败总数", async () => {
  vi.useFakeTimers();
  const root = fixture();
  const sentinel = "Bearer " + "s".repeat(32);
  const failure = Object.assign(new Error("failed"), {
    code: 1,
    stdout: root + " " + sentinel,
    stderr: "界".repeat(2000) + " " + sentinel,
  });
  const { observe } = await controlledDu(Array.from({ length: 42 }, () => failure));
  const { stop } = await observe({ root, intervalMs: 1 });
  await vi.advanceTimersByTimeAsync(40);
  const result = await stop();
  expect(result.failureCount).toBe(42);
  expect(result.errors).toHaveLength(32);
  expect(result.droppedFailureCount).toBe(10);
  expect(result.errors[0]).toMatchObject({ sampleId: 1, phase: "initial" });
  expect(result.scopes[0]).toMatchObject({ attempts: 42, samples: 0, failedSamples: 42 });
  expect(result.errors[0].stdout.text).toBe("<workspace> [REDACTED]");
  expect(result.errors[0].stderr.truncated).toBe(true);
  expect(Buffer.byteLength(result.errors[0].stderr.text)).toBeLessThanOrEqual(4096);
  expect(JSON.stringify(result)).not.toContain(sentinel);
  expect(JSON.stringify(result)).not.toContain(root);
  expect(result.status).toBe("incomplete");
});

it("保留启动错误码并拒绝超过安全整数的磁盘字节数", async () => {
  const { observe } = await controlledDu([
    Object.assign(new Error("spawn du ENOENT"), { code: "ENOENT" }),
    { stdout: "9007199254740991 root\n", stderr: "" },
  ]);
  const { stop } = await observe({ root: fixture() });
  const result = await stop();
  expect(result.errors[0]).toMatchObject({ exitCode: null, errorCode: "ENOENT" });
  expect(result.errors[1]).toMatchObject({
    exitCode: 0,
    errorCode: "INVALID_DISK_SAMPLE",
    phase: "final",
  });
  expect(result.failureCount).toBe(2);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("清理先等待已启动采样，暂停期间不遍历，停止等待清理后最终采样", async () => {
  vi.useFakeTimers();
  const pendingSample = deferred();
  const pendingCleanup = deferred();
  const { observe, execute } = await controlledDu([undefined, pendingSample.promise]);
  const observer = await observe({ root: fixture(), intervalMs: 10 });
  await vi.advanceTimersByTimeAsync(10);
  const cleanup = vi.fn(() => pendingCleanup.promise);
  const action = observer.withPausedSampling("build-work-cleanup", cleanup);
  await vi.advanceTimersByTimeAsync(50);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(cleanup).not.toHaveBeenCalled();
  pendingSample.resolve({ stdout: "8 root\n", stderr: "" });
  await vi.advanceTimersByTimeAsync(0);
  expect(cleanup).toHaveBeenCalledOnce();
  const stop = observer.stop();
  expect(observer.stop()).toBe(stop);
  await vi.advanceTimersByTimeAsync(50);
  expect(execute).toHaveBeenCalledTimes(2);
  pendingCleanup.resolve("cleaned");
  expect(await action).toBe("cleaned");
  const report = await stop;
  expect(execute).toHaveBeenCalledTimes(3);
  expect(report.pauses).toMatchObject({ count: 1, droppedDetailsCount: 0 });
  expect(report.pauses.entries[0]).toMatchObject({
    reason: "build-work-cleanup",
    outcome: "passed",
  });
  expect(report.pauses.totalDurationMs).toBeGreaterThanOrEqual(100);
  expect(report.peakIsLowerBound).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  expect(execute).toHaveBeenCalledTimes(3);
  await expect(observer.withPausedSampling("cleanup", cleanup)).rejects.toThrow(
    "RESOURCE_OBSERVER_STOPPING",
  );
});

it.each([false, true])("清理失败仍传播并恢复或停止采样：stop重叠=%s", async (overlap) => {
  vi.useFakeTimers();
  const pendingCleanup = deferred();
  const { observe, execute } = await controlledDu([
    Object.assign(new Error("du failed"), { code: 1 }),
  ]);
  const observer = await observe({ root: fixture(), intervalMs: 10 });
  const action = observer.withPausedSampling("build-work-cleanup", () => pendingCleanup.promise);
  const failure = expect(action).rejects.toThrow("owned cleanup failure");
  await expect(observer.withPausedSampling("cleanup", () => {})).rejects.toThrow(
    "RESOURCE_PAUSE_ALREADY_ACTIVE",
  );
  const stopping = overlap ? observer.stop() : undefined;
  pendingCleanup.reject(new Error("owned cleanup failure"));
  await failure;
  await vi.advanceTimersByTimeAsync(10);
  const report = await (stopping ?? observer.stop());
  expect(execute).toHaveBeenCalledTimes(overlap ? 2 : 3);
  expect(report.status).toBe("incomplete");
  expect(report.failureCount).toBe(1);
  expect(report.errors[0]).toMatchObject({ phase: "initial", exitCode: 1 });
  expect(report.pauses.entries[0].outcome).toBe("failed");
});

it("暂停原因有界且不接受动态敏感文本，重复暂停统计不会无限增长", async () => {
  const { observe } = await controlledDu([]);
  const observer = await observe({ root: fixture() });
  await expect(
    observer.withPausedSampling("Bearer " + "sensitive-value", () => {}),
  ).rejects.toThrow("RESOURCE_PAUSE_ARGUMENT_INVALID");
  await expect(observer.withPausedSampling("cleanup", null)).rejects.toThrow(
    "RESOURCE_PAUSE_ARGUMENT_INVALID",
  );
  for (let index = 0; index < 34; index += 1)
    await observer.withPausedSampling("cleanup", () => {});
  const report = await observer.stop();
  expect(report.pauses).toMatchObject({ count: 34, droppedDetailsCount: 2 });
  expect(report.pauses.entries).toHaveLength(32);
});
