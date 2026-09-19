import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import {
  sandboxFileTargetSchema,
  type SandboxFileTarget,
} from "@himawari-agent/execution-contracts";
import type {
  GovernedCodingOperationsPort,
  HostDirectoryGrant,
  HostFileIdentity,
} from "@himawari-agent/application";
import { scanMachineSecrets } from "@himawari-agent/application";
import { ConstrainedHostFileSystem } from "./constrained-file-system.js";

/** A per-invocation adapter inside SRT, not an isolation backend or authority
 * store. The Worker supplies the already resolved directory grant. */
export async function createSandboxedCodingOperations(input: {
  readonly grant: HostDirectoryGrant;
  readonly targetPath?: string;
  readonly expectedTarget?: SandboxFileTarget;
  readonly shell: string;
  readonly privateDirectory: string;
  readonly binaryDirectory: string;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly onVerifiedWrite?: (proof: {
    readonly path: string;
    readonly contentDigest: string;
    readonly byteLength: number;
  }) => void;
}): Promise<GovernedCodingOperationsPort> {
  const platform = new ConstrainedHostFileSystem();
  const grant = structuredClone(input.grant);
  const fixedTarget = input.targetPath === undefined ? undefined : path.resolve(input.targetPath);
  const expectedTarget =
    input.expectedTarget === undefined
      ? undefined
      : sandboxFileTargetSchema.parse(structuredClone(input.expectedTarget));
  const baseline = new Map<string, { identity: HostFileIdentity; bytes: Uint8Array } | null>();
  const check = () => {
    input.signal?.throwIfAborted();
    if (grant.revokedAt !== null || grant.expiresAt <= new Date().toISOString())
      throw new Error("PI_DIRECTORY_GRANT_EXPIRED");
  };
  const relative = (absolute: string) => {
    check();
    if (fixedTarget !== undefined && path.resolve(absolute) !== fixedTarget)
      throw new Error("PI_FIXED_TARGET_CHANGED");
    const value = path.relative(grant.displayPath, absolute);
    if (!value || value === ".." || value.startsWith(`..${path.sep}`) || path.isAbsolute(value))
      throw new Error("PI_PATH_OUTSIDE_GRANT");
    if (
      value
        .split(path.sep)
        .some((part) => part === ".git" || part === ".env" || part.startsWith(".himawari-"))
    )
      throw new Error("PI_PROTECTED_PATH");
    return value;
  };
  const capture = async (absolute: string) => {
    const name = relative(absolute);
    if (!baseline.has(name)) {
      const identity = await platform.inspect(grant, name);
      if (identity && !grant.operations.includes("read"))
        throw new Error("PI_DIRECTORY_OPERATION_DENIED");
      baseline.set(
        name,
        identity
          ? {
              identity,
              bytes: await platform.read(grant, name, 16 * 1024 * 1024, identity),
            }
          : null,
      );
    }
    return name;
  };
  const assertExpectedParents = async () => {
    if (!expectedTarget) return;
    if (!fixedTarget || relative(fixedTarget) !== expectedTarget.relativePath)
      throw new Error("PI_FIXED_TARGET_CHANGED");
    let current = await realpath(grant.displayPath);
    const directories = [current];
    for (const part of expectedTarget.relativePath.split("/").slice(0, -1)) {
      current = path.join(current, part);
      directories.push(current);
    }
    if (directories.length !== expectedTarget.lineage.length + (expectedTarget.missingParents ?? 0))
      throw new Error("PI_FILE_PARENT_CHANGED");
    for (const [index, filename] of directories.entries()) {
      const expected = expectedTarget.lineage[index];
      const info = await lstat(filename, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
        if (!expected && expectedTarget.missingParents && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!info) return;
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        String(info.dev) !== expectedTarget.lineage[0]?.device ||
        (expected && String(info.ino) !== expected.inode)
      )
        throw new Error("PI_FILE_PARENT_CHANGED");
    }
  };
  await assertExpectedParents();
  if (fixedTarget) await capture(fixedTarget);
  if (expectedTarget) {
    const observed = baseline.get(expectedTarget.relativePath);
    const before = expectedTarget.before;
    if (
      before === null
        ? observed !== null
        : !observed ||
          observed.identity.device !== before.device ||
          observed.identity.inode !== before.inode ||
          createHash("sha256").update(observed.bytes).digest("hex") !== before.contentDigest
    )
      throw new Error("PI_FILE_VERSION_CHANGED");
    await assertExpectedParents();
  }
  return {
    async access(absolute, mode) {
      if (!grant.operations.includes(mode === "read" ? "read" : "update"))
        throw new Error("PI_DIRECTORY_OPERATION_DENIED");
      const name = await capture(absolute);
      if (!baseline.get(name)) throw new Error("PI_FILE_MISSING");
    },
    async readFile(absolute) {
      if (!grant.operations.includes("read")) throw new Error("PI_DIRECTORY_OPERATION_DENIED");
      const name = await capture(absolute);
      const previous = baseline.get(name);
      if (!previous) throw new Error("PI_FILE_MISSING");
      const bytes = await platform.read(
        grant,
        name,
        16 * 1024 * 1024,
        previous.identity,
        "opened_version",
      );
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0") || scanMachineSecrets(text).length)
        throw new Error("PI_TEXT_READ_REJECTED");
      return bytes;
    },
    async makeDirectory(absolute) {
      // createExclusive creates missing parents through the same no-link walk.
      // Pi calls mkdir before writeFile; do not introduce a separate raw mkdir.
      check();
      if (fixedTarget !== undefined) {
        if (path.resolve(absolute) !== path.dirname(fixedTarget))
          throw new Error("PI_FIXED_TARGET_CHANGED");
      } else if (absolute !== grant.displayPath) relative(absolute);
    },
    async writeFile(absolute, content) {
      const name = relative(absolute);
      if (!baseline.has(name)) throw new Error("PI_WRITE_BASELINE_MISSING");
      const previous = baseline.get(name);
      if (!grant.operations.includes(previous ? "update" : "create"))
        throw new Error("PI_DIRECTORY_OPERATION_DENIED");
      const bytes = new TextEncoder().encode(content);
      if (bytes.length > 16 * 1024 * 1024) throw new Error("PI_WRITE_LIMIT");
      const storage = await platform.storageObservation(grant);
      if (storage.availableBytes < bytes.length + 64 * 1024 * 1024)
        throw new Error("PI_STORAGE_RESERVE");
      const hooks = {
        beforePublish: async () => {
          check();
          await assertExpectedParents();
        },
        assertCurrentAuthority: async () => {
          check();
          await assertExpectedParents();
        },
      };
      if (previous)
        await platform.replaceAtomic(grant, name, previous.identity, bytes, previous.bytes, hooks);
      else await platform.createExclusive(grant, name, bytes, hooks);
      const observed = await platform.read(grant, name, Math.max(1, bytes.length));
      if (!Buffer.from(observed).equals(bytes)) throw new Error("PI_WRITE_VERIFICATION_FAILED");
      input.onVerifiedWrite?.({
        path: absolute,
        contentDigest: createHash("sha256").update(observed).digest("hex"),
        byteLength: observed.byteLength,
      });
    },
    async executeCommand(command) {
      check();
      if (fixedTarget !== undefined) throw new Error("PI_FIXED_FILE_COMMAND_DENIED");
      if (command.cwd !== grant.displayPath) throw new Error("PI_COMMAND_CWD_CHANGED");
      // Arbitrary shell can delete and move files. A partial write grant cannot
      // be promoted to a shell grant merely because the tool is called bash.
      if (
        grant.operations.some((operation) => operation !== "read") &&
        !["create", "update", "move", "trash", "restore", "permanent_delete"].every((operation) =>
          grant.operations.includes(operation as HostDirectoryGrant["operations"][number]),
        )
      )
        throw new Error("PI_SHELL_EFFECT_SCOPE_INCOMPLETE");
      return new Promise((resolve, reject) => {
        const child = spawn(input.shell, ["--noprofile", "--norc", "-c", command.command], {
          cwd: grant.displayPath,
          env: {
            PATH: input.binaryDirectory,
            HOME: input.privateDirectory,
            TMPDIR: input.privateDirectory,
            CLAUDE_CODE_TMPDIR: input.privateDirectory,
            PI_OFFLINE: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let failure: Error | undefined;
        let count = 0;
        const stop = (error: Error) => {
          failure ??= error;
          child.kill("SIGKILL");
        };
        const abort = () => stop(new Error("PI_COMMAND_ABORTED"));
        const timer = setTimeout(
          () => stop(new Error("PI_COMMAND_TIMEOUT")),
          Math.max(
            1,
            Math.min(
              command.timeoutMs ?? Number.MAX_SAFE_INTEGER,
              Date.parse(grant.expiresAt) - Date.now(),
            ),
          ),
        );
        command.signal?.addEventListener("abort", abort, { once: true });
        if (command.signal?.aborted) abort();
        const data = (bytes: Buffer) => {
          count += bytes.length;
          if (count > input.maxOutputBytes) stop(new Error("PI_COMMAND_OUTPUT_LIMIT"));
          else if (!failure) {
            try {
              command.onData(bytes);
            } catch {
              stop(new Error("PI_COMMAND_OUTPUT_REJECTED"));
            }
          }
        };
        child.stdout.on("data", data);
        child.stderr.on("data", data);
        child.once("error", (error) => {
          failure = error;
        });
        child.once("close", (exitCode) => {
          clearTimeout(timer);
          command.signal?.removeEventListener("abort", abort);
          if (failure) reject(failure);
          else if (exitCode === null) reject(new Error("PI_COMMAND_SIGNALLED"));
          else resolve({ exitCode });
        });
      });
    },
  };
}
