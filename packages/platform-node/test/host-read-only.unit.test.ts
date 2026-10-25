import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  HOST_READ_ONLY_ERROR_CODES as CODES,
  HostReadOnlyError,
  type HostDirectoryGrant,
} from "@himawari-agent/application";
import { describe, expect, it } from "vitest";
import { DescriptorRelativeReadOnly } from "../src/files/host-read-only.js";

const linux = process.platform === "linux";
const scratchRoot = process.env["HIMAWARI_TEST_TEMP_ROOT"] ?? os.tmpdir();

function workspace(): string {
  const directory = mkdtempSync(path.join(scratchRoot, "host-read-"));
  chmodSync(directory, 0o700);
  return directory;
}

function grantFor(directory: string): HostDirectoryGrant {
  const info = lstatSync(directory, { bigint: true });
  return Object.freeze({
    id: "directory:test",
    revision: 1,
    hostId: "host:test",
    canonicalRootId: `${info.dev}:${info.ino}`,
    displayPath: directory,
    operations: Object.freeze(["read" as const]),
    dataClassification: "private" as const,
    disclosure: "model" as const,
    pathPolicy: "same_filesystem_no_links" as const,
    mountPolicy: "fixed_device" as const,
    authorizationRef: "authorization:test",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    revokedAt: null,
  });
}

async function reject(run: () => Promise<unknown>): Promise<HostReadOnlyError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof HostReadOnlyError) return error;
    throw error;
  }
  throw new Error("expected the read-only port to reject");
}

function text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

