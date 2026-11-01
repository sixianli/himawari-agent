import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  root: "",
  fingerprintFile: undefined as string | undefined,
  port: { postMessage: vi.fn() } as { postMessage: ReturnType<typeof vi.fn> } | null,
  opened: vi.fn(),
  read: vi.fn(),
  resolved: vi.fn(),
}));
vi.mock("node:worker_threads", () => ({
  get parentPort() {
    return boundary.port;
  },
  get workerData() {
    return { root: boundary.root, fingerprintFile: boundary.fingerprintFile };
  },
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    fstatSync: (...args: Parameters<typeof fs.fstatSync>) => {
      const value = fs.fstatSync(...args);
      return boundary.opened(value) ?? value;
    },
    readSync: (...args: Parameters<typeof fs.readSync>) => {
      boundary.read();
      return fs.readSync(...args);
    },
    realpathSync: Object.assign(
      (...args: Parameters<typeof fs.realpathSync>) => {
        boundary.resolved(args[0]);
        return fs.realpathSync(...args);
      },
      { native: fs.realpathSync.native },
    ),
  };
});
let root: string;
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "runtime-digest-contract-")));
  chmodSync(root, 0o700);
  boundary.root = root;
  boundary.port = { postMessage: vi.fn() };
  boundary.fingerprintFile = undefined;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const load = () => import("../src/capabilities/sandbox-runtime-digest-worker.ts");
