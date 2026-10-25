import { afterEach, describe, expect, it, vi } from "vitest";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));

import { parseJobHostRequest } from "../src/job-host-protocol.ts";
import {
  classifyObservationError,
  observeTaskResources,
  parseProcessSnapshot,
  TaskResourceAccumulator,
} from "../src/resource-observer.ts";

const birth = "Wed Sep  9 00:00:00 2026";
const row = (
  pid: number,
  parent: number,
  group: number,
  rss: number,
  time: string,
  started = birth,
) => `${pid} ${parent} ${group} ${rss} ${time} ${started}\n`;
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
describe("sampled task resources", () => {
  it("parses Mac and Linux CPU times and KiB RSS without reading command lines", () => {
    const samples = parseProcessSnapshot(
      row(2, 1, 2, 4, "01:02.50") + row(3, 2, 2, 8, "1-02:03:04"),
    );
    expect(samples.map((s) => s.cpuTimeMs)).toEqual([62500, 93784000]);
    expect(samples[0]?.memoryBytes).toBe(4096);
    expect(() => parseProcessSnapshot("ps failed")).toThrow("INVALID");
    expect(() => parseProcessSnapshot(row(2, 1, 2, 4, "not-time"))).toThrow("INVALID");
    expect(() => parseProcessSnapshot(row(2, 1, 2, Number.MAX_SAFE_INTEGER, "00:01"))).toThrow(
      "INVALID",
    );
  });
  it("includes child trees and groups, tracks observed reparenting, excludes unrelated processes and PID reuse", () => {
    const task = new TaskResourceAccumulator(10);
    const first = parseProcessSnapshot(
      row(12, 11, 12, 30, "00:00.30") +
        row(11, 10, 10, 20, "00:00.20") +
        row(10, 1, 10, 10, "00:00.10") +
        row(13, 1, 10, 40, "00:00.40") +
        row(99, 1, 99, 9000, "01:00"),
    );
    expect(task.add(first)).toEqual({
      samples: 1,
      observedCpuTimeMs: 1000,
      peakObservedMemoryBytes: 100 * 1024,
    });
    expect(task.add(parseProcessSnapshot(row(12, 1, 12, 2, "00:00.50")))).toEqual({
      samples: 2,
      observedCpuTimeMs: 1200,
      peakObservedMemoryBytes: 100 * 1024,
    });
    expect(
      task.add(parseProcessSnapshot(row(12, 1, 12, 9999, "59:59", "Wed Sep  9 00:00:01 2026")))
        .observedCpuTimeMs,
    ).toBe(1200);
  });
  it("[R2-P2] counts only CPU time observed after the baseline snapshot", () => {
    const baseline = parseProcessSnapshot(
      row(10, 1, 10, 10, "00:01.00") +
        row(11, 10, 10, 20, "00:00.50") +
        row(99, 1, 99, 9000, "02:00"),
    );
    const task = new TaskResourceAccumulator(10, baseline);
    expect(task.current()).toEqual({
      samples: 0,
      observedCpuTimeMs: 0,
      peakObservedMemoryBytes: 0,
    });
    expect(
      task.add(
        parseProcessSnapshot(
          row(10, 1, 10, 10, "00:01.30") +
            row(11, 10, 10, 20, "00:00.50") +
            row(12, 10, 10, 5, "00:00.20"),
        ),
      ),
    ).toEqual({
      samples: 1,
      observedCpuTimeMs: 500,
      peakObservedMemoryBytes: 35 * 1024,
    });
  });
  it.each([
    ["cpu", 10],
    ["memory", 10],
    ["cpu", 11],
    ["memory", 11],
  ] as const)(
    "stops on observed %s overshoot in group %s with one bounded ps request at a time",
    async (kind, group) => {
      vi.useFakeTimers();
      const stop = vi.fn();
      let resolve!: (error: Error | null, stdout: string) => void;
      execFile.mockImplementation((_file, _args, _options, callback) => {
        resolve = callback;
      });
      const observer = observeTaskResources(10, { maxCpuTimeMs: 100, maxMemoryBytes: 1024 }, stop);
      await vi.advanceTimersByTimeAsync(500);
      expect(execFile).toHaveBeenCalledTimes(1);
      const [command, args, options] = execFile.mock.calls[0] ?? [];
      expect(command).toBe("/bin/ps");
      expect(args).toEqual(["-axo", "pid=,ppid=,pgid=,rss=,time=,lstart="]);
      expect(options.timeout).toBe(5000);
      resolve(
        null,
        row(10, 1, 10, 0, "00:00.00") +
          row(11, 10, group, kind === "memory" ? 2 : 1, kind === "cpu" ? "00:00.20" : "00:00.01"),
      );
      await vi.advanceTimersByTimeAsync(500);
      expect(stop).toHaveBeenCalledExactlyOnceWith("resource_limit");
      expect(observer.current().samples).toBe(1);
      expect(execFile).toHaveBeenCalledTimes(1);
      observer.stop();
    },
  );
  it("stops on an invalid observation at once instead of inventing zero usage", async () => {
    execFile.mockImplementation((_file, _args, _options, callback) =>
      callback(null, "invalid sample"),
    );
    const stop = vi.fn();
    const observer = observeTaskResources(10, { maxCpuTimeMs: 100, maxMemoryBytes: 1024 }, stop);
    await Promise.resolve();
    await Promise.resolve();
    expect(stop).toHaveBeenCalledExactlyOnceWith("host_failure", "RESOURCE_OBSERVATION_INVALID");
    expect(observer.current().samples).toBe(0);
    observer.stop();
  });
  it("[R2-D31] keeps sampling through unavailable snapshots and stops only after 10 seconds without one", async () => {
    vi.useFakeTimers();
    execFile.mockImplementation((_file, _args, _options, callback) =>
      callback(Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }), ""),
    );
    const stop = vi.fn();
    const observer = observeTaskResources(10, { maxCpuTimeMs: 100, maxMemoryBytes: 1024 }, stop);
    await vi.advanceTimersByTimeAsync(9900);
    expect(stop).not.toHaveBeenCalled();
    expect(execFile.mock.calls.length).toBeGreaterThan(90);
    await vi.advanceTimersByTimeAsync(300);
    expect(stop).toHaveBeenCalledExactlyOnceWith(
      "host_failure",
      "RESOURCE_OBSERVATION_UNAVAILABLE",
      "signal=SIGTERM killed=true",
    );
    const calls = execFile.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(execFile).toHaveBeenCalledTimes(calls);
    expect(observer.current().samples).toBe(0);
    observer.stop();
  });
  it("[R2-D31] stops after 10 seconds when ps never answers", async () => {
    vi.useFakeTimers();
    execFile.mockImplementation(() => undefined);
    const stop = vi.fn();
    const observer = observeTaskResources(10, { maxCpuTimeMs: 100, maxMemoryBytes: 1024 }, stop);
    await vi.advanceTimersByTimeAsync(9900);
    expect(stop).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(stop).toHaveBeenCalledExactlyOnceWith(
      "host_failure",
      "RESOURCE_OBSERVATION_UNAVAILABLE",
    );
    observer.stop();
  });
  it("[R2-D31] restarts the 10 second window at every successful snapshot", async () => {
    vi.useFakeTimers();
    let calls = 0;
    execFile.mockImplementation((_file, _args, _options, callback) => {
      calls++;
      if (calls === 61) callback(null, row(10, 1, 10, 1, "00:00.01"));
      else callback(new Error("denied"), "");
    });
    const stop = vi.fn();
    const observer = observeTaskResources(10, { maxCpuTimeMs: 100, maxMemoryBytes: 1024 }, stop);
    await vi.advanceTimersByTimeAsync(15900);
    expect(stop).not.toHaveBeenCalled();
    expect(observer.current()).toEqual({
      samples: 1,
      observedCpuTimeMs: 10,
      peakObservedMemoryBytes: 1024,
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(stop).toHaveBeenCalledExactlyOnceWith(
      "host_failure",
      "RESOURCE_OBSERVATION_UNAVAILABLE",
    );
    observer.stop();
  });
  it("ignores a late observation after task completion", async () => {
    vi.useFakeTimers();
    let resolve!: (error: Error | null, stdout: string) => void;
    execFile.mockImplementation((_file, _args, _options, callback) => {
      resolve = callback;
    });
    const stop = vi.fn();
    const observer = observeTaskResources(10, { maxCpuTimeMs: 1, maxMemoryBytes: 1 }, stop);
    observer.stop();
    resolve(null, row(10, 1, 10, 999, "01:00"));
    await Promise.resolve();
    await Promise.resolve();
    expect(stop).not.toHaveBeenCalled();
    expect(observer.current().samples).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stop).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledTimes(1);
  });
  it("[R2-D31] classifies snapshot errors into a failure code and the ps error detail", () => {
    expect(
      classifyObservationError(
        new Error("RESOURCE_OBSERVATION_UNAVAILABLE", {
          cause: { code: "ENOENT", signal: null, killed: false },
        }),
      ),
    ).toEqual({ failure: "RESOURCE_OBSERVATION_UNAVAILABLE", detail: "code=ENOENT killed=false" });
    expect(classifyObservationError(new Error("RESOURCE_OBSERVATION_UNAVAILABLE"))).toEqual({
      failure: "RESOURCE_OBSERVATION_UNAVAILABLE",
      detail: undefined,
    });
    expect(classifyObservationError(new Error("RESOURCE_OBSERVATION_INVALID"))).toEqual({
      failure: "RESOURCE_OBSERVATION_INVALID",
      detail: undefined,
    });
    expect(classifyObservationError(new Error("RESOURCE_OBSERVATION_CAPACITY"))).toEqual({
      failure: "RESOURCE_OBSERVATION_CAPACITY",
      detail: undefined,
    });
    expect(classifyObservationError("denied")).toEqual({
      failure: "RESOURCE_OBSERVATION_INVALID",
      detail: undefined,
    });
  });
  it("rejects malformed resource limits before launching any process", () => {
    const input = {
      jobId: "job",
      attemptId: "attempt",
      policy: { workspace: "/workspace", privateDirectory: "/private" },
      policyDigest: "a".repeat(64),
      executable: "/bin/echo",
      args: [],
      deadlineAt: new Date(Date.now() + 10000).toISOString(),
      maxOutputBytes: 10,
      cleanupTimeoutMs: 100,
    };
    for (const limits of [
      null,
      {},
      { maxCpuTimeMs: 0, maxMemoryBytes: 1 },
      { maxCpuTimeMs: 1, maxMemoryBytes: 1, extra: 1 },
    ])
      expect(() => parseJobHostRequest({ ...input, resourceLimits: limits })).toThrow(
        "RESOURCE_LIMIT_INVALID",
      );
    expect(
      parseJobHostRequest({ ...input, resourceLimits: { maxCpuTimeMs: 1, maxMemoryBytes: 1 } })
        .resourceLimits,
    ).toEqual({ maxCpuTimeMs: 1, maxMemoryBytes: 1 });
  });
});

it("uses the platform containment contract for a detached process group", async () => {
  vi.useFakeTimers();
  execFile.mockImplementation((_file, _args, _options, callback) =>
    callback(null, row(10, 1, 10, 1, "00:00.01") + row(11, 10, 11, 1, "00:00.01")),
  );
  const stop = vi.fn();
  const observer = observeTaskResources(10, { maxCpuTimeMs: 1000, maxMemoryBytes: 1048576 }, stop);
  await vi.advanceTimersByTimeAsync(100);
  expect(stop).not.toHaveBeenCalled();
  expect(execFile).toHaveBeenCalledTimes(2);
  expect(observer.current()).toEqual({
    samples: 2,
    observedCpuTimeMs: 20,
    peakObservedMemoryBytes: 2048,
  });
  observer.stop();
});
