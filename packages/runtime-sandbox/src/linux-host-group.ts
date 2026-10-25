import { readFile, readdir } from "node:fs/promises";
import process from "node:process";

export interface LinuxProcessIdentity {
  readonly processId: number;
  readonly parentProcessId: number;
  readonly processGroupId: number;
  readonly sessionId: number;
  readonly startToken: string;
  readonly state: string;
}

export async function readLinuxProcessIdentity(
  processId: number,
): Promise<LinuxProcessIdentity | null> {
  if (!Number.isSafeInteger(processId) || processId <= 1)
    throw new Error("JOB_HOST_GROUP_IDENTITY_CHANGED");
  let raw: string;
  try {
    raw = await readFile(`/proc/${processId}/stat`, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return null;
    throw error;
  }
  if (!raw.startsWith(`${processId} (`)) throw new Error("JOB_HOST_GROUP_IDENTITY_CHANGED");
  const fields = raw
    .slice(raw.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  if (
    ![fields[1], fields[2], fields[3], fields[19]].every((field) => /^\d+$/.test(field ?? "")) ||
    !fields[0]
  )
    throw new Error("JOB_HOST_GROUP_IDENTITY_CHANGED");
  return {
    processId,
    parentProcessId: Number(fields[1]),
    processGroupId: Number(fields[2]),
    sessionId: Number(fields[3]),
    startToken: fields[19] as string,
    state: fields[0],
  };
}

export async function assertLinuxProcessNamespace(): Promise<void> {
  const own = await readFile("/proc/self/stat", "utf8");
  if (!own.startsWith(`${process.pid} (`)) throw new Error("JOB_HOST_GROUP_IDENTITY_CHANGED");
}

export async function readLinuxHostGroup(processGroupId: number): Promise<LinuxProcessIdentity[]> {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1)
    throw new Error("JOB_HOST_GROUP_IDENTITY_CHANGED");
  await assertLinuxProcessNamespace();
  const names = (await readdir("/proc")).filter((name) => /^\d+$/.test(name) && Number(name) > 1);
  if (names.length > 16384) throw new Error("JOB_HOST_GROUP_OBSERVATION_UNAVAILABLE");
  const members: LinuxProcessIdentity[] = [];
  for (let offset = 0; offset < names.length; offset += 64) {
    const batch = await Promise.all(
      names.slice(offset, offset + 64).map(async (name) => {
        const before = await readLinuxProcessIdentity(Number(name));
        if (!before || before.processGroupId !== processGroupId) return null;
        const after = await readLinuxProcessIdentity(before.processId);
        if (!after) return null;
        if (
          after.startToken !== before.startToken ||
          after.processGroupId !== before.processGroupId ||
          after.sessionId !== before.sessionId
        )
          throw new Error("JOB_HOST_GROUP_IDENTITY_CHANGED");
        return after;
      }),
    );
    members.push(...batch.filter((member): member is LinuxProcessIdentity => member !== null));
  }
  return members;
}

export async function reclaimLinuxHostGroup(
  host: Pick<LinuxProcessIdentity, "processId" | "startToken">,
  guardian: Pick<LinuxProcessIdentity, "processId" | "startToken">,
  deadline: number,
): Promise<boolean> {
  if (performance.now() >= deadline) throw new Error("JOB_HOST_GUARDIAN_UNAVAILABLE");
  await assertLinuxProcessNamespace();
  const original = await readLinuxProcessIdentity(host.processId);
  const isOriginalZombie = (identity: LinuxProcessIdentity | null) =>
    identity !== null &&
    identity.startToken === host.startToken &&
    identity.state === "Z" &&
    identity.processGroupId === host.processId &&
    identity.sessionId === host.processId;
  if (original?.startToken === host.startToken && original.state !== "Z") return false;
  if ((original && !isOriginalZombie(original)) || guardian.processId !== process.pid)
    throw new Error("JOB_HOST_GROUP_IDENTITY_CHANGED");
  const members = await readLinuxHostGroup(host.processId);
  const own = members.find((member) => member.processId === guardian.processId);
  if (
    own?.startToken !== guardian.startToken ||
    members.some((member) => member.sessionId !== host.processId)
  )
    throw new Error("JOB_HOST_GROUP_IDENTITY_CHANGED");
  const [parent, current] = await Promise.all([
    readLinuxProcessIdentity(host.processId),
    readLinuxProcessIdentity(guardian.processId),
  ]);
  if (
    (parent && !isOriginalZombie(parent)) ||
    current?.startToken !== guardian.startToken ||
    current.processGroupId !== host.processId ||
    current.sessionId !== host.processId
  )
    throw new Error("JOB_HOST_GROUP_IDENTITY_CHANGED");
  if (performance.now() >= deadline) throw new Error("JOB_HOST_GUARDIAN_UNAVAILABLE");
  process.kill(0, "SIGKILL");
  return true;
}
