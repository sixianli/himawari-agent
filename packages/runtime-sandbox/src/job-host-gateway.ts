import type { ChildProcess } from "node:child_process";
import type { Server, Socket } from "node:net";
import path from "node:path";
import { answerJobHostControlFrame, jobHostControlFailure } from "./job-host-gateway-control.ts";
import { readGatewayFrames, writeGatewayFrame } from "./job-host-gateway-frames.ts";
import { forkJobHost } from "./job-host-messages.ts";
import { type JobHostRequest, parseJobHostRequest } from "./job-host-protocol.ts";

export interface JobHostGatewayOptions {
  readonly idleExitMs: number;
  readonly onIdle: () => void;
  readonly controlRoot?: string;
  readonly fork?: (request: JobHostRequest) => ChildProcess;
}

export interface JobHostGateway {
  readonly liveJobHosts: () => number;
  readonly openConnections: () => number;
}

function killGroup(child: ChildProcess): void {
  if (child.pid && child.exitCode === null && child.signalCode === null)
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
}

export function serveJobHostGateway(
  server: Server,
  options: JobHostGatewayOptions,
): JobHostGateway {
  if (!Number.isSafeInteger(options.idleExitMs) || options.idleExitMs <= 0)
    throw new Error("JOB_HOST_GATEWAY_IDLE_EXIT_INVALID");
  if (
    options.controlRoot !== undefined &&
    (!path.isAbsolute(options.controlRoot) ||
      path.resolve(options.controlRoot) !== options.controlRoot)
  )
    throw new Error("JOB_HOST_GATEWAY_CONTROL_ROOT_INVALID");
  const fork = options.fork ?? forkJobHost;
  const children = new Set<ChildProcess>();
  const connections = new Set<Socket>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const reconsider = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (children.size === 0 && connections.size === 0)
      idleTimer = setTimeout(() => {
        if (children.size === 0 && connections.size === 0) options.onIdle();
      }, options.idleExitMs);
  };
  const accept = (socket: Socket) => {
    connections.add(socket);
    reconsider();
    let child: ChildProcess | undefined;
    let cleanupTimeoutMs = 0;
    let launched = false;
    let controlling = false;
    const reject = () => {
      if (child) killGroup(child);
      socket.destroy();
    };
    const launch = (value: unknown) => {
      const refuse = () => {
        writeGatewayFrame(socket, { type: "error" });
        writeGatewayFrame(socket, { type: "close", exitCode: null, signal: null });
        socket.end();
      };
      let request: JobHostRequest;
      try {
        request = parseJobHostRequest(value);
      } catch {
        return refuse();
      }
      cleanupTimeoutMs = request.cleanupTimeoutMs;
      let started: ChildProcess;
      try {
        started = fork(request);
      } catch {
        return refuse();
      }
      child = started;
      children.add(started);
      reconsider();
      writeGatewayFrame(socket, { type: "started", pid: started.pid ?? null });
      started.on("message", (message: unknown) =>
        writeGatewayFrame(socket, { type: "message", message }),
      );
      started.stderr?.on("data", (chunk: Buffer | string) =>
        writeGatewayFrame(socket, {
          type: "stderr",
          data: Buffer.from(chunk).toString("base64"),
        }),
      );
      let finished = false;
      let exitStatus: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;
      let stderrDone = started.stderr === null;
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (finished) return;
        finished = true;
        children.delete(started);
        writeGatewayFrame(socket, { type: "close", exitCode, signal });
        socket.end();
        reconsider();
      };
      const finishAfterExit = () => {
        if (exitStatus && stderrDone) finish(exitStatus.exitCode, exitStatus.signal);
      };
      started.stderr?.once("close", () => {
        stderrDone = true;
        finishAfterExit();
      });
      started.once("disconnect", () => writeGatewayFrame(socket, { type: "disconnect" }));
      started.once("exit", (exitCode: number | null, signal: NodeJS.Signals | null) => {
        exitStatus = { exitCode, signal };
        writeGatewayFrame(socket, { type: "exit" });
        finishAfterExit();
      });
      started.once("error", () => writeGatewayFrame(socket, { type: "error" }));
      started.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) =>
        finish(exitCode, signal),
      );
    };
    const answerControl = (frame: Record<string, unknown>) => {
      const aborted = new AbortController();
      socket.once("close", () => aborted.abort());
      const root = options.controlRoot;
      void (
        root === undefined
          ? Promise.reject(new Error("JOB_HOST_GATEWAY_CONTROL_UNAVAILABLE"))
          : answerJobHostControlFrame(root, frame, aborted.signal)
      ).then(
        (value) => {
          writeGatewayFrame(socket, { ...value, type: "result", ok: true });
          socket.end();
        },
        (error: unknown) => {
          writeGatewayFrame(socket, jobHostControlFailure(error));
          socket.end();
        },
      );
    };
    readGatewayFrames(
      socket,
      (frame) => {
        if (!launched) {
          launched = true;
          if (frame["type"] === "control") {
            controlling = true;
            return answerControl(frame);
          }
          if (frame["type"] !== "launch") return reject();
          return launch(frame["request"]);
        }
        if (controlling) return reject();
        const current = child;
        if (!current) return;
        if (frame["type"] === "kill") return killGroup(current);
        if (frame["type"] !== "message") return reject();
        const message = frame["message"];
        if (!message || typeof message !== "object" || Array.isArray(message)) return reject();
        if (!current.connected) return;
        current.send(message, (error) => {
          if (error) killGroup(current);
        });
      },
      reject,
    );
    socket.on("error", () => {});
    socket.once("close", () => {
      connections.delete(socket);
      const current = child;
      const running = (target: ChildProcess) =>
        children.has(target) && target.exitCode === null && target.signalCode === null;
      if (current && running(current)) {
        if (current.connected) current.disconnect();
        const grace = setTimeout(() => {
          if (running(current)) killGroup(current);
        }, cleanupTimeoutMs);
        current.once("exit", () => clearTimeout(grace));
      }
      reconsider();
    });
  };
  server.on("connection", accept);
  reconsider();
  return Object.freeze({
    liveJobHosts: () => children.size,
    openConnections: () => connections.size,
  });
}

