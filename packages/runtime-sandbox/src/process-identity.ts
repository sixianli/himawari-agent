import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const errorCode = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? error.code : undefined;

const validProcessId = (pid: number) => Number.isSafeInteger(pid) && pid > 1;

async function darwinStartToken(pid: number): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { LC_ALL: "C" },
      timeout: 5000,
    });
    const token = stdout.trim();
    if (!token) throw new Error("PROCESS_START_TOKEN_UNAVAILABLE");
    return token;
  } catch (error) {
    if (
      errorCode(error) === 1 &&
      typeof (error as { stdout?: unknown }).stdout === "string" &&
      (error as { stdout: string }).stdout.trim() === ""
    )
      return null;
    throw new Error("PROCESS_START_TOKEN_UNAVAILABLE", { cause: error });
  }
}

async function linuxStartToken(pid: number): Promise<string | null> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ESRCH") return null;
    throw new Error("PROCESS_START_TOKEN_UNAVAILABLE", { cause: error });
  }
  const token = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  if (!token || !/^\d+$/.test(token)) throw new Error("PROCESS_START_TOKEN_UNAVAILABLE");
  return token;
}

export async function readProcessStartToken(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (!validProcessId(pid)) throw new Error("PROCESS_START_TOKEN_UNAVAILABLE");
  if (platform === "darwin") return darwinStartToken(pid);
  if (platform === "linux") return linuxStartToken(pid);
  throw new Error("PROCESS_START_TOKEN_UNAVAILABLE");
}

export function processGroupPresent(groupId: number): boolean {
  if (!validProcessId(groupId)) throw new Error("PROCESS_GROUP_ID_INVALID");
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    if (errorCode(error) === "EPERM") return true;
    throw error;
  }
}
