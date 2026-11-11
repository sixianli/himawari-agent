import type { ChildProcess } from "node:child_process";
import { forkJobHost } from "./job-host-messages.ts";
import type { JobHostRequest } from "./job-host-protocol.ts";

export interface JobHostTransport {
  readonly pid: number | undefined;
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
