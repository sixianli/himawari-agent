import { readFile } from "node:fs/promises";
import path from "node:path";

export interface UserComputerConfig {
  readonly schemaVersion: "user-computers.v1";
  readonly docker: { readonly executable: string; readonly host: string | null };
  readonly runtime: string;
  readonly image: { readonly reference: string | null; readonly digest: string };
  readonly stateDirectory: string;
  readonly socket: { readonly path: string; readonly groupId: number | null };
  readonly disk: { readonly mode: "loop" | "directory"; readonly sizeBytes: number };
  readonly resources: {
    readonly memoryBytes: number;
    readonly cpus: number;
    readonly maxProcesses: number;
  };
  readonly admission: {
    readonly startBytes: number;
    readonly reserveBytes: number;
    readonly waitMs: number;
    readonly pollMs: number;
  };
  readonly idle: {
    readonly stopAfterMs: number;
    readonly checkIntervalMs: number;
    readonly staleAfterMs: number;
  };
  readonly commandTimeoutMs: number;
  readonly stopGraceSeconds: number;
  readonly beforeStop: { readonly argv: readonly string[]; readonly timeoutSeconds: number } | null;
  readonly hostPaths: {
    readonly runtimeRoots: readonly string[];
    readonly seedRoots: readonly string[];
  };
}

function fail(field: string): never {
  throw new Error(`USER_COMPUTER_CONFIG_INVALID: ${field}`);
}

function record(value: unknown, field: string, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field);
  const entries = value as Record<string, unknown>;
  for (const key of Object.keys(entries)) if (!keys.includes(key)) fail(`${field}.${key}`);
  for (const key of keys) if (!(key in entries)) fail(`${field}.${key}`);
  return entries;
}

function positive(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(field);
  return value;
}

function whole(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(field);
  return value as number;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) fail(field);
  return value;
}

function absolute(value: unknown, field: string): string {
  const candidate = text(value, field);
  if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate) fail(field);
  return candidate;
}

export function parseUserComputerConfig(input: unknown): UserComputerConfig {
  const root = record(input, "config", [
    "schemaVersion",
    "docker",
    "runtime",
    "image",
    "stateDirectory",
    "socket",
    "disk",
    "resources",
    "admission",
    "idle",
    "commandTimeoutMs",
    "stopGraceSeconds",
    "beforeStop",
    "hostPaths",
  ]);
  if (root["schemaVersion"] !== "user-computers.v1") fail("schemaVersion");
  const docker = record(root["docker"], "docker", ["executable", "host"]);
  const image = record(root["image"], "image", ["reference", "digest"]);
  const socket = record(root["socket"], "socket", ["path", "groupId"]);
  const disk = record(root["disk"], "disk", ["mode", "sizeBytes"]);
  const resources = record(root["resources"], "resources", ["memoryBytes", "cpus", "maxProcesses"]);
  const admission = record(root["admission"], "admission", [
    "startBytes",
    "reserveBytes",
    "waitMs",
    "pollMs",
  ]);
  const idle = record(root["idle"], "idle", ["stopAfterMs", "checkIntervalMs", "staleAfterMs"]);
  const digest = text(image["digest"], "image.digest");
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) fail("image.digest");
  const runtime = text(root["runtime"], "runtime");
  if (!/^[a-z][a-z0-9._-]*$/.test(runtime)) fail("runtime");
  if (disk["mode"] !== "loop" && disk["mode"] !== "directory") fail("disk.mode");
  const host = docker["host"];
  if (host !== null && typeof host !== "string") fail("docker.host");
  const groupId = socket["groupId"];
  if (groupId !== null) whole(groupId, "socket.groupId");
  let beforeStop: UserComputerConfig["beforeStop"] = null;
  if (root["beforeStop"] !== null) {
    const hook = record(root["beforeStop"], "beforeStop", ["argv", "timeoutSeconds"]);
    const argv = hook["argv"];
    if (!Array.isArray(argv) || argv.length === 0) fail("beforeStop.argv");
    beforeStop = Object.freeze({
      argv: Object.freeze(argv.map((part, index) => text(part, `beforeStop.argv.${index}`))),
      timeoutSeconds: whole(hook["timeoutSeconds"], "beforeStop.timeoutSeconds"),
    });
  }
  const hostPaths = record(root["hostPaths"], "hostPaths", ["runtimeRoots", "seedRoots"]);
  const roots = (value: unknown, field: string) => {
    if (!Array.isArray(value)) fail(field);
    return Object.freeze(value.map((entry, index) => absolute(entry, `${field}.${index}`)));
  };
  return Object.freeze({
    schemaVersion: "user-computers.v1",
    docker: Object.freeze({
      executable: absolute(docker["executable"], "docker.executable"),
      host: host === null ? null : text(host, "docker.host"),
    }),
    runtime,
    image: Object.freeze({
      reference: image["reference"] === null ? null : text(image["reference"], "image.reference"),
      digest,
    }),
    stateDirectory: absolute(root["stateDirectory"], "stateDirectory"),
    socket: Object.freeze({
      path: absolute(socket["path"], "socket.path"),
      groupId: groupId as number | null,
    }),
    disk: Object.freeze({
      mode: disk["mode"],
      sizeBytes: whole(disk["sizeBytes"], "disk.sizeBytes"),
    }),
    resources: Object.freeze({
      memoryBytes: whole(resources["memoryBytes"], "resources.memoryBytes"),
      cpus: positive(resources["cpus"], "resources.cpus"),
      maxProcesses: whole(resources["maxProcesses"], "resources.maxProcesses"),
    }),
    admission: Object.freeze({
      startBytes: whole(admission["startBytes"], "admission.startBytes"),
      reserveBytes: whole(admission["reserveBytes"], "admission.reserveBytes"),
      waitMs: whole(admission["waitMs"], "admission.waitMs"),
      pollMs: positive(admission["pollMs"], "admission.pollMs"),
    }),
    idle: Object.freeze({
      stopAfterMs: positive(idle["stopAfterMs"], "idle.stopAfterMs"),
      checkIntervalMs: positive(idle["checkIntervalMs"], "idle.checkIntervalMs"),
      staleAfterMs: positive(idle["staleAfterMs"], "idle.staleAfterMs"),
    }),
    commandTimeoutMs: positive(root["commandTimeoutMs"], "commandTimeoutMs"),
    stopGraceSeconds: whole(root["stopGraceSeconds"], "stopGraceSeconds"),
    beforeStop,
    hostPaths: Object.freeze({
      runtimeRoots: roots(hostPaths["runtimeRoots"], "hostPaths.runtimeRoots"),
      seedRoots: roots(hostPaths["seedRoots"], "hostPaths.seedRoots"),
    }),
  });
}

export async function readUserComputerConfig(file: string): Promise<UserComputerConfig> {
  return parseUserComputerConfig(JSON.parse(await readFile(file, "utf8")));
}
