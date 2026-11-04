import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SRT_SECCOMP_HELPER_SHA256 = Object.freeze({
  x64: "7effeb0f2d94f7b8bbb8d25a9b21fe77416e5f5c7e408cefea5a07f7560ca24a",
  arm64: "4fee55ac7f22dd023ba1674ff1c3fa1b502ef8121800a78ae1bc9c515091ab17",
});

export interface SrtSeccompHelperIdentity {
  readonly path: string;
  readonly realPath: string | null;
  readonly regularFile: boolean;
  readonly executable: boolean;
  readonly sha256: string | null;
}

export interface SrtRuntimeIdentity {
  readonly packageName: string | null;
  readonly version: string | null;
  readonly helper: SrtSeccompHelperIdentity | null;
  readonly bwrapVersion: string | null;
}

export function installedSrtPackageRoot(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime"))),
    "..",
  );
}

function helperArchitecture(arch: string): keyof typeof SRT_SECCOMP_HELPER_SHA256 | null {
  return arch === "x64" || arch === "arm64" ? arch : null;
}

async function readPackage(
  packageRoot: string,
): Promise<{ name: string | null; version: string | null }> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { name: null, version: null };
    const { name, version } = parsed as Record<string, unknown>;
    return {
      name: typeof name === "string" ? name : null,
      version: typeof version === "string" ? version : null,
    };
  } catch {
    return { name: null, version: null };
  }
}

async function readHelper(helperPath: string): Promise<SrtSeccompHelperIdentity> {
  const resolved = await realpath(helperPath).catch(() => null);
  const status = await lstat(helperPath).catch(() => null);
  const regularFile = status?.isFile() ?? false;
  const executable = regularFile
    ? await access(helperPath, constants.X_OK).then(
        () => true,
        () => false,
      )
    : false;
  const sha256 = regularFile
    ? await readFile(helperPath).then(
        (bytes) => createHash("sha256").update(bytes).digest("hex"),
        () => null,
      )
    : null;
  return { path: helperPath, realPath: resolved, regularFile, executable, sha256 };
}

function readBwrapVersion(): string | null {
  const probe = spawnSync("bwrap", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  if (probe.error || probe.status !== 0) return null;
  const text = probe.stdout.trim().replace(/\s+/g, " ");
  return text.length > 0 && text.length <= 80 ? text : null;
}

export async function readSrtRuntimeIdentity(
  packageRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<SrtRuntimeIdentity> {
  const root = await realpath(packageRoot).catch(() => packageRoot);
  const { name, version } = await readPackage(root);
  if (platform !== "linux") return { packageName: name, version, helper: null, bwrapVersion: null };
  const architecture = helperArchitecture(arch);
  return {
    packageName: name,
    version,
    helper: architecture
      ? await readHelper(path.join(root, "vendor", "seccomp", architecture, "apply-seccomp"))
      : null,
    bwrapVersion: readBwrapVersion(),
  };
}

export function requireLockedSrtRuntime(
  identity: SrtRuntimeIdentity,
  expectedVersion: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { readonly helperPath: string | null } {
  if (
    identity.packageName !== "@anthropic-ai/sandbox-runtime" ||
    identity.version !== expectedVersion
  )
    throw new Error("JOB_HOST_SRT_VERSION_MISMATCH");
  if (platform !== "linux") return { helperPath: null };
  const architecture = helperArchitecture(arch);
  const helper = identity.helper;
  if (
    !architecture ||
    !helper ||
    helper.realPath !== helper.path ||
    !helper.regularFile ||
    !helper.executable ||
    helper.sha256 !== SRT_SECCOMP_HELPER_SHA256[architecture]
  )
    throw new Error("JOB_HOST_SECCOMP_HELPER_UNAVAILABLE");
  return { helperPath: helper.path };
}

export function srtRuntimeText(identity: SrtRuntimeIdentity): string {
  return `srt ${identity.version ?? "unknown"}; bwrap ${identity.bwrapVersion ?? "unknown"}`;
}

export function srtRuntimeIdentityValue(value: unknown): SrtRuntimeIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = (item: unknown) => item === null || typeof item === "string";
  if (
    Object.keys(record).sort().join(",") !== "bwrapVersion,helper,packageName,version" ||
    !text(record["packageName"]) ||
    !text(record["version"]) ||
    !text(record["bwrapVersion"])
  )
    return null;
  const helper = record["helper"];
  if (helper !== null) {
    if (!helper || typeof helper !== "object" || Array.isArray(helper)) return null;
    const fields = helper as Record<string, unknown>;
    if (
      Object.keys(fields).sort().join(",") !== "executable,path,realPath,regularFile,sha256" ||
      typeof fields["path"] !== "string" ||
      !text(fields["realPath"]) ||
      typeof fields["regularFile"] !== "boolean" ||
      typeof fields["executable"] !== "boolean" ||
      !text(fields["sha256"])
    )
      return null;
  }
  return structuredClone(record) as unknown as SrtRuntimeIdentity;
}
