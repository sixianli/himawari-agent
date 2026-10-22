import { readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
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

export interface ResidentTaskEnvironmentSession {
  readonly kind: string;
  readonly jobId: string;
  readonly pid: number | null;
  readonly startToken: string | null;
  readonly residentProcessId: number | null;
  readonly residentStartToken: string | null;
  readonly commandGroups: readonly number[];
}

export interface ResidentTaskEnvironmentRecord {
  readonly environmentId: string;
  readonly runId: string;
  readonly executionJobId: string;
  readonly role: string | null;
  readonly destroyed: boolean;
  readonly stopRequested: boolean;
  readonly sessions: readonly ResidentTaskEnvironmentSession[];
}

const residentEnvironmentRoot = (stateRoot: string) =>
  path.join(stateRoot, "runtime", "srt-environments");

const readResidentSession = (
  kind: string,
  value: {
    readonly jobId?: unknown;
    readonly pid?: unknown;
    readonly startToken?: unknown;
    readonly residentGroup?: unknown;
    readonly residentStartToken?: unknown;
    readonly commandGroups?: unknown;
  },
): ResidentTaskEnvironmentSession => {
  if (typeof value.jobId !== "string" || !/^env-[a-f0-9]{20}$/.test(value.jobId))
    throw new Error(`PRODUCT_PATH_RESIDENT_SESSION_INVALID:${kind}`);
  const commandGroups = Array.isArray(value.commandGroups) ? value.commandGroups : [];
  if (commandGroups.some((group) => !Number.isSafeInteger(group) || group <= 1))
    throw new Error(`PRODUCT_PATH_RESIDENT_SESSION_COMMAND_GROUPS_INVALID:${kind}`);
  return {
    kind,
    jobId: value.jobId,
    pid: Number.isSafeInteger(value.pid) ? (value.pid as number) : null,
    startToken: typeof value.startToken === "string" ? value.startToken : null,
    residentProcessId: Number.isSafeInteger(value.residentGroup)
      ? (value.residentGroup as number)
      : null,
    residentStartToken:
      typeof value.residentStartToken === "string" ? value.residentStartToken : null,
    commandGroups: commandGroups as number[],
  };
};

export async function readResidentTaskEnvironments(
  stateRoot: string,
): Promise<ResidentTaskEnvironmentRecord[]> {
  const root = residentEnvironmentRoot(stateRoot);
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: ResidentTaskEnvironmentRecord[] = [];
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{32}$/.test(name)) continue;
    const file = path.join(root, name, "sessions.json");
    const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (text === null) continue;
    const state = JSON.parse(text) as {
      identity?: {
        environmentId?: unknown;
        runId?: unknown;
        executionJobId?: unknown;
        role?: unknown;
      };
      destroyed?: unknown;
      stop?: unknown;
      sessions?: Record<string, unknown>;
    };
    if (
      typeof state.identity?.environmentId !== "string" ||
      typeof state.identity.runId !== "string" ||
      typeof state.identity.executionJobId !== "string"
    )
      throw new Error(`PRODUCT_PATH_RESIDENT_STATE_INVALID:${file}`);
    records.push({
      environmentId: state.identity.environmentId,
      runId: state.identity.runId,
      executionJobId: state.identity.executionJobId,
      role: typeof state.identity.role === "string" ? state.identity.role : null,
      destroyed: state.destroyed === true,
      stopRequested: state.stop !== null && state.stop !== undefined,
      sessions: Object.entries(state.sessions ?? {}).map(([kind, value]) =>
        readResidentSession(kind, value as Record<string, unknown>),
      ),
    });
  }
  return records;
}

