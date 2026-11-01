import { mkdir, mkdtemp, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectSandboxCommands,
  SANDBOX_COMMAND_CANDIDATES,
  SANDBOX_READ_ROOTS,
  sandboxCanRead,
} from "../src/sandbox-command-inventory.js";
import { runCapabilityNotice } from "../src/production-run-policy.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

async function tree() {
  const base = await mkdtemp(path.join(tmpdir(), "inventory-"));
  directories.push(base);
  for (const name of ["bin", "alternatives", "closed"]) await mkdir(path.join(base, name));
  const program = path.join(base, "program");
  await writeFile(program, "#!/bin/sh\n");
  await chmod(program, 0o755);
  await symlink(program, path.join(base, "alternatives", "awk"));
  await symlink(program, path.join(base, "closed", "vi"));
  await symlink(path.join(base, "alternatives", "awk"), path.join(base, "bin", "awk"));
  await symlink(path.join(base, "closed", "vi"), path.join(base, "bin", "vi"));
  await symlink(program, path.join(base, "bin", "sed"));
  await writeFile(path.join(base, "bin", "grep"), "x");
  await symlink(path.join(base, "nowhere"), path.join(base, "bin", "perl"));
  return base;
}

describe("sandbox command inventory", () => {
  it("lists a command as available only when the sandbox can follow every link to an executable", async () => {
    const base = await tree();
    const roots = [path.join(base, "bin"), path.join(base, "alternatives"), program(base)];
    const inventory = await inspectSandboxCommands({
      directories: [path.join(base, "bin")],
      roots,
      candidates: ["awk", "sed", "vi", "grep", "perl", "zip"],
      runtimeCommands: ["bash"],
    });
    expect(inventory.available).toEqual(["bash", "awk", "sed"]);
    expect(inventory.unavailable).toEqual(["vi", "grep", "perl", "zip"]);
    const withClosed = await inspectSandboxCommands({
      directories: [path.join(base, "bin")],
      roots: [...roots, path.join(base, "closed")],
      candidates: ["awk", "vi"],
      runtimeCommands: [],
    });
    expect(withClosed.available).toEqual(["awk", "vi"]);
  });

  it("follows usr-merged system paths", () => {
    expect(sandboxCanRead("/lib/x86_64-linux-gnu/libc.so.6", SANDBOX_READ_ROOTS)).toBe(true);
    expect(sandboxCanRead("/etc/alternatives/awk", SANDBOX_READ_ROOTS)).toBe(true);
    expect(sandboxCanRead("/etc/alternatives/awk", ["/usr/bin"])).toBe(false);
    for (const secret of ["/etc/shadow", "/etc/passwd", "/etc/himawari/config.json", "/root/x"])
      expect(sandboxCanRead(secret, SANDBOX_READ_ROOTS)).toBe(false);
  });

  it("keeps the readable roots equal to the ones the release packet seals", () => {
    const seal = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../scripts/delivery-mode/packet-template/signing/cloud-seal.mjs",
      ),
      "utf8",
    );
    const block = seal.split("readOnlyToolchainPaths: [")[1]?.split("protectedPaths: [")[0] ?? "";
    expect([...block.matchAll(/"(\/[^"]*)"/g)].map((match) => match[1])).toEqual(
      expect.arrayContaining([...SANDBOX_READ_ROOTS]),
    );
    expect([...block.matchAll(/"(\/[^"]*)"/g)].length).toBe(SANDBOX_READ_ROOTS.length);
  });

  it("tells the model which commands exist and which do not", () => {
    const notice = runCapabilityNotice({
      publicSearch: false,
      coding: true,
      workspaceRoot: "/var/lib/himawari/workspace",
      sandboxCommands: { available: ["bash", "sed"], unavailable: ["awk", "zip"] },
    });
    expect(notice).toContain("能直接用的常用命令：bash、sed");
    expect(notice).toContain("沙箱里没有：awk、zip");
    expect(notice).toContain("command -v");
    expect(
      runCapabilityNotice({ publicSearch: false, coding: false, workspaceRoot: null }),
    ).not.toContain("常用命令");
  });

  it("does not offer candidates that need the network", () => {
    for (const network of ["curl", "wget", "pip", "pip3", "npm"])
      expect(SANDBOX_COMMAND_CANDIDATES).not.toContain(network);
  });
});

function program(base: string) {
  return path.join(base, "program");
}
