import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  rename,
  link,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HostDirectoryGrant } from "@himawari-agent/application";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConstrainedHostFileSystem,
  createSandboxedCodingOperations,
  exportPiOutputFile,
  formatForegroundPiResult,
} from "../src/index.js";

const BACKGROUND_OUTPUT_NOTICE =
  "仍有后台程序占用这次命令的输出，它之后的输出不会显示在这次结果里；如果它继续往这里写输出，会被系统结束。需要长期运行的程序，请把输出重定向到文件，例如 `npm run dev > dev.log 2>&1 &`。";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(initial?: string) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-ops-")));
  roots.push(root);
  const file = path.join(root, "file.txt");
  if (initial !== undefined) await writeFile(file, initial);
  const identity = await new ConstrainedHostFileSystem().inspectRoot(root);
  const grant: HostDirectoryGrant = {
    id: "grant",
    revision: 1,
    hostId: "host",
    canonicalRootId: `${identity.device}:${identity.inode}`,
    displayPath: root,
    operations: ["read", "create", "update"],
    dataClassification: "private",
    disclosure: "worker",
    pathPolicy: "same_filesystem_no_links",
    mountPolicy: "fixed_device",
    authorizationRef: "authorization",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    revokedAt: null,
  };
  const port = await createSandboxedCodingOperations({
    grant,
    targetPath: file,
    shell: "/bin/bash",
    privateDirectory: root,
    commandPath: "/usr/bin",
    maxOutputBytes: 4096,
  });
  return { root, file, grant, port };
}
describe("sandboxed coding file operations", () => {
  it("does not publish when durable preparation fails", async () => {
    const { root, file, grant } = await setup("original");
    let calls = 0;
    const options = {
      grant,
      targetPath: file,
      shell: "/bin/bash",
      privateDirectory: root,
      commandPath: "/usr/bin",
      maxOutputBytes: 4096,
      async onPreparedWrite() {
        calls++;
        throw new Error("JOURNAL_UNAVAILABLE");
      },
    };
    const port = await createSandboxedCodingOperations(options);
    await expect(port.writeFile(file, "new bytes")).rejects.toThrow("JOURNAL_UNAVAILABLE");
    expect(calls).toBe(1);
    expect(await readFile(file, "utf8")).toBe("original");
  });
  it("waits for durable write verification before reporting completion", async () => {
    const { root, file, grant } = await setup("original");
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const stored = new Promise<void>((resolve) => {
      release = resolve;
    });
    const port = await createSandboxedCodingOperations({
      grant,
      targetPath: file,
      shell: "/bin/bash",
      privateDirectory: root,
      commandPath: "/usr/bin",
      maxOutputBytes: 4096,
      async onVerifiedWrite() {
        reached();
        await stored;
      },
    });
    let complete = false;
    const write = port.writeFile(file, "new bytes").then(() => {
      complete = true;
    });
    await entered;
    // An observable filesystem read allows the old, unawaited callback path to finish.
    expect(await readFile(file, "utf8")).toBe("new bytes");
    const completedBeforeReceipt = complete;
    release();
    await write;
    expect(completedBeforeReceipt).toBe(false);
  });
  it("pins a fixed file call to its target even within a broader grant", async () => {
    const { root, file, port } = await setup("original");
    const other = path.join(root, "other.txt");
    await writeFile(other, "unrelated");
    await expect(port.readFile(other)).rejects.toThrow("PI_FIXED_TARGET_CHANGED");
    await expect(port.access(other, "read")).rejects.toThrow("PI_FIXED_TARGET_CHANGED");
    await expect(port.writeFile(other, "replacement")).rejects.toThrow("PI_FIXED_TARGET_CHANGED");
    await expect(port.makeDirectory(path.join(root, "elsewhere"))).rejects.toThrow(
      "PI_FIXED_TARGET_CHANGED",
    );
    expect(await readFile(other, "utf8")).toBe("unrelated");
    await port.makeDirectory(root);
    await port.writeFile(file, "updated");
    expect(await readFile(file, "utf8")).toBe("updated");
  });
  it("does not expose a shell through a fixed file call with broad directory authority", async () => {
    const { root, file, grant } = await setup("original");
    const port = await createSandboxedCodingOperations({
      grant: {
        ...grant,
        operations: ["read", "create", "update", "move", "trash", "restore", "permanent_delete"],
      },
      targetPath: file,
      shell: "/bin/bash",
      privateDirectory: root,
      commandPath: "/usr/bin",
      maxOutputBytes: 4096,
    });
    await expect(
      port.executeCommand({ cwd: root, command: "printf bypass > other.txt", onData() {} }),
    ).rejects.toThrow("PI_FIXED_FILE_COMMAND_DENIED");
    await expect(readFile(path.join(root, "other.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("creates missing parents exclusively and reads a genuine empty file", async () => {
    const { file, port } = await setup();
    await expect(port.readFile(file)).rejects.toThrow("PI_FILE_MISSING");
    await port.writeFile(file, "");
    expect(await readFile(file, "utf8")).toBe("");
  });
  it("safely replaces an empty existing file", async () => {
    const { file, port } = await setup("");
    expect(await port.readFile(file)).toHaveLength(0);
    await port.writeFile(file, "new content");
    expect(await readFile(file, "utf8")).toBe("new content");
  });
  it("preserves an external modification between prepare and write", async () => {
    const { file, port } = await setup("original");
    await writeFile(file, "user edit");
    await expect(port.writeFile(file, "agent edit")).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("user edit");
  });
  it("does not replace a file created after the exclusive-create baseline", async () => {
    const { file, port } = await setup();
    await writeFile(file, "user file");
    await expect(port.writeFile(file, "agent file")).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("user file");
  });
  it("rejects escape, protected paths and changed symlink targets", async () => {
    const { root, file, port } = await setup("original");
    for (const name of ["../other", ".env", ".git/config", ".himawari-recovery/x"])
      await expect(port.readFile(path.resolve(root, name))).rejects.toThrow();
    await rm(file);
    await symlink(path.join(root, "other"), file);
    await expect(port.writeFile(file, "replacement")).rejects.toThrow();
  });
  it("does not turn a partial file write grant into arbitrary shell authority", async () => {
    const { root, grant } = await setup();
    // Exercise the real command adapter; the fixed-file adapter rejects earlier.
    const port = await createSandboxedCodingOperations({
      grant,
      shell: "/bin/bash",
      privateDirectory: root,
      commandPath: "/usr/bin",
      maxOutputBytes: 4096,
    });
    await expect(port.executeCommand({ cwd: root, command: "true", onData() {} })).rejects.toThrow(
      "PI_SHELL_EFFECT_SCOPE_INCOMPLETE",
    );
  });
});
describe("Pi output export", () => {
  it("exports bytes and digest, without a host locator", async () => {
    const { root } = await setup();
    const file = path.join(root, "pi-bash-123abc.log");
    await writeFile(file, "output");
    const result = await exportPiOutputFile(file, root, 64);
    expect(Buffer.from(result.data, "base64").toString()).toBe("output");
    expect(JSON.stringify(result)).not.toContain(root);
  });
  it("rejects forged paths, links and oversized files", async () => {
    const { root, file } = await setup("private bytes");
    const output = path.join(root, "pi-bash-abc123.log");
    await expect(exportPiOutputFile(file, root, 64)).rejects.toThrow("PI_OUTPUT_OWNER_MISMATCH");
    await symlink(file, output);
    await expect(exportPiOutputFile(output, root, 64)).rejects.toThrow();
    await rm(output);
    await link(file, output);
    await expect(exportPiOutputFile(output, root, 64)).rejects.toThrow("PI_OUTPUT_FILE_REJECTED");
    await rm(output);
    await writeFile(output, "too long");
    await expect(exportPiOutputFile(output, root, 1)).rejects.toThrow("PI_OUTPUT_FILE_REJECTED");
  });
});

describe("sandboxed shell result boundary", () => {
  it("preserves nonzero exits and rejects signal exits instead of empty success", async () => {
    const { root, grant } = await setup();
    const port = await createSandboxedCodingOperations({
      grant: { ...grant, operations: ["read"] },
      shell: "/bin/bash",
      privateDirectory: root,
      commandPath: "/usr/bin",
      maxOutputBytes: 64,
    });
    let output = "";
    const command = {
      cwd: root,
      onData(bytes: Uint8Array) {
        output += Buffer.from(bytes).toString();
      },
    };
    expect(await port.executeCommand({ ...command, command: "printf output; exit 7" })).toEqual({
      exitCode: 7,
    });
    expect(output).toBe("output");
    await expect(port.executeCommand({ ...command, command: "kill -KILL $$" })).rejects.toThrow(
      "PI_COMMAND_SIGNALLED",
    );
    await expect(
      port.executeCommand({ ...command, command: "while :; do :; done", timeoutMs: 20 }),
    ).rejects.toThrow("PI_COMMAND_TIMEOUT");
    await expect(port.executeCommand({ ...command, command: "printf '%100s' x" })).rejects.toThrow(
      "PI_COMMAND_OUTPUT_LIMIT",
    );
  });
});

it.each(["unchanged", "create", "content", "inode", "created"] as const)(
  "enforces a host-frozen baseline at runner startup: %s",
  async (change) => {
    const { root, file, grant } = await setup(
      change === "created" || change === "create" ? undefined : "approved baseline",
    );
    const identity = await new ConstrainedHostFileSystem().inspect(grant, "file.txt");
    const [device, inode] = grant.canonicalRootId.split(":");
    if (!device || !inode) throw new Error("fixture root identity missing");
    const expectedTarget = {
      schemaVersion: "sandbox-file-target.v1" as const,
      relativePath: "file.txt",
      lineage: [{ device, inode }],
      before: identity
        ? {
            device: identity.device,
            inode: identity.inode,
            contentDigest: createHash("sha256").update("approved baseline").digest("hex"),
          }
        : null,
    };
    if (change === "inode") await rename(file, path.join(root, "old.txt"));
    const unchanged = change === "unchanged" || change === "create";
    if (!unchanged) await writeFile(file, "other writer's version");
    const starting = createSandboxedCodingOperations({
      grant,
      targetPath: file,
      expectedTarget,
      shell: "/bin/bash",
      privateDirectory: root,
      commandPath: "/usr/bin",
      maxOutputBytes: 4096,
    });
    if (unchanged) {
      const port = await starting;
      await port.writeFile(file, "approved result");
      expect(await readFile(file, "utf8")).toBe("approved result");
    } else {
      await expect(starting).rejects.toThrow("PI_FILE_VERSION_CHANGED");
      expect(await readFile(file, "utf8")).toBe("other writer's version");
    }
  },
);

it("keeps directory coordination while creating previously missing parents", async () => {
  const { root, grant } = await setup();
  const [device, inode] = grant.canonicalRootId.split(":");
  if (!device || !inode) throw new Error("fixture root identity missing");
  const file = path.join(root, "new", "notes", "file.txt");
  const port = await createSandboxedCodingOperations({
    grant,
    targetPath: file,
    expectedTarget: {
      schemaVersion: "sandbox-file-target.v1",
      relativePath: "new/notes/file.txt",
      lineage: [{ device, inode }],
      before: null,
      missingParents: 2,
    },
    shell: "/bin/bash",
    privateDirectory: root,
    commandPath: "/usr/bin",
    maxOutputBytes: 4096,
  });
  await port.makeDirectory(path.dirname(file));
  await port.writeFile(file, "complete nested file");
  expect(await readFile(file, "utf8")).toBe("complete nested file");
});

async function inheritedOutputFixture(
  mode: "quiet" | "tail" | "closed" | "continuous",
  maxOutputBytes = 4096,
) {
  const { root, grant } = await setup();
  const marker = `B3_PIPE_${path.basename(root)}`;
  const childFile = path.join(root, "child.cjs");
  const launcher = path.join(root, "launch.cjs");
  const pidFile = path.join(root, "child.pid");
  const readyFile = path.join(root, "child.ready");
  await writeFile(
    childFile,
    `
const fs = require("node:fs");
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
process.stdout.write("background-start\\n");
fs.writeFileSync(${JSON.stringify(readyFile)}, "ready");
let count = 0;
const mode = ${JSON.stringify(mode)};
if (mode !== "quiet") {
  const timer = setInterval(() => {
    count++;
    (count % 2 ? process.stdout : process.stderr).write("tail-" + count + "\\n");
    if (mode !== "continuous" && count === 20) {
      clearInterval(timer);
      if (mode === "closed") process.exit(0);
    }
  }, 20);
}
setTimeout(() => process.exit(0), 30000);
`,
  );
  await writeFile(
    launcher,
    `
const fs = require("node:fs");
const child = require("node:child_process").spawn(process.execPath, [${JSON.stringify(childFile)}, ${JSON.stringify(marker)}], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
child.unref();
const ready = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(readyFile)})) clearInterval(ready);
}, 5);
`,
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const port = await createSandboxedCodingOperations({
    grant: { ...grant, operations: ["read"] },
    shell: "/bin/bash",
    privateDirectory: root,
    commandPath: "/usr/bin:/bin",
    maxOutputBytes,
  });
  const child = async () => {
    const pid = Number(await readFile(pidFile, "utf8"));
    const command = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).trim();
    expect(command).toContain(marker);
    return pid;
  };
  return {
    root,
    port,
    command: `${quote(process.execPath)} ${quote(launcher)}; printf 'parent-output\\n'; exit`,
    child,
    async cleanup() {
      const pid = await readFile(pidFile, "utf8").then(Number, () => null);
      if (pid === null) return;
      const command = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" })
        .split("\n")
        .find((line) => new RegExp(`^\\s*${pid}\\s`).test(line));
      if (command?.includes(marker)) process.kill(pid, "SIGKILL");
    },
  };
}

describe("sandboxed Bash inherited output", () => {
  it("keeps an exact-limit command successful when appending the background notice", async () => {
    const original = "background-start\nparent-output\n";
    const fixture = await inheritedOutputFixture("quiet", Buffer.byteLength(original));
    let output = "";
    try {
      await expect(
        fixture.port.executeCommand({
          cwd: fixture.root,
          command: `${fixture.command} 0`,
          onData: (bytes) => {
            output += Buffer.from(bytes).toString();
          },
        }),
      ).resolves.toEqual({ exitCode: 0 });
      expect(output).toBe(original + "\n\n" + BACKGROUND_OUTPUT_NOTICE + "\n");
      expect(await fixture.child()).toBeGreaterThan(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([0, 7])(
    "settles a quiet inherited pipe with exit %s while its detached owner remains alive",
    async (exitCode) => {
      const fixture = await inheritedOutputFixture("quiet");
      let output = "";
      let result: { exitCode: number | null } | undefined;
      const running = fixture.port
        .executeCommand({
          cwd: fixture.root,
          command: `${fixture.command} ${exitCode}`,
          onData: (bytes) => {
            output += Buffer.from(bytes).toString();
          },
        })
        .then((value) => {
          result = value;
          return value;
        });
      try {
        await expect.poll(() => result, { timeout: 1500 }).toEqual({ exitCode });
        expect(output).toContain("parent-output\n");
        expect(output).toContain("background-start\n");
        expect(output).toContain(BACKGROUND_OUTPUT_NOTICE);
        expect(await fixture.child()).toBeGreaterThan(1);
      } finally {
        await fixture.cleanup();
        await running.catch(() => undefined);
      }
    },
  );

  it.each(["tail", "closed"] as const)(
    "keeps all post-exit stdout and stderr when the pipe is %s",
    async (mode) => {
      const fixture = await inheritedOutputFixture(mode);
      let output = "";
      let complete = false;
      const running = fixture.port
        .executeCommand({
          cwd: fixture.root,
          command: `${fixture.command} 0`,
          onData: (bytes) => {
            output += Buffer.from(bytes).toString();
          },
        })
        .then((value) => {
          complete = true;
          return value;
        });
      try {
        await expect.poll(() => complete, { timeout: 2000 }).toBe(true);
        expect(await running).toEqual({ exitCode: 0 });
        expect(
          output.match(/tail-\d+\n/g)?.sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))),
        ).toEqual(Array.from({ length: 20 }, (_, i) => `tail-${i + 1}\n`));
        expect(output.includes(BACKGROUND_OUTPUT_NOTICE)).toBe(mode === "tail");
        if (mode === "tail") await fixture.child();
      } finally {
        await fixture.cleanup();
        await running.catch(() => undefined);
      }
    },
  );

  it.each(["cancel", "deadline", "output-limit", "output-rejected"] as const)(
    "preserves %s while detached output never becomes idle",
    async (mode) => {
      const fixture = await inheritedOutputFixture(
        "continuous",
        mode === "output-limit" ? 64 : 4096,
      );
      const controller = new AbortController();
      let failure: unknown;
      const running = fixture.port
        .executeCommand({
          cwd: fixture.root,
          command: `${fixture.command} 0`,
          signal: controller.signal,
          timeoutMs: 1000,
          onData(bytes) {
            if (Buffer.from(bytes).toString().includes("tail-3")) {
              if (mode === "cancel") controller.abort();
              if (mode === "output-rejected") throw new Error("rejected by caller");
            }
          },
        })
        .catch((error: unknown) => {
          failure = error;
        });
      try {
        const expected = {
          cancel: "PI_COMMAND_ABORTED",
          deadline: "PI_COMMAND_TIMEOUT",
          "output-limit": "PI_COMMAND_OUTPUT_LIMIT",
          "output-rejected": "PI_COMMAND_OUTPUT_REJECTED",
        }[mode];
        await expect.poll(() => failure, { timeout: 2000 }).toMatchObject({ message: expected });
      } finally {
        await fixture.cleanup();
        await running;
      }
    },
  );
});

async function lateOutputFixture(runtime: "node" | "sh", redirected = false) {
  const { root, grant } = await setup();
  const marker = `B3_LATE_${runtime}_${path.basename(root)}`;
  const outputFile = path.join(root, "background.log");
  const gate = path.join(root, "write-now");
  const ready = path.join(root, "ready");
  const attempted = path.join(root, "attempted");
  const survived = path.join(root, "survived");
  const identityFile = path.join(root, "identity.json");
  const exitFile = path.join(root, "exit.json");
  const childFile = path.join(root, runtime === "node" ? "child.cjs" : "child.sh");
  const observerFile = path.join(root, "observer.cjs");
  const launcherFile = path.join(root, "launcher.cjs");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    childFile,
    runtime === "node"
      ? `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(ready)}, "ready");
const gate = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(gate)})) return;
  clearInterval(gate);
  fs.writeFileSync(${JSON.stringify(attempted)}, "attempted");
  process.stdout.write("late-node-output\\n");
  setInterval(() => {
    process.stdout.write("late-node-output\\n");
    fs.writeFileSync(${JSON.stringify(survived)}, "alive");
  }, 20);
}, 5);
setTimeout(() => process.exit(99), 10000);
`
      : `
printf ready > ${quote(ready)}
while [ ! -f ${quote(gate)} ]; do /bin/sleep 0.01; done
printf attempted > ${quote(attempted)}
while :; do
  echo late-sh-output
  printf alive > ${quote(survived)}
  /bin/sleep 0.02
done
`,
  );
  await writeFile(
    observerFile,
    `
const fs = require("node:fs");
const output = ${redirected ? `fs.openSync(${JSON.stringify(outputFile)}, "a")` : JSON.stringify("inherit")};
const child = require("node:child_process").spawn(${JSON.stringify(runtime === "node" ? process.execPath : "/bin/sh")}, [${JSON.stringify(childFile)}, ${JSON.stringify(marker)}], { detached: true, stdio: ["ignore", output, output] });
fs.writeFileSync(${JSON.stringify(identityFile)}, JSON.stringify({ pid: child.pid, observer: process.pid }));
child.once("exit", (code, signal) => fs.writeFileSync(${JSON.stringify(exitFile)}, JSON.stringify({ code, signal, at: Date.now() })));
`,
  );
  await writeFile(
    launcherFile,
    `
const fs = require("node:fs");
const observer = require("node:child_process").spawn(process.execPath, [${JSON.stringify(observerFile)}, ${JSON.stringify(marker + "_OBSERVER")}], { detached: true, stdio: ${JSON.stringify(redirected ? ["ignore", "ignore", "ignore"] : ["ignore", "inherit", "inherit"])} });
observer.unref();
const ready = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(ready)})) clearInterval(ready);
}, 5);
`,
  );
  const port = await createSandboxedCodingOperations({
    grant: { ...grant, operations: ["read"] },
    shell: "/bin/bash",
    privateDirectory: root,
    commandPath: "/usr/bin:/bin",
    maxOutputBytes: 4096,
  });
  const processes = () =>
    execFileSync("/bin/ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" })
      .split("\n")
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return match
          ? [{ pid: Number(match[1]), pgid: Number(match[2]), command: match[3] ?? "" }]
          : [];
      })
      .filter((row) => row.command.includes(marker));
  return {
    root,
    runtime,
    marker,
    gate,
    attempted,
    survived,
    outputFile,
    exitFile,
    identityFile,
    processes,
    port,
    command: `${quote(process.execPath)} ${quote(launcherFile)}; exit 0`,
    async cleanup() {
      for (const row of processes()) if (row.pid === row.pgid) process.kill(row.pid, "SIGKILL");
      await expect.poll(() => processes(), { timeout: 2000 }).toEqual([]);
    },
  };
}

