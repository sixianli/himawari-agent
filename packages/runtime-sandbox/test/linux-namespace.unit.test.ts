import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => ({
  lstat: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  readlink: vi.fn(),
}));
vi.mock("node:fs/promises", () => fs);

import { captureLinuxNamespace, readLinuxNamespaceState } from "../src/linux-namespace.ts";

const namespaceId = "pid:[9001]",
  host = "pid:[1]";
const proof = { namespaceId, initPid: 20, initStartTicks: "200" };
let records: Map<number, { parent: number; start: string; inner: number; ns: string }>;
function known(pid: number) {
  const value = records.get(pid);
  if (!value) throw new Error("missing fixture process");
  return value;
}
function stat(pid: number, parent: number, start: string) {
  const fields = new Array<string>(20).fill("0");
  fields[0] = "S";
  fields[1] = String(parent);
  fields[19] = start;
  return `${pid} (command with ) spaces) ${fields.join(" ")}`;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("process", Object.create(process, { platform: { value: "linux" } }));
  records = new Map([
    [10, { parent: 1, start: "100", inner: 10, ns: host }],
    [20, { parent: 10, start: "200", inner: 1, ns: namespaceId }],
    [21, { parent: 20, start: "210", inner: 2, ns: namespaceId }],
  ]);
  const record = (path: string) => {
    const pid = Number(path.split("/")[2]);
    const value = records.get(pid);
    if (!value) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    return { pid, ...value };
  };
  fs.readdir.mockImplementation(async () => ["self", "sys", ...[...records.keys()].map(String)]);
  fs.lstat.mockImplementation(async (path: string) => {
    record(path);
    return { uid: process.getuid?.() };
  });
  fs.readlink.mockImplementation(async (path: string) =>
    path === "/proc/self/ns/pid" ? host : record(path).ns,
  );
  fs.readFile.mockImplementation(async (path: string) => {
    const r = record(path);
    return path.endsWith("/stat")
      ? stat(r.pid, r.parent, r.start)
      : `Name: task\nNSpid:\t${r.pid}\t${r.inner}\n`;
  });
});
afterEach(() => vi.unstubAllGlobals());
describe("Linux namespace identity and release proof", () => {
  it("rejects non-Linux capture before consulting the proc fixture", async () => {
    vi.stubGlobal("process", Object.create(process, { platform: { value: "darwin" } }));
    await expect(captureLinuxNamespace(10, 2, namespaceId)).rejects.toThrow(
      "NAMESPACE_CAPTURE_INVALID",
    );
    expect(fs.readdir).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalled();
  });
  it("binds namespace init to the supplied task ancestry and rechecks its birth marker", async () => {
    expect(await captureLinuxNamespace(10, 2, namespaceId)).toEqual(proof);
    expect(await readLinuxNamespaceState(proof)).toBe("alive");
    records.set(20, { parent: 10, start: "201", inner: 1, ns: namespaceId });
    expect(await readLinuxNamespaceState(proof)).toBe("released");
    records.delete(20);
    expect(await readLinuxNamespaceState(proof)).toBe("released");
  });
  it.each([
    [1, 1, namespaceId],
    [1.5, 1, namespaceId],
    [10, 0, namespaceId],
    [10, 1, "invalid"],
  ])("rejects invalid capture identity %s/%s/%s before reading proc", async (root, inner, ns) => {
    await expect(captureLinuxNamespace(Number(root), Number(inner), String(ns))).rejects.toThrow(
      "NAMESPACE_CAPTURE_INVALID",
    );
    expect(fs.readdir).not.toHaveBeenCalled();
  });
  it.each([
    { initPid: 1 },
    { initPid: 2.5 },
    { namespaceId: "unknown" },
    { initStartTicks: "not-a-birth-marker" },
  ])("does not treat invalid stored proof %j as released", async (fields) => {
    expect(await readLinuxNamespaceState({ ...proof, ...fields })).toBe("unknown");
    expect(fs.readFile).not.toHaveBeenCalled();
  });
  it.each(["same-host", "unrelated", "cycle", "missing-init", "over-capacity"])(
    "rejects %s capture instead of assuming ownership",
    async (kind) => {
      if (kind === "same-host") for (const r of records.values()) r.ns = host;
      if (kind === "unrelated") known(20).parent = 99;
      if (kind === "cycle") {
        known(20).parent = 21;
        known(21).parent = 20;
      }
      if (kind === "missing-init") known(20).inner = 3;
      if (kind === "over-capacity")
        fs.readdir.mockResolvedValue(Array.from({ length: 16385 }, (_, i) => String(i + 1)));
      await expect(captureLinuxNamespace(10, 2, namespaceId)).rejects.toThrow(
        kind === "over-capacity"
          ? "NAMESPACE_CAPTURE_CAPACITY"
          : kind === "missing-init"
            ? "NAMESPACE_INIT_UNAVAILABLE"
            : "NAMESPACE_CAPTURE_AMBIGUOUS",
      );
    },
  );
  it.each([
    "owner",
    "permission",
    "namespace",
    "inner",
    "missing-nspid",
    "invalid-stat",
    "changed-stat",
  ])("keeps %s uncertainty distinct from proven release", async (kind) => {
    if (kind === "owner") fs.lstat.mockResolvedValue({ uid: (process.getuid?.() ?? 0) + 1 });
    if (kind === "permission")
      fs.readFile.mockRejectedValue(Object.assign(new Error("permission"), { code: "EACCES" }));
    if (kind === "namespace") known(20).ns = "pid:[9002]";
    if (kind === "inner") known(20).inner = 2;
    if (kind === "missing-nspid" || kind === "invalid-stat") {
      const original = fs.readFile.getMockImplementation();
      if (!original) throw new Error("missing fixture reader");
      fs.readFile.mockImplementation((path: string) =>
        path.endsWith(kind === "missing-nspid" ? "/status" : "/stat")
          ? Promise.resolve("incomplete")
          : original(path),
      );
    }
    if (kind === "changed-stat")
      fs.readFile
        .mockResolvedValueOnce(stat(20, 10, "200"))
        .mockResolvedValueOnce("NSpid: 20 1")
        .mockResolvedValueOnce(stat(20, 10, "201"));
    expect(await readLinuxNamespaceState(proof)).toBe("unknown");
  });
});
