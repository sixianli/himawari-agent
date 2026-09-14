import { lstat, readdir, readFile, readlink } from "node:fs/promises";

/** Identity of PID 1 in the innermost task namespace, captured before user code.
 * Kernel termination of namespace PID 1 kills the remaining namespace members. */
export interface LinuxNamespaceIdentity {
  readonly namespaceId: string;
  readonly initPid: number;
  readonly initStartTicks: string;
}
interface ProcessIdentity {
  pid: number;
  parent: number;
  start: string;
  namespaceId: string;
  innerPid: number;
}
async function readProcess(pid: number): Promise<ProcessIdentity> {
  const root = `/proc/${pid}`;
  if ((await lstat(root)).uid !== process.getuid?.()) throw new Error("NAMESPACE_OWNER_CHANGED");
  const stat = await readFile(`${root}/stat`, "utf8");
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  const status = await readFile(`${root}/status`, "utf8");
  const pids = /^NSpid:\s+([\d\t ]+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number);
  const namespaceId = await readlink(`${root}/ns/pid`);
  const after = await readFile(`${root}/stat`, "utf8");
  if (
    stat.slice(0, stat.lastIndexOf(")") + 1) !== after.slice(0, after.lastIndexOf(")") + 1) ||
    fields[19] !==
      after
        .slice(after.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/)[19] ||
    !fields[19] ||
    !/^\d+$/.test(fields[19]) ||
    !pids?.length ||
    !/^pid:\[\d+\]$/.test(namespaceId)
  )
    throw new Error("NAMESPACE_PROCESS_CHANGED");
  return {
    pid,
    parent: Number(fields[1]),
    start: fields[19],
    namespaceId,
    innerPid: pids.at(-1) ?? -1,
  };
}
export async function captureLinuxNamespace(
  rootPid: number,
  innerPid: number,
  namespaceId: string,
): Promise<LinuxNamespaceIdentity> {
  if (
    process.platform !== "linux" ||
    !Number.isSafeInteger(rootPid) ||
    rootPid <= 1 ||
    !Number.isSafeInteger(innerPid) ||
    innerPid < 1 ||
    !/^pid:\[\d+\]$/.test(namespaceId)
  )
    throw new Error("NAMESPACE_CAPTURE_INVALID");
  const hostNamespace = await readlink("/proc/self/ns/pid");
  const names = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  if (names.length > 16384) throw new Error("NAMESPACE_CAPTURE_CAPACITY");
  const processes: ProcessIdentity[] = [];
  // Bounded batches avoid exhausting file descriptors on busy hosts.
  for (let offset = 0; offset < names.length; offset += 64) {
    const batch = await Promise.all(
      names.slice(offset, offset + 64).map(async (name) => {
        try {
          return await readProcess(Number(name));
        } catch {
          return null;
        }
      }),
    );
    processes.push(...batch.filter((item): item is ProcessIdentity => item !== null));
  }
  const byPid = new Map(processes.map((item) => [item.pid, item]));
  const descends = (item: ProcessIdentity) => {
    const seen = new Set<number>();
    let current: ProcessIdentity | undefined = item;
    while (current && !seen.has(current.pid)) {
      if (current.pid === rootPid) return true;
      seen.add(current.pid);
      current = byPid.get(current.parent);
    }
    return false;
  };
  const candidates = processes.filter(
    (item) =>
      item.innerPid === innerPid &&
      item.namespaceId === namespaceId &&
      item.namespaceId !== hostNamespace &&
      descends(item),
  );
  const namespaces = new Set(candidates.map((item) => item.namespaceId));
  if (namespaces.size !== 1) throw new Error("NAMESPACE_CAPTURE_AMBIGUOUS");
  const init = processes.find(
    (item) => namespaces.has(item.namespaceId) && item.innerPid === 1 && descends(item),
  );
  if (!init) throw new Error("NAMESPACE_INIT_UNAVAILABLE");
  const proof = { namespaceId: init.namespaceId, initPid: init.pid, initStartTicks: init.start };
  if ((await readLinuxNamespaceState(proof)) !== "alive") throw new Error("NAMESPACE_INIT_CHANGED");
  return Object.freeze(proof);
}
/** Read-only: never signal a recycled PID. A different birth marker proves the
 * old namespace init exited; same-birth inconsistent namespace remains unknown. */
export async function readLinuxNamespaceState(
  identity: LinuxNamespaceIdentity,
): Promise<"alive" | "released" | "unknown"> {
  if (
    process.platform !== "linux" ||
    !/^pid:\[\d+\]$/.test(identity.namespaceId) ||
    !Number.isSafeInteger(identity.initPid) ||
    identity.initPid <= 1 ||
    !/^\d+$/.test(identity.initStartTicks)
  )
    return "unknown";
  try {
    const current = await readProcess(identity.initPid);
    if (current.start !== identity.initStartTicks) return "released";
    return current.innerPid === 1 && current.namespaceId === identity.namespaceId
      ? "alive"
      : "unknown";
  } catch (error) {
    return error && typeof error === "object" && "code" in error && error.code === "ENOENT"
      ? "released"
      : "unknown";
  }
}
