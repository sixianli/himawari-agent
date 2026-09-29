import { execFile } from "node:child_process";

export interface ResourceLimits {
  readonly maxCpuTimeMs: number;
  readonly maxMemoryBytes: number;
}
export interface ResourceObservation {
  readonly samples: number;
  readonly observedCpuTimeMs: number;
  readonly peakObservedMemoryBytes: number;
}
interface ProcessSample {
  readonly pid: number;
  readonly parent: number;
  readonly group: number;
  readonly memoryBytes: number;
  readonly cpuTimeMs: number;
  readonly birth: string;
}

/** ps snapshots omit short-lived/unobserved descendants. These are observations,
 * never a hard quota or proof of task-tree completeness. No command lines are read. */
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
        timeout: 1000,
        maxBuffer: 4 * 1024 * 1024,
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("RESOURCE_OBSERVATION_UNAVAILABLE"));
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

/** Tracks observed descendants after reparenting, and keeps their observed CPU
 * after exit. A changed birth marker does not inherit the old PID's membership. */
export class TaskResourceAccumulator {
  readonly #root: number;
  readonly #known = new Map<number, string>();
  readonly #cpu = new Map<string, number>();
  #samples = 0;
  #peak = 0;
  constructor(root: number) {
    if (!Number.isSafeInteger(root) || root <= 1) throw new Error("RESOURCE_ROOT_INVALID");
    this.#root = root;
  }
  add(snapshot: readonly ProcessSample[]): ResourceObservation {
    const members = new Set<number>();
    for (const process of snapshot) {
      const birth = this.#known.get(process.pid);
      if (birth === process.birth || (process.pid === this.#root && birth === undefined))
        members.add(process.pid);
    }
    // Walk the snapshot once per edge; a deep process tree must not delay stop
    // decisions through repeated full-table scans.
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
  current(): ResourceObservation {
    const cpu = [...this.#cpu.values()].reduce((sum, value) => sum + value, 0);
    if (!Number.isSafeInteger(cpu)) throw new Error("RESOURCE_OBSERVATION_CAPACITY");
    return { samples: this.#samples, observedCpuTimeMs: cpu, peakObservedMemoryBytes: this.#peak };
  }
}

/** One bounded query at a time; stop() prevents late samples from cancelling an
 * already completed job. Observation failures are never converted to zero usage. */
export function observeTaskResources(
  root: number,
  limits: ResourceLimits,
  stopTask: (reason: "resource_limit" | "host_failure") => void,
) {
  const accumulator = new TaskResourceAccumulator(root);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sample = async () => {
    try {
      const snapshot = await readProcessSnapshot();
      if (stopped) return;
      const usage = accumulator.add(snapshot);
      if (
        usage.observedCpuTimeMs > limits.maxCpuTimeMs ||
        usage.peakObservedMemoryBytes > limits.maxMemoryBytes
      ) {
        stopped = true;
        stopTask("resource_limit");
        return;
      }
    } catch {
      if (!stopped) {
        stopped = true;
        stopTask("host_failure");
      }
      return;
    }
    if (!stopped) timer = setTimeout(() => void sample(), 100);
  };
  void sample();
  return {
    current: () => accumulator.current(),
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
