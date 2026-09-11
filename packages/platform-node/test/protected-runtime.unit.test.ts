import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Controlled Linux filesystem/process evidence. These tests do not qualify an
// installed host; the deployment acceptance must run real denied writes too.
const fixture = vi.hoisted(() => ({
  manifest: "",
  status: "",
  nodes: new Map<
    string,
    { uid: number; mode: number; ino: number; directory: boolean; link?: boolean }
  >(),
}));
vi.mock("node:fs/promises", () => {
  const metadata = (name: string) => {
    const node = fixture.nodes.get(name);
    if (!node) throw new Error("ENOENT");
    return {
      ...node,
      dev: 1,
      size: name === "/etc/himawari/runtime.json" ? Buffer.byteLength(fixture.manifest) : 1,
      mtimeMs: 1,
      ctimeMs: 1,
      isDirectory: () => node.directory && !node.link,
      isFile: () => !node.directory && !node.link,
    };
  };
  return {
    lstat: async (name: string) => metadata(name),
    realpath: async (name: string) => name,
    readFile: async () => fixture.status,
    readdir: async (name: string) =>
      [...fixture.nodes.keys()]
        .filter((key) => key.startsWith(`${name}/`) && !key.slice(name.length + 1).includes("/"))
        .map((key) => key.slice(name.length + 1)),
    open: async (name: string) => ({
      stat: async () => metadata(name),
      readFile: async () => Buffer.from(fixture.manifest),
      close: async () => {},
    }),
  };
});
import {
  ProtectedRuntimeVerifier,
  verifyProtectedRuntime,
} from "../src/capabilities/protected-runtime.js";

function node(name: string) {
  const value = fixture.nodes.get(name);
  if (!value) throw new Error(`Missing fixture node: ${name}`);
  return value;
}

const root = "/data/himawari/releases/v1";
const manifestPath = "/etc/himawari/runtime.json";
const digest = "a".repeat(64);
beforeEach(() => {
  fixture.nodes.clear();
  let ino = 1;
  for (const name of [
    "/",
    "/etc",
    "/etc/himawari",
    "/data",
    "/data/himawari",
    "/data/himawari/releases",
    root,
  ])
    fixture.nodes.set(name, { uid: 0, mode: 0o755, ino: ino++, directory: true });
  for (const name of [manifestPath, `${root}/helper.js`])
    fixture.nodes.set(name, { uid: 0, mode: 0o644, ino: ino++, directory: false });
  node("/data").uid = 1000;
  fixture.manifest = JSON.stringify({
    schemaVersion: "protected-runtime.v1",
    runtimeRoot: root,
    runtimeDigest: digest,
    runtimeUid: 1234,
    deploymentUid: 1000,
  });
  fixture.status =
    "Uid:\t1234\t1234\t1234\t1234\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\n";
  vi.stubGlobal("process", {
    ...process,
    env: { ...process.env },
    platform: "linux",
    getuid: () => 1234,
    geteuid: () => 1234,
  });
});
afterEach(() => vi.unstubAllGlobals());

it("shares the initial byte audit but rechecks protection for later calls", async () => {
  const verifier = new ProtectedRuntimeVerifier(manifestPath);
  const readBytes = vi.fn(async () => digest);
  await Promise.all([
    verifier.verify(root, digest, readBytes),
    verifier.verify(root, digest, readBytes),
  ]);
  await verifier.verify(root, digest, readBytes);
  expect(readBytes).toHaveBeenCalledTimes(1);
  node("/data/himawari").mode = 0o777;
  await expect(verifier.verify(root, digest, readBytes)).rejects.toThrow("PROTECTION_INVALID");
  expect(readBytes).toHaveBeenCalledTimes(1);
});

