import { type ChildProcess, fork, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type JobHostGateway,
  parseJobHostGatewayArgs,
  serveJobHostGateway,
} from "../../packages/runtime-sandbox/src/job-host-gateway.ts";
import { JOB_HOST_GATEWAY_FRAME_MAX_BYTES } from "../../packages/runtime-sandbox/src/job-host-gateway-frames.ts";
import type { JobHostRequest } from "../../packages/runtime-sandbox/src/job-host-protocol.ts";
import {
  gatewayJobHostLauncher,
  type JobHostTransport,
} from "../../packages/runtime-sandbox/src/job-host-transport.ts";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const childFixture = path.join(repository, "test/fixtures/job-host-gateway-child.mjs");
const gatewayMain = path.join(repository, "packages/runtime-sandbox/src/job-host-gateway-main.ts");

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

async function directory() {
  const created = await mkdtemp(path.join(tmpdir(), "hjg-"));
  cleanups.push(() => rm(created, { recursive: true, force: true }));
  return created;
}

function forkFixture(args: readonly string[] = []) {
  return fork(childFixture, [...args], {
    detached: true,
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
}

async function startGateway(idleExitMs = 60000, childArgs: readonly string[] = []) {
  const socketPath = path.join(await directory(), "gateway.sock");
  const server = createServer();
  const onIdle = vi.fn(() => server.close());
  const forks: ChildProcess[] = [];
  const gateway = serveJobHostGateway(server, {
    idleExitMs,
    onIdle,
    fork: () => {
      const child = forkFixture(childArgs);
      forks.push(child);
      return child;
    },
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(() => {
    for (const child of forks)
      if (child.pid && child.exitCode === null && child.signalCode === null)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { socketPath, server, gateway, onIdle, forks };
}

function observe(transport: JobHostTransport) {
  const messages: unknown[] = [];
  let stderr = "";
  let exited = false;
  let errored = false;
  transport.onMessage((value) => messages.push(value));
  transport.onStderr((chunk) => {
    stderr += chunk.toString();
  });
  transport.onceExit(() => {
    exited = true;
  });
  transport.onceError(() => {
    errored = true;
  });
  const closed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => transport.onceClose((exitCode, signal) => resolve({ exitCode, signal })),
  );
  return {
    messages,
    closed,
    stderr: () => stderr,
    exited: () => exited,
    errored: () => errored,
  };
}

async function until(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("CONDITION_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function liveJobHostsDrain(gateway: JobHostGateway) {
  await until(() => gateway.liveJobHosts() === 0);
}

describe("Job Host gateway", () => {
  it("relays the Job Host's own process id, messages and stderr", async () => {
    const { socketPath, forks } = await startGateway();
    const transport = gatewayJobHostLauncher(socketPath)(request());
    const seen = observe(transport);
    const pid = await transport.spawned;
    expect(pid).toBe(forks[0]?.pid);
    expect(pid).not.toBe(process.pid);
    expect(transport.pid).toBe(pid);
    transport.send({ type: "ping", echo: "value" }, () => {
      throw new Error("SEND_FAILED");
    });
    await until(() => seen.messages.length > 0 && seen.stderr().includes("child-ready"));
    expect(seen.messages[0]).toEqual({ type: "pong", pid, uid: process.getuid?.(), echo: "value" });
    transport.send({ type: "exit" }, () => {});
    expect(await seen.closed).toEqual({ exitCode: 3, signal: null });
    expect(seen.exited()).toBe(true);
    expect(transport.connected).toBe(false);
  });

  it("kills the Job Host's process group when the worker asks", async () => {
    const { socketPath, gateway } = await startGateway();
    const transport = gatewayJobHostLauncher(socketPath)(request());
    const seen = observe(transport);
    await transport.spawned;
    transport.killGroup();
    expect(await seen.closed).toEqual({ exitCode: null, signal: "SIGKILL" });
    await liveJobHostsDrain(gateway);
  });

  it("disconnects the Job Host when the worker connection drops", async () => {
    const { socketPath, gateway, forks } = await startGateway();
    const socket = connect(socketPath);
    socket.write(
      `${JSON.stringify({ type: "launch", request: { ...request(), cleanupTimeoutMs: 5000 } })}\n`,
    );
    await until(() => gateway.liveJobHosts() === 1);
    const exited = new Promise<number | null>((resolve) =>
      forks[0]?.once("exit", (code) => resolve(code)),
    );
    socket.destroy();
    expect(await exited).toBe(0);
    await liveJobHostsDrain(gateway);
  });

  it("refuses an invalid launch request without starting a Job Host", async () => {
    const { socketPath, forks } = await startGateway();
    const transport = gatewayJobHostLauncher(socketPath)({
      ...request(),
      policyDigest: "not-a-digest",
    });
    const seen = observe(transport);
    expect(await seen.closed).toEqual({ exitCode: null, signal: null });
    expect(seen.errored()).toBe(true);
    expect(await transport.spawned).toBeUndefined();
    expect(forks).toHaveLength(0);
  });

  it("drops a connection whose first frame is not a launch", async () => {
    const { socketPath, forks } = await startGateway();
    const socket = connect(socketPath);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.on("error", () => {});
    socket.write(`${JSON.stringify({ type: "message", message: { type: "ping" } })}\n`);
    await closed;
    expect(forks).toHaveLength(0);
  });

  it("drops a connection that sends a line that is not a JSON object", async () => {
    const { socketPath, forks } = await startGateway();
    const socket = connect(socketPath);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.on("error", () => {});
    socket.write("[1,2]\n");
    await closed;
    expect(forks).toHaveLength(0);
  });

  it("reports a start failure when the gateway socket does not exist", async () => {
    const transport = gatewayJobHostLauncher(path.join(await directory(), "missing.sock"))(
      request(),
    );
    const seen = observe(transport);
    expect(await seen.closed).toEqual({ exitCode: null, signal: null });
    expect(seen.errored()).toBe(true);
    expect(await transport.spawned).toBeUndefined();
    expect(transport.connected).toBe(false);
  });

  it("kills a Job Host that ignores the disconnect once its cleanup time has passed", async () => {
    const { socketPath, gateway, forks } = await startGateway(60000, ["--ignore-disconnect"]);
    const socket = connect(socketPath);
    socket.write(`${JSON.stringify({ type: "launch", request: request() })}\n`);
    await until(() => gateway.liveJobHosts() === 1);
    const ended = new Promise<NodeJS.Signals | null>((resolve) =>
      forks[0]?.once("exit", (_code, signal) => resolve(signal)),
    );
    socket.destroy();
    expect(await ended).toBe("SIGKILL");
    await liveJobHostsDrain(gateway);
  });

  it("drops the connection and kills the Job Host on a second launch", async () => {
    const { socketPath, gateway, forks } = await startGateway();
    const socket = connect(socketPath);
    socket.on("error", () => {});
    socket.resume();
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.write(`${JSON.stringify({ type: "launch", request: request() })}\n`);
    await until(() => gateway.liveJobHosts() === 1);
    const ended = new Promise<NodeJS.Signals | null>((resolve) =>
      forks[0]?.once("exit", (_code, signal) => resolve(signal)),
    );
    socket.write(`${JSON.stringify({ type: "launch", request: request() })}\n`);
    await closed;
    expect(await ended).toBe("SIGKILL");
    expect(forks).toHaveLength(1);
  });

  it("drops a frame longer than the frame limit without starting a Job Host", async () => {
    const { socketPath, forks } = await startGateway();
    const socket = connect(socketPath);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.on("error", () => {});
    socket.write(`${"x".repeat(JOB_HOST_GATEWAY_FRAME_MAX_BYTES + 1)}\n`);
    await closed;
    expect(forks).toHaveLength(0);
  });

  it("gives up when the gateway accepts but never reports a started Job Host", async () => {
    const socketPath = path.join(await directory(), "silent.sock");
    const silent = createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(socketPath, resolve));
    cleanups.push(() => {
      silent.close();
    });
    const transport = gatewayJobHostLauncher(socketPath, 100)(request());
    const seen = observe(transport);
    expect(await seen.closed).toEqual({ exitCode: null, signal: null });
    expect(seen.errored()).toBe(true);
    expect(await transport.spawned).toBeUndefined();
  });

  it("goes idle only after every Job Host has ended", async () => {
    const { socketPath, gateway, onIdle } = await startGateway(50);
    const transport = gatewayJobHostLauncher(socketPath)(request());
    const seen = observe(transport);
    await transport.spawned;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onIdle).not.toHaveBeenCalled();
    transport.killGroup();
    await seen.closed;
    await liveJobHostsDrain(gateway);
    await until(() => onIdle.mock.calls.length === 1);
  });
});

describe("Job Host gateway arguments", () => {
  it("requires an idle exit time and one listening source", () => {
    expect(() => parseJobHostGatewayArgs(["--socket", "/s"], {}, 10)).toThrow(
      "JOB_HOST_GATEWAY_IDLE_EXIT_INVALID",
    );
    expect(() =>
      parseJobHostGatewayArgs(["--idle-exit-ms", "0", "--socket", "/s"], {}, 10),
    ).toThrow("JOB_HOST_GATEWAY_IDLE_EXIT_INVALID");
    expect(() => parseJobHostGatewayArgs(["--idle-exit-ms", "100"], {}, 10)).toThrow(
      "JOB_HOST_GATEWAY_SOCKET_MISSING",
    );
    expect(() =>
      parseJobHostGatewayArgs(["--idle-exit-ms", "100", "--extra", "x"], {}, 10),
    ).toThrow("JOB_HOST_GATEWAY_ARGS_INVALID");
    expect(() =>
      parseJobHostGatewayArgs(
        ["--idle-exit-ms", "100", "--socket", "/s"],
        {
          LISTEN_PID: "10",
          LISTEN_FDS: "1",
        },
        10,
      ),
    ).toThrow("JOB_HOST_GATEWAY_ARGS_INVALID");
    expect(
      parseJobHostGatewayArgs(["--idle-exit-ms", "100"], { LISTEN_PID: "10", LISTEN_FDS: "1" }, 10),
    ).toEqual({ idleExitMs: 100, listen: { fd: 3 } });
    expect(() =>
      parseJobHostGatewayArgs(["--idle-exit-ms", "100"], { LISTEN_PID: "11", LISTEN_FDS: "1" }, 10),
    ).toThrow("JOB_HOST_GATEWAY_SOCKET_MISSING");
    expect(parseJobHostGatewayArgs(["--idle-exit-ms", "100", "--socket", "/s"], {}, 10)).toEqual({
      idleExitMs: 100,
      listen: { path: "/s" },
    });
  });
});

describe("Job Host gateway process", () => {
  it("refuses an invalid launch and exits on its own once idle", async () => {
    const socketPath = path.join(await directory(), "gateway.sock");
    const gateway = spawn(
      process.execPath,
      [gatewayMain, "--socket", socketPath, "--idle-exit-ms", "300"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    cleanups.push(() => {
      if (gateway.exitCode === null) gateway.kill("SIGKILL");
    });
    const exited = new Promise<number | null>((resolve) => gateway.once("exit", resolve));
    await until(() => existsSync(socketPath));
    const transport = gatewayJobHostLauncher(socketPath)({ ...request(), policyDigest: "bad" });
    const seen = observe(transport);
    expect(await seen.closed).toEqual({ exitCode: null, signal: null });
    expect(seen.errored()).toBe(true);
    expect(await exited).toBe(0);
  });
});
