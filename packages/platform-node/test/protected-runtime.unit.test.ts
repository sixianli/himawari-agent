import { readFileSync } from "node:fs";
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
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  class InstallationAuditPasses extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => {
        this.emit("message", { protected: true });
        this.emit("exit", 0);
      });
    }
    terminate() {
      return Promise.resolve(0);
    }
  }
  return { Worker: InstallationAuditPasses };
});
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

it("keeps refusing after a deferred audit failed, even if a later audit would succeed", async () => {
  const verifier = verifierFor();
  const settled = vi.fn();
  await verifier.begin(root, digest, async () => "c".repeat(64), [], settled);
  await vi.waitFor(() => expect(settled).toHaveBeenCalled());
  const later = vi.fn(async () => digest);
  for (let attempt = 0; attempt < 3; attempt++)
    await expect(verifier.verify(root, digest, later)).rejects.toThrow(
      "SANDBOX_RUNTIME_PROTECTION_INVALID",
    );
  expect(later).not.toHaveBeenCalled();
});

it.each([
  new Error("SANDBOX_HOST_DIGEST_WORKER_EXIT:1"),
  Object.assign(new Error("read failed"), { code: "EIO" }),
])(
  "does not lock the sandbox after a transient error in the deferred audit (%s)",
  async (error) => {
    const verifier = verifierFor();
    const settled = vi.fn();
    await verifier.begin(
      root,
      digest,
      async () => {
        throw error;
      },
      [],
      settled,
    );
    await vi.waitFor(() =>
      expect(settled).toHaveBeenCalledWith(expect.objectContaining({ ok: false })),
    );
    const later = vi.fn(async () => digest);
    await verifier.verify(root, digest, later);
    expect(later).toHaveBeenCalledOnce();
  },
);

it("keeps refusing after a deferred audit hit a non-transient error such as a file changed during reading", async () => {
  const verifier = verifierFor();
  const settled = vi.fn();
  await verifier.begin(
    root,
    digest,
    async () => {
      throw new Error("SANDBOX_HOST_CHANGED");
    },
    [],
    settled,
  );
  await vi.waitFor(() => expect(settled).toHaveBeenCalled());
  const later = vi.fn(async () => digest);
  await expect(verifier.verify(root, digest, later)).rejects.toThrow("SANDBOX_HOST_CHANGED");
  expect(later).not.toHaveBeenCalled();
});

const readBytesOk = () => async () => digest;
it("survives a settle callback that throws", async () => {
  const verifier = verifierFor();
  await verifier.begin(root, digest, readBytesOk(), [], () => {
    throw new Error("logger broke");
  });
  await verifier.verify(root, digest, readBytesOk());
});

it("does not let a content audit that never finishes block sandbox calls forever", async () => {
  const verifier = new ProtectedRuntimeVerifier(manifestPath, fixture.audit, 20);
  const settled = vi.fn();
  await verifier.begin(root, digest, () => new Promise<string>(() => {}), [], settled);
  await expect(verifier.verify(root, digest, async () => digest)).rejects.toThrow(
    "SANDBOX_RUNTIME_AUDIT_TIMEOUT",
  );
  await vi.waitFor(() =>
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ ok: false })),
  );
  await verifier.verify(root, digest, async () => digest);
});

it("aborts the running digest when the content audit times out, and marks the outcome transient", async () => {
  const verifier = new ProtectedRuntimeVerifier(manifestPath, fixture.audit, 20);
  const settled = vi.fn();
  let received: AbortSignal | undefined;
  await verifier.begin(
    root,
    digest,
    (_root, signal) => {
      received = signal;
      return new Promise<string>(() => {});
    },
    [],
    settled,
  );
  await vi.waitFor(() =>
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ ok: false, transient: true })),
  );
  expect(received?.aborted).toBe(true);
});

it("retries a transient deferred failure once before reporting it", async () => {
  const verifier = verifierFor();
  const settled = vi.fn();
  const retrying = vi.fn();
  let calls = 0;
  await verifier.begin(
    root,
    digest,
    async () => {
      calls++;
      if (calls === 1) throw new Error("SANDBOX_HOST_DIGEST_WORKER_EXIT:1");
      return digest;
    },
    [],
    settled,
    retrying,
  );
  await vi.waitFor(() => expect(settled).toHaveBeenCalled());
  expect(retrying).toHaveBeenCalledOnce();
  expect(calls).toBe(2);
  expect(settled).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
});

it("reports a transient failure only after the retry also failed", async () => {
  const verifier = verifierFor();
  const settled = vi.fn();
  const retrying = vi.fn();
  const failing = vi.fn(async () => {
    throw new Error("SANDBOX_HOST_DIGEST_WORKER_EXIT:1");
  });
  await verifier.begin(root, digest, failing, [], settled, retrying);
  await vi.waitFor(() => expect(settled).toHaveBeenCalled());
  expect(failing).toHaveBeenCalledTimes(2);
  expect(settled).toHaveBeenCalledWith(expect.objectContaining({ ok: false, transient: true }));
});

it("does not retry a real inconsistency", async () => {
  const verifier = verifierFor();
  const settled = vi.fn();
  const retrying = vi.fn();
  const wrong = vi.fn(async () => "c".repeat(64));
  await verifier.begin(root, digest, wrong, [], settled, retrying);
  await vi.waitFor(() => expect(settled).toHaveBeenCalled());
  expect(wrong).toHaveBeenCalledOnce();
  expect(retrying).not.toHaveBeenCalled();
});

