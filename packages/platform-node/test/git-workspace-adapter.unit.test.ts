import { type ChildProcess, execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  CommandProfileService,
  CommitGateService,
  type CommitPreview,
  WorkspaceService,
  type WorkspaceSnapshot,
  type WorkspaceStatePort,
} from "@himawari-agent/application";
import { afterEach, describe, expect, it } from "vitest";
import { GitWorkspaceAdapter } from "../src/index.js";
import { GitIndexTransaction } from "../src/workspaces/git-index-transaction.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const children = new Map<ChildProcess, Promise<NodeJS.Signals | null>>();
afterEach(async () => {
  try {
    for (const child of children.keys()) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.all(children.values());
  } finally {
    children.clear();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  }
});

class MemoryWorkspaceState implements WorkspaceStatePort {
  snapshots = new Map<string, WorkspaceSnapshot>();
  previews = new Map<string, CommitPreview>();
  operations = new Map<string, { previewId: string; resultRef: string | null }>();
  async saveSnapshot(value: WorkspaceSnapshot) {
    this.snapshots.set(value.id, value);
    return value;
  }
  async readSnapshot(id: string) {
    return this.snapshots.get(id);
  }
  async saveCommitPreview(value: CommitPreview) {
    this.previews.set(value.id, value);
    return value;
  }
  async readCommitPreview(id: string) {
    return this.previews.get(id);
  }
  async readCommitOperation(id: string) {
    return this.operations.get(id);
  }
  async createCommitOperation(input: { operationId: string; previewId: string }) {
    const current = this.operations.get(input.operationId);
    if (current) return { replayed: true, resultRef: current.resultRef };
    this.operations.set(input.operationId, { previewId: input.previewId, resultRef: null });
    return { replayed: false, resultRef: null };
  }
  async finishCommitOperation(input: { operationId: string; resultRef: string }) {
    const current = this.operations.get(input.operationId);
    if (!current) throw new Error("operation missing");
    this.operations.set(input.operationId, { ...current, resultRef: input.resultRef });
  }
}

async function git(
  root: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
) {
  return execFile("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index-signature access.
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      LC_ALL: "C",
      GIT_OPTIONAL_LOCKS: "0",
      ...environment,
    },
  });
}

