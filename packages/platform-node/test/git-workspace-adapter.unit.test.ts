import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  CommandProfileService,
  CommitGateService,
  WorkspaceService,
  type CommitPreview,
  type WorkspaceSnapshot,
  type WorkspaceStatePort,
} from "@himawari-agent/application";
import { afterEach, describe, expect, it } from "vitest";
import { GitWorkspaceAdapter } from "../src/index.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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

async function git(root: string, args: readonly string[]) {
  return execFile("git", ["-C", root, ...args], {
    encoding: "utf8",
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index-signature access.
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LC_ALL: "C" },
  });
}

describe("GitWorkspaceAdapter", () => {
  it("preserves Owner dirty files and commits only the frozen staged task change", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-git-workspace-"));
    roots.push(root);
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.name", "Fixture Owner"]);
    await git(root, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(path.join(root, "baseline.txt"), "baseline\n");
    await git(root, ["add", "baseline.txt"]);
    await git(root, ["commit", "-q", "-m", "baseline"]);
    await writeFile(path.join(root, "task.txt"), "task-owned\n");
    await writeFile(path.join(root, "owner.txt"), "owner-untracked\n");
    await git(root, ["add", "task.txt"]);

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
    const snapshot = await workspace.snapshot({
      workspaceId: "workspace-01",
      hostId: "host-mac",
      root,
    });
    expect(snapshot.files.find(({ path }) => path === "owner.txt")?.owner).toBe("owner");

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
        profile: { ...profile, argvPattern: ["npm", "test"], network: "declared" },
        argv: ["npm", "test"],
        workdir: "/fixture",
        environmentNames: [],
        scriptDigest: null,
        now: "2026-08-28T20:00:00.000Z",
      }),
    ).toThrow("Networked commands require a new ActionIntent");
  });
});
