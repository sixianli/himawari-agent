import { execFile } from "node:child_process";
import { mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ComputerDisk {
  readonly image: string;
  readonly home: string;
}

export function computerDiskPaths(stateDirectory: string, ownerKey: string): ComputerDisk {
  const root = path.join(stateDirectory, "computers", ownerKey);
  return { image: path.join(root, "disk.img"), home: path.join(root, "home") };
}

async function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function mounted(directory: string) {
  const [self, parent] = await Promise.all([stat(directory), stat(path.dirname(directory))]);
  return self.dev !== parent.dev;
}

export async function prepareComputerDisk(input: {
  readonly stateDirectory: string;
  readonly ownerKey: string;
  readonly mode: "loop" | "directory";
  readonly sizeBytes: number;
  readonly timeoutMs: number;
}): Promise<ComputerDisk> {
  const disk = computerDiskPaths(input.stateDirectory, input.ownerKey);
  await mkdir(disk.home, { recursive: true, mode: 0o700 });
  if (input.mode === "directory") return disk;
  if (!(await exists(disk.image))) {
    const partial = `${disk.image}.partial`;
    const handle = await open(partial, "w", 0o600);
    try {
      await handle.truncate(input.sizeBytes);
    } finally {
      await handle.close();
    }
    await run("mkfs.ext4", ["-q", "-F", "-m", "0", partial], { timeout: input.timeoutMs });
    await run("mv", ["-T", partial, disk.image], { timeout: input.timeoutMs });
  }
  if (!(await mounted(disk.home)))
    await run("mount", ["-o", "loop,nosuid,nodev", disk.image, disk.home], {
      timeout: input.timeoutMs,
    });
  return disk;
}

export async function removeComputerDisk(input: {
  readonly stateDirectory: string;
  readonly ownerKey: string;
  readonly timeoutMs: number;
}): Promise<void> {
  const disk = computerDiskPaths(input.stateDirectory, input.ownerKey);
  if ((await exists(disk.home)) && (await mounted(disk.home)))
    await run("umount", [disk.home], { timeout: input.timeoutMs });
  await rm(path.dirname(disk.home), { recursive: true, force: true });
}
