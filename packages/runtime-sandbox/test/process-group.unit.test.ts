import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopProcessGroup } from "../src/process-group.ts";

const survivors: number[] = [];
afterEach(() => {
  for (const pid of survivors.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

async function waitUntil(condition: () => boolean) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  return condition();
}

describe("stopProcessGroup", () => {
  it("ends members left in the task group after the leader exits and leaves escaped sessions untracked", async () => {
    const leader = spawn(
      process.execPath,
      [
        "-e",
        [
          'const { spawn } = require("node:child_process");',
          'const member = spawn("sleep", ["30"], { stdio: "ignore" });',
          'const escaped = spawn("sleep", ["30"], { stdio: "ignore", detached: true });',
          'process.stdout.write(JSON.stringify({ member: member.pid, escaped: escaped.pid }) + "\\n", () => process.exit(0));',
        ].join("\n"),
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const exited = once(leader, "exit");
    let output = "";
    for await (const chunk of leader.stdout) output += chunk;
    const { member, escaped } = JSON.parse(output) as { member: number; escaped: number };
    survivors.push(member, escaped);
    await exited;
    if (!leader.pid) throw new Error("leader pid missing");
    expect(alive(member)).toBe(true);

    const gone = await stopProcessGroup(leader.pid, {
      timeoutMs: 2000,
      intervalMs: 10,
      kill: (pid, signal) => process.kill(pid, signal),
    });

    expect(gone).toBe(true);
    expect(await waitUntil(() => !alive(member))).toBe(true);
    expect(alive(escaped)).toBe(true);
  });

  it("reports a group that is already empty without sending a kill signal", async () => {
    const kill = vi.fn(() => {
      throw Object.assign(new Error("no such group"), { code: "ESRCH" });
    });
    await expect(stopProcessGroup(4242, { timeoutMs: 50, intervalMs: 5, kill })).resolves.toBe(
      true,
    );
    expect(kill.mock.calls).toEqual([[-4242, 0]]);
  });

  it("does not report a group as gone when it cannot be signalled", async () => {
    const kill = vi.fn(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    await expect(stopProcessGroup(4242, { timeoutMs: 50, intervalMs: 5, kill })).resolves.toBe(
      false,
    );
  });

  it("does not report a group as gone while it still has members at the time limit", async () => {
    const kill = vi.fn();
    await expect(stopProcessGroup(4242, { timeoutMs: 30, intervalMs: 5, kill })).resolves.toBe(
      false,
    );
    expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
  });

  it.each([0, 1, -5, 1.5])("never signals the invalid group id %s", async (groupId) => {
    const kill = vi.fn();
    await expect(stopProcessGroup(groupId, { timeoutMs: 30, intervalMs: 5, kill })).resolves.toBe(
      false,
    );
    expect(kill).not.toHaveBeenCalled();
  });
});
