import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { ContainerMount } from "./host-directories.ts";

export const NEVER = "0001-01-01T00:00:00Z";

export interface PinnedImage {
  readonly reference: string;
  readonly digest: string;
  readonly pin: "registry-digest" | "image-id";
}
export const STOPPED_STATUSES = new Set(["exited", "created", "dead"]);

export interface Container {
  readonly Id: string;
  readonly Name: string;
  readonly Image: string;
  readonly Config: {
    readonly User: string;
    readonly Labels: Record<string, string> | null;
    readonly Entrypoint: readonly string[] | null;
    readonly Cmd: readonly string[] | null;
    readonly Env?: readonly string[] | null;
  };
  readonly HostConfig: Record<string, unknown> & {
    readonly RestartPolicy?: { readonly Name?: string };
    readonly LogConfig?: { readonly Type?: string };
  };
  readonly State: {
    readonly Status: string;
    readonly Running: boolean;
    readonly Paused: boolean;
    readonly Restarting: boolean;
    readonly StartedAt: string;
  };
  readonly RestartCount: number;
  readonly Mounts: readonly unknown[] | null;
  readonly NetworkSettings?: {
    readonly Networks?: Record<string, { readonly Aliases?: readonly string[] | null }> | null;
  };
}

export function hasStopped(container: Container) {
  return (
    !container.State.Running &&
    !container.State.Paused &&
    !container.State.Restarting &&
    STOPPED_STATUSES.has(container.State.Status) &&
    container.HostConfig.RestartPolicy?.Name === "no"
  );
}

export function mountArguments(mounts: readonly ContainerMount[]) {
  return mounts.flatMap((mount) => [
    "--mount",
    `type=bind,source=${mount.source},target=${mount.target}${mount.readOnly ? ",readonly" : ""}`,
  ]);
}

export function expectedMounts(mounts: readonly ContainerMount[]) {
  return {
    hostMounts: mounts.map((mount) => ({
      type: "bind",
      source: mount.source,
      target: mount.target,
      readOnly: mount.readOnly,
      rest: {},
    })),
    mounts: mounts.map((mount) => ({
      type: "bind",
      source: mount.source,
      destination: mount.target,
      mode: "",
      rw: !mount.readOnly,
      propagation: "rprivate",
    })),
  };
}

export function effectiveMounts(container: Container) {
  return {
    hostMounts: records(container.HostConfig["Mounts"])
      .map(({ Type, Source, Target, ReadOnly, ...rest }) => ({
        type: Type,
        source: Source,
        target: Target,
        readOnly: ReadOnly === true,
        rest,
      }))
      .sort((a, b) => compareText(String(a.target), String(b.target))),
    mounts: records(container.Mounts)
      .map((mount) => ({
        type: mount["Type"],
        source: mount["Source"],
        destination: mount["Destination"],
        mode: mount["Mode"],
        rw: mount["RW"],
        propagation: mount["Propagation"],
      }))
      .sort((a, b) => compareText(String(a.destination), String(b.destination))),
  };
}

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

export function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function writeOnce<T extends object>(
  file: string,
  value: T,
  mode = 0o644,
): Promise<T> {
  try {
    await writeFile(file, `${JSON.stringify(value)}\n`, { flag: "wx", mode });
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readJson<T>(file);
    if (!existing) throw error;
    return existing;
  }
}

export async function readJson<T = Record<string, unknown>>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
