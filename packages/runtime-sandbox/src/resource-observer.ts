import { execFile } from "node:child_process";

export const RESOURCE_SNAPSHOT_TIMEOUT_MS = 5_000;
export const RESOURCE_SAMPLE_INTERVAL_MS = 100;
export const RESOURCE_OBSERVATION_GRACE_MS = 10_000;
export const RESOURCE_OBSERVATION_FAILURES = [
  "RESOURCE_OBSERVATION_UNAVAILABLE",
  "RESOURCE_OBSERVATION_INVALID",
  "RESOURCE_OBSERVATION_CAPACITY",
] as const;
export type ResourceObservationFailure = (typeof RESOURCE_OBSERVATION_FAILURES)[number];
export interface ResourceObservationProblem {
  readonly failure: ResourceObservationFailure;
  readonly detail: string | undefined;
}

export interface ResourceLimits {
  readonly maxCpuTimeMs: number;
  readonly maxMemoryBytes: number;
}
export interface ResourceObservation {
  readonly samples: number;
  readonly observedCpuTimeMs: number;
  readonly peakObservedMemoryBytes: number;
}
export interface ProcessSample {
  readonly pid: number;
  readonly parent: number;
  readonly group: number;
  readonly memoryBytes: number;
  readonly cpuTimeMs: number;
  readonly birth: string;
}

export function parseProcessSnapshot(value: string): readonly ProcessSample[] {
  return value
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
      if (!match) throw new Error("RESOURCE_OBSERVATION_INVALID");
      const [, pid, parent, group, rss, cpu, birth] = match;
      const time = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(cpu ?? "");
      if (!time || !birth || !Number.isFinite(Date.parse(birth)))
        throw new Error("RESOURCE_OBSERVATION_INVALID");
      const cpuTimeMs = Math.round(
        (Number(time[1] ?? 0) * 86400 +
          Number(time[2] ?? 0) * 3600 +
          Number(time[3]) * 60 +
          Number(time[4])) *
          1000,
      );
      const sample = {
        pid: Number(pid),
        parent: Number(parent),
        group: Number(group),
        memoryBytes: Number(rss) * 1024,
        cpuTimeMs,
        birth,
      };
      if (
        Object.values(sample).some(
          (item) => typeof item === "number" && (!Number.isSafeInteger(item) || item < 0),
        )
      )
        throw new Error("RESOURCE_OBSERVATION_INVALID");
      return sample;
    });
}

export function readProcessSnapshot(): Promise<readonly ProcessSample[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/ps",
      ["-axo", "pid=,ppid=,pgid=,rss=,time=,lstart="],
      {
        encoding: "utf8",
        timeout: RESOURCE_SNAPSHOT_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("RESOURCE_OBSERVATION_UNAVAILABLE", { cause: error }));
          return;
        }
        try {
          resolve(parseProcessSnapshot(stdout));
        } catch {
          reject(new Error("RESOURCE_OBSERVATION_INVALID"));
        }
      },
    );
  });
}

