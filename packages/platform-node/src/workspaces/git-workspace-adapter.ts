import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  PayloadRef,
  WorkspaceFileObservation,
  WorkspacePlatformPort,
} from "@himawari-agent/application";

const execFile = promisify(execFileCallback);

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
    const [headResult, branchResult, upstream, status, submodules, worktrees] = await Promise.all([
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
    ]);
    const rootInfo = await stat(root);
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
      files: parsePorcelain(status),
      submoduleRefs: submodules
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      worktreeRefs: worktrees
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice(9)),
      nestedRepositoryRefs: [],
    };
  }

  async inspectCommitState(workspaceId: string) {
    const [branch, head, indexTree, stagedDiff, status, hooksDigest, configurationDigest] =
      await Promise.all([
        this.#git(workspaceId, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => ""),
        this.#git(workspaceId, ["rev-parse", "HEAD"]),
        this.#git(workspaceId, ["write-tree"]),
        this.#gitBuffer(workspaceId, ["diff", "--cached", "--binary", "--no-ext-diff"]),
        this.#git(workspaceId, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
        this.#hooksDigest(workspaceId),
        this.#gitBuffer(workspaceId, ["config", "--local", "--list", "-z"]).then(digest),
      ]);
    const stagedFiles = (await this.#git(workspaceId, ["diff", "--cached", "--name-only", "-z"]))
      .split("\0")
      .filter(Boolean);
    return {
      branch: branch.trim() || null,
      head: head.trim(),
      indexTree: indexTree.trim(),
      stagedDiffRef: await this.#writePayload({ contentType: "text/x-diff", body: stagedDiff }),
      stagedDiffDigest: digest(stagedDiff),
      stagedFiles,
      remainingDirtyRefs: parsePorcelain(status).map(({ path }) => path),
      hooksDigest,
      configurationDigest,
    };
  }

  async commit(input: {
    readonly workspaceId: string;
    readonly message: string;
    readonly operationId: string;
  }) {
    const parent = (await this.#git(input.workspaceId, ["rev-parse", "HEAD"])).trim();
    await this.#git(input.workspaceId, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      "-m",
      input.message,
    ]);
    const commit = (await this.#git(input.workspaceId, ["rev-parse", "HEAD"])).trim();
    const actualParent = (await this.#git(input.workspaceId, ["rev-parse", `${commit}^`])).trim();
    if (actualParent !== parent) throw new Error("WORKSPACE_COMMIT_PARENT_CHANGED");
    const remaining = parsePorcelain(
      await this.#git(input.workspaceId, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
    ).map(({ path }) => path);
    return { commit, parent, remainingDirtyRefs: remaining };
  }

  async reconcileCommit(input: { readonly workspaceId: string; readonly expectedParent: string }) {
    const commit = (
      await this.#git(input.workspaceId, ["rev-parse", "HEAD"]).catch(() => "")
    ).trim();
    if (!commit) return { commit: null, parent: null };
    const parent = (
      await this.#git(input.workspaceId, ["rev-parse", `${commit}^`]).catch(() => "")
    ).trim();
    return parent === input.expectedParent
      ? { commit, parent }
      : { commit: null, parent: parent || null };
  }

  async #root(workspaceId: string): Promise<string> {
    const configured = this.#roots.get(workspaceId);
    if (!configured || !path.isAbsolute(configured)) throw new Error("WORKSPACE_NOT_REGISTERED");
    return realpath(configured);
  }

  async #git(workspaceId: string, args: readonly string[]): Promise<string> {
    const { stdout } = await execFile("git", ["-C", await this.#root(workspaceId), ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index-signature access.
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  }

  async #gitBuffer(workspaceId: string, args: readonly string[]): Promise<Uint8Array> {
    const { stdout } = await execFile("git", ["-C", await this.#root(workspaceId), ...args], {
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index-signature access.
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
    });
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
}

function parsePorcelain(value: string): readonly WorkspaceFileObservation[] {
  return value
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const code = entry.slice(0, 2);
      const filePath = entry.slice(3);
      const staged = code[0] !== " " && code[0] !== "?";
      const unstaged = code[1] !== " " && code[1] !== "?";
      const state =
        code === "??"
          ? "untracked"
          : staged && unstaged
            ? "staged_and_unstaged"
            : staged
              ? "staged"
              : unstaged
                ? "unstaged"
                : "clean";
      return Object.freeze({
        path: filePath,
        indexDigest: staged ? digest(new TextEncoder().encode(`index:${entry}`)) : null,
        worktreeDigest:
          unstaged || code === "??" ? digest(new TextEncoder().encode(`worktree:${entry}`)) : null,
        state,
        owner: "owner" as const,
        hunkFingerprints: Object.freeze([digest(new TextEncoder().encode(entry))]),
      });
    });
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
