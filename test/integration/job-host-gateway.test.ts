import { type ChildProcess, fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type JobHostControlBinding,
  type JobHostControlObservation,
  openJobHostControl,
  readJobHostStartEvidence,
} from "../../packages/runtime-sandbox/src/job-host-control.ts";
import { gatewayJobHostControlAccess } from "../../packages/runtime-sandbox/src/job-host-control-access.ts";
import {
  type JobHostGateway,
  parseJobHostGatewayArgs,
  serveJobHostGateway,
} from "../../packages/runtime-sandbox/src/job-host-gateway.ts";
import { JOB_HOST_GATEWAY_FRAME_MAX_BYTES } from "../../packages/runtime-sandbox/src/job-host-gateway-frames.ts";
import type { JobHostLaunchContext } from "../../packages/runtime-sandbox/src/job-host-launch-decision.ts";
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

async function startGateway(
  idleExitMs = 60000,
  childArgs: readonly string[] = [],
  controlRoot?: string,
) {
  const socketPath = path.join(await directory(), "gateway.sock");
  const server = createServer();
  const onIdle = vi.fn(() => server.close());
  const forks: ChildProcess[] = [];
  const gateway = serveJobHostGateway(server, {
    idleExitMs,
    onIdle,
    ...(controlRoot === undefined ? {} : { controlRoot }),
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

  it("kills a Job Host that already let go of its channel once the worker drops", async () => {
    const { socketPath, gateway, forks } = await startGateway(60000, [
      "--disconnect-self",
      "--ignore-disconnect",
    ]);
    const socket = connect(socketPath);
    socket.resume();
    socket.write(`${JSON.stringify({ type: "launch", request: request() })}\n`);
    await until(() => gateway.liveJobHosts() === 1 && forks[0]?.connected === false);
    const ended = new Promise<NodeJS.Signals | null>((resolve) =>
      forks[0]?.once("exit", (_code, signal) => resolve(signal)),
    );
    socket.destroy();
    expect(await ended).toBe("SIGKILL");
    await liveJobHostsDrain(gateway);
  });

  it("answers a Job Host that cannot be forked and keeps serving", async () => {
    const socketPath = path.join(await directory(), "gateway.sock");
    const server = createServer();
    let attempts = 0;
    serveJobHostGateway(server, {
      idleExitMs: 60000,
      onIdle: () => {},
      fork: () => {
        attempts += 1;
        throw new Error("FORK_FAILED");
      },
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    for (const _ of [1, 2]) {
      const transport = gatewayJobHostLauncher(socketPath)(request());
      const seen = observe(transport);
      expect(await seen.closed).toEqual({ exitCode: null, signal: null });
      expect(seen.errored()).toBe(true);
      expect(seen.exited()).toBe(false);
    }
    expect(attempts).toBe(2);
  });

  it("gives up at once when the gateway reports a started Job Host without a process id", async () => {
    const socketPath = path.join(await directory(), "lying.sock");
    const lying = createServer((socket) => {
      socket.write(`${JSON.stringify({ type: "started", pid: null })}\n`);
    });
    await new Promise<void>((resolve) => lying.listen(socketPath, resolve));
    cleanups.push(() => {
      lying.close();
    });
    const transport = gatewayJobHostLauncher(socketPath, 60000)(request());
    const seen = observe(transport);
    expect(await seen.closed).toEqual({ exitCode: null, signal: null });
    expect(seen.errored()).toBe(true);
    expect(await transport.spawned).toBeUndefined();
  });

  it("does not signal the process group of a Job Host that has already exited", async () => {
    const { socketPath } = await startGateway(60000, ["--hold-stderr"]);
    const transport = gatewayJobHostLauncher(socketPath)(request());
    const seen = observe(transport);
    const pid = await transport.spawned;
    transport.send({ type: "ping" }, () => {});
    await until(() => seen.messages.length > 0);
    const holder = (seen.messages[0] as { holder: number }).holder;
    cleanups.push(() => {
      try {
        process.kill(-(pid as number), "SIGKILL");
      } catch {}
    });
    transport.send({ type: "exit" }, () => {});
    await until(() => seen.exited());
    transport.killGroup();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const state = readFileSync(`/proc/${holder}/stat`, "utf8").split(") ").at(1)?.at(0);
    expect(state).not.toBe("Z");
  });

  it("reports a Job Host that let go of its channel as no longer connected", async () => {
    const { socketPath, gateway } = await startGateway(60000, [
      "--disconnect-self",
      "--ignore-disconnect",
    ]);
    const transport = gatewayJobHostLauncher(socketPath)(request());
    const seen = observe(transport);
    let closed = false;
    void seen.closed.then(() => {
      closed = true;
    });
    await transport.spawned;
    await until(() => !transport.connected);
    expect(seen.errored()).toBe(false);
    expect(seen.exited()).toBe(false);
    expect(closed).toBe(false);
    transport.send({ type: "heartbeat" }, () => {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(gateway.liveJobHosts()).toBe(1);
    expect(closed).toBe(false);
    transport.killGroup();
    await seen.closed;
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
  const root = ["--control-root", "/r"];
  it("requires an idle exit time, a control root and one listening source", () => {
    expect(() => parseJobHostGatewayArgs([...root, "--socket", "/s"], {}, 10)).toThrow(
      "JOB_HOST_GATEWAY_IDLE_EXIT_INVALID",
    );
    expect(() =>
      parseJobHostGatewayArgs([...root, "--idle-exit-ms", "0", "--socket", "/s"], {}, 10),
    ).toThrow("JOB_HOST_GATEWAY_IDLE_EXIT_INVALID");
    expect(() =>
      parseJobHostGatewayArgs(["--idle-exit-ms", "100", "--socket", "/s"], {}, 10),
    ).toThrow("JOB_HOST_GATEWAY_CONTROL_ROOT_INVALID");
    for (const invalid of ["relative", "/r/../x", "/r/"])
      expect(() =>
        parseJobHostGatewayArgs(
          ["--control-root", invalid, "--idle-exit-ms", "100", "--socket", "/s"],
          {},
          10,
        ),
      ).toThrow("JOB_HOST_GATEWAY_CONTROL_ROOT_INVALID");
    expect(() => parseJobHostGatewayArgs([...root, "--idle-exit-ms", "100"], {}, 10)).toThrow(
      "JOB_HOST_GATEWAY_SOCKET_MISSING",
    );
    expect(() =>
      parseJobHostGatewayArgs([...root, "--idle-exit-ms", "100", "--extra", "x"], {}, 10),
    ).toThrow("JOB_HOST_GATEWAY_ARGS_INVALID");
    expect(() =>
      parseJobHostGatewayArgs(
        [...root, "--idle-exit-ms", "100", "--socket", "/s"],
        {
          LISTEN_PID: "10",
          LISTEN_FDS: "1",
        },
        10,
      ),
    ).toThrow("JOB_HOST_GATEWAY_ARGS_INVALID");
    expect(
      parseJobHostGatewayArgs(
        [...root, "--idle-exit-ms", "100"],
        { LISTEN_PID: "10", LISTEN_FDS: "1" },
        10,
      ),
    ).toEqual({ idleExitMs: 100, controlRoot: "/r", listen: { fd: 3 } });
    expect(() =>
      parseJobHostGatewayArgs(
        [...root, "--idle-exit-ms", "100"],
        { LISTEN_PID: "11", LISTEN_FDS: "1" },
        10,
      ),
    ).toThrow("JOB_HOST_GATEWAY_SOCKET_MISSING");
    expect(
      parseJobHostGatewayArgs([...root, "--idle-exit-ms", "100", "--socket", "/s"], {}, 10),
    ).toEqual({
      idleExitMs: 100,
      controlRoot: "/r",
      listen: { path: "/s" },
    });
  });
});

describe("Job Host gateway process", () => {
  it("refuses an invalid launch and exits on its own once idle", async () => {
    const socketPath = path.join(await directory(), "gateway.sock");
    const gateway = spawn(
      process.execPath,
      [
        gatewayMain,
        "--socket",
        socketPath,
        "--idle-exit-ms",
        "300",
        "--control-root",
        path.dirname(socketPath),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    cleanups.push(() => {
      if (gateway.exitCode === null) gateway.kill("SIGKILL");
    });
    const exited = new Promise<number | null>((resolve) => gateway.once("exit", resolve));
    await until(() => existsSync(socketPath));
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    const transport = gatewayJobHostLauncher(socketPath)({ ...request(), policyDigest: "bad" });
    const seen = observe(transport);
    expect(await seen.closed).toEqual({ exitCode: null, signal: null });
    expect(seen.errored()).toBe(true);
    expect(await exited).toBe(0);
  });
  it.each(["symbolic link", "missing directory"] as const)(
    "refuses to start when the control root is a %s",
    async (kind) => {
      const parent = await realpath(await directory());
      const socketPath = path.join(parent, "gateway.sock");
      const target = path.join(parent, "target");
      const controlRoot = path.join(parent, "root");
      if (kind === "symbolic link") {
        await mkdir(target);
        await symlink(target, controlRoot);
      }
      const gateway = spawn(
        process.execPath,
        [
          gatewayMain,
          "--socket",
          socketPath,
          "--idle-exit-ms",
          "300",
          "--control-root",
          controlRoot,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      cleanups.push(() => {
        if (gateway.exitCode === null) gateway.kill("SIGKILL");
      });
      let stderr = "";
      gateway.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      expect(await new Promise((resolve) => gateway.once("exit", resolve))).toBe(1);
      expect(stderr).toContain("JOB_HOST_GATEWAY_CONTROL_ROOT_INVALID");
      expect(existsSync(socketPath)).toBe(false);
    },
  );
});

describe("Job Host gateway control", () => {
  const name = `control-${"0".repeat(20)}`;
  async function controlGateway() {
    const root = await realpath(await directory());
    const started = await startGateway(60000, [], root);
    return { ...started, root, access: gatewayJobHostControlAccess(started.socketPath) };
  }
  function binding(directoryPath: string): JobHostControlBinding {
    return {
      directory: directoryPath,
      token: "b".repeat(64),
      sessionId: randomUUID(),
      jobId: "job",
      attemptId: "attempt",
    };
  }
  function observation(control: JobHostControlBinding, phase: JobHostControlObservation["phase"]) {
    return {
      sessionId: control.sessionId,
      jobId: control.jobId,
      attemptId: control.attemptId,
      bootId: randomUUID(),
      processIdentityRef: `job-host-process:${randomUUID()}`,
      processId: process.pid,
      processStartedAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      sequence: 1,
      phase,
      policyDigest: "c".repeat(64),
      privateDirectoryRef: `sandbox-private:${"d".repeat(64)}`,
      linuxNamespace: null,
      taskStarted: true,
      taskProcessExited: false,
      stdioClosed: false,
      srtReset: false,
      resources: null,
      processStartToken: "start-token",
      taskProcessGroup: { processGroupId: process.pid, startToken: "group-token" },
    } satisfies JobHostControlObservation;
  }

  it("creates and describes control directories only inside its own control root", async () => {
    const { root, access } = await controlGateway();
    const prepared = await access.prepareDirectory(name);
    const metadata = await lstat(prepared.directory);
    expect(prepared).toEqual({
      directory: path.join(root, name),
      device: String(metadata.dev),
      inode: String(metadata.ino),
    });
    expect(metadata.mode & 0o777).toBe(0o700);
    expect(await access.describeDirectory(prepared.directory)).toEqual({
      canonical: true,
      directory: true,
      private: true,
      device: prepared.device,
      inode: prepared.inode,
    });
    await expect(access.prepareDirectory(name)).rejects.toMatchObject({ code: "EEXIST" });
    await expect(access.prepareDirectory("../control")).rejects.toThrow(
      "JOB_HOST_CONTROL_DIRECTORY_NAME_INVALID",
    );
    const elsewhere = path.join(await realpath(await directory()), name);
    await expect(access.describeDirectory(elsewhere)).rejects.toThrow(
      "JOB_HOST_GATEWAY_CONTROL_OUTSIDE_ROOT",
    );
    await expect(access.readFinalEvidence(binding(elsewhere))).rejects.toThrow(
      "JOB_HOST_GATEWAY_CONTROL_OUTSIDE_ROOT",
    );
    await expect(access.describeDirectory(`${prepared.directory}/`)).rejects.toThrow(
      "JOB_HOST_GATEWAY_CONTROL_OUTSIDE_ROOT",
    );
    await expect(
      access.blockLaunch(
        {
          plan: {} as JobHostLaunchContext["plan"],
          control: binding(elsewhere),
          policyDigest: "c".repeat(64),
          directoryDevice: prepared.device,
          directoryInode: prepared.inode,
        },
        new Date().toISOString(),
      ),
    ).rejects.toThrow("JOB_HOST_GATEWAY_CONTROL_OUTSIDE_ROOT");
    await expect(
      access.describeDirectory(path.join(root, `control-${"1".repeat(20)}`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("relays signed control answers and evidence that the caller verifies itself", async () => {
    const { access } = await controlGateway();
    const control = binding((await access.prepareDirectory(name)).directory);
    let phase: JobHostControlObservation["phase"] = "running";
    const stops: string[] = [];
    const server = await openJobHostControl(
      control,
      () => observation(control, phase),
      () => {
        stops.push("stop");
        phase = "stopping";
      },
    );
    await expect(access.readStartEvidence(control)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await access.query(control, "inspect")).toMatchObject({ phase: "running" });
    expect(await access.query(control, "stop")).toMatchObject({ phase: "stopping" });
    expect(stops).toEqual(["stop"]);
    await server.recordStart();
    expect(await access.readStartEvidence(control)).toEqual(
      await readJobHostStartEvidence(control),
    );
    phase = "finished";
    await server.finish();
    expect(await access.readFinalEvidence(control)).toMatchObject({ phase: "finished" });
    await expect(access.query(control, "inspect")).rejects.toThrow();
    await expect(access.readFinalEvidence({ ...control, token: "e".repeat(64) })).rejects.toThrow(
      "JOB_HOST_CONTROL_EVIDENCE_INVALID",
    );
    await writeFile(
      path.join(control.directory, "final.json"),
      JSON.stringify({
        body: JSON.stringify(observation(control, "finished")),
        signature: "f".repeat(64),
      }),
      { mode: 0o600 },
    );
    await expect(access.readFinalEvidence(control)).rejects.toThrow(
      "JOB_HOST_CONTROL_EVIDENCE_INVALID",
    );
  });

  it("lets the caller reject a forged control answer and never reports an unreachable gateway as missing evidence", async () => {
    const { access, root } = await controlGateway();
    const control = binding((await access.prepareDirectory(name)).directory);
    const forged = createServer((socket) => {
      socket.resume();
      socket.end(
        JSON.stringify({
          body: JSON.stringify(observation(control, "running")),
          signature: "f".repeat(64),
        }),
      );
    });
    await new Promise<void>((resolve) =>
      forged.listen(path.join(control.directory, "control.sock"), resolve),
    );
    cleanups.push(() => new Promise<void>((resolve) => forged.close(() => resolve())));
    await expect(access.query(control, "inspect")).rejects.toThrow(/^JOB_HOST_CONTROL_[A-Z_]+$/);
    const unreachable = gatewayJobHostControlAccess(path.join(root, "missing.sock"));
    const failure = await unreachable.readFinalEvidence(control).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("JOB_HOST_GATEWAY_UNAVAILABLE");
    expect(failure).not.toHaveProperty("code");
  });

  it("refuses a FIFO in place of evidence without blocking the gateway", async () => {
    const { access } = await controlGateway();
    const control = binding((await access.prepareDirectory(name)).directory);
    const fifo = spawn("mkfifo", ["-m", "600", path.join(control.directory, "final.json")]);
    expect(await new Promise((resolve) => fifo.once("exit", resolve))).toBe(0);
    await expect(access.readFinalEvidence(control)).rejects.toThrow(
      "JOB_HOST_CONTROL_EVIDENCE_INVALID",
    );
    await expect(access.describeDirectory(control.directory)).resolves.toMatchObject({
      directory: true,
    });
  });

  it("stops asking the Job Host when the caller gives up", async () => {
    const { access } = await controlGateway();
    const control = binding((await access.prepareDirectory(name)).directory);
    const connections = new Set<Socket>();
    let closed = 0;
    const stalled = createServer({ allowHalfOpen: true }, (socket) => {
      connections.add(socket);
      socket.resume();
      socket.on("error", () => {});
      socket.on("close", () => {
        connections.delete(socket);
        closed++;
      });
    });
    await new Promise<void>((resolve) =>
      stalled.listen(path.join(control.directory, "control.sock"), resolve),
    );
    cleanups.push(async () => {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => stalled.close(() => resolve()));
    });
    const aborted = new AbortController();
    const asked = access.query(control, "inspect", 30000, aborted.signal);
    await until(() => connections.size === 1);
    aborted.abort();
    await expect(asked).rejects.toThrow("JOB_HOST_CONTROL_ABORTED");
    await until(() => {
      for (const socket of connections) if (!socket.destroyed) socket.write("x");
      return closed === 1;
    }, 2000);
  });

  it("refuses control requests without a control root and a second frame on one connection", async () => {
    const { socketPath } = await startGateway();
    await expect(gatewayJobHostControlAccess(socketPath).prepareDirectory(name)).rejects.toThrow(
      "JOB_HOST_GATEWAY_CONTROL_UNAVAILABLE",
    );
    const { socketPath: rooted } = await controlGateway();
    const socket = connect(rooted);
    let received = "";
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString();
    });
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.write(
      `${JSON.stringify({ type: "control", op: "prepare", name })}\n${JSON.stringify({ type: "kill" })}\n`,
    );
    await closed;
    expect(received).toBe("");
  });
});