export function parseJobHostGatewayArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  pid: number,
): {
  readonly idleExitMs: number;
  readonly controlRoot: string;
  readonly listen: { fd: number } | { path: string };
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !["--idle-exit-ms", "--socket", "--control-root"].includes(String(key)) ||
      key === undefined ||
      value === undefined ||
      values.has(key)
    )
      throw new Error("JOB_HOST_GATEWAY_ARGS_INVALID");
    values.set(key, value);
  }
  const idle = values.get("--idle-exit-ms");
  if (idle === undefined || !/^[1-9][0-9]{0,8}$/.test(idle))
    throw new Error("JOB_HOST_GATEWAY_IDLE_EXIT_INVALID");
  const controlRoot = values.get("--control-root");
  if (
    controlRoot === undefined ||
    !path.isAbsolute(controlRoot) ||
    path.resolve(controlRoot) !== controlRoot
  )
    throw new Error("JOB_HOST_GATEWAY_CONTROL_ROOT_INVALID");
  const socket = values.get("--socket");
  const activated = env["LISTEN_PID"] === String(pid) && env["LISTEN_FDS"] === "1";
  if (socket !== undefined && activated) throw new Error("JOB_HOST_GATEWAY_ARGS_INVALID");
  if (socket === undefined && !activated) throw new Error("JOB_HOST_GATEWAY_SOCKET_MISSING");
  return Object.freeze({
    idleExitMs: Number(idle),
    controlRoot,
    listen: socket === undefined ? { fd: 3 } : { path: socket },
  });
}
