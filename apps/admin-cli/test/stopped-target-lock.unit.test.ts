import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireStateRootLock } from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { lockStoppedTarget } from "../src/stopped-target-lock.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch() {
  const root = await mkdtemp(path.join(tmpdir(), "himawari-admin-lock-"));
  roots.push(root);
  return root;
}

describe("taking the state-root lock before a maintenance command", () => {
  it("says the target is not stopped only when a live process holds the lock", async () => {
    const root = await scratch();
    const held = await acquireStateRootLock(root);
    try {
      await expect(lockStoppedTarget(root)).rejects.toThrow("ADMIN_TARGET_NOT_STOPPED");
    } finally {
      await held.release();
    }
    const lock = await lockStoppedTarget(root);
    await lock.release();
  });

  it("passes any other failure through with its own code", async () => {
    const root = await scratch();
    const file = path.join(root, "not-a-directory");
    await writeFile(file, "");
    await expect(lockStoppedTarget(path.join(file, "state"))).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });
});
