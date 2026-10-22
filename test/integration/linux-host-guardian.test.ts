import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";
import { expect, it } from "vitest";
import {
  type LinuxProcessIdentity,
  readLinuxHostGroup,
  readLinuxProcessIdentity,
} from "../../packages/runtime-sandbox/src/linux-host-group.ts";

it("[R2-S4] reclaims a dead Host group before its parent reaps the zombie", async () => {
  expect(process.platform).toBe("linux");
  const scratch = await mkdtemp(path.join(testTemporaryRoot(), "g-"));
  const output = path.resolve(".ci-output/r2-s4-guardian", path.basename(scratch));
  await mkdir(output, { recursive: true });
  const readyPath = path.join(scratch, "ready.json");
  const supervisor = spawn(
    process.env["HIMAWARI_CI_PYTHON"] as string,
    [
      fileURLToPath(new URL("../fixtures/linux-host-guardian-supervisor.py", import.meta.url)),
      process.execPath,
      fileURLToPath(new URL("../fixtures/linux-host-guardian-host.mjs", import.meta.url)),
      new URL("../../packages/runtime-sandbox/src/linux-host-guardian.ts", import.meta.url).href,
      new URL("../../packages/runtime-sandbox/src/linux-host-group.ts", import.meta.url).href,
      readyPath,
      "5000",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  supervisor.stdin.on("error", () => {});
  let stderr = "";
  supervisor.stderr.on("data", (value: Buffer) => {
    stderr += value.toString();
  });
  const closed = new Promise<void>((resolve, reject) => {
    supervisor.once("error", reject);
    supervisor.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`GUARDIAN_FIXTURE_EXIT:${code}:${stderr}`));
    });
  });
  void closed.catch(() => {});
  const readySignal = new Promise<void>((resolve, reject) => {
    let stdout = "";
    supervisor.stdout.on("data", (value: Buffer) => {
      stdout += value.toString();
      if (stdout.split("\n").includes("ready")) resolve();
    });
    closed.then(() => reject(new Error(`GUARDIAN_FIXTURE_EXITED_BEFORE_READY:${stderr}`)), reject);
  });
  void readySignal.catch(() => {});
  let ready:
    | {
        hostIdentity: LinuxProcessIdentity;
        proxyIdentity: LinuxProcessIdentity;
        guardianIdentity: LinuxProcessIdentity;
        startupMs: number;
        guardianRssBytes: number;
      }
    | undefined;
  try {
    await readySignal;
    const published: NonNullable<typeof ready> = JSON.parse(await readFile(readyPath, "utf8"));
    ready = published;
    await writeFile(path.join(output, "ready.json"), JSON.stringify(published, null, 2));
    const host = published.hostIdentity;
    const live = await readLinuxProcessIdentity(host.processId);
    expect(live).not.toBeNull();
    expect(live?.startToken).toBe(host.startToken);
    expect(live?.state).not.toBe("Z");
    supervisor.stdin.write("kill\n");
    await expect
      .poll(async () => (await readLinuxProcessIdentity(host.processId))?.state)
      .toBe("Z");
    const before = await readLinuxHostGroup(host.processId);
    await writeFile(path.join(output, "host-zombie-before.json"), JSON.stringify(before, null, 2));
    await expect
      .poll(async () => readLinuxProcessIdentity(ready?.guardianIdentity.processId as number), {
        timeout: 8000,
      })
      .toBeNull();
    await expect
      .poll(async () => readLinuxProcessIdentity(ready?.proxyIdentity.processId as number))
      .toBeNull();
    const remaining = await readLinuxHostGroup(host.processId);
    await writeFile(
      path.join(output, "host-zombie-after.json"),
      JSON.stringify(remaining, null, 2),
    );
    expect(remaining).toEqual([
      expect.objectContaining({
        processId: host.processId,
        startToken: host.startToken,
        state: "Z",
      }),
    ]);
    supervisor.stdin.write("reap\n");
    await expect.poll(async () => readLinuxHostGroup(host.processId)).toEqual([]);
    await writeFile(
      path.join(output, "after-reap.json"),
      JSON.stringify(await readLinuxHostGroup(host.processId)),
    );
  } finally {
    try {
      if (ready)
        await writeFile(
          path.join(output, "before-fixture-cleanup.json"),
          JSON.stringify(await readLinuxHostGroup(ready.hostIdentity.processId), null, 2),
        );
    } finally {
      supervisor.stdin.end("stop\n");
      try {
        await closed;
      } finally {
        try {
          await writeFile(path.join(output, "supervisor-stderr.log"), stderr);
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      }
    }
  }
});
