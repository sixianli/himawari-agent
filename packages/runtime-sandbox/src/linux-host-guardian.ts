import { fork } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertLinuxProcessNamespace, readLinuxProcessIdentity } from "./linux-host-group.ts";

export async function startLinuxHostGuardian(
  cleanupTimeoutMs: number,
  failed: () => void,
): Promise<void> {
  await assertLinuxProcessNamespace();
  const host = await readLinuxProcessIdentity(process.pid);
  if (
    process.platform !== "linux" ||
    host?.processGroupId !== process.pid ||
    host.sessionId !== process.pid
  )
    throw new Error("JOB_HOST_GROUP_IDENTITY_CHANGED");
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const child = fork(
    fileURLToPath(new URL(`./linux-host-guardian-main.${extension}`, import.meta.url)),
    [String(host.processId), host.startToken, String(cleanupTimeoutMs)],
    {
      execArgv: [],
      detached: false,
      env: process.env,
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    const unavailable = () => {
      if (ready) failed();
      else reject(new Error("JOB_HOST_GUARDIAN_UNAVAILABLE"));
    };
    child.once("error", unavailable);
    child.once("exit", unavailable);
    child.once("message", (value: unknown) => {
      void (async () => {
        const message = value as Record<string, unknown> | null;
        const own = child.pid === undefined ? null : await readLinuxProcessIdentity(child.pid);
        if (
          !message ||
          message["type"] !== "ready" ||
          message["hostStartToken"] !== host.startToken ||
          message["processId"] !== child.pid ||
          message["startToken"] !== own?.startToken ||
          own?.parentProcessId !== host.processId ||
          own.processGroupId !== host.processId ||
          own.sessionId !== host.processId
        )
          throw new Error("JOB_HOST_GROUP_IDENTITY_CHANGED");
        ready = true;
        child.unref();
        child.channel?.unref();
        resolve();
      })().catch(reject);
    });
  });
}
