import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { GitIndexTransaction } from "./git-index-transaction.js";
import type {
  PayloadRef,
  WorkspaceFileObservation,
  WorkspacePlatformPort,
} from "@himawari-agent/application";

const execFile = promisify(execFileCallback);
const GIT_HARDENING_ARGS = Object.freeze([
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "commit.gpgSign=false",
]);

export class GitWorkspaceAdapter implements WorkspacePlatformPort {
  readonly #roots: ReadonlyMap<string, string>;
  readonly #writePayload: (input: {
    readonly contentType: string;
    readonly body: Uint8Array;
  }) => Promise<PayloadRef>;

  constructor(input: {
    readonly roots: ReadonlyMap<string, string>;
    readonly writePayload: (input: {
      readonly contentType: string;
      readonly body: Uint8Array;
    }) => Promise<PayloadRef>;
  }) {
    this.#roots = input.roots;
    this.#writePayload = input.writePayload;
  }

  async snapshot(input: {
    readonly workspaceId: string;
    readonly hostId: string;
    readonly root: string;
  }) {
    const root = await this.#root(input.workspaceId);
    if ((await realpath(input.root)) !== root) throw new Error("WORKSPACE_ROOT_IDENTITY_CHANGED");
    await this.#assertRepositoryConfigSafe(input.workspaceId);
    const repositoryRoot = await this.#git(input.workspaceId, [
      "rev-parse",
      "--show-toplevel",
    ]).catch(() => null);
    if (!repositoryRoot) {
      const rootInfo = await stat(root);
      return {
        workspaceId: input.workspaceId,
        hostId: input.hostId,
        rootIdentity: `${rootInfo.dev}:${rootInfo.ino}`,
        repositoryKind: "non_git" as const,
        branch: null,
        head: null,
        upstreamObservation: null,
        detached: false,
        unborn: false,
        files: [],
        submoduleRefs: [],
        worktreeRefs: [],
        nestedRepositoryRefs: [],
      };
    }
    if ((await realpath(repositoryRoot.trim())) !== root)
      throw new Error("WORKSPACE_NESTED_REPOSITORY_SCOPE_REQUIRED");
    const [headResult, branchResult, upstream, status, submodules, worktrees, nestedRepositories] =
      await Promise.all([
        this.#git(input.workspaceId, ["rev-parse", "HEAD"]).catch(() => ""),
        this.#git(input.workspaceId, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => ""),
        this.#git(input.workspaceId, [
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{upstream}",
        ]).catch(() => ""),
        this.#git(input.workspaceId, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
        this.#git(input.workspaceId, ["submodule", "status", "--recursive"]).catch(() => ""),
        this.#git(input.workspaceId, ["worktree", "list", "--porcelain"]).catch(() => ""),
        this.#nestedRepositories(input.workspaceId),
      ]);
    const rootInfo = await stat(root);
    const files = await this.#observeStatus(input.workspaceId, status, headResult.trim() || null);
    const verifiedHead = (
      await this.#git(input.workspaceId, ["rev-parse", "HEAD"]).catch(() => "")
    ).trim();
    if (verifiedHead !== headResult.trim()) throw new Error("WORKSPACE_HEAD_CHANGED");
    return {
      workspaceId: input.workspaceId,
      hostId: input.hostId,
      rootIdentity: `${rootInfo.dev}:${rootInfo.ino}`,
      repositoryKind: "git" as const,
      branch: branchResult.trim() || null,
      head: headResult.trim() || null,
      upstreamObservation: upstream.trim() || null,
      detached: branchResult.trim().length === 0 && headResult.trim().length > 0,
      unborn: headResult.trim().length === 0,
      files,
      submoduleRefs: submodules
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      worktreeRefs: worktrees
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice(9)),
      nestedRepositoryRefs: nestedRepositories,
    };
  }

  async stageTaskChanges(input: {
    readonly workspaceId: string;
    readonly expectedHead: string;
    readonly files: readonly WorkspaceFileObservation[];
  }) {
    await this.#assertRepositoryConfigSafe(input.workspaceId);
    const head = (await this.#git(input.workspaceId, ["rev-parse", "HEAD"])).trim();
    if (head !== input.expectedHead) throw new Error("WORKSPACE_HEAD_CHANGED");
    const currentStatus = await this.#git(input.workspaceId, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    const current = new Map(
      (await this.#observeStatus(input.workspaceId, currentStatus, input.expectedHead)).map(
        (file) => [file.path, file],
      ),
    );
    for (const expected of input.files) {
      const observed = current.get(expected.path);
      if (
        !observed ||
        expected.owner !== "task" ||
        !expected.taskWrite ||
        expected.taskWrite.afterDigest !== expected.worktreeDigest ||
        observed.indexDigest !== expected.indexDigest ||
        observed.worktreeDigest !== expected.worktreeDigest ||
        observed.hunkFingerprints.join("\0") !== expected.hunkFingerprints.join("\0")
      ) {
        throw new Error("WORKSPACE_TASK_CHANGE_CHANGED");
      }
    }
    const stagingRef = `staging:${randomUUID()}`;
    const indexPath = await this.#stagingIndexPath(input.workspaceId, stagingRef, true);
    const environment = { GIT_INDEX_FILE: indexPath };
    try {
      await this.#git(input.workspaceId, ["read-tree", input.expectedHead], environment);
      for (const file of input.files) {
        const root = await this.#root(input.workspaceId);
        const target = path.join(root, file.path);
        const info = await lstat(target).catch(() => null);
        if (!info) {
          if (file.worktreeDigest !== null) throw new Error("WORKSPACE_TASK_CHANGE_CHANGED");
          await this.#git(
            input.workspaceId,
            ["update-index", "--force-remove", "--", file.path],
            environment,
          );
          continue;
        }
        if (!info.isFile() || info.isSymbolicLink())
          throw new Error("WORKSPACE_TASK_OBJECT_UNSAFE");
        const fileHandle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        let frozenBytes: Uint8Array;
        try {
          const opened = await fileHandle.stat();
          if (
            !opened.isFile() ||
            opened.nlink !== 1 ||
            opened.dev !== info.dev ||
            opened.ino !== info.ino
          )
            throw new Error("WORKSPACE_TASK_OBJECT_UNSAFE");
          frozenBytes = await fileHandle.readFile();
        } finally {
          await fileHandle.close();
        }
        if (digest(frozenBytes) !== file.worktreeDigest)
          throw new Error("WORKSPACE_TASK_CHANGE_CHANGED");
        const afterRead = await lstat(target);
        if (
          afterRead.dev !== info.dev ||
          afterRead.ino !== info.ino ||
          afterRead.mode !== info.mode
        )
          throw new Error("WORKSPACE_TASK_CHANGE_CHANGED");
        const blob = await this.#hashFrozenBlob(input.workspaceId, frozenBytes);
        if (!/^[a-f0-9]{40,64}$/.test(blob)) throw new Error("WORKSPACE_TASK_BLOB_INVALID");
        const mode = (info.mode & 0o111) === 0 ? "100644" : "100755";
        await this.#git(
          input.workspaceId,
          ["update-index", "--add", "--cacheinfo", `${mode},${blob},${file.path}`],
          environment,
        );
      }
      const [indexTree, stagedFiles] = await Promise.all([
        this.#git(input.workspaceId, ["write-tree"], environment),
        this.#git(input.workspaceId, ["diff", "--cached", "--name-only", "-z"], environment),
      ]);
      const actual = stagedFiles.split("\0").filter(Boolean);
      if (
        actual.length === 0 ||
        actual.some((filePath) => !input.files.some(({ path }) => path === filePath))
      )
        throw new Error("WORKSPACE_STAGING_SCOPE_CHANGED");
      return Object.freeze({ stagingRef, indexTree: indexTree.trim(), stagedFiles: actual });
    } catch (error) {
      await unlink(indexPath).catch(() => undefined);
      throw error;
    }
  }

  async inspectCommitState(workspaceId: string, stagingRef: string) {
    await this.#assertRepositoryConfigSafe(workspaceId);
    const environment = {
      GIT_INDEX_FILE: await this.#stagingIndexPath(workspaceId, stagingRef, false),
    };
    const [branch, head, indexTree, stagedDiff, status, hooksDigest, configurationDigest] =
      await Promise.all([
        this.#git(workspaceId, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => ""),
        this.#git(workspaceId, ["rev-parse", "HEAD"]),
        this.#git(workspaceId, ["write-tree"], environment),
        this.#gitBuffer(
          workspaceId,
          ["diff", "--cached", "--binary", "--no-ext-diff"],
          environment,
        ),
        this.#git(workspaceId, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
        this.#hooksDigest(workspaceId),
        this.#gitBuffer(workspaceId, ["config", "--local", "--list", "-z"]).then(digest),
      ]);
    const stagedFiles = (
      await this.#git(workspaceId, ["diff", "--cached", "--name-only", "-z"], environment)
    )
      .split("\0")
      .filter(Boolean);
    return {
      branch: branch.trim() || null,
      head: head.trim(),
      indexTree: indexTree.trim(),
      ownerIndexDigest: digest(await readFile(await this.#ownerIndexPath(workspaceId))),
      stagedDiffRef: await this.#writePayload({ contentType: "text/x-diff", body: stagedDiff }),
      stagedDiffDigest: digest(stagedDiff),
      stagedFiles,
      remainingDirtyRefs: parseStatusEntries(status).map(({ path }) => path),
      hooksDigest,
      configurationDigest,
    };
  }

  async commit(input: Parameters<WorkspacePlatformPort["commit"]>[0]) {
    await this.#assertRepositoryConfigSafe(input.workspaceId);
    return (await this.#transaction(input.workspaceId, input.stagingRef)).commit(input);
  }

  async reconcileCommit(input: Parameters<WorkspacePlatformPort["reconcileCommit"]>[0]) {
    await this.#assertRepositoryConfigSafe(input.workspaceId);
    const result = await (await this.#transaction(input.workspaceId, input.stagingRef)).reconcile(
      input.operationId,
      input.expectedParent,
    );
    return result ?? { commit: null, parent: null, remainingDirtyRefs: [] };
  }

  async #ownerIndexPath(workspaceId: string): Promise<string> {
    return path.resolve(
      await this.#root(workspaceId),
      (await this.#git(workspaceId, ["rev-parse", "--git-path", "index"])).trim(),
    );
  }

  async #transaction(workspaceId: string, stagingRef: string): Promise<GitIndexTransaction> {
    return new GitIndexTransaction({
      git: (args, environment) => this.#git(workspaceId, args, environment),
      indexPath: await this.#ownerIndexPath(workspaceId),
      stagingIndexPath: await this.#stagingIndexPath(workspaceId, stagingRef, false),
      inspect: () => this.inspectCommitState(workspaceId, stagingRef),
      remaining: async () =>
        parseStatusEntries(
          await this.#git(workspaceId, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
        ).map(({ path }) => path),
    });
  }

  async #hashFrozenBlob(workspaceId: string, bytes: Uint8Array): Promise<string> {
    const root = await this.#root(workspaceId);
    return new Promise((resolve, reject) => {
      const child = execFileCallback(
        "git",
        ["-C", root, ...GIT_HARDENING_ARGS, "hash-object", "-w", "--no-filters", "--stdin"],
        {
          encoding: "utf8",
          env: {
            // biome-ignore lint/complexity/useLiteralKeys: Node env has an index signature.
            PATH: process.env["PATH"] ?? "/usr/bin:/bin",
            LC_ALL: "C",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_OPTIONAL_LOCKS: "0",
          },
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
      );
      child.stdin?.on("error", reject);
      child.stdin?.end(bytes);
    });
  }

  async #root(workspaceId: string): Promise<string> {
    const configured = this.#roots.get(workspaceId);
    if (!configured || !path.isAbsolute(configured)) throw new Error("WORKSPACE_NOT_REGISTERED");
    return realpath(configured);
  }

  async #assertRepositoryConfigSafe(workspaceId: string): Promise<void> {
    const config = await this.#git(workspaceId, [
      "config",
      "--no-includes",
      "--local",
      "--null",
      "--list",
    ]);
    const unsafe = config
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.slice(0, entry.indexOf("\n") < 0 ? undefined : entry.indexOf("\n")))
      .map((key) => key.toLowerCase())
      .filter(
        (key) =>
          /^filter\..+\.(clean|smudge|process|required)$/.test(key) ||
          /^diff\..+\.(command|textconv)$/.test(key) ||
          /^merge\..+\.driver$/.test(key) ||
          key === "core.attributesfile" ||
          key === "core.excludesfile" ||
          key === "core.fsmonitor" ||
          key === "include.path" ||
          /^includeif\..+\.path$/.test(key),
      );
    if (unsafe.length > 0)
      throw new Error(`WORKSPACE_EXECUTABLE_CONFIG_FORBIDDEN:${unsafe.sort().join(",")}`);
  }

  async #git(
    workspaceId: string,
    args: readonly string[],
    extraEnvironment: Readonly<Record<string, string>> = {},
  ): Promise<string> {
    const { stdout } = await execFile(
      "git",
      ["-C", await this.#root(workspaceId), ...GIT_HARDENING_ARGS, ...args],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: {
          // biome-ignore lint/complexity/useLiteralKeys: Node env has an index signature.
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          LC_ALL: "C",
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_OPTIONAL_LOCKS: "0",
          ...extraEnvironment,
        },
      },
    );
    return stdout;
  }

  async #gitBuffer(
    workspaceId: string,
    args: readonly string[],
    extraEnvironment: Readonly<Record<string, string>> = {},
  ): Promise<Uint8Array> {
    const { stdout } = await execFile(
      "git",
      ["-C", await this.#root(workspaceId), ...GIT_HARDENING_ARGS, ...args],
      {
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
        env: {
          // biome-ignore lint/complexity/useLiteralKeys: Node env has an index signature.
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          LC_ALL: "C",
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_OPTIONAL_LOCKS: "0",
          ...extraEnvironment,
        },
      },
    );
    return new Uint8Array(stdout);
  }

  async #hooksDigest(workspaceId: string): Promise<string> {
    const root = await this.#root(workspaceId);
    const gitDirectory = (await this.#git(workspaceId, ["rev-parse", "--git-dir"])).trim();
    const directory = path.resolve(root, gitDirectory, "hooks");
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const observations = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const info = await stat(path.join(directory, entry.name));
          return `${entry.name}:${info.size}:${info.mtimeMs}:${info.mode}`;
        }),
    );
    return digest(new TextEncoder().encode(observations.sort().join("\n")));
  }

  async #observeStatus(
    workspaceId: string,
    status: string,
    frozenHead: string | null,
  ): Promise<readonly WorkspaceFileObservation[]> {
    const root = await this.#root(workspaceId);
    const entries = [...parseStatusEntries(status)];
    const observedPaths = new Set(entries.map(({ path }) => path));
    const trackedPaths = (await this.#git(workspaceId, ["ls-files", "-z"]))
      .split("\0")
      .filter(Boolean);
    for (const filePath of trackedPaths) {
      if (!observedPaths.has(filePath))
        entries.push({ code: "  ", path: filePath, originalPath: null });
    }
    return Promise.all(
      entries.map(async ({ code, path: filePath, originalPath }) => {
        const staged = code[0] !== " " && code[0] !== "?";
        const unstaged = code[1] !== " " && code[1] !== "?";
        let state: WorkspaceFileObservation["state"] =
          code === "??"
            ? "untracked"
            : staged && unstaged
              ? "staged_and_unstaged"
              : staged
                ? "staged"
                : unstaged
                  ? "unstaged"
                  : "clean";
        const indexBytes = await this.#gitBuffer(workspaceId, [
          "ls-files",
          "--stage",
          "-z",
          "--",
          filePath,
        ]);
        const worktreeBytes = await readWorktreeObject(root, filePath);
        // Porcelain is only a discovery hint: bytes or the index may change after status.
        // A clean baseline must agree with the frozen HEAD, actual index entry and file mode.
        if (state === "clean") {
          const indexEntry = /^(\d+) ([a-f0-9]{40,64}) 0\t/.exec(
            new TextDecoder().decode(indexBytes),
          );
          const headEntry = frozenHead
            ? /^(\d+) blob ([a-f0-9]{40,64})\t/.exec(
                await this.#git(workspaceId, ["ls-tree", "-z", frozenHead, "--", filePath]),
              )
            : null;
          const indexMatchesHead =
            indexEntry &&
            headEntry &&
            indexEntry[1] === headEntry[1] &&
            indexEntry[2] === headEntry[2];
          const indexContent = indexEntry
            ? await this.#gitBuffer(workspaceId, ["cat-file", "blob", indexEntry[2] ?? ""])
            : null;
          const info = await lstat(path.join(root, filePath)).catch(() => null);
          const mode = info?.isFile() ? ((info.mode & 0o111) === 0 ? "100644" : "100755") : null;
          const worktreeMatchesIndex =
            worktreeBytes &&
            indexContent &&
            digest(worktreeBytes) === digest(indexContent) &&
            mode === indexEntry?.[1];
          if (!indexMatchesHead) state = worktreeMatchesIndex ? "staged" : "staged_and_unstaged";
          else if (!worktreeMatchesIndex) state = "unstaged";
        }
        const hunkInputs: Uint8Array[] = [];
        if (staged) {
          hunkInputs.push(
            await this.#gitBuffer(workspaceId, [
              "diff",
              "--cached",
              "--binary",
              "--no-ext-diff",
              "--",
              originalPath ?? filePath,
              filePath,
            ]),
          );
        }
        if (unstaged) {
          hunkInputs.push(
            await this.#gitBuffer(workspaceId, [
              "diff",
              "--binary",
              "--no-ext-diff",
              "--",
              filePath,
            ]),
          );
        }
        if (code === "??" && worktreeBytes) hunkInputs.push(worktreeBytes);
        return Object.freeze({
          path: filePath,
          indexDigest: indexBytes && indexBytes.byteLength > 0 ? digest(indexBytes) : null,
          worktreeDigest: worktreeBytes ? digest(worktreeBytes) : null,
          state,
          owner: "owner" as const,
          hunkFingerprints: Object.freeze(
            hunkInputs.filter(({ byteLength }) => byteLength > 0).map(digest),
          ),
        });
      }),
    );
  }

  async #nestedRepositories(workspaceId: string): Promise<readonly string[]> {
    const root = await this.#root(workspaceId);
    const candidates = (
      await this.#git(workspaceId, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "--directory",
        "-z",
      ])
    )
      .split("\0")
      .filter(Boolean);
    const nested: string[] = [];
    for (const candidate of candidates) {
      const directory = candidate.replace(/\/$/, "");
      const marker = path.join(root, directory, ".git");
      if (await lstat(marker).catch(() => null)) nested.push(directory);
    }
    return Object.freeze(nested.sort());
  }

  async #stagingIndexPath(
    workspaceId: string,
    stagingRef: string,
    createDirectory: boolean,
  ): Promise<string> {
    if (!/^staging:[0-9a-f-]{36}$/.test(stagingRef))
      throw new Error("WORKSPACE_STAGING_REF_INVALID");
    const root = await this.#root(workspaceId);
    const commonDirectory = (
      await this.#git(workspaceId, ["rev-parse", "--git-common-dir"])
    ).trim();
    const directory = path.resolve(root, commonDirectory, "himawari-indexes");
    if (createDirectory) await mkdir(directory, { recursive: true, mode: 0o700 });
    return path.join(directory, `${stagingRef.slice(8)}.index`);
  }
}

function parseStatusEntries(value: string): readonly {
  readonly code: string;
  readonly path: string;
  readonly originalPath: string | null;
}[] {
  const fields = value.split("\0");
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const code = field.slice(0, 2);
    const filePath = field.slice(3);
    const renamed = code.includes("R") || code.includes("C");
    const originalPath = renamed ? (fields[index + 1] ?? null) : null;
    if (renamed) index += 1;
    entries.push(Object.freeze({ code, path: filePath, originalPath }));
  }
  return Object.freeze(entries);
}

async function readWorktreeObject(root: string, filePath: string): Promise<Uint8Array | null> {
  const target = path.join(root, filePath);
  const info = await lstat(target).catch(() => null);
  if (!info) return null;
  if (info.isSymbolicLink()) return new TextEncoder().encode(`symlink:${await readlink(target)}`);
  if (!info.isFile()) return null;
  return readFile(target);
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