const put = (name: string, content: string) => {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, content, { mode: 0o600 });
};
describe("installed runtime byte verification worker", () => {
  it("hashes every byte and binds relative names, sizes and modes in stable order", async () => {
    put("z.txt", "last");
    put("nested/a.txt", "first");
    await load();
    const files = [
      {
        path: "nested/a.txt",
        sha256: createHash("sha256").update("first").digest("hex"),
        bytes: 5,
        mode: 0o600,
      },
      {
        path: "z.txt",
        sha256: createHash("sha256").update("last").digest("hex"),
        bytes: 4,
        mode: 0o600,
      },
    ];
    expect(boundary.port?.postMessage).toHaveBeenCalledExactlyOnceWith({
      digest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
      reused: 0,
      hashed: 2,
    });
    expect(boundary.read.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
  it.each(["relative", "noncanonical", "writable-directory", "writable-file", "symlink"])(
    "rejects unsafe %s without publishing a result",
    async (kind) => {
      put("file", "fixture");
      if (kind === "relative") boundary.root = "relative/runtime";
      if (kind === "noncanonical") boundary.root = root + "/../" + path.basename(root);
      if (kind === "writable-directory") chmodSync(root, 0o777);
      if (kind === "writable-file") chmodSync(path.join(root, "file"), 0o666);
      if (kind === "symlink") symlinkSync(path.join(root, "file"), path.join(root, "link"));
      await expect(load()).rejects.toThrow("SANDBOX_HOST_PATH_UNSAFE");
      expect(boundary.port?.postMessage).not.toHaveBeenCalled();
    },
  );
  it.each(["opened identity", "changed during read"])(
    "rejects %s and does not publish a partial proof",
    async (kind) => {
      put("file", "fixture");
      let calls = 0;
      boundary.opened.mockImplementation((value) => {
        calls++;
        return calls === (kind === "opened identity" ? 1 : 2)
          ? { ...value, ino: value.ino + 1n }
          : value;
      });
      await expect(load()).rejects.toThrow("SANDBOX_HOST_CHANGED");
      expect(boundary.port?.postMessage).not.toHaveBeenCalled();
      rmSync(path.join(root, "file"));
    },
  );
  it("[R2-D25] resolves only the runtime root", async () => {
    put("a/b/c/file", "fixture");
    put("d/file", "fixture");
    await load();
    expect(boundary.port?.postMessage).toHaveBeenCalledOnce();
    expect(new Set(boundary.resolved.mock.calls.map(([value]) => value))).toEqual(new Set([root]));
  });
  it("[R2-D25] rejects a nested directory replaced by a symlink", async () => {
    put("outside/file", "fixture");
    put("inside/keep", "fixture");
    symlinkSync(path.join(root, "outside"), path.join(root, "inside", "linked"));
    await expect(load()).rejects.toThrow("SANDBOX_HOST_PATH_UNSAFE");
    expect(boundary.port?.postMessage).not.toHaveBeenCalled();
  });
  it("does no work when imported without a Worker channel", async () => {
    boundary.port = null;
    boundary.root = "invalid";
    await load();
    expect(boundary.read).not.toHaveBeenCalled();
  });
  describe("persisted fingerprint cache", () => {
    let cacheFile: string;
    let cacheDirectory: string;
    beforeEach(() => {
      cacheDirectory = realpathSync(mkdtempSync(path.join(tmpdir(), "runtime-fingerprint-cache-")));
      cacheFile = path.join(cacheDirectory, "cache", "fingerprints.json");
      boundary.fingerprintFile = cacheFile;
    });
    afterEach(() => {
      vi.useRealTimers();
      rmSync(cacheDirectory, { recursive: true, force: true });
    });
    const run = async () => {
      boundary.port = { postMessage: vi.fn() };
      vi.resetModules();
      await load();
      return boundary.port?.postMessage.mock.calls[0]?.[0] as {
        digest: string;
        reused: number;
        hashed: number;
      };
    };
    const settle = () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 60_000);
    };
    it("hashes every file once, then reuses the stored hashes without reading any file", async () => {
      put("a.txt", "alpha");
      put("dir/b.txt", "bravo");
      settle();
      const first = await run();
      expect(first).toMatchObject({ reused: 0, hashed: 2 });
      expect(readFileSync(cacheFile, "utf8")).toContain("dir/b.txt");
      boundary.read.mockClear();
      const second = await run();
      expect(second).toEqual({ ...first, reused: 2, hashed: 0 });
      expect(boundary.read).not.toHaveBeenCalled();
    });
    it("rehashes a file whose bytes changed and reports the new digest", async () => {
      put("a.txt", "alpha");
      put("b.txt", "bravo");
      settle();
      const first = await run();
      appendFileSync(path.join(root, "a.txt"), "!");
      settle();
      const second = await run();
      expect(second).toMatchObject({ reused: 1, hashed: 1 });
      expect(second.digest).not.toBe(first.digest);
    });
    it("rehashes a file whose size and mtime were restored after a content change", async () => {
      put("a.txt", "alpha");
      settle();
      const first = await run();
      const file = path.join(root, "a.txt");
      const before = new Date(Date.now() - 120_000);
      writeFileSync(file, "ALPHA");
      utimesSync(file, before, before);
      settle();
      const second = await run();
      expect(second.hashed).toBe(1);
      expect(second.digest).not.toBe(first.digest);
    });
    it("drops a deleted file and hashes an added file", async () => {
      put("a.txt", "alpha");
      put("b.txt", "bravo");
      settle();
      await run();
      rmSync(path.join(root, "b.txt"));
      put("c.txt", "charlie");
      settle();
      const second = await run();
      expect(second).toMatchObject({ reused: 1, hashed: 1 });
      expect(readFileSync(cacheFile, "utf8")).not.toContain("b.txt");
    });
    it("never trusts a file changed within the racy window", async () => {
      put("a.txt", "alpha");
      await run();
      boundary.read.mockClear();
      const second = await run();
      expect(second).toMatchObject({ reused: 0, hashed: 1 });
      expect(boundary.read).toHaveBeenCalled();
    });
    it.each(["corrupt json", "other root", "group writable", "bad entry"])(
      "ignores a %s cache and hashes everything",
      async (kind) => {
        put("a.txt", "alpha");
        settle();
        await run();
        const raw = JSON.parse(readFileSync(cacheFile, "utf8"));
        if (kind === "corrupt json") writeFileSync(cacheFile, "{not json");
        if (kind === "other root")
          writeFileSync(cacheFile, JSON.stringify({ ...raw, root: "/elsewhere" }));
        if (kind === "group writable") chmodSync(cacheFile, 0o666);
        if (kind === "bad entry") {
          raw.files["a.txt"].sha256 = "zz";
          writeFileSync(cacheFile, JSON.stringify(raw));
        }
        const second = await run();
        expect(second).toMatchObject({ reused: 0, hashed: 1 });
      },
    );
    it("does not follow a symlinked cache file", async () => {
      put("a.txt", "alpha");
      settle();
      await run();
      const real = `${cacheFile}.real`;
      writeFileSync(real, readFileSync(cacheFile));
      rmSync(cacheFile);
      symlinkSync(real, cacheFile);
      const second = await run();
      expect(second).toMatchObject({ reused: 0, hashed: 1 });
    });
    it("produces the same digest with and without the cache", async () => {
      put("a.txt", "alpha");
      put("n/b.txt", "bravo");
      settle();
      const cached = await run();
      const reused = await run();
      boundary.fingerprintFile = undefined;
      const plain = await run();
      expect(reused.digest).toBe(plain.digest);
      expect(cached.digest).toBe(plain.digest);
    });
  });
});
