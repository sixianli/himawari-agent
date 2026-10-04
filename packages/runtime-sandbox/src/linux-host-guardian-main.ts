import process from "node:process";
import {
  assertLinuxProcessNamespace,
  readLinuxProcessIdentity,
  reclaimLinuxHostGroup,
} from "./linux-host-group.ts";

async function main() {
  const hostProcessId = Number(process.argv[2]);
  const hostStartToken = process.argv[3];
  const cleanupTimeoutMs = Number(process.argv[4]);
  if (
    process.platform !== "linux" ||
    !process.connected ||
    !hostStartToken ||
    !Number.isSafeInteger(cleanupTimeoutMs) ||
    cleanupTimeoutMs <= 0
  )
    throw new Error("JOB_HOST_GUARDIAN_UNAVAILABLE");
  await assertLinuxProcessNamespace();
  const [host, own] = await Promise.all([
    readLinuxProcessIdentity(hostProcessId),
    readLinuxProcessIdentity(process.pid),
  ]);
  if (
    host?.startToken !== hostStartToken ||
    host.processGroupId !== hostProcessId ||
    host.sessionId !== hostProcessId ||
    own?.parentProcessId !== hostProcessId ||
    own.processGroupId !== hostProcessId ||
    own.sessionId !== hostProcessId
  )
    throw new Error("JOB_HOST_GROUP_IDENTITY_CHANGED");
  process.on("disconnect", () => {
    void (async () => {
      const deadline = performance.now() + cleanupTimeoutMs;
      setTimeout(() => process.exit(1), cleanupTimeoutMs);
      for (;;) {
        if (await reclaimLinuxHostGroup(host, own, deadline)) return;
        if (performance.now() >= deadline) throw new Error("JOB_HOST_GUARDIAN_UNAVAILABLE");
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    })().catch(() => {
      process.stderr.write("JOB_HOST_GUARDIAN_UNAVAILABLE\n");
      process.exitCode = 1;
    });
  });
  process.send?.({
    type: "ready",
    processId: own.processId,
    startToken: own.startToken,
    hostStartToken,
  });
}
void main().catch(() => {
  process.stderr.write("JOB_HOST_GUARDIAN_UNAVAILABLE\n");
  process.exit(1);
});
