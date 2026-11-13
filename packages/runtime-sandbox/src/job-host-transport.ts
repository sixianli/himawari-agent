import type { ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { readGatewayFrames, writeGatewayFrame } from "./job-host-gateway-frames.ts";
import { forkJobHost } from "./job-host-messages.ts";
import type { JobHostRequest } from "./job-host-protocol.ts";

export interface JobHostTransport {
  readonly pid: number | undefined;
  readonly spawned: Promise<number | undefined>;
  readonly connected: boolean;
  send(message: Record<string, unknown>, onSendFailure: () => void): void;
  onMessage(listener: (value: unknown) => void): void;
  onStderr(listener: (chunk: Buffer | string) => void): void;
  onceExit(listener: () => void): void;
  onceError(listener: () => void): void;
  onceClose(listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): void;
  killGroup(): void;
}

export type JobHostLauncher = (request: JobHostRequest) => JobHostTransport;

export function localJobHostTransport(child: ChildProcess): JobHostTransport {
  return Object.freeze({
    get pid() {
      return child.pid;
    },
    spawned: Promise.resolve(child.pid),
    get connected() {
      return child.connected;
    },
    send(message: Record<string, unknown>, onSendFailure: () => void) {
      child.send(message, (error) => {
        if (error) onSendFailure();
      });
    },
    onMessage(listener: (value: unknown) => void) {
      child.on("message", listener);
    },
    onStderr(listener: (chunk: Buffer | string) => void) {
      child.stderr?.on("data", listener);
    },
    onceExit(listener: () => void) {
      child.once("exit", listener);
    },
    onceError(listener: () => void) {
      child.once("error", listener);
    },
    onceClose(listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void) {
      child.once("close", listener);
    },
    killGroup() {
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
    },
  });
}

export const forkLocalJobHost: JobHostLauncher = (request) =>
  localJobHostTransport(forkJobHost(request));

export function gatewayJobHostLauncher(socketPath: string): JobHostLauncher {
  return (request) => {
    const socket = connect(socketPath);
    const messageListeners: Array<(value: unknown) => void> = [];
    const stderrListeners: Array<(chunk: Buffer | string) => void> = [];
    const exitListeners: Array<() => void> = [];
    const errorListeners: Array<() => void> = [];
    const closeListeners: Array<(exitCode: number | null, signal: NodeJS.Signals | null) => void> =
      [];
    let pid: number | undefined;
    let resolveSpawned!: (value: number | undefined) => void;
    const spawned = new Promise<number | undefined>((resolve) => {
      resolveSpawned = resolve;
    });
    let open = true;
    let exited = false;
    let errored = false;
    let closed = false;
    const exit = () => {
      if (exited) return;
      exited = true;
      for (const listener of exitListeners.splice(0)) listener();
    };
    const fail = () => {
      if (errored) return;
      errored = true;
      for (const listener of errorListeners.splice(0)) listener();
    };
    const close = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (closed) return;
      closed = true;
      open = false;
      resolveSpawned(pid);
      exit();
      for (const listener of closeListeners.splice(0)) listener(exitCode, signal);
      socket.destroy();
    };
    readGatewayFrames(
      socket,
      (frame) => {
        if (closed) return;
        const type = frame["type"];
        if (type === "started") {
          const value = frame["pid"];
          pid =
            Number.isSafeInteger(value) && (value as number) > 1 ? (value as number) : undefined;
          resolveSpawned(pid);
        } else if (type === "message") {
          for (const listener of messageListeners) listener(frame["message"]);
        } else if (type === "stderr" && typeof frame["data"] === "string") {
          const chunk = Buffer.from(frame["data"], "base64");
          for (const listener of stderrListeners) listener(chunk);
        } else if (type === "exit") {
          open = false;
          exit();
        } else if (type === "error") {
          fail();
        } else if (type === "close") {
          const exitCode = Number.isSafeInteger(frame["exitCode"])
            ? (frame["exitCode"] as number)
            : null;
          const signal =
            typeof frame["signal"] === "string" ? (frame["signal"] as NodeJS.Signals) : null;
          close(exitCode, signal);
        } else {
          fail();
          close(null, null);
        }
      },
      () => {
        fail();
        close(null, null);
      },
    );
    socket.on("error", () => {
      if (pid === undefined) fail();
    });
    socket.once("close", () => close(null, null));
    writeGatewayFrame(socket, { type: "launch", request });
    return Object.freeze({
      get pid() {
        return pid;
      },
      spawned,
      get connected() {
        return open && !socket.destroyed;
      },
      send(message: Record<string, unknown>, onSendFailure: () => void) {
        writeGatewayFrame(socket, { type: "message", message }, onSendFailure);
      },
      onMessage(listener: (value: unknown) => void) {
        messageListeners.push(listener);
      },
      onStderr(listener: (chunk: Buffer | string) => void) {
        stderrListeners.push(listener);
      },
      onceExit(listener: () => void) {
        if (exited) return;
        exitListeners.push(listener);
      },
      onceError(listener: () => void) {
        if (errored) return;
        errorListeners.push(listener);
      },
      onceClose(listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void) {
        if (closed) return;
        closeListeners.push(listener);
      },
      killGroup() {
        if (!closed) writeGatewayFrame(socket, { type: "kill" });
      },
    });
  };
}
