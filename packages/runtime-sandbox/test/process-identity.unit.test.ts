import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { processGroupPresent, readProcessStartToken } from "../src/process-identity.ts";

const survivors: number[] = [];
afterEach(() => {
  for (const pid of survivors.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
});

async function exitedPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  if (!child.pid) throw new Error("child pid unavailable");
  return child.pid;
}

describe("readProcessStartToken", () => {
  it("reads the same start token for a running process twice", async () => {
    const first = await readProcessStartToken(process.pid);
    expect(first).toEqual(expect.any(String));
    expect(first).not.toBe("");
    await expect(readProcessStartToken(process.pid)).resolves.toBe(first);
  });

  it("reports no token once a process has exited and been reaped", async () => {
    await expect(readProcessStartToken(await exitedPid())).resolves.toBeNull();
  });

  it("refuses an invalid process id and an unsupported platform", async () => {
    for (const pid of [0, 1, -5, 1.5])
      await expect(readProcessStartToken(pid)).rejects.toThrow("PROCESS_START_TOKEN_UNAVAILABLE");
    await expect(readProcessStartToken(process.pid, "win32")).rejects.toThrow(
      "PROCESS_START_TOKEN_UNAVAILABLE",
    );
  });
});

describe("processGroupPresent", () => {
  it("sees a live group, including one whose leader has exited, and not a vanished group", async () => {
    const leader = spawn("/bin/sh", ["-c", "sleep 30 & echo $!; exit 0"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!leader.pid) throw new Error("leader pid unavailable");
    survivors.push(leader.pid);
    const [member] = (await once(leader.stdout, "data")) as [Buffer];
    await once(leader, "exit");
    expect(Number(member.toString().trim())).toBeGreaterThan(1);
    expect(processGroupPresent(leader.pid)).toBe(true);
    await expect(readProcessStartToken(leader.pid)).resolves.toBeNull();
    process.kill(-leader.pid, "SIGKILL");
    for (let attempt = 0; attempt < 200 && processGroupPresent(leader.pid); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(processGroupPresent(leader.pid)).toBe(false);
  });

  it("refuses an invalid group id", () => {
    for (const pid of [0, 1, -5, 1.5])
      expect(() => processGroupPresent(pid)).toThrow("PROCESS_GROUP_ID_INVALID");
  });
});
