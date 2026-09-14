import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  root: "",
  port: { postMessage: vi.fn() } as { postMessage: ReturnType<typeof vi.fn> } | null,
  opened: vi.fn(),
  read: vi.fn(),
}));
vi.mock("node:worker_threads", () => ({
  get parentPort() {
    return boundary.port;
  },
  get workerData() {
    return boundary.root;
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
    expect(boundary.port?.postMessage).toHaveBeenCalledExactlyOnceWith(
      createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    );
    expect(boundary.read.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
  it.each(["relative", "noncanonical", "writable-directory", "writable-file", "symlink"])(
    "rejects unsafe %s without publishing a digest",
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
          ? { ...value, ino: value.ino + 1 }
          : value;
      });
      await expect(load()).rejects.toThrow("SANDBOX_HOST_CHANGED");
      expect(boundary.port?.postMessage).not.toHaveBeenCalled();
      // The owned temporary file remains removable after the failed read.
      rmSync(path.join(root, "file"));
    },
  );
  it("does no work when imported without a Worker channel", async () => {
    boundary.port = null;
    boundary.root = "invalid";
    await load();
    expect(boundary.read).not.toHaveBeenCalled();
  });
});