describe("Bash background output delivery boundaries", () => {
  it("counts the ADR 0040 notice toward the whole foreground result limit", async () => {
    const original = "background-start\nparent-output\n";
    const publication = {
      tool: "bash",
      result: { content: [{ type: "text", text: original }], isError: false },
      commandExitCode: 0,
      verifiedWrite: null,
      privateDirectory: "/tmp",
      maxOutputBytes: 4096,
      closing: {},
      source: {
        workspace: "/workspace",
        toolCallId: "call",
        directoryGrantRef: "grant",
        directoryGrantRevision: 1,
        parameters: { command: "background-command" },
      },
    };
    const baseline = await formatForegroundPiResult(publication);
    const limit = Buffer.byteLength(baseline.output);
    await expect(
      formatForegroundPiResult({ ...publication, maxOutputBytes: limit }),
    ).resolves.toEqual(baseline);
    const fixture = await inheritedOutputFixture("quiet", limit);
    let output = "";
    try {
      await expect(
        fixture.port.executeCommand({
          cwd: fixture.root,
          command: `${fixture.command} 0`,
          onData: (bytes) => {
            output += Buffer.from(bytes).toString();
          },
        }),
      ).resolves.toEqual({ exitCode: 0 });
      console.info(
        "B3_RESULT_LIMIT",
        JSON.stringify({
          commandBytes: Buffer.byteLength(original),
          limit,
          bytesWithNotice: Buffer.byteLength(output),
          originalResultBytes: limit,
        }),
      );
      await expect(
        formatForegroundPiResult({
          ...publication,
          maxOutputBytes: limit,
          result: { content: [{ type: "text", text: output }], isError: false },
        }),
      ).rejects.toThrow("PI_RESULT_OUTPUT_LIMIT");
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(["node", "sh"] as const)(
    "records the accepted ADR 0040 exit of unredirected %s after a late write",
    async (runtime) => {
      const fixture = await lateOutputFixture(runtime);
      let output = "";
      try {
        const result = await fixture.port.executeCommand({
          cwd: fixture.root,
          command: fixture.command,
          onData: (bytes) => {
            output += Buffer.from(bytes).toString();
          },
        });
        expect(result).toEqual({ exitCode: 0 });
        expect(output).toBe("\n\n" + BACKGROUND_OUTPUT_NOTICE + "\n");
        const identity = JSON.parse(await readFile(fixture.identityFile, "utf8")) as {
          pid: number;
          observer: number;
        };
        const before = fixture.processes().find((row) => row.pid === identity.pid);
        expect(before?.pgid).toBe(identity.pid);
        const completedAt = Date.now();
        await writeFile(fixture.gate, "write");
        await expect
          .poll(
            async () =>
              Boolean(
                (await readFile(fixture.exitFile, "utf8").catch(() => "")) ||
                  (await readFile(fixture.survived, "utf8").catch(() => "")),
              ),
            { timeout: 2000 },
          )
          .toBe(true);
        expect(await readFile(fixture.attempted, "utf8")).toBe("attempted");
        const termination = await readFile(fixture.exitFile, "utf8")
          .then((bytes) => JSON.parse(bytes))
          .catch(() => null);
        const after = fixture.processes().find((row) => row.pid === identity.pid) ?? null;
        console.info(
          "B3_LATE_OUTPUT",
          JSON.stringify({
            runtime,
            completedAt,
            before,
            after,
            termination,
            observedAt: Date.now(),
            productKilledChild: false,
          }),
        );
        expect(after).toBeNull();
        expect(termination).toMatchObject(
          runtime === "node" ? { code: 1, signal: null } : { code: null, signal: "SIGPIPE" },
        );
        expect(termination.at).toBeGreaterThanOrEqual(completedAt);
      } finally {
        await fixture.cleanup();
      }
    },
  );
  it.each(["node", "sh"] as const)(
    "keeps redirected %s writing its log after the call returns",
    async (runtime) => {
      const fixture = await lateOutputFixture(runtime, true);
      let output = "";
      try {
        const result = await fixture.port.executeCommand({
          cwd: fixture.root,
          command: fixture.command,
          onData: (bytes) => {
            output += Buffer.from(bytes).toString();
          },
        });
        expect(result).toEqual({ exitCode: 0 });
        expect(output).toBe("");
        const identity = JSON.parse(await readFile(fixture.identityFile, "utf8")) as {
          pid: number;
          observer: number;
        };
        expect(await readFile(fixture.outputFile, "utf8")).toBe("");
        const completedAt = Date.now();
        await writeFile(fixture.gate, "write after result");
        await expect
          .poll(
            async () =>
              (await readFile(fixture.outputFile, "utf8")).split(`late-${runtime}-output\n`)
                .length - 1,
            { timeout: 2000 },
          )
          .toBeGreaterThanOrEqual(2);
        const observedOutput = await readFile(fixture.outputFile, "utf8");
        const after = fixture.processes().find((row) => row.pid === identity.pid);
        expect(after?.pgid).toBe(identity.pid);
        await expect(readFile(fixture.exitFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        console.info(
          "B3_REDIRECTED_OUTPUT",
          JSON.stringify({
            runtime,
            completedAt,
            observedAt: Date.now(),
            after,
            observedOutput,
            outputFile: fixture.outputFile,
          }),
        );
      } finally {
        await fixture.cleanup();
      }
    },
  );
});
