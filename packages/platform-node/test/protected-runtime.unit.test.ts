import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  artifactDigest: vi.fn(),
  audit: vi.fn(),
  manifest: "",
  status: "",
  nodes: new Map<
    string,
    { uid: number; mode: number; ino: number; directory: boolean; link?: boolean }
  >(),
}));
vi.mock("../src/capabilities/artifact-verifier.js", () => ({
  digestRegularFile: fixture.artifactDigest,
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
const verifierFor = () => new ProtectedRuntimeVerifier(manifestPath, fixture.audit);
const manifestPath = "/etc/himawari/runtime.json";
const digest = "a".repeat(64);
beforeEach(() => {
  fixture.artifactDigest.mockReset().mockResolvedValue(`sha256:${digest}`);
  fixture.audit.mockReset().mockResolvedValue(undefined);
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

it("returns before the content audit finishes, and later checks wait for the same audit", async () => {
  const verifier = verifierFor();
  let finish: ((value: string) => void) | undefined;
  const readBytes = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const settled = vi.fn();
  await verifier.begin(root, digest, readBytes, [], settled);
  expect(settled).not.toHaveBeenCalled();
  let later = false;
  const waiting = verifier.verify(root, digest, readBytes).then(() => {
    later = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(later).toBe(false);
  finish?.(digest);
  await waiting;
  expect(readBytes).toHaveBeenCalledOnce();
  expect(settled).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
});

it("rejects every later check when the deferred content audit finds a different digest", async () => {
  const verifier = verifierFor();
  const settled = vi.fn();
  const wrong = async () => "c".repeat(64);
  await verifier.begin(root, digest, wrong, [], settled);
  await expect(verifier.verify(root, digest, wrong)).rejects.toThrow(
    "SANDBOX_RUNTIME_PROTECTION_INVALID",
  );
  expect(settled).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
});

it("still rejects at once, without deferring, when the protection record does not match", async () => {
  const verifier = verifierFor();
  const readBytes = vi.fn(async () => digest);
  await expect(verifier.begin(root, "d".repeat(64), readBytes)).rejects.toThrow(
    "SANDBOX_RUNTIME_PROTECTION_INVALID",
  );
  await expect(verifier.begin("/data/himawari/other", digest, readBytes)).rejects.toThrow(
    "SANDBOX_RUNTIME_PROTECTION_INVALID",
  );
  fixture.status = fixture.status.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0");
  await expect(verifier.begin(root, digest, readBytes)).rejects.toThrow(
    "SANDBOX_RUNTIME_PROTECTION_INVALID",
  );
  expect(readBytes).not.toHaveBeenCalled();
});

it("reuses protected artifact bytes only for unchanged installation and file identities", async () => {
  const verifier = verifierFor();
  const readBytes = vi.fn(async () => digest);
  const artifacts = [{ path: `${root}/helper.js`, sha256: digest }];
  await verifier.verify(root, digest, readBytes, artifacts);
  await verifier.verify(root, digest, readBytes, artifacts);
  expect(fixture.artifactDigest).toHaveBeenCalledTimes(1);
  node(`${root}/helper.js`).ino++;
  await verifier.verify(root, digest, readBytes, artifacts);
  expect(fixture.artifactDigest).toHaveBeenCalledTimes(2);
  node(manifestPath).ino++;
  await verifier.verify(root, digest, readBytes, artifacts);
  expect(fixture.artifactDigest).toHaveBeenCalledTimes(3);
});

it("never trusts a different expected artifact digest or retains a failed check", async () => {
  const verifier = verifierFor();
  const artifacts = [{ path: `${root}/helper.js`, sha256: "b".repeat(64) }];
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(verifier.verify(root, digest, async () => digest, artifacts)).rejects.toThrow(
      "SANDBOX_HOST_ARTIFACT_CHANGED",
    );
  expect(fixture.artifactDigest).toHaveBeenCalledTimes(2);
});

it("does not cache artifact bytes outside the protected runtime", async () => {
  fixture.nodes.set("/data/external", { uid: 0, mode: 0o644, ino: 99, directory: false });
  const verifier = verifierFor();
  const artifacts = [{ path: "/data/external", sha256: digest }];
  await verifier.verify(root, digest, async () => digest, artifacts);
  await verifier.verify(root, digest, async () => digest, artifacts);
  expect(fixture.artifactDigest).toHaveBeenCalledTimes(2);
});

it("shares one installation audit across different protected runners", async () => {
  fixture.nodes.set(`${root}/search.js`, { uid: 0, mode: 0o644, ino: 99, directory: false });
  const verifier = verifierFor();
  const readBytes = vi.fn(async () => digest);
  for (const name of ["helper.js", "search.js", "helper.js", "search.js"])
    await verifier.verify(root, digest, readBytes, [{ path: `${root}/${name}`, sha256: digest }]);
  expect(readBytes).toHaveBeenCalledOnce();
  expect(fixture.artifactDigest).toHaveBeenCalledTimes(2);
});

it("finishes the installation audit before validating reusable artifact bytes", async () => {
  let finish: ((value: string) => void) | undefined;
  const readBytes = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const verifying = verifierFor().verify(root, digest, readBytes, [
    { path: `${root}/helper.js`, sha256: digest },
  ]);
  await vi.waitFor(() => expect(readBytes).toHaveBeenCalledOnce());
  try {
    expect(fixture.artifactDigest).not.toHaveBeenCalled();
  } finally {
    finish?.(digest);
    await verifying;
  }
});

it("rejects changed artifact permissions after a successful cached audit", async () => {
  const verifier = verifierFor();
  const artifacts = [{ path: `${root}/helper.js`, sha256: digest }];
  await verifier.verify(root, digest, async () => digest, artifacts);
  node(`${root}/helper.js`).mode = 0o666;
  await expect(verifier.verify(root, digest, async () => digest, artifacts)).rejects.toThrow(
    "PROTECTION_INVALID",
  );
});
afterEach(() => vi.unstubAllGlobals());

it("shares the initial byte audit but rechecks protection for later calls", async () => {
  const verifier = verifierFor();
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
  const verifier = verifierFor();
  const readBytes = vi.fn(async () => digest);
  await verifier.verify(root, digest, readBytes);
  node(manifestPath).ino++;
  await verifier.verify(root, digest, readBytes);
  node(root).ino++;
  await verifier.verify(root, digest, readBytes);
  expect(readBytes).toHaveBeenCalledTimes(3);
});

it("does not retain a failed content audit as trusted", async () => {
  const verifier = verifierFor();
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
] as const)(
  "rejects %s before trusting the initial content audit",
  async (_label, name, key, value) => {
    node(name)[key] = value;
    const readBytes = vi.fn(async () => digest);
    await expect(verifierFor().verify(root, digest, readBytes)).rejects.toThrow(
      "PROTECTION_INVALID",
    );
    expect(readBytes).not.toHaveBeenCalled();
  },
);

it("audits the whole installation before reading its bytes and keeps no failed audit", async () => {
  const verifier = verifierFor();
  const readBytes = vi.fn(async () => digest);
  fixture.audit.mockRejectedValueOnce(new Error("SANDBOX_RUNTIME_PROTECTION_INVALID"));
  await expect(verifier.verify(root, digest, readBytes)).rejects.toThrow("PROTECTION_INVALID");
  expect(fixture.audit).toHaveBeenCalledExactlyOnceWith(root);
  expect(readBytes).not.toHaveBeenCalled();
  await verifier.verify(root, digest, readBytes);
  await verifier.verify(root, digest, readBytes);
  expect(fixture.audit).toHaveBeenCalledTimes(2);
  expect(readBytes).toHaveBeenCalledOnce();
});

it.each([
  ["NoNewPrivs:\t1", "NoNewPrivs:\t0"],
  ["CapEff:\t0000000000000000", "CapEff:\t0000000000000001"],
  ["1234\t1234\t1234\t1234", "1234\t1234\t0\t1234"],
])("rejects unsafe process credentials (%s)", async (before, after) => {
  fixture.status = fixture.status.replace(before, after);
  await expect(verifierFor().verify(root, digest, async () => digest)).rejects.toThrow(
    "PROTECTION_INVALID",
  );
});

it("cannot authorize another runtime or digest through the protected record", async () => {
  const verifier = verifierFor();
  await expect(verifier.verify(`${root}-other`, digest, async () => digest)).rejects.toThrow(
    "PROTECTION_INVALID",
  );
  await expect(verifier.verify(root, "b".repeat(64), async () => digest)).rejects.toThrow(
    "PROTECTION_INVALID",
  );
});

it("rechecks process protection even after a successful audit", async () => {
  const verifier = verifierFor();
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

it("does nothing extra when protection is not configured, even if the content audit is deferred", async () => {
  const readBytes = vi.fn(async () => digest);
  delete process.env["HIMAWARI_RUNTIME_PROTECTION_FILE"];
  expect(
    await verifyProtectedRuntime(root, digest, readBytes, [], { deferContentAudit: true }),
  ).toBe(false);
  expect(readBytes).not.toHaveBeenCalled();
});
