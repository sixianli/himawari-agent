import { spawn } from "node:child_process";
import { chmod, chown, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { JobHostRequest } from "../../packages/runtime-sandbox/src/job-host-protocol.ts";
import { gatewayJobHostLauncher } from "../../packages/runtime-sandbox/src/job-host-transport.ts";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const hostFixture = path.join(repository, "test/fixtures/job-host-gateway-host.mjs");
const gatewaySource = path.join(repository, "packages/runtime-sandbox/src/job-host-gateway.ts");
const EXEC_UID = 4999;

function request(): JobHostRequest {
  return {
    jobId: "job",
    attemptId: "attempt",
    policy: {
      workspace: "/workspace",
      privateDirectory: "/private-job",
      writable: true,
      readOnlyToolchainPaths: [],
      protectedPaths: [],
      allowedDomains: [],
    },
    policyDigest: "a".repeat(64),
    executable: "/bin/echo",
    args: ["value"],
    deadlineAt: new Date(Date.now() + 10000).toISOString(),
    maxOutputBytes: 16,
    cleanupTimeoutMs: 10,
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.skipIf(process.getuid?.() !== 0)("Job Host gateway under another account", () => {
  it("runs the Job Host as the gateway's account and kills it on request", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hjg-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await chown(root, EXEC_UID, EXEC_UID);
    await chmod(root, 0o700);
    const socketPath = path.join(root, "gateway.sock");
    const host = spawn(
      "setpriv",
      [
        `--reuid=${EXEC_UID}`,
        `--regid=${EXEC_UID}`,
        "--clear-groups",
        process.execPath,
        hostFixture,
        gatewaySource,
        socketPath,
        "60000",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    cleanups.push(() => {
      if (host.exitCode === null) host.kill("SIGKILL");
    });
    await new Promise<void>((resolve, reject) => {
      host.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("listening")) resolve();
      });
      host.once("exit", () => reject(new Error("GATEWAY_HOST_EXITED")));
      host.once("error", reject);
    });
    const transport = gatewayJobHostLauncher(socketPath)(request());
    const messages: unknown[] = [];
    transport.onMessage((value) => messages.push(value));
    const closed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => transport.onceClose((exitCode, signal) => resolve({ exitCode, signal })),
    );
    const pid = await transport.spawned;
    transport.send({ type: "ping", echo: "x" }, () => {});
    const deadline = Date.now() + 5000;
    while (messages.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(messages[0]).toMatchObject({ pid, uid: EXEC_UID });
    transport.killGroup();
    expect(await closed).toEqual({ exitCode: null, signal: "SIGKILL" });
  });
});