export class TaskResourceAccumulator {
  readonly #root: number;
  readonly #known = new Map<number, string>();
  readonly #cpu = new Map<string, number>();
  readonly #baseline = new Map<string, number>();
  #samples = 0;
  #peak = 0;
  constructor(root: number, baseline?: readonly ProcessSample[]) {
    if (!Number.isSafeInteger(root) || root <= 1) throw new Error("RESOURCE_ROOT_INVALID");
    this.#root = root;
    if (!baseline) return;
    const members = this.#members(baseline);
    for (const process of baseline)
      if (members.has(process.pid))
        this.#baseline.set(`${process.pid}:${process.birth}`, process.cpuTimeMs);
  }
  add(snapshot: readonly ProcessSample[]): ResourceObservation {
    const members = this.#members(snapshot);
    let memory = 0;
    for (const process of snapshot) {
      if (!members.has(process.pid)) continue;
      this.#known.set(process.pid, process.birth);
      const key = `${process.pid}:${process.birth}`;
      this.#cpu.set(key, Math.max(this.#cpu.get(key) ?? 0, process.cpuTimeMs));
      memory += process.memoryBytes;
    }
    if (this.#cpu.size > 16384 || !Number.isSafeInteger(memory))
      throw new Error("RESOURCE_OBSERVATION_CAPACITY");
    this.#peak = Math.max(this.#peak, memory);
    this.#samples++;
    return this.current();
  }
  #members(snapshot: readonly ProcessSample[]): Set<number> {
    const members = new Set<number>();
    for (const process of snapshot) {
      const birth = this.#known.get(process.pid);
      if (birth === process.birth || (process.pid === this.#root && birth === undefined))
        members.add(process.pid);
    }
    const children = new Map<number, number[]>();
    for (const process of snapshot) {
      const siblings = children.get(process.parent) ?? [];
      siblings.push(process.pid);
      children.set(process.parent, siblings);
      if (members.has(this.#root) && process.group === this.#root) members.add(process.pid);
    }
    const pending = [...members];
    for (let index = 0; index < pending.length; index++) {
      for (const pid of children.get(pending[index] ?? -1) ?? []) {
        if (!members.has(pid)) {
          members.add(pid);
          pending.push(pid);
        }
      }
    }
    return members;
  }
  current(): ResourceObservation {
    const cpu = [...this.#cpu].reduce(
      (sum, [key, value]) => sum + Math.max(0, value - (this.#baseline.get(key) ?? 0)),
      0,
    );
    if (!Number.isSafeInteger(cpu)) throw new Error("RESOURCE_OBSERVATION_CAPACITY");
    return { samples: this.#samples, observedCpuTimeMs: cpu, peakObservedMemoryBytes: this.#peak };
  }
}

export function observeTaskResources(
  root: number,
  limits: ResourceLimits,
  stopTask: (
    reason: "resource_limit" | "host_failure",
    failure?: ResourceObservationFailure,
    detail?: string,
  ) => void,
  baseline?: readonly ProcessSample[],
) {
  const accumulator = new TaskResourceAccumulator(root, baseline);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let lastUnavailable: string | undefined;
  const fail = (failure: ResourceObservationFailure, detail?: string) => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(watchdog);
    if (detail === undefined) stopTask("host_failure", failure);
    else stopTask("host_failure", failure, detail);
  };
  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(
      () => fail("RESOURCE_OBSERVATION_UNAVAILABLE", lastUnavailable),
      RESOURCE_OBSERVATION_GRACE_MS,
    );
  };
  const schedule = () => {
    if (!stopped) timer = setTimeout(() => void sample(), RESOURCE_SAMPLE_INTERVAL_MS);
  };
  const sample = async () => {
    let snapshot: readonly ProcessSample[];
    try {
      snapshot = await readProcessSnapshot();
    } catch (error) {
      if (stopped) return;
      const { failure, detail } = classifyObservationError(error);
      if (failure !== "RESOURCE_OBSERVATION_UNAVAILABLE") {
        fail(failure);
        return;
      }
      lastUnavailable = detail;
      schedule();
      return;
    }
    if (stopped) return;
    let usage: ResourceObservation;
    try {
      usage = accumulator.add(snapshot);
    } catch (error) {
      fail(observationFailure(error) ?? "RESOURCE_OBSERVATION_INVALID");
      return;
    }
    lastUnavailable = undefined;
    if (
      usage.observedCpuTimeMs > limits.maxCpuTimeMs ||
      usage.peakObservedMemoryBytes > limits.maxMemoryBytes
    ) {
      stopped = true;
      clearTimeout(watchdog);
      stopTask("resource_limit");
      return;
    }
    armWatchdog();
    schedule();
  };
  armWatchdog();
  void sample();
  return {
    current: () => accumulator.current(),
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(watchdog);
    },
  };
}

export function classifyObservationError(error: unknown): ResourceObservationProblem {
  const failure = observationFailure(error) ?? "RESOURCE_OBSERVATION_INVALID";
  if (failure !== "RESOURCE_OBSERVATION_UNAVAILABLE") return { failure, detail: undefined };
  return { failure, detail: describeUnavailable(error) };
}

function describeUnavailable(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  if (!cause || typeof cause !== "object") return undefined;
  const parts = ["code", "signal", "killed"]
    .map((key) => [key, (cause as Record<string, unknown>)[key]] as const)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function observationFailure(error: unknown): ResourceObservationFailure | undefined {
  const message = error instanceof Error ? error.message : undefined;
  return RESOURCE_OBSERVATION_FAILURES.find((code) => code === message);
}