describe("descriptor-relative read-only port", () => {
  if (!linux) {
    it("reports itself unavailable on hosts without procfs", async () => {
      const port = new DescriptorRelativeReadOnly();
      expect(port.available).toBe(false);
      const directory = workspace();
      await expect(
        port.readFile({
          grant: grantFor(directory),
          relativePath: "notes.txt",
          maximumBytes: 1024,
        }),
      ).rejects.toMatchObject({ code: CODES.PROC_UNAVAILABLE });
      rmSync(directory, { recursive: true, force: true });
    });
    return;
  }

  it("reads a regular file inside the granted root", async () => {
    const directory = workspace();
    const port = new DescriptorRelativeReadOnly();
    expect(port.available).toBe(true);
    writeFileSync(path.join(directory, "notes.txt"), "向日葵\n");
    const bytes = await port.readFile({
      grant: grantFor(directory),
      relativePath: "notes.txt",
      maximumBytes: 1024,
    });
    expect(text(bytes)).toBe("向日葵\n");
    rmSync(directory, { recursive: true, force: true });
  });

  it("reports a missing target", async () => {
    const directory = workspace();
    const port = new DescriptorRelativeReadOnly();
    const error = await reject(() =>
      port.readFile({
        grant: grantFor(directory),
        relativePath: "missing.txt",
        maximumBytes: 1024,
      }),
    );
    expect(error.code).toBe(CODES.TARGET_MISSING);
    rmSync(directory, { recursive: true, force: true });
  });

  it("refuses traversal and absolute components before opening", async () => {
    const directory = workspace();
    const port = new DescriptorRelativeReadOnly();
    const grant = grantFor(directory);
    for (const relativePath of ["..", "../outside", "a/../../b", "/etc/passwd", "", "."]) {
      const error = await reject(() => port.readFile({ grant, relativePath, maximumBytes: 1024 }));
      expect([CODES.PATH_UNSAFE, CODES.NOT_REGULAR]).toContain(error.code);
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it("refuses a final symlink that points outside the root", async () => {
    const directory = workspace();
    const outside = mkdtempSync(path.join(scratchRoot, "host-out-"));
    writeFileSync(path.join(outside, "secret.txt"), "outside\n");
    symlinkSync(path.join(outside, "secret.txt"), path.join(directory, "link.txt"));
    const port = new DescriptorRelativeReadOnly();
    const error = await reject(() =>
      port.readFile({ grant: grantFor(directory), relativePath: "link.txt", maximumBytes: 1024 }),
    );
    expect(error.code).toBe(CODES.LINK_ESCAPE);
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses an intermediate directory that is a symlink to outside", async () => {
    const directory = workspace();
    const outside = mkdtempSync(path.join(scratchRoot, "host-out-"));
    writeFileSync(path.join(outside, "secret.txt"), "outside\n");
    symlinkSync(outside, path.join(directory, "sub"));
    const port = new DescriptorRelativeReadOnly();
    const error = await reject(() =>
      port.readFile({
        grant: grantFor(directory),
        relativePath: "sub/secret.txt",
        maximumBytes: 1024,
      }),
    );
    expect(error.code).toBe(CODES.LINK_ESCAPE);
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a hard link inside the root", async () => {
    const directory = workspace();
    writeFileSync(path.join(directory, "target.txt"), "content\n");
    execFileSync("ln", [path.join(directory, "target.txt"), path.join(directory, "alias.txt")]);
    const port = new DescriptorRelativeReadOnly();
    const error = await reject(() =>
      port.readFile({ grant: grantFor(directory), relativePath: "alias.txt", maximumBytes: 1024 }),
    );
    expect(error.code).toBe(CODES.HARDLINK);
    rmSync(directory, { recursive: true, force: true });
  });

  it("refuses a FIFO without blocking", async () => {
    const directory = workspace();
    execFileSync("mkfifo", [path.join(directory, "pipe")]);
    const port = new DescriptorRelativeReadOnly();
    const started = Date.now();
    const error = await reject(() =>
      port.readFile({ grant: grantFor(directory), relativePath: "pipe", maximumBytes: 1024 }),
    );
    expect(error.code).toBe(CODES.NOT_REGULAR);
    expect(Date.now() - started).toBeLessThan(2_000);
    rmSync(directory, { recursive: true, force: true });
  });

  it("refuses protected names case-insensitively", async () => {
    const directory = workspace();
    for (const name of [".env", "KEY.PEM", ".ssh", "id_rsa"]) {
      if (name === ".ssh") mkdirSync(path.join(directory, name));
      else writeFileSync(path.join(directory, name), "secret\n");
    }
    const port = new DescriptorRelativeReadOnly();
    const grant = grantFor(directory);
    for (const relativePath of [".env", "KEY.PEM", ".ssh", "id_rsa"]) {
      const error = await reject(() => port.readFile({ grant, relativePath, maximumBytes: 1024 }));
      expect(error.code).toBe(CODES.PROTECTED);
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it("refuses a file larger than the read limit", async () => {
    const directory = workspace();
    writeFileSync(path.join(directory, "big.txt"), "x".repeat(4096));
    const port = new DescriptorRelativeReadOnly();
    const error = await reject(() =>
      port.readFile({ grant: grantFor(directory), relativePath: "big.txt", maximumBytes: 1024 }),
    );
    expect(error.code).toBe(CODES.LENGTH_EXCEEDED);
    rmSync(directory, { recursive: true, force: true });
  });

  it("refuses a root whose identity no longer matches the grant", async () => {
    const directory = workspace();
    writeFileSync(path.join(directory, "notes.txt"), "content\n");
    const port = new DescriptorRelativeReadOnly();
    const grant = { ...grantFor(directory), canonicalRootId: "1:1" };
    const error = await reject(() =>
      port.readFile({ grant, relativePath: "notes.txt", maximumBytes: 1024 }),
    );
    expect(error.code).toBe(CODES.ROOT_IDENTITY_CHANGED);
    rmSync(directory, { recursive: true, force: true });
  });

  it("refuses a root whose inode changed on the same filesystem", async () => {
    const directory = workspace();
    writeFileSync(path.join(directory, "notes.txt"), "content\n");
    const other = workspace();
    writeFileSync(path.join(other, "notes.txt"), "other\n");
    const port = new DescriptorRelativeReadOnly();
    const grant = { ...grantFor(directory), displayPath: other };
    for (const run of [
      () => port.readFile({ grant, relativePath: "notes.txt", maximumBytes: 1024 }),
      () => port.listDirectory({ grant, relativePath: "" }),
      () => port.inspectEntry({ grant, relativePath: "notes.txt" }),
    ]) {
      const error = await reject(run);
      expect(error.code).toBe(CODES.ROOT_IDENTITY_CHANGED);
    }
    rmSync(directory, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  it("refuses protected paths for listing and inspection as well as reading", async () => {
    const directory = workspace();
    mkdirSync(path.join(directory, ".ssh"));
    writeFileSync(path.join(directory, ".ssh", "config"), "Host x\n");
    writeFileSync(path.join(directory, "KEY.PEM"), "key\n");
    const port = new DescriptorRelativeReadOnly();
    const grant = grantFor(directory);
    for (const relativePath of [".ssh", "KEY.PEM"]) {
      for (const run of [
        () => port.readFile({ grant, relativePath, maximumBytes: 1024 }),
        () => port.listDirectory({ grant, relativePath }),
        () => port.inspectEntry({ grant, relativePath }),
      ]) {
        const error = await reject(run);
        expect(error.code).toBe(CODES.PROTECTED);
      }
    }
    const entries = await port.listDirectory({ grant, relativePath: "" });
    expect(entries.map((entry) => entry.name).sort()).toEqual([".ssh", "KEY.PEM"].sort());
    rmSync(directory, { recursive: true, force: true });
  });

  it("refuses a directory that was replaced by a symlink to outside", async () => {
    const directory = workspace();
    mkdirSync(path.join(directory, "sub"));
    writeFileSync(path.join(directory, "sub", "inside.txt"), "inside\n");
    const outside = mkdtempSync(path.join(scratchRoot, "host-out-"));
    writeFileSync(path.join(outside, "inside.txt"), "outside\n");
    const port = new DescriptorRelativeReadOnly();
    const grant = grantFor(directory);
    const renamed = `${directory}-moved`;
    execFileSync("mv", [path.join(directory, "sub"), renamed]);
    symlinkSync(outside, path.join(directory, "sub"));
    let escaped: string | undefined;
    const error = await reject(async () => {
      const bytes = await port.readFile({
        grant,
        relativePath: "sub/inside.txt",
        maximumBytes: 1024,
      });
      escaped = text(bytes);
    });
    expect(error.code).toBe(CODES.LINK_ESCAPE);
    expect(escaped).toBeUndefined();
    rmSync(directory, { recursive: true, force: true });
    rmSync(renamed, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a root path that became a symlink", async () => {
    const directory = workspace();
    const outside = mkdtempSync(path.join(scratchRoot, "host-out-"));
    writeFileSync(path.join(outside, "inside.txt"), "outside\n");
    const grant = grantFor(directory);
    const renamed = `${directory}-moved`;
    execFileSync("mv", [directory, renamed]);
    symlinkSync(outside, directory);
    const port = new DescriptorRelativeReadOnly();
    const error = await reject(() =>
      port.readFile({ grant, relativePath: "inside.txt", maximumBytes: 1024 }),
    );
    expect(error.code).toBe(CODES.ROOT_IDENTITY_CHANGED);
    rmSync(directory, { recursive: true, force: true });
    rmSync(renamed, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("lists entries without following symlinks, including protected names", async () => {
    const directory = workspace();
    writeFileSync(path.join(directory, "a.txt"), "a\n");
    mkdirSync(path.join(directory, "sub"));
    writeFileSync(path.join(directory, ".env"), "secret\n");
    symlinkSync(path.join(directory, "sub"), path.join(directory, "dirlink"));
    const port = new DescriptorRelativeReadOnly();
    const entries = await port.listDirectory({ grant: grantFor(directory), relativePath: "" });
    const byName = new Map(entries.map((entry) => [entry.name, entry.kind]));
    expect(byName.get("a.txt")).toBe("file");
    expect(byName.get("sub")).toBe("directory");
    expect(byName.get(".env")).toBe("file");
    expect(byName.get("dirlink")).toBe("other");
    rmSync(directory, { recursive: true, force: true });
  });

  it("inspects entries without following the final component", async () => {
    const directory = workspace();
    mkdirSync(path.join(directory, "sub"));
    writeFileSync(path.join(directory, "sub", "file.txt"), "x\n");
    symlinkSync(path.join(directory, "sub"), path.join(directory, "dirlink"));
    const port = new DescriptorRelativeReadOnly();
    const grant = grantFor(directory);
    expect(await port.inspectEntry({ grant, relativePath: "" })).toBe("directory");
    expect(await port.inspectEntry({ grant, relativePath: "sub" })).toBe("directory");
    expect(await port.inspectEntry({ grant, relativePath: "sub/file.txt" })).toBe("file");
    expect(await port.inspectEntry({ grant, relativePath: "dirlink" })).toBe("other");
    expect(await port.inspectEntry({ grant, relativePath: "nope" })).toBeNull();
    rmSync(directory, { recursive: true, force: true });
  });

  it("does not leak descriptors across calls", async () => {
    const directory = workspace();
    writeFileSync(path.join(directory, "notes.txt"), "content\n");
    mkdirSync(path.join(directory, "sub"));
    const port = new DescriptorRelativeReadOnly();
    const grant = grantFor(directory);
    const before = readdirSync("/proc/self/fd").length;
    for (let index = 0; index < 25; index++) {
      await port.readFile({ grant, relativePath: "notes.txt", maximumBytes: 1024 });
      await port.listDirectory({ grant, relativePath: "" });
      await port.inspectEntry({ grant, relativePath: "sub" });
      await reject(() => port.readFile({ grant, relativePath: "sub", maximumBytes: 1024 }));
    }
    const after = readdirSync("/proc/self/fd").length;
    expect(after).toBeLessThanOrEqual(before + 2);
    rmSync(directory, { recursive: true, force: true });
  });

  it("never returns bytes for a file that changed during the read", async () => {
    const directory = workspace();
    const target = path.join(directory, "changing.txt");
    const content = createHash("sha256").update("seed").digest("hex").repeat(8192);
    writeFileSync(target, content);
    const port = new DescriptorRelativeReadOnly();
    const grant = grantFor(directory);
    const child = spawn(process.execPath, [
      "-e",
      `const fs=require("fs");const p=${JSON.stringify(target)};const t=setInterval(()=>{try{fs.truncateSync(p,0);}catch{} },1);setTimeout(()=>{clearInterval(t);},2000);`,
    ]);
    try {
      const bytes = await port.readFile({
        grant,
        relativePath: "changing.txt",
        maximumBytes: content.length + 16,
      });
      const digest = createHash("sha256").update(bytes).digest("hex");
      expect(digest).toBe(createHash("sha256").update(content).digest("hex"));
    } catch (error) {
      expect((error as HostReadOnlyError).code).toBe(CODES.CONTENT_CHANGED);
    } finally {
      child.kill("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
