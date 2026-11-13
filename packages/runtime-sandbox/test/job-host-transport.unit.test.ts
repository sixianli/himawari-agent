import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareSandboxJobHost } from "../src/job-host.ts";
import type { JobHostRequest } from "../src/job-host-protocol.ts";
import { prepareSandboxJobSession } from "../src/job-host-session.ts";
import {
  gatewayJobHostLauncher,
  type JobHostTransport,
  localJobHostTransport,
} from "../src/job-host-transport.ts";

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

function fakeTransport(pid: number | undefined, sendFails = false) {
  const listeners = {
    message: [] as Array<(value: unknown) => void>,
    close: [] as Array<(exitCode: number | null, signal: NodeJS.Signals | null) => void>,
    exit: [] as Array<() => void>,
  };
  const sent: Array<Record<string, unknown>> = [];
  const killGroup = vi.fn();
  const transport: JobHostTransport = {
    pid,
    spawned: Promise.resolve(pid),
    connected: true,
    send: (message, onSendFailure) => {
      sent.push(message);
      if (sendFails) onSendFailure();
    },
    onMessage: (listener) => listeners.message.push(listener),
    onStderr: () => {},
    onceExit: (listener) => listeners.exit.push(listener),
    onceError: () => {},
    onceClose: (listener) => listeners.close.push(listener),
    killGroup,
  };
  let sequence = 0;
  return {
    transport,
    sent,
    killGroup,
    emit(message: Record<string, unknown>, processId = pid) {
      for (const listener of listeners.message)
        listener({
          protocolVersion: "job-host.v2",
          sessionId: sent[0]?.["sessionId"],
          bootId: "11111111-1111-1111-1111-111111111111",
          processId,
          processIdentityRef: "job-host-process:11111111-1111-1111-1111-111111111111",
          processStartedAt: new Date().toISOString(),
          observedAt: new Date().toISOString(),
          sequence: ++sequence,
          ...message,
        });
    },
    close() {
      for (const listener of listeners.close) listener(0, null);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Job Host transport", () => {
  it("runs the Job Host protocol over an injected transport without forking", async () => {
    const remote = fakeTransport(4242);
    const host = prepareSandboxJobHost(
      request(),
      undefined,
      undefined,
      undefined,
      () => remote.transport,
    );
    expect(remote.sent[0]).toMatchObject({ type: "prepare" });
    remote.emit({
      type: "ready",
      jobId: "job",
      attemptId: "attempt",
      policyDigest: "a".repeat(64),
    });
    await host.ready;
    expect(host.inspect()).toMatchObject({ processId: 4242, state: "alive" });
    remote.close();
    expect(await host.result).toMatchObject({ jobId: "job" });
  });

  it("kills through the transport and never signals a process group directly", async () => {
    vi.useFakeTimers();
    const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
    const remote = fakeTransport(4242);
    const host = prepareSandboxJobHost(
      request(),
      undefined,
      undefined,
      undefined,
      () => remote.transport,
    );
    remote.emit({
      type: "ready",
      jobId: "job",
      attemptId: "attempt",
      policyDigest: "a".repeat(64),
    });
    await host.ready;
    host.cancel();
    expect(remote.sent.at(-1)).toMatchObject({ type: "cancel" });
    await vi.advanceTimersByTimeAsync(50);
    expect(remote.killGroup).toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
    remote.close();
    await host.result;
  });

  it("rejects an envelope whose process id is not the transport's", async () => {
    vi.useFakeTimers();
    const remote = fakeTransport(4242);
    const host = prepareSandboxJobHost(
      request(),
      undefined,
      undefined,
      undefined,
      () => remote.transport,
    );
    remote.emit(
      { type: "ready", jobId: "job", attemptId: "attempt", policyDigest: "a".repeat(64) },
      9999,
    );
    expect(remote.sent.at(-1)).toMatchObject({ type: "cancel", reason: "host_failure" });
    await vi.advanceTimersByTimeAsync(50);
    expect(remote.killGroup).toHaveBeenCalled();
    remote.close();
    await host.result;
  });

  it("runs a session over an injected transport and kills through it", async () => {
    vi.useFakeTimers();
    const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
    const remote = fakeTransport(4242);
    const session = prepareSandboxJobSession(request(), () => remote.transport);
    expect(remote.sent[0]).toMatchObject({ type: "prepare", session: true });
    expect(session.pid).toBe(4242);
    expect(await session.spawned).toBe(4242);
    session.close();
    await vi.advanceTimersByTimeAsync(50);
    expect(remote.killGroup).toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
    remote.close();
    await session.result;
  });

  it("kills through the transport when a message cannot be delivered", async () => {
    const remote = fakeTransport(4242, true);
    const host = prepareSandboxJobHost(
      request(),
      undefined,
      undefined,
      undefined,
      () => remote.transport,
    );
    expect(remote.sent[0]).toMatchObject({ type: "prepare" });
    expect(remote.killGroup).toHaveBeenCalled();
    remote.close();
    await host.result;
  });
});

describe("local Job Host transport", () => {
  function localChild(pid: number | undefined, sendError: Error | null = null) {
    const child = Object.assign(new EventEmitter(), {
      pid,
      connected: true,
      stderr: new PassThrough(),
      send: vi.fn((_message: unknown, callback: (error: Error | null) => void) =>
        callback(sendError),
      ),
    });
    return child;
  }

  it("signals the whole process group of the Job Host with SIGKILL", () => {
    const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
    localJobHostTransport(localChild(4242) as unknown as ChildProcess).killGroup();
    expect(signal).toHaveBeenCalledWith(-4242, "SIGKILL");
  });

  it("does not signal when the Job Host has no process id", () => {
    const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
    localJobHostTransport(localChild(undefined) as unknown as ChildProcess).killGroup();
    expect(signal).not.toHaveBeenCalled();
  });

  it("reports a failed send and stays silent on a delivered one", () => {
    const failed = vi.fn();
    localJobHostTransport(localChild(4242, new Error("closed")) as unknown as ChildProcess).send(
      { type: "prepare" },
      failed,
    );
    expect(failed).toHaveBeenCalledTimes(1);
    const delivered = vi.fn();
    localJobHostTransport(localChild(4242) as unknown as ChildProcess).send(
      { type: "prepare" },
      delivered,
    );
    expect(delivered).not.toHaveBeenCalled();
  });

  it("reports the forked process id as already spawned", async () => {
    expect(await localJobHostTransport(localChild(4242) as unknown as ChildProcess).spawned).toBe(
      4242,
    );
  });
});

describe("gateway Job Host transport", () => {
  it("gives up when the gateway relays a message before reporting a started Job Host", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hjt-"));
    const early = createServer((socket) => {
      socket.write(`${JSON.stringify({ type: "message", message: { type: "ready" } })}\n`);
    });
    await new Promise<void>((resolve) => early.listen(path.join(directory, "g.sock"), resolve));
    const transport = gatewayJobHostLauncher(path.join(directory, "g.sock"), 60000)(request());
    const messages: unknown[] = [];
    transport.onMessage((value) => messages.push(value));
    const closed = new Promise((resolve) => transport.onceClose(() => resolve(true)));
    expect(await closed).toBe(true);
    expect(messages).toEqual([]);
    early.close();
    await rm(directory, { recursive: true, force: true });
  });
});