async function readResidentNamespace(input: {
  readonly hostPid: number;
  readonly hostStartToken: string;
  readonly residentPid: number;
  readonly residentStartToken: string;
  readonly stateRoot: string;
}) {
  if (process.platform !== "linux") throw new Error("PRODUCT_PATH_RESIDENT_NAMESPACE_LINUX_ONLY");
  const [host, residentStat] = await Promise.all([
    readLinuxProcessStat(input.hostPid),
    readLinuxProcessStat(input.residentPid),
  ]);
  if (!host || host.starttime !== input.hostStartToken)
    throw new Error(
      `PRODUCT_PATH_RESIDENT_HOST_IDENTITY_MISMATCH:${input.hostPid}:${residentEnvironmentRoot(input.stateRoot)}`,
    );
  if (!residentStat || residentStat.starttime !== input.residentStartToken)
    throw new Error(
      `PRODUCT_PATH_RESIDENT_RUNNER_IDENTITY_MISMATCH:${input.residentPid}:${residentEnvironmentRoot(input.stateRoot)}`,
    );
  let hostNamespace: string;
  try {
    hostNamespace = await readlink("/proc/self/ns/pid");
  } catch (error) {
    throw new Error(
      `PRODUCT_PATH_RESIDENT_HOST_NAMESPACE_UNREADABLE:${(error as NodeJS.ErrnoException).code ?? "UNKNOWN"}`,
    );
  }
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
  const resident = byPid.get(input.residentPid);
  if (!resident || resident.starttime !== input.residentStartToken)
    throw new Error(
      `PRODUCT_PATH_RESIDENT_RUNNER_IDENTITY_MISMATCH:${input.residentPid}:${residentEnvironmentRoot(input.stateRoot)}`,
    );
  if (resident.pidNamespace !== hostNamespace)
    throw new Error(
      `PRODUCT_PATH_RESIDENT_NAMESPACE_PRECONDITION_CHANGED:${input.residentPid}:${resident.pidNamespace ?? "unreadable"}:${hostNamespace}`,
    );
  const descends = (row: NonNullable<Awaited<ReturnType<typeof readLinuxProcess>>>) => {
    const seen = new Set<number>();
    let current: typeof row | undefined = row;
    while (current && !seen.has(current.pid)) {
      if (current.pid === input.residentPid) return true;
      seen.add(current.pid);
      current = byPid.get(current.parentPid);
    }
    return false;
  };
  const candidates = rows.filter(
    (row) =>
      row.pidNamespace !== null &&
      row.pidNamespace !== hostNamespace &&
      row.namespacePids !== null &&
      row.namespacePids.at(-1) === 1 &&
      /^\d+$/.test(row.starttime) &&
      descends(row),
  );
  if (candidates.length === 0)
    throw new Error(
      `PRODUCT_PATH_RESIDENT_NAMESPACE_INIT_MISSING:${input.residentPid}:${residentEnvironmentRoot(input.stateRoot)}`,
    );
  const deepest = Math.max(...candidates.map((row) => row.namespacePids?.length ?? 0));
  const innermost = candidates.filter((row) => row.namespacePids?.length === deepest);
  if (innermost.length !== 1)
    throw new Error(
      `PRODUCT_PATH_RESIDENT_NAMESPACE_INIT_AMBIGUOUS:${innermost
        .map((row) => `${row.pid}:${row.pidNamespace}:${row.namespacePids?.join("/") ?? "-"}`)
        .join(",")}`,
    );
  const init = innermost[0];
  if (!init?.pidNamespace)
    throw new Error(`PRODUCT_PATH_RESIDENT_NAMESPACE_INIT_MISSING:${input.residentPid}`);
  return { namespaceId: init.pidNamespace, initPid: init.pid, initStartTicks: init.starttime };
}

export async function readResidentJobHostStart(options: {
  readonly stateRoot: string;
  readonly runId: string;
  readonly kind?: "command" | "file_write";
  readonly group: "command" | "resident";
}): Promise<ProductPathJobHostStart> {
  const kind = options.kind ?? "command";
  const environments = (await readResidentTaskEnvironments(options.stateRoot)).filter(
    (environment) => environment.runId === options.runId,
  );
  if (environments.length !== 1)
    throw new Error(
      `PRODUCT_PATH_RESIDENT_ENVIRONMENT_NOT_UNIQUE:${options.runId}:${environments.length}:${residentEnvironmentRoot(options.stateRoot)}`,
    );
  const environment = environments[0];
  if (!environment) throw new Error(`PRODUCT_PATH_RESIDENT_ENVIRONMENT_MISSING:${options.runId}`);
  const session = environment.sessions.find((candidate) => candidate.kind === kind);
  if (!session) throw new Error(`PRODUCT_PATH_RESIDENT_SESSION_MISSING:${options.runId}:${kind}`);
  const { pid, startToken, residentProcessId, residentStartToken } = session;
  if (
    pid === null ||
    startToken === null ||
    residentProcessId === null ||
    residentStartToken === null
  )
    throw new Error(
      `PRODUCT_PATH_RESIDENT_HOST_IDENTITY_INCOMPLETE:${options.runId}:${kind}:${residentEnvironmentRoot(options.stateRoot)}`,
    );
  const groupId: number = (() => {
    if (options.group === "resident") return residentProcessId;
    if (session.commandGroups.length !== 1)
      throw new Error(
        `PRODUCT_PATH_RESIDENT_COMMAND_GROUP_NOT_UNIQUE:${options.runId}:${kind}:${session.commandGroups.length}:${residentEnvironmentRoot(options.stateRoot)}`,
      );
    return session.commandGroups[0] as number;
  })();
  const groupStartToken = await (async () => {
    if (options.group === "resident") return residentStartToken;
    const group = await readLinuxProcessStat(groupId);
    if (!group)
      throw new Error(
        `PRODUCT_PATH_RESIDENT_COMMAND_GROUP_IDENTITY_MISSING:${groupId}:${residentEnvironmentRoot(options.stateRoot)}`,
      );
    return group.starttime;
  })();
  const linuxNamespace = await readResidentNamespace({
    hostPid: pid,
    hostStartToken: startToken,
    residentPid: residentProcessId,
    residentStartToken,
    stateRoot: options.stateRoot,
  });
  return {
    jobId: session.jobId,
    processId: pid,
    processStartToken: startToken,
    taskProcessGroup: { processGroupId: groupId, startToken: groupStartToken },
    linuxNamespace,
  };
}
