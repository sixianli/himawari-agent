import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureResidentInfrastructure,
  processSubtree,
  readProcessTable,
  sweepResidentCommand,
  type TreeProcess,
} from "../src/resident-process-tree.ts";

const linux = process.platform === "linux";
const survivors: number[] = [];
afterEach(() => {
  for (const pid of survivors.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

function shell(): ChildProcess {
  const child = spawn("/bin/sh", [], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
  if (!child.pid) throw new Error("shell pid unavailable");
  survivors.push(child.pid);
  return child;
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function subtreeAtLeast(root: number, count: number): Promise<TreeProcess[]> {
  return waitFor(async () => {
    const tree = processSubtree(await readProcessTable(), root);
    return tree.length >= count ? tree : undefined;
  });
}

describe("[R2-P2] resident process tree sweep", () => {
  if (!linux) {
    it("[R2-P2] requires Linux procfs for the resident process sweep", () => {
      expect(linux).toBe(false);
    });
    return;
  }

  it("[R2-P2] captures the root and every current descendant with its start token", async () => {
    const root = shell();
    root.stdin?.write("sleep 60 & sleep 61 &\n");
    const tree = await subtreeAtLeast(root.pid as number, 3);
    const infrastructure = await captureResidentInfrastructure(root.pid as number);
    expect(infrastructure.has(root.pid as number)).toBe(true);
    expect(infrastructure.size).toBeGreaterThanOrEqual(3);
    for (const process of tree) expect(infrastructure.get(process.pid)).toBe(process.start);
    for (const start of infrastructure.values()) expect(start).toMatch(/^\d+$/);
  });

  it("[R2-P2] kills a detached, a nohup, and a redirected leftover and leaves the base processes", async () => {
    const root = shell();
    root.stdin?.write("sleep 60 &\n");
    await subtreeAtLeast(root.pid as number, 2);
    const infrastructure = await captureResidentInfrastructure(root.pid as number);
    root.stdin?.write("setsid sleep 61 &\n");
    root.stdin?.write("nohup sleep 62 >/dev/null 2>&1 &\n");
    root.stdin?.write("sleep 63 >/dev/null 2>&1 &\n");
    const leftovers = await waitFor(async () => {
      const tree = processSubtree(await readProcessTable(), root.pid as number);
      const extra = tree.filter((process) => !infrastructure.has(process.pid));
      return extra.length >= 3 ? extra : undefined;
    });
    for (const process of leftovers) survivors.push(process.pid);
    const kill = vi.fn((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
    const sweep = await sweepResidentCommand(root.pid as number, infrastructure, {
      timeoutMs: 5000,
      intervalMs: 20,
      kill,
    });
    expect(sweep).toEqual({ commandTreeGone: true, infrastructureIntact: true });
    for (const process of leftovers) expect(kill).toHaveBeenCalledWith(process.pid, "SIGKILL");
    const remaining = await readProcessTable();
    for (const process of leftovers)
      expect(remaining.some((item) => item.pid === process.pid)).toBe(false);
    for (const [pid, start] of infrastructure)
      expect(remaining.some((item) => item.pid === pid && item.start === start)).toBe(true);
  });

  it("[R2-P2] stops without killing when a captured base process is gone", async () => {
    const root = shell();
    root.stdin?.write("sleep 64 &\n");
    await subtreeAtLeast(root.pid as number, 2);
    const infrastructure = await captureResidentInfrastructure(root.pid as number);
    const dead = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
    await once(dead, "exit");
    const withDead = new Map(infrastructure);
    withDead.set(dead.pid as number, "0");
    const kill = vi.fn();
    const sweep = await sweepResidentCommand(root.pid as number, withDead, {
      timeoutMs: 1000,
      intervalMs: 20,
      kill,
    });
    expect(sweep).toEqual({ commandTreeGone: false, infrastructureIntact: false });
    expect(kill).not.toHaveBeenCalled();
  });

  it("[R2-P2] re-reads a leftover's identity and never kills it when the identity changed", async () => {
    const root = shell();
    const infrastructure = await captureResidentInfrastructure(root.pid as number);
    root.stdin?.write("sleep 65 &\n");
    const leftover = await waitFor(async () => {
      const tree = processSubtree(await readProcessTable(), root.pid as number);
      return tree.find((process) => !infrastructure.has(process.pid));
    });
    const identity = vi.fn(async () => ({
      pid: leftover.pid,
      parent: leftover.parent,
      start: "different",
    }));
    const kill = vi.fn();
    const sweep = await sweepResidentCommand(root.pid as number, infrastructure, {
      timeoutMs: 200,
      intervalMs: 20,
      kill,
      identity,
    });
    expect(identity).toHaveBeenCalledWith(leftover.pid);
    expect(kill).not.toHaveBeenCalled();
    expect(sweep.commandTreeGone).toBe(false);
  });

  it("[R2-P2] returns immediately without killing when proceed is false", async () => {
    const root = shell();
    const infrastructure = await captureResidentInfrastructure(root.pid as number);
    root.stdin?.write("sleep 66 &\n");
    await subtreeAtLeast(root.pid as number, 2);
    const kill = vi.fn();
    const sweep = await sweepResidentCommand(root.pid as number, infrastructure, {
      timeoutMs: 1000,
      intervalMs: 20,
      kill,
      proceed: () => false,
    });
    expect(sweep).toEqual({ commandTreeGone: false, infrastructureIntact: true });
    expect(kill).not.toHaveBeenCalled();
  });

  it("[R2-P2] reports an unfinished cleanup while a process keeps respawning children", async () => {
    const root = shell();
    root.stdin?.write("sh -c 'while :; do sleep 0.5 & sleep 0.005; done' &\n");
    await subtreeAtLeast(root.pid as number, 2);
    const infrastructure = await captureResidentInfrastructure(root.pid as number);
    const sweep = await sweepResidentCommand(root.pid as number, infrastructure, {
      timeoutMs: 300,
      intervalMs: 20,
      kill: (pid, signal) => process.kill(pid, signal),
    });
    expect(sweep.commandTreeGone).toBe(false);
  });
});
