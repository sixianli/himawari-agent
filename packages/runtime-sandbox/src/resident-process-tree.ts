import { readdir, readFile } from "node:fs/promises";

export interface TreeProcess {
  readonly pid: number;
  readonly parent: number;
  readonly start: string;
}
export type ResidentInfrastructure = ReadonlyMap<number, string>;
export interface ResidentSweep {
  readonly commandTreeGone: boolean;
  readonly infrastructureIntact: boolean;
}

const errorCode = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? error.code : undefined;

async function readTreeProcess(pid: number): Promise<TreeProcess | null> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ESRCH") return null;
    throw new Error("RESIDENT_PROCESS_TABLE_UNAVAILABLE", { cause: error });
  }
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (fields[0] === "Z" || fields[0] === "X") return null;
  const parent = Number(fields[1]);
  const start = fields[19];
  if (!Number.isSafeInteger(parent) || parent < 0 || !start || !/^\d+$/.test(start))
    throw new Error("RESIDENT_PROCESS_TABLE_UNAVAILABLE");
  return { pid, parent, start };
}

export async function readProcessTable(): Promise<readonly TreeProcess[]> {
  let names: string[];
  try {
    names = await readdir("/proc");
  } catch (error) {
    throw new Error("RESIDENT_PROCESS_TABLE_UNAVAILABLE", { cause: error });
  }
  const processes = await Promise.all(
    names.filter((name) => /^[1-9]\d*$/.test(name)).map((name) => readTreeProcess(Number(name))),
  );
  return processes.filter((process): process is TreeProcess => process !== null);
}

export function processSubtree(table: readonly TreeProcess[], root: number): TreeProcess[] {
  const children = new Map<number, TreeProcess[]>();
  for (const process of table) {
    const siblings = children.get(process.parent) ?? [];
    siblings.push(process);
    children.set(process.parent, siblings);
  }
  const rootProcess = table.find((process) => process.pid === root);
  if (!rootProcess) return [];
  const members = [rootProcess];
  for (let index = 0; index < members.length; index++)
    for (const child of children.get(members[index]?.pid ?? -1) ?? [])
      if (child.pid !== root) members.push(child);
  return members;
}

export async function captureResidentInfrastructure(
  root: number,
  table: () => Promise<readonly TreeProcess[]> = readProcessTable,
): Promise<ResidentInfrastructure> {
  const tree = processSubtree(await table(), root);
  if (tree.length === 0) throw new Error("RESIDENT_TREE_UNAVAILABLE");
  return new Map(tree.map((process) => [process.pid, process.start]));
}

export async function sweepResidentCommand(
  root: number,
  infrastructure: ResidentInfrastructure,
  options: {
    readonly timeoutMs: number;
    readonly intervalMs: number;
    readonly kill: (pid: number, signal: NodeJS.Signals) => void;
    readonly table?: () => Promise<readonly TreeProcess[]>;
    readonly identity?: (pid: number) => Promise<TreeProcess | null>;
    readonly proceed?: () => boolean;
  },
): Promise<ResidentSweep> {
  const table = options.table ?? readProcessTable;
  const identity = options.identity ?? readTreeProcess;
  const deadline = Date.now() + options.timeoutMs;
  let cleanScans = 0;
  for (;;) {
    if (options.proceed && !options.proceed())
      return { commandTreeGone: false, infrastructureIntact: true };
    const tree = processSubtree(await table(), root);
    const present = new Map(tree.map((process) => [process.pid, process.start]));
    for (const [pid, start] of infrastructure)
      if (present.get(pid) !== start)
        return { commandTreeGone: false, infrastructureIntact: false };
    const leftovers = tree.filter((process) => infrastructure.get(process.pid) !== process.start);
    if (leftovers.length === 0) {
      cleanScans++;
      if (cleanScans >= 2) return { commandTreeGone: true, infrastructureIntact: true };
    } else {
      cleanScans = 0;
      for (const leftover of leftovers) {
        if (options.proceed && !options.proceed())
          return { commandTreeGone: false, infrastructureIntact: true };
        const current = await identity(leftover.pid);
        if (current?.start !== leftover.start || current.parent !== leftover.parent) continue;
        try {
          options.kill(leftover.pid, "SIGKILL");
        } catch {}
      }
    }
    if (Date.now() >= deadline) return { commandTreeGone: false, infrastructureIntact: true };
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
}
