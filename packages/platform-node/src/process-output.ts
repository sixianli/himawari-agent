import type { ChildProcess } from "node:child_process";

export function waitForProcessOutput(
  child: ChildProcess,
  interruption?: AbortSignal,
): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  outputOpen: boolean;
}> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;
    const cleanup = () => {
      clearTimeout(idleTimer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("close", onClose);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.stdout?.off("end", onStdoutEnd);
      child.stderr?.off("end", onStderrEnd);
      interruption?.removeEventListener("abort", onInterruption);
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const finish = (outputOpen: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode, signal, outputOpen });
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = () => {
      if (!exited || settled) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(true), 100);
    };
    const finishEndedOutput = () => {
      if (exited && stdoutEnded && stderrEnded) finish(false);
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      finishEndedOutput();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      finishEndedOutput();
    };
    const onInterruption = () => {
      if (exited) finish(false);
    };
    const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) => {
      exited = true;
      exitCode = code;
      signal = exitSignal;
      if (interruption?.aborted) finish(false);
      else {
        finishEndedOutput();
        onData();
      }
    };
    const onClose = (code: number | null, exitSignal: NodeJS.Signals | null) => {
      exitCode = code;
      signal = exitSignal;
      finish(false);
    };
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    interruption?.addEventListener("abort", onInterruption, { once: true });
  });
}