it("requires a new audit after the deployment record or directory is replaced", async () => {
  const verifier = new ProtectedRuntimeVerifier(manifestPath);
  const readBytes = vi.fn(async () => digest);
  await verifier.verify(root, digest, readBytes);
  node(manifestPath).ino++;
  await verifier.verify(root, digest, readBytes);
  node(root).ino++;
  await verifier.verify(root, digest, readBytes);
  expect(readBytes).toHaveBeenCalledTimes(3);
});

it("does not retain a failed content audit as trusted", async () => {
  const verifier = new ProtectedRuntimeVerifier(manifestPath);
  const readBytes = vi.fn().mockResolvedValueOnce("b".repeat(64)).mockResolvedValue(digest);
  await expect(verifier.verify(root, digest, readBytes)).rejects.toThrow("PROTECTION_INVALID");
  await verifier.verify(root, digest, readBytes);
  expect(readBytes).toHaveBeenCalledTimes(2);
});

it.each([
  ["runtime-owned deployment record", manifestPath, "uid", 1234],
  ["writable deployment record", manifestPath, "mode", 0o666],
  ["writable authority parent", "/etc/himawari", "mode", 0o777],
  ["runtime-owned installation parent", "/data/himawari", "uid", 1234],
  ["runtime-owned helper", `${root}/helper.js`, "uid", 1234],
  ["writable helper", `${root}/helper.js`, "mode", 0o666],
] as const)(
  "rejects %s before trusting the initial content audit",
  async (_label, name, key, value) => {
    node(name)[key] = value;
    const readBytes = vi.fn(async () => digest);
    await expect(
      new ProtectedRuntimeVerifier(manifestPath).verify(root, digest, readBytes),
    ).rejects.toThrow("PROTECTION_INVALID");
    expect(readBytes).not.toHaveBeenCalled();
  },
);

it("rejects a helper symlink, even when it is root owned", async () => {
  node(`${root}/helper.js`).link = true;
  await expect(
    new ProtectedRuntimeVerifier(manifestPath).verify(root, digest, async () => digest),
  ).rejects.toThrow("PROTECTION_INVALID");
});

it.each([
  ["NoNewPrivs:\t1", "NoNewPrivs:\t0"],
  ["CapEff:\t0000000000000000", "CapEff:\t0000000000000001"],
  ["1234\t1234\t1234\t1234", "1234\t1234\t0\t1234"],
])("rejects unsafe process credentials (%s)", async (before, after) => {
  fixture.status = fixture.status.replace(before, after);
  await expect(
    new ProtectedRuntimeVerifier(manifestPath).verify(root, digest, async () => digest),
  ).rejects.toThrow("PROTECTION_INVALID");
});

it("cannot authorize another runtime or digest through the protected record", async () => {
  const verifier = new ProtectedRuntimeVerifier(manifestPath);
  await expect(verifier.verify(`${root}-other`, digest, async () => digest)).rejects.toThrow(
    "PROTECTION_INVALID",
  );
  await expect(verifier.verify(root, "b".repeat(64), async () => digest)).rejects.toThrow(
    "PROTECTION_INVALID",
  );
});

it("rechecks process protection even after a successful audit", async () => {
  const verifier = new ProtectedRuntimeVerifier(manifestPath);
  const readBytes = vi.fn(async () => digest);
  await verifier.verify(root, digest, readBytes);
  fixture.status = fixture.status.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0");
  await expect(verifier.verify(root, digest, readBytes)).rejects.toThrow("PROTECTION_INVALID");
  expect(readBytes).toHaveBeenCalledTimes(1);
});

it("keeps the original audit path only when protection was not configured", async () => {
  const readBytes = vi.fn(async () => digest);
  delete process.env["HIMAWARI_RUNTIME_PROTECTION_FILE"];
  expect(await verifyProtectedRuntime(root, digest, readBytes)).toBe(false);
  process.env["HIMAWARI_RUNTIME_PROTECTION_FILE"] = "";
  await expect(verifyProtectedRuntime(root, digest, readBytes)).rejects.toThrow(
    "PROTECTION_INVALID",
  );
  expect(readBytes).not.toHaveBeenCalled();
});