it("aborts the installation audit worker when the audit times out", async () => {
  let received: AbortSignal | undefined;
  const audit = (_root: string, signal?: AbortSignal) => {
    received = signal;
    return new Promise<void>(() => {});
  };
  const verifier = new ProtectedRuntimeVerifier(manifestPath, audit, 20);
  const settled = vi.fn();
  await verifier.begin(root, digest, async () => digest, [], settled);
  await vi.waitFor(() => expect(settled).toHaveBeenCalled());
  expect(received?.aborted).toBe(true);
});

it("marks a real inconsistency as not transient", async () => {
  const verifier = verifierFor();
  const settled = vi.fn();
  await verifier.begin(root, digest, async () => "c".repeat(64), [], settled);
  await vi.waitFor(() =>
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ ok: false, transient: false })),
  );
});

it("does not keep refusing after a failed audit that was not started in the background", async () => {
  const verifier = verifierFor();
  await expect(verifier.verify(root, digest, async () => "c".repeat(64))).rejects.toThrow(
    "SANDBOX_RUNTIME_PROTECTION_INVALID",
  );
  await verifier.verify(root, digest, async () => digest);
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

it("aborts a superseded background audit without counting it as a failure or retrying it", async () => {
  const verifier = verifierFor();
  const settled = vi.fn();
  const retrying = vi.fn();
  let received: AbortSignal | undefined;
  const hung = vi.fn((_root: string, signal?: AbortSignal) => {
    received = signal;
    return new Promise<string>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("SANDBOX_HOST_DIGEST_ABORTED")));
    });
  });
  await verifier.begin(root, digest, hung, [], settled, retrying);
  node(manifestPath).ino++;
  await verifier.verify(root, digest, async () => digest);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(received?.aborted).toBe(true);
  expect(hung).toHaveBeenCalledOnce();
  expect(retrying).not.toHaveBeenCalled();
  expect(settled).toHaveBeenCalledOnce();
  expect(settled).toHaveBeenCalledWith(
    expect.objectContaining({ ok: false, transient: false, superseded: true }),
  );
  await verifier.verify(root, digest, async () => digest);
});

it("re-audits once for a foreground call whose audit was superseded instead of failing it", async () => {
  const verifier = verifierFor();
  const hung = (_root: string, signal?: AbortSignal) =>
    new Promise<string>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("SANDBOX_HOST_DIGEST_ABORTED")));
    });
  const waiting = verifier.verify(root, digest, hung);
  await new Promise((resolve) => setTimeout(resolve, 10));
  node(manifestPath).ino++;
  await verifier.verify(root, digest, async () => digest);
  await expect(waiting).resolves.toBeUndefined();
});

it("reports the start of a background audit only after the cheap checks passed", async () => {
  const verifier = verifierFor();
  const started = vi.fn();
  await expect(
    verifier.begin(root, "d".repeat(64), async () => digest, [], undefined, undefined, started),
  ).rejects.toThrow("SANDBOX_RUNTIME_PROTECTION_INVALID");
  expect(started).not.toHaveBeenCalled();
  await verifier.begin(root, digest, async () => digest, [], undefined, undefined, started);
  expect(started).toHaveBeenCalledOnce();
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
  expect(fixture.audit).toHaveBeenCalledExactlyOnceWith(root, expect.any(AbortSignal));
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

function startupReadbackTreatsAsFailure(): (event: string) => boolean {
  const readback = readFileSync(
    new URL(
      "../../../scripts/delivery-mode/packet-template/systemd/S7-startup-readback.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  const start = readback.indexOf("function startupFailureEvents(");
  const end = readback.indexOf("\nfunction ", start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const startupFailureEvents = new Function(
    `${readback.slice(start, end)}\nreturn startupFailureEvents;`,
  )() as (records: readonly { event: string }[]) => string[];
  return (event) => startupFailureEvents([{ event }]).includes(event);
}

it("the deploy start-up readback treats failed and retryable deferred audits as failures, completed ones not", () => {
  const isFailure = startupReadbackTreatsAsFailure();
  expect(isFailure("sandbox_runtime.content_audit_failed")).toBe(true);
  expect(isFailure("sandbox_runtime.content_audit_retryable")).toBe(true);
  expect(isFailure("sandbox_runtime.content_audit_completed")).toBe(false);
});

it("logs a failed deferred audit under an event name that the deploy start-up readback treats as a failure", async () => {
  process.env["HIMAWARI_RUNTIME_PROTECTION_FILE"] = manifestPath;
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await verifyProtectedRuntime(root, digest, async () => "c".repeat(64), [], {
      deferContentAudit: true,
    });
    const settledEvent = () =>
      logged.mock.calls
        .map(([line]) => JSON.parse(String(line)) as { event?: string })
        .map(({ event }) => event)
        .find((event) => event !== undefined && /content_audit_(?!started|retrying)/.test(event));
    await vi.waitFor(() => expect(settledEvent()).toBeDefined());
    expect(settledEvent()).toBe("sandbox_runtime.content_audit_failed");
    expect(startupReadbackTreatsAsFailure()(String(settledEvent()))).toBe(true);
  } finally {
    logged.mockRestore();
  }
});
