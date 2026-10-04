import { readFile, readdir, readlink } from "node:fs/promises";
import type { JobHostControlObservation } from "@himawari-agent/runtime-sandbox/control";

export type ProductPathJobHostStart = Pick<
  JobHostControlObservation,
  "jobId" | "processId" | "processStartToken" | "linuxNamespace"
> & { taskProcessGroup: NonNullable<JobHostControlObservation["taskProcessGroup"]> };

async function readLinuxProcessStat(pid: number) {
  let rawStat: string;
  try {
    rawStat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
  const fields = rawStat
    .slice(rawStat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  if (![fields[1], fields[2], fields[3], fields[19]].every((field) => /^\d+$/.test(field ?? "")))
    throw new Error("PRODUCT_PATH_PROCESS_STAT_INVALID");
  return {
    pid,
    parentPid: Number(fields[1]),
    processGroupId: Number(fields[2]),
    sessionId: Number(fields[3]),
    state: fields[0],
    starttime: fields[19] as string,
    rawStat,
  };
}

export async function linuxProcessIdentityPresent(identity: { pid: number; starttime: string }) {
  return (await readLinuxProcessStat(identity.pid))?.starttime === identity.starttime;
}

export async function readLinuxHostProcessGroup(host: ProductPathJobHostStart) {
  if (process.platform !== "linux" || !host.processStartToken)
    throw new Error("PRODUCT_PATH_LINUX_HOST_IDENTITY_MISSING");
  const names = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  if (names.length > 16384) throw new Error("PRODUCT_PATH_PROCESS_SCAN_CAPACITY");
  const members: Array<NonNullable<Awaited<ReturnType<typeof readLinuxProcess>>>> = [];
  for (let offset = 0; offset < names.length; offset += 64) {
    const rows = await Promise.all(
      names.slice(offset, offset + 64).map(async (name) => {
        const stat = await readLinuxProcessStat(Number(name));
        if (stat?.processGroupId !== host.processId) return null;
        return readLinuxProcess(stat.pid);
      }),
    );
    members.push(...rows.filter((row): row is NonNullable<typeof row> => row !== null));
  }
  const hostStat = await readLinuxProcessStat(host.processId);
  return {
    observedAt: new Date().toISOString(),
    recordedHost: host,
    recordedHostPresent: hostStat?.starttime === host.processStartToken,
    hostStat,
    members,
  };
}

async function readLinuxProcess(pid: number) {
  const before = await readLinuxProcessStat(pid);
  if (!before) return null;
  let pidNamespace: string | null = null;
  let namespaceReadError: string | null = null;
  try {
    pidNamespace = await readlink(`/proc/${pid}/ns/pid`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(code)) throw error;
    namespaceReadError = code;
  }
  const status = await readFile(`/proc/${pid}/status`, "utf8").catch((error) => {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  });
  const after = await readLinuxProcessStat(pid);
  if (!after || status === null) return null;
  const namespacePids = /^NSpid:\s+([\d\t ]+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number);
  return {
    ...before,
    pidNamespace,
    namespaceReadError,
    namespacePids: namespacePids ?? null,
    stable:
      before.starttime === after.starttime &&
      before.parentPid === after.parentPid &&
      before.processGroupId === after.processGroupId &&
      before.sessionId === after.sessionId,
    rawStatAfter: after.rawStat,
  };
}

export async function readLinuxJobProcesses(host: ProductPathJobHostStart) {
  if (process.platform !== "linux" || !host.linuxNamespace || !host.processStartToken)
    throw new Error("PRODUCT_PATH_LINUX_HOST_IDENTITY_MISSING");
  const namespace = host.linuxNamespace;
  const names = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  if (names.length > 16384) throw new Error("PRODUCT_PATH_PROCESS_SCAN_CAPACITY");
  const rows: Array<NonNullable<Awaited<ReturnType<typeof readLinuxProcess>>>> = [];
  for (let offset = 0; offset < names.length; offset += 64) {
    const batch = await Promise.all(
      names.slice(offset, offset + 64).map((name) => readLinuxProcess(Number(name))),
    );
    rows.push(...batch.filter((row): row is NonNullable<typeof row> => row !== null));
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const hostRow = byPid.get(host.processId);
  const recordedHostPresent =
    hostRow?.stable === true && hostRow.starttime === host.processStartToken;
  const ancestorChain = (row: (typeof rows)[number]) => {
    const seen = new Set<number>();
    const chain: (typeof rows)[number][] = [];
    let current: (typeof rows)[number] | undefined = row;
    while (current?.stable && !seen.has(current.pid)) {
      chain.push(current);
      if (current.pid === host.processId) return recordedHostPresent ? chain : null;
      seen.add(current.pid);
      current = byPid.get(current.parentPid);
    }
    return null;
  };
  const relevant = rows.filter(
    (row) => ancestorChain(row) !== null || row.pidNamespace === namespace.namespaceId,
  );
  const processes = await Promise.all(
    relevant.map(async (row) => {
      const rawArgv = await readFile(`/proc/${row.pid}/cmdline`).catch((error) => {
        if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
        throw error;
      });
      const chain = ancestorChain(row);
      const chainChecks = await Promise.all(
        (chain ?? []).map(async (ancestor) => {
          const current = await readLinuxProcessStat(ancestor.pid);
          return (
            current?.starttime === ancestor.starttime && current.parentPid === ancestor.parentPid
          );
        }),
      );
      const current = await readLinuxProcessStat(row.pid);
      return {
        ...row,
        argv:
          rawArgv === null
            ? null
            : rawArgv
                .toString()
                .split("\0")
                .filter((argument, index, values) => index < values.length - 1 || argument !== ""),
        stable: row.stable && current?.starttime === row.starttime,
        descendantOfRecordedHost:
          chain !== null && chainChecks.every(Boolean) && row.pid !== host.processId,
        ancestorIdentities: chain?.map(({ pid, starttime }) => ({ pid, starttime })) ?? [],
      };
    }),
  );
  const namespaceInitStat = await readLinuxProcessStat(namespace.initPid);
  return {
    observedAt: new Date().toISOString(),
    recordedHost: host,
    recordedHostPresent,
    processes,
    unreadableNamespaces: rows
      .filter((row) => row.namespaceReadError !== null)
      .map(({ pid, starttime, namespaceReadError }) => ({
        pid,
        starttime,
        error: namespaceReadError,
      })),
    namespaceMembers: processes.filter((row) => row.pidNamespace === namespace.namespaceId),
    namespaceInitStat,
    namespaceInitIdentityPresent: namespaceInitStat?.starttime === namespace.initStartTicks,
  };
}
