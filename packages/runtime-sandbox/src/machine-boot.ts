import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const bootIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function rawBootId(platform: NodeJS.Platform): Promise<string> {
  if (platform === "darwin")
    return (
      await promisify(execFile)("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
        timeout: 5000,
      })
    ).stdout;
  if (platform === "linux") return readFile("/proc/sys/kernel/random/boot_id", "utf8");
  throw new Error("MACHINE_BOOT_ID_UNAVAILABLE");
}

export async function readMachineBootId(
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const value = (await rawBootId(platform)).trim().toLowerCase();
  if (!bootIdPattern.test(value)) throw new Error("MACHINE_BOOT_ID_UNAVAILABLE");
  return value;
}