// These cases execute real Git subprocesses and crash recovery under coverage.
describe("GitWorkspaceAdapter", { timeout: 15_000 }, () => {
  it.for(["inspect", "update-index", "commit-tree"])(
    "recovers its real Git lock after SIGKILL during %s",
    async (boundary, { signal }) => {
      const fixture = await preparedTransactionFixture();
      const ownerIndex = await readFile(path.join(fixture.root, ".git/index"));
      const script = path.join(fixture.root, ".git/kill-harness.mjs");
      const moduleUrl = new URL("../src/workspaces/git-index-transaction.ts", import.meta.url).href;
      await writeFile(
        script,
        `import { GitIndexTransaction } from ${JSON.stringify(moduleUrl)};
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const pause = async (name) => { if (name === ${JSON.stringify(boundary)}) { process.stdout.write("READY\\n"); await new Promise(() => setInterval(() => {}, 1000)); } };
const tx = new GitIndexTransaction({
  indexPath: ${JSON.stringify(path.join(fixture.root, ".git/index"))},
  stagingIndexPath: ${JSON.stringify(path.join(fixture.root, ".git/himawari-indexes", `${fixture.preview.stagingRef.slice(8)}.index`))},
  inspect: async () => { await pause("inspect"); return ${JSON.stringify(fixture.preview)}; },
  remaining: async () => [],
  git: async (args, environment) => { const result = await run("git", ["-C", ${JSON.stringify(fixture.root)}, ...args], { env: { PATH: process.env.PATH, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", ...environment } }); await pause(args[0]); return result.stdout; }
});
await tx.commit(${JSON.stringify(fixture.commitInput)});
`,
      );
      signal.throwIfAborted();
      const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
      const closed = new Promise<NodeJS.Signals | null>((resolve) =>
        child.once("close", (_code, exitSignal) => resolve(exitSignal)),
      );
      children.set(child, closed);
      let errors = "";
      child.stderr.on("data", (data) => {
        errors += data.toString();
      });
      child.on("error", (error) => {
        errors += error.message;
      });
      await new Promise<void>((resolve, reject) => {
        let output = "";
        const cleanup = () => {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          child.off("exit", onExit);
          child.off("error", onError);
          signal.removeEventListener("abort", onAbort);
        };
        const fail = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onData = (data: Buffer) => {
          output += data.toString();
          if (output.includes("READY\n")) {
            cleanup();
            resolve();
          }
        };
        const onExit = () => fail(new Error(`Child exited before ${boundary}: ${errors}`));
        const onError = (error: Error) => fail(error);
        const onAbort = () => fail(new Error(`Test cancelled before ${boundary}`));
        const timer = setTimeout(
          () => fail(new Error(`Child did not reach ${boundary} within 10000ms: ${errors}`)),
          10_000,
        );
        child.stdout.on("data", onData);
        child.once("exit", onExit);
        child.once("error", onError);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      child.kill("SIGKILL");
      expect(await closed).toBe("SIGKILL");
      expect(
        await transactionFor(fixture).reconcile(
          fixture.commitInput.operationId,
          fixture.preview.head,
        ),
      ).toBeNull();
      await expect(readFile(path.join(fixture.root, ".git/index.lock"))).rejects.toThrow();
      expect(await readFile(path.join(fixture.root, ".git/index"))).toEqual(ownerIndex);
    },
  );

  it("does not call content clean when Owner edits after status but before content capture", async () => {
    const fixture = await ownershipFixture();
    const bin = await mkdtemp(path.join(tmpdir(), "himawari-git-status-race-"));
    roots.push(bin);
    const target = path.join(fixture.root, "baseline.txt");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(
      path.join(bin, "git"),
      `#!/bin/sh\n/usr/bin/git "$@"\ntask_exit=$?\nfor task_arg in "$@"; do\n  if [ "$task_arg" = status ]; then printf 'Owner edit\\n' > ${quote(target)}; fi\ndone\nexit "$task_exit"\n`,
    );
    await chmod(path.join(bin, "git"), 0o700);
    const previousPath = process.env["PATH"];
    let before: WorkspaceSnapshot;
    try {
      process.env["PATH"] = `${bin}:/usr/bin:/bin`;
      before = await fixture.workspace.snapshot(fixture.scope);
    } finally {
      process.env["PATH"] = previousPath;
    }
    expect(before.files.find(({ path }) => path === "baseline.txt")?.state).toBe("unstaged");
    await writeFile(target, "Owner edit\ntask addition\n");
    const after = await fixture.workspace.snapshot({
      ...fixture.scope,
      previousSnapshotId: before.id,
      controlledWritePaths: ["baseline.txt"],
      controlledWrites: [
        writeEvidence("baseline.txt", "Owner edit\n", "Owner edit\ntask addition\n"),
      ],
    });
    expect(after.files.find(({ path }) => path === "baseline.txt")?.owner).toBe("owner");
  });

  it("recovers a committed HEAD whose Owner index installation was interrupted", async () => {
    const fixture = await preparedTransactionFixture();
    const ownerIndex = await readFile(path.join(fixture.root, ".git/index"));
    const crashing = transactionFor(fixture, () => {
      throw new Error("crash after ref publication");
    });
    await expect(crashing.commit(fixture.commitInput)).rejects.toThrow("crash after ref");
    expect(await readFile(path.join(fixture.root, ".git/index"))).toEqual(ownerIndex);
    expect((await git(fixture.root, ["rev-parse", "HEAD"])).stdout.trim()).not.toBe(
      fixture.preview.head,
    );
    const result = await transactionFor(fixture).reconcile(
      fixture.commitInput.operationId,
      fixture.preview.head,
    );
    expect(result?.parent).toBe(fixture.preview.head);
    expect((await git(fixture.root, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe(
      "owner.txt",
    );
    expect((await git(fixture.root, ["diff", "--name-only"])).stdout.trim()).toBe("");
    expect((await git(fixture.root, ["show", "HEAD:owner.txt"])).stdout).toBe("Owner base\n");
    expect((await git(fixture.root, ["show", "HEAD:task.txt"])).stdout).toBe("task\n");
    expect(await transactionFor(fixture).commit(fixture.commitInput)).toEqual(result);
    await expect(
      transactionFor(fixture).commit({
        ...fixture.commitInput,
        operationId: "different-operation",
      }),
    ).rejects.toThrow("OPERATION_CONFLICT");
  });

  it("never replaces another Git writer's index lock", async () => {
    const fixture = await preparedTransactionFixture();
    const lockPath = path.join(fixture.root, ".git/index.lock");
    await writeFile(lockPath, "Owner owns this lock", { flag: "wx" });
    await expect(transactionFor(fixture).commit(fixture.commitInput)).rejects.toThrow();
    expect(await readFile(lockPath, "utf8")).toBe("Owner owns this lock");
    expect((await git(fixture.root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
      fixture.preview.head,
    );
  });

  it("fails closed if the Owner index changed before crash recovery", async () => {
    const fixture = await preparedTransactionFixture();
    await expect(
      transactionFor(fixture, () => {
        throw new Error("crash");
      }).commit(fixture.commitInput),
    ).rejects.toThrow("crash");
    await rm(path.join(fixture.root, ".git/index.lock"));
    await writeFile(path.join(fixture.root, "owner.txt"), "new Owner change\n");
    await git(fixture.root, ["add", "owner.txt"]);
    const changedIndex = await readFile(path.join(fixture.root, ".git/index"));
    await expect(
      transactionFor(fixture).reconcile(fixture.commitInput.operationId, fixture.preview.head),
    ).rejects.toThrow("RECOVERY_INDEX_CHANGED");
    expect(await readFile(path.join(fixture.root, ".git/index"))).toEqual(changedIndex);
  });

  it("requires before and after evidence for a declared controlled path", async () => {
    const fixture = await ownershipFixture();
    const before = await fixture.workspace.snapshot(fixture.scope);
    await writeFile(path.join(fixture.root, "task.txt"), "task\n");
    const after = await fixture.workspace.snapshot({
      ...fixture.scope,
      previousSnapshotId: before.id,
      controlledWritePaths: ["task.txt"],
    });
    expect(after.files.find(({ path }) => path === "task.txt")?.owner).toBe("concurrent_unowned");
  });
  it.each(["unstaged", "untracked"])(
    "never transfers pre-existing Owner %s content to a controlled path",
    async (kind) => {
      const fixture = await ownershipFixture();
      const filename = kind === "unstaged" ? "baseline.txt" : "owner.txt";
      await writeFile(path.join(fixture.root, filename), "Owner content\n");
      const before = await fixture.workspace.snapshot(fixture.scope);
      await writeFile(path.join(fixture.root, filename), "Owner content\ntask addition\n");
      const after = await fixture.workspace.snapshot({
        ...fixture.scope,
        previousSnapshotId: before.id,
        controlledWritePaths: [filename],
        controlledWrites: [
          writeEvidence(filename, "Owner content\n", "Owner content\ntask addition\n"),
        ],
      });
      expect(after.files.find(({ path }) => path === filename)?.owner).toBe("owner");
      await expect(
        fixture.workspace.stageTaskChanges({ snapshotId: after.id, paths: [filename] }),
      ).rejects.toThrow("Owner or concurrent");
    },
  );

  it("does not let an initial scope declaration claim existing content", async () => {
    const fixture = await ownershipFixture();
    await writeFile(path.join(fixture.root, "owner.txt"), "Owner content\n");
    const snapshot = await fixture.workspace.snapshot({
      ...fixture.scope,
      controlledWritePaths: ["owner.txt"],
    });
    expect(snapshot.files.find(({ path }) => path === "owner.txt")?.owner).toBe("owner");
  });

  it("invalidates approval when the real Owner index changes after preview", async () => {
    const fixture = await ownershipFixture();
    const before = await fixture.workspace.snapshot(fixture.scope);
    await writeFile(path.join(fixture.root, "task.txt"), "task\n");
    const after = await fixture.workspace.snapshot({
      ...fixture.scope,
      previousSnapshotId: before.id,
      controlledWritePaths: ["task.txt"],
      controlledWrites: [writeEvidence("task.txt", null, "task\n")],
    });
    const staged = await fixture.workspace.stageTaskChanges({
      snapshotId: after.id,
      paths: ["task.txt"],
    });
    const preview = await fixture.gate.prepare({
      workspaceId: fixture.scope.workspaceId,
      stagingRef: staged.stagingRef,
      taskChangeSetRevision: after.taskChangeSetRevision,
      validationResultRefs: [],
      message: "task change",
      expiresAt: "2026-08-28T21:00:00.000Z",
    });
    await git(fixture.root, ["add", "task.txt"]);
    const ownerIndex = await readFile(path.join(fixture.root, ".git", "index"));
    await expect(
      fixture.gate.commit({ handle: fixture.handle(preview), authorityFence: 1 }),
    ).rejects.toThrow("index");
    expect(await readFile(path.join(fixture.root, ".git", "index"))).toEqual(ownerIndex);
    expect((await git(fixture.root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(preview.head);
  });

  it("preserves Owner dirty files and commits only the frozen staged task change", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-git-workspace-"));
    roots.push(root);
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.name", "Fixture Owner"]);
    await git(root, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(path.join(root, "baseline.txt"), "baseline\n");
    await git(root, ["add", "baseline.txt"]);
    await git(root, ["commit", "-q", "-m", "baseline"]);
    await writeFile(path.join(root, "owner.txt"), "owner-untracked\n");
    await git(root, ["add", "owner.txt"]);

    const payloads = new Map<string, Uint8Array>();
    const adapter = new GitWorkspaceAdapter({
      roots: new Map([["workspace-01", root]]),
      writePayload: async ({ body }) => {
        const ref = `payload:diff:${payloads.size + 1}`;
        payloads.set(ref, body);
        return ref;
      },
    });
    const state = new MemoryWorkspaceState();
    let sequence = 0;
    const workspace = new WorkspaceService({
      platform: adapter,
      state,
      clock: { now: () => "2026-08-28T20:00:00.000Z" },
      ids: { next: (prefix) => `${prefix}-${++sequence}` },
    });
    const initialSnapshot = await workspace.snapshot({
      workspaceId: "workspace-01",
      hostId: "host-mac",
      root,
    });
    expect(initialSnapshot.files.find(({ path }) => path === "owner.txt")?.owner).toBe("owner");
    await writeFile(path.join(root, "task.txt"), "task-owned\n");
    const snapshot = await workspace.snapshot({
      workspaceId: "workspace-01",
      hostId: "host-mac",
      root,
      previousSnapshotId: initialSnapshot.id,
      controlledWritePaths: ["task.txt"],
      controlledWrites: [writeEvidence("task.txt", null, "task-owned\n")],
    });
    expect(snapshot.files.find(({ path }) => path === "owner.txt")?.owner).toBe("owner");
    expect(snapshot.files.find(({ path }) => path === "task.txt")?.owner).toBe("task");
    const staged = await workspace.stageTaskChanges({
      snapshotId: snapshot.id,
      paths: ["task.txt"],
    });
    expect(staged.stagedFiles).toEqual(["task.txt"]);

    const gate = new CommitGateService({
      platform: adapter,
      state,
      digest: {
        digest: (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        digestCanonical: (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`,
      },
      clock: { now: () => "2026-08-28T20:00:00.000Z" },
      ids: { next: (prefix) => `${prefix}-${++sequence}` },
    });
    const preview = await gate.prepare({
      workspaceId: "workspace-01",
      stagingRef: staged.stagingRef,
      taskChangeSetRevision: snapshot.taskChangeSetRevision,
      validationResultRefs: ["validation:fixture"],
      message: "test: commit isolated task change",
      expiresAt: "2026-08-28T21:00:00.000Z",
    });
    expect(preview.stagedFiles).toEqual(["task.txt"]);
    const result = await gate.commit({
      handle: {
        ref: "commit-handle-01",
        previewId: preview.id,
        previewHash: preview.canonicalHash,
        operationId: "commit-operation-01",
        recentAuthenticationRef: "authentication:fixture",
        authorityFence: 1,
        expiresAt: "2026-08-28T21:00:00.000Z",
        maxUses: 1,
      },
      authorityFence: 1,
    });
    expect(result.parent).not.toBe(result.commit);
    expect(result.remainingDirtyRefs).toContain("owner.txt");
    expect((await git(root, ["show", "--name-only", "--format=", "HEAD"])).stdout.trim()).toBe(
      "task.txt",
    );
    expect((await git(root, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe("owner.txt");
    expect(
      await gate.commit({
        handle: {
          ref: "commit-handle-01",
          previewId: preview.id,
          previewHash: preview.canonicalHash,
          operationId: "commit-operation-01",
          recentAuthenticationRef: "authentication:fixture",
          authorityFence: 1,
          expiresAt: "2026-08-28T21:00:00.000Z",
          maxUses: 1,
        },
        authorityFence: 1,
      }),
    ).toEqual(result);
  });

  it("mechanically denies push and networked command profiles", () => {
    const service = new CommandProfileService();
    const profile = {
      id: "profile-01",
      revision: 1,
      workspaceId: "workspace-01",
      argvPattern: ["git", "push"],
      workdir: "/fixture",
      environmentNames: [],
      fileScopes: ["."],
      network: "none" as const,
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      resources: { maxCpuTimeMs: 1_000, maxMemoryBytes: 64 * 1024 * 1024, maxProcesses: 4 },
      sandboxTier: "isolated-high-risk" as const,
      sandboxRuntimeIdentity: "fixture-sandbox:v1",
      scriptDigest: null,
      scriptSource: null,
      authorizationRef: "authorization:profile",
      expiresAt: "2026-08-28T21:00:00.000Z",
      revokedAt: null,
    };
    expect(() =>
      service.authorize({
        profile,
        argv: ["git", "push"],
        workdir: "/fixture",
        environmentNames: [],
        scriptDigest: null,
        now: "2026-08-28T20:00:00.000Z",
      }),
    ).toThrow("outside the frozen CommandProfile");
    expect(() =>
      service.authorize({
        profile: {
          ...profile,
          argvPattern: ["npm", "test"],
          sandboxTier: "native-low-risk",
        },
        argv: ["npm", "test"],
        workdir: "/fixture",
        environmentNames: [],
        scriptDigest: null,
        now: "2026-08-28T20:00:00.000Z",
      }),
    ).toThrow("does not match the frozen sandbox tier");
    expect(() =>
      service.authorize({
        profile: {
          ...profile,
          argvPattern: ["git", "status"],
          sandboxTier: "native-low-risk",
        },
        argv: ["git", "status"],
        workdir: "/fixture",
        environmentNames: [],
        scriptDigest: null,
        now: "2026-08-28T20:00:00.000Z",
      }),
    ).not.toThrow();
    expect(() =>
      service.authorize({
        profile: { ...profile, argvPattern: ["npm", "test"], network: "declared" },
        argv: ["npm", "test"],
        workdir: "/fixture",
        environmentNames: [],
        scriptDigest: null,
        now: "2026-08-28T20:00:00.000Z",
      }),
    ).toThrow("Networked commands require a new ActionIntent");

    for (const argv of [
      ["git", "-c", "alias.ship=push", "ship"],
      ["git", "commit"],
      ["gh", "pr", "create"],
      ["ssh", "git@example.invalid"],
      ["npm", "install"],
      ["/tmp/renamed-git", "push"],
    ]) {
      expect(() =>
        service.authorize({
          profile: { ...profile, argvPattern: argv },
          argv,
          workdir: "/fixture",
          environmentNames: [],
          scriptDigest: null,
          now: "2026-08-28T20:00:00.000Z",
        }),
      ).toThrow("outside the frozen CommandProfile");
    }
    expect(() =>
      service.authorize({
        profile: {
          ...profile,
          argvPattern: ["npm", "test"],
          environmentNames: ["GIT_SSH_COMMAND"],
        },
        argv: ["npm", "test"],
        workdir: "/fixture",
        environmentNames: ["GIT_SSH_COMMAND"],
        scriptDigest: null,
        now: "2026-08-28T20:00:00.000Z",
      }),
    ).toThrow("outside the frozen CommandProfile");
  });

  it("uses content identities to reject same-status edits and reports nested repositories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-git-identity-"));
    roots.push(root);
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.name", "Fixture Owner"]);
    await git(root, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(path.join(root, "tracked.txt"), "baseline\n");
    await git(root, ["add", "tracked.txt"]);
    await git(root, ["commit", "-q", "-m", "baseline"]);
    await writeFile(path.join(root, "task.txt"), "first\n");
    const nested = path.join(root, "nested");
    await git(root, ["init", "-q", nested]);
    const adapter = new GitWorkspaceAdapter({
      roots: new Map([["workspace-identity", root]]),
      writePayload: async () => "payload:diff",
    });
    const observed = await adapter.snapshot({
      workspaceId: "workspace-identity",
      hostId: "host-mac",
      root,
    });
    expect(observed.nestedRepositoryRefs).toEqual(["nested"]);
    const task = observed.files.find(({ path }) => path === "task.txt");
    if (!task || !observed.head) throw new TypeError("task observation missing");
    await writeFile(path.join(root, "task.txt"), "second\n");
    await expect(
      adapter.stageTaskChanges({
        workspaceId: "workspace-identity",
        expectedHead: observed.head,
        files: [{ ...task, owner: "task" }],
      }),
    ).rejects.toThrow("WORKSPACE_TASK_CHANGE_CHANGED");
  });

  it("persists and blocks formatter scope expansion as concurrent-unowned", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-formatter-scope-"));
    roots.push(root);
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.name", "Fixture Owner"]);
    await git(root, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(path.join(root, "expected.ts"), "export const expected = 1;\n");
    await writeFile(path.join(root, "outside.ts"), "export const outside = 1;\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-q", "-m", "baseline"]);
    const adapter = new GitWorkspaceAdapter({
      roots: new Map([["workspace-formatter", root]]),
      writePayload: async () => "payload:diff",
    });
    const state = new MemoryWorkspaceState();
    let sequence = 0;
    const workspaces = new WorkspaceService({
      platform: adapter,
      state,
      clock: { now: () => "2026-08-29T00:00:00.000Z" },
      ids: { next: (prefix) => `${prefix}-${++sequence}` },
    });
    const before = await workspaces.snapshot({
      workspaceId: "workspace-formatter",
      hostId: "host-mac",
      root,
    });
    await writeFile(path.join(root, "expected.ts"), "export const expected = 2;\n");
    await writeFile(path.join(root, "outside.ts"), "export const outside = 2;\n");
    await expect(
      workspaces.reconcileControlledCommand({
        workspaceId: "workspace-formatter",
        hostId: "host-mac",
        root,
        previousSnapshotId: before.id,
        expectedWritePaths: ["expected.ts"],
        controlledWrites: [
          writeEvidence(
            "expected.ts",
            "export const expected = 1;\n",
            "export const expected = 2;\n",
          ),
        ],
      }),
    ).rejects.toMatchObject({
      code: "PORT_CONFLICT",
      details: expect.objectContaining({ paths: "outside.ts" }),
    });
    const persisted = [...state.snapshots.values()].at(-1);
    expect(persisted?.files.find(({ path }) => path === "expected.ts")?.owner).toBe("task");
    expect(persisted?.files.find(({ path }) => path === "outside.ts")?.owner).toBe(
      "concurrent_unowned",
    );
  });

  it("rejects executable filters and stages exact blobs without running hooks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-filter-safe-stage-"));
    roots.push(root);
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.name", "Fixture Owner"]);
    await git(root, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(path.join(root, "task.txt"), "base\n");
    await git(root, ["add", "task.txt"]);
    await git(root, ["commit", "-q", "-m", "baseline"]);
    const marker = path.join(root, "filter-or-hook-ran");
    const filter = path.join(root, "unsafe-filter.sh");
    await writeFile(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    await chmod(filter, 0o700);
    await writeFile(path.join(root, ".gitattributes"), "task.txt filter=unsafe\n");
    await git(root, ["config", "filter.unsafe.clean", filter]);
    const hooks = path.join(root, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    const preCommit = path.join(hooks, "pre-commit");
    await writeFile(preCommit, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    await chmod(preCommit, 0o700);
    await writeFile(path.join(root, "task.txt"), "task-owned\n");

    const adapter = new GitWorkspaceAdapter({
      roots: new Map([["workspace-safe-stage", root]]),
      writePayload: async () => "payload:diff",
    });
    const state = new MemoryWorkspaceState();
    let sequence = 0;
    const workspaces = new WorkspaceService({
      platform: adapter,
      state,
      clock: { now: () => "2026-08-29T00:00:00.000Z" },
      ids: { next: (prefix) => `${prefix}-${++sequence}` },
    });
    await expect(
      workspaces.snapshot({
        workspaceId: "workspace-safe-stage",
        hostId: "host-mac",
        root,
      }),
    ).rejects.toThrow("WORKSPACE_EXECUTABLE_CONFIG_FORBIDDEN:filter.unsafe.clean");
    expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
    await git(root, ["config", "--unset", "filter.unsafe.clean"]);
    const initial = await workspaces.snapshot({
      workspaceId: "workspace-safe-stage",
      hostId: "host-mac",
      root,
    });
    const task = initial.files.find(({ path: filePath }) => filePath === "task.txt");
    if (!task || !initial.head) throw new TypeError("task fixture missing");
    const staged = await adapter.stageTaskChanges({
      workspaceId: "workspace-safe-stage",
      expectedHead: initial.head,
      files: [
        {
          ...task,
          owner: "task",
          taskWrite: {
            ...writeEvidence("task.txt", "base\n", "task-owned\n"),
            beforeSnapshotId: initial.id,
          },
        },
      ],
    });
    const preview = await adapter.inspectCommitState("workspace-safe-stage", staged.stagingRef);
    expect(preview.stagedFiles).toEqual(["task.txt"]);
    expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
  });
});

async function ownershipFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "himawari-ownership-regression-"));
  roots.push(root);
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Fixture Owner"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(path.join(root, "baseline.txt"), "baseline\n");
  await git(root, ["add", "baseline.txt"]);
  await git(root, ["commit", "-q", "-m", "baseline"]);
  const adapter = new GitWorkspaceAdapter({
    roots: new Map([["workspace-regression", root]]),
    writePayload: async () => "payload:diff",
  });
  const state = new MemoryWorkspaceState();
  let sequence = 0;
  const common = {
    platform: adapter,
    state,
    clock: { now: () => "2026-08-28T20:00:00.000Z" },
    ids: { next: (prefix: string) => `${prefix}-${++sequence}` },
  };
  const workspace = new WorkspaceService(common);
  const gate = new CommitGateService({
    ...common,
    digest: {
      digest: (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      digestCanonical: (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`,
    },
  });
  return {
    root,
    adapter,
    state,
    workspace,
    gate,
    scope: { workspaceId: "workspace-regression", hostId: "host-mac", root },
    handle: (preview: CommitPreview) => ({
      ref: "handle-regression",
      previewId: preview.id,
      previewHash: preview.canonicalHash,
      operationId: "operation-regression",
      recentAuthenticationRef: "auth:fixture",
      authorityFence: 1,
      expiresAt: "2026-08-28T21:00:00.000Z",
      maxUses: 1 as const,
    }),
  };
}

function writeEvidence(path: string, before: string | null, after: string | null) {
  const hash = (value: string | null) =>
    value === null ? null : `sha256:${createHash("sha256").update(value).digest("hex")}`;
  return { path, beforeDigest: hash(before), afterDigest: hash(after) };
}

async function preparedTransactionFixture() {
  const fixture = await ownershipFixture();
  await writeFile(path.join(fixture.root, "owner.txt"), "Owner base\n");
  await git(fixture.root, ["add", "owner.txt"]);
  await git(fixture.root, ["commit", "-q", "-m", "Owner base"]);
  await writeFile(path.join(fixture.root, "owner.txt"), "Owner staged\n");
  await git(fixture.root, ["add", "owner.txt"]);
  const before = await fixture.workspace.snapshot(fixture.scope);
  await writeFile(path.join(fixture.root, "task.txt"), "task\n");
  const after = await fixture.workspace.snapshot({
    ...fixture.scope,
    previousSnapshotId: before.id,
    controlledWritePaths: ["task.txt"],
    controlledWrites: [writeEvidence("task.txt", null, "task\n")],
  });
  const staged = await fixture.workspace.stageTaskChanges({
    snapshotId: after.id,
    paths: ["task.txt"],
  });
  const preview = await fixture.gate.prepare({
    workspaceId: fixture.scope.workspaceId,
    stagingRef: staged.stagingRef,
    taskChangeSetRevision: after.taskChangeSetRevision,
    validationResultRefs: [],
    message: "task change",
    expiresAt: "2026-08-28T21:00:00.000Z",
  });
  return {
    ...fixture,
    preview,
    commitInput: {
      workspaceId: fixture.scope.workspaceId,
      stagingRef: staged.stagingRef,
      message: preview.message,
      operationId: "transaction-regression",
      expectedHead: preview.head,
      expectedBranch: preview.branch,
      expectedIndexTree: preview.indexTree,
      expectedOwnerIndexDigest: preview.ownerIndexDigest,
      expectedHooksDigest: preview.hooksDigest,
      expectedConfigurationDigest: preview.configurationDigest,
    },
  };
}

function transactionFor(
  fixture: Awaited<ReturnType<typeof preparedTransactionFixture>>,
  afterRefUpdate?: () => void,
) {
  return new GitIndexTransaction({
    git: async (args, environment) => {
      const result = await git(fixture.root, args, environment);
      if (args[0] === "update-ref") afterRefUpdate?.();
      return result.stdout;
    },
    indexPath: path.join(fixture.root, ".git/index"),
    stagingIndexPath: path.join(
      fixture.root,
      ".git/himawari-indexes",
      `${fixture.preview.stagingRef.slice(8)}.index`,
    ),
    inspect: () =>
      fixture.adapter.inspectCommitState(fixture.scope.workspaceId, fixture.preview.stagingRef),
    remaining: async () =>
      (await git(fixture.root, ["status", "--porcelain=v1"])).stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(3)),
  });
}
