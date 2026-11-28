import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface AdmissionCandidate {
  readonly ownerKey: string;
  readonly activeCalls: number;
  readonly lastActivityMs: number;
}

export type AdmissionDecision =
  | { readonly kind: "start" }
  | { readonly kind: "evict"; readonly ownerKey: string }
  | { readonly kind: "wait"; readonly detail: string };

export function decideAdmission(input: {
  readonly availableBytes: number;
  readonly startBytes: number;
  readonly reserveBytes: number;
  readonly running: readonly AdmissionCandidate[];
}): AdmissionDecision {
  if (input.availableBytes - input.reserveBytes >= input.startBytes) return { kind: "start" };
  const idle = input.running
    .filter((candidate) => candidate.activeCalls === 0)
    .sort((a, b) => a.lastActivityMs - b.lastActivityMs);
  const [oldest] = idle;
  if (oldest) return { kind: "evict", ownerKey: oldest.ownerKey };
  const mib = (bytes: number) => Math.max(0, Math.floor(bytes / (1024 * 1024)));
  return {
    kind: "wait",
    detail: `等内存：开一台电脑要 ${mib(input.startBytes)} MiB，东京机现在可用 ${mib(input.availableBytes - input.reserveBytes)} MiB，开着的 ${input.running.length} 台电脑都正在用`,
  };
}

export async function hostAvailableMemoryBytes(meminfo = "/proc/meminfo"): Promise<number> {
  const text = await readFile(meminfo, "utf8");
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
  if (!match?.[1]) throw new Error("MEMINFO_UNAVAILABLE");
  return Number(match[1]) * 1024;
}

const CGROUP_CANDIDATES = (containerId: string) => [
  `/sys/fs/cgroup/system.slice/docker-${containerId}.scope/memory.current`,
  `/sys/fs/cgroup/docker/${containerId}/memory.current`,
  `/sys/fs/cgroup/memory/docker/${containerId}/memory.usage_in_bytes`,
];

async function cgroupBytes(containerId: string): Promise<number | null> {
  for (const candidate of CGROUP_CANDIDATES(containerId)) {
    try {
      const value = Number((await readFile(candidate, "utf8")).trim());
      if (Number.isSafeInteger(value)) return value;
    } catch {}
  }
  return null;
}

async function sandboxProcessBytes(containerId: string, proc: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(proc).catch(() => [] as string[])) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const command = (await readFile(path.join(proc, entry, "cmdline"), "utf8")).split("\0");
      if (!command[0]?.includes("runsc") || !command.includes(containerId)) continue;
      const status = await readFile(path.join(proc, entry, "status"), "utf8");
      const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1];
      if (rss) total += Number(rss) * 1024;
    } catch {}
  }
  return total;
}

export async function computerMemoryBytes(
  containerId: string,
  proc = "/proc",
): Promise<number | null> {
  const cgroup = await cgroupBytes(containerId);
  const sandbox = await sandboxProcessBytes(containerId, proc);
  if (cgroup === null && sandbox === 0) return null;
  return (cgroup ?? 0) + sandbox;
}
