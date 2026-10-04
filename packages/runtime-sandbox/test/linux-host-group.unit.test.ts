import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ readFile: vi.fn(), readdir: vi.fn(), kill: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: boundary.readFile, readdir: boundary.readdir }));
vi.mock("node:process", () => ({ default: { pid: 6001, kill: boundary.kill } }));
import { readLinuxHostGroup, reclaimLinuxHostGroup } from "../src/linux-host-group.ts";

const host = { processId: 6000, startToken: "100" };
const guardian = { processId: 6001, startToken: "101" };
let rows: Map<number, string>;
function stat(pid: number, group: number, session: number, token: string, state = "S") {
  const fields = [
    state,
    "1",
    String(group),
    String(session),
    ...Array<string>(15).fill("0"),
    token,
  ];
  return `${pid} (name with ) delimiters) ${fields.join(" ")}\n`;
}
beforeEach(() => {
  vi.resetAllMocks();
  rows = new Map([
    [6001, stat(6001, 6000, 6000, "101")],
    [6002, stat(6002, 6000, 6000, "102")],
    [9000, stat(9000, 9000, 9000, "900")],
  ]);
  boundary.readdir.mockImplementation(async () => [...rows.keys()].map(String));
  boundary.readFile.mockImplementation(async (filename: string) => {
    const pid =
      filename === "/proc/self/stat" ? 6001 : Number(/^\/proc\/(\d+)\/stat$/.exec(filename)?.[1]);
    const value = rows.get(pid);
    if (value === undefined) throw Object.assign(new Error("absent"), { code: "ENOENT" });
    return value;
  });
});

afterEach(() => vi.restoreAllMocks());

describe("Linux Host group identity and reclamation", () => {
  it("does not signal when group observation finishes after its original cleanup deadline", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(100);
    await expect(reclaimLinuxHostGroup(host, guardian, 50)).rejects.toThrow(
      "JOB_HOST_GUARDIAN_UNAVAILABLE",
    );
    expect(boundary.kill).not.toHaveBeenCalled();
  });
  it("signals only its own anchored group after the original Host has been reaped", async () => {
    await expect(reclaimLinuxHostGroup(host, guardian, performance.now() + 5000)).resolves.toBe(
      true,
    );
    expect(boundary.kill).toHaveBeenCalledExactlyOnceWith(0, "SIGKILL");
    expect(await readLinuxHostGroup(6000)).toEqual([
      expect.objectContaining({
        processId: 6001,
        processGroupId: 6000,
        sessionId: 6000,
        startToken: "101",
      }),
      expect.objectContaining({
        processId: 6002,
        processGroupId: 6000,
        sessionId: 6000,
        startToken: "102",
      }),
    ]);
  });
  it.each(["S", "Z"])(
    "never signals while the original Host is still present as %s",
    async (state) => {
      rows.set(6000, stat(6000, 6000, 6000, "100", state));
      await expect(reclaimLinuxHostGroup(host, guardian, performance.now() + 5000)).resolves.toBe(
        false,
      );
      expect(boundary.kill).not.toHaveBeenCalled();
    },
  );
  it.each([
    "guardian-replaced",
    "guardian-left-group",
    "guardian-left-session",
    "member-other-session",
    "host-replaced",
  ])("refuses to signal when ownership is inconsistent: %s", async (kind) => {
    if (kind === "guardian-replaced") rows.set(6001, stat(6001, 6000, 6000, "999"));
    if (kind === "guardian-left-group") rows.set(6001, stat(6001, 6001, 6000, "101"));
    if (kind === "guardian-left-session") rows.set(6001, stat(6001, 6000, 6001, "101"));
    if (kind === "member-other-session") rows.set(6002, stat(6002, 6000, 9999, "102"));
    if (kind === "host-replaced") rows.set(6000, stat(6000, 6000, 6000, "999"));
    await expect(reclaimLinuxHostGroup(host, guardian, performance.now() + 5000)).rejects.toThrow(
      "JOB_HOST_GROUP_IDENTITY_CHANGED",
    );
    expect(boundary.kill).not.toHaveBeenCalled();
  });
  it.each(["EACCES", "EPERM"])(
    "does not turn an unreadable identity into an empty group: %s",
    async (code) => {
      boundary.readFile.mockRejectedValue(Object.assign(new Error("unreadable"), { code }));
      await expect(readLinuxHostGroup(6000)).rejects.toThrow();
      await expect(
        reclaimLinuxHostGroup(host, guardian, performance.now() + 5000),
      ).rejects.toThrow();
      expect(boundary.kill).not.toHaveBeenCalled();
    },
  );
  it("refuses signaling when procfs uses a different PID namespace", async () => {
    const read = boundary.readFile.getMockImplementation();
    boundary.readFile.mockImplementation(async (filename: string) => {
      if (filename === "/proc/self/stat") return stat(9999, 6000, 6000, "101");
      return read?.(filename);
    });
    await expect(reclaimLinuxHostGroup(host, guardian, performance.now() + 5000)).rejects.toThrow(
      "JOB_HOST_GROUP_IDENTITY_CHANGED",
    );
    expect(boundary.kill).not.toHaveBeenCalled();
  });
  it("keeps zombies in the group until the operating system reaps them", async () => {
    rows.set(6002, stat(6002, 6000, 6000, "102", "Z"));
    expect(await readLinuxHostGroup(6000)).toContainEqual(
      expect.objectContaining({ processId: 6002, state: "Z" }),
    );
  });
  it("refuses changed process identity during group observation", async () => {
    let reads = 0;
    const read = boundary.readFile.getMockImplementation();
    boundary.readFile.mockImplementation(async (filename: string) => {
      if (filename === "/proc/6002/stat")
        return stat(6002, 6000, 6000, ++reads === 1 ? "102" : "103");
      return read?.(filename);
    });
    await expect(readLinuxHostGroup(6000)).rejects.toThrow("JOB_HOST_GROUP_IDENTITY_CHANGED");
    expect(boundary.kill).not.toHaveBeenCalled();
  });
});
