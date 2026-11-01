import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { digestRegularFile } from "./artifact-verifier.js";
import type { ProtectedRuntimeAuditRequest } from "./protected-runtime-audit-worker.js";

interface RuntimeArtifact {
  readonly path: string;
  readonly sha256: string;
}

async function verifyArtifact(artifact: RuntimeArtifact): Promise<void> {
  if ((await digestRegularFile(artifact.path)) !== `sha256:${artifact.sha256}`)
    throw new Error("SANDBOX_HOST_ARTIFACT_CHANGED");
}

const failure = () => new Error("SANDBOX_RUNTIME_PROTECTION_INVALID");
const canonical = (value: unknown): value is string =>
  typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value;

interface Protection {
  readonly schemaVersion: "protected-runtime.v1";
  readonly runtimeRoot: string;
  readonly runtimeDigest: string;
  readonly runtimeUid: number;
  readonly deploymentUid: number;
}

function parse(value: unknown): Protection {
  if (!value || typeof value !== "object") throw failure();
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join() !==
      "deploymentUid,runtimeDigest,runtimeRoot,runtimeUid,schemaVersion" ||
    input["schemaVersion"] !== "protected-runtime.v1" ||
    !canonical(input["runtimeRoot"]) ||
    input["runtimeRoot"] === "/" ||
    typeof input["runtimeDigest"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(input["runtimeDigest"]) ||
    !Number.isSafeInteger(input["runtimeUid"]) ||
    Number(input["runtimeUid"]) <= 0 ||
    !Number.isSafeInteger(input["deploymentUid"]) ||
    Number(input["deploymentUid"]) < 0 ||
    input["runtimeUid"] === input["deploymentUid"]
  )
    throw failure();
  return input as unknown as Protection;
}

export function auditProtectedRuntime(root: string, ownerUid: number): Promise<void> {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const request: ProtectedRuntimeAuditRequest = { root, ownerUid };
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL(`./protected-runtime-audit-worker.${extension}`, import.meta.url),
      { workerData: request },
    );
    let received = false;
    worker.once("message", (value: unknown) => {
      received = true;
      if ((value as { protected?: unknown } | null)?.protected === true) resolve();
      else reject(failure());
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (!received) reject(new Error(`SANDBOX_RUNTIME_AUDIT_WORKER_EXIT:${code}`));
    });
  });
}

const CONTENT_AUDIT_TIMEOUT_MS = 600_000;
const TRANSIENT_CODES = new Set([
  "EIO",
  "EMFILE",
  "ENFILE",
  "ENOMEM",
  "EAGAIN",
  "EBUSY",
  "ETIMEDOUT",
]);

function isTransientAuditError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return (
    (typeof code === "string" && TRANSIENT_CODES.has(code)) ||
    /^(SANDBOX_RUNTIME_AUDIT_TIMEOUT|SANDBOX_HOST_DIGEST_WORKER_EXIT|SANDBOX_RUNTIME_AUDIT_WORKER_EXIT)/.test(
      error.message,
    )
  );
}

export class ProtectedRuntimeVerifier {
  readonly #manifestPath: string;
  readonly #auditInstallation: (root: string) => Promise<void>;
  readonly #audits = new Map<string, Promise<void>>();
  readonly #artifactAudits = new Map<string, Promise<void>>();
  readonly #refused = new Map<string, unknown>();
  readonly #contentAuditTimeoutMs: number;
  constructor(
    manifestPath: string,
    auditInstallation: (root: string) => Promise<void> = (root) => auditProtectedRuntime(root, 0),
    contentAuditTimeoutMs = CONTENT_AUDIT_TIMEOUT_MS,
  ) {
    if (!canonical(manifestPath)) throw failure();
    this.#manifestPath = manifestPath;
    this.#auditInstallation = auditInstallation;
    this.#contentAuditTimeoutMs = contentAuditTimeoutMs;
  }

  async #process(uid: number): Promise<void> {
    if (process.platform !== "linux" || process.getuid?.() !== uid || process.geteuid?.() !== uid)
      throw failure();
    const status = await readFile("/proc/self/status", "utf8");
    if (!new RegExp(`^Uid:\\s+${uid}\\s+${uid}\\s+${uid}\\s+${uid}$`, "m").test(status))
      throw failure();
    for (const name of ["CapInh", "CapPrm", "CapEff", "CapAmb"])
      if (!new RegExp(`^${name}:\\s+0+$`, "m").test(status)) throw failure();
    if (!/^NoNewPrivs:\s+1$/m.test(status)) throw failure();
  }

  async #parents(filename: string, owners: readonly number[]): Promise<string> {
    const entries: string[] = [];
    for (let current = filename; ; current = path.dirname(current)) {
      const info = await lstat(current);
      if (
        !info.isDirectory() ||
        (info.mode & 0o022) !== 0 ||
        !owners.includes(info.uid) ||
        (await realpath(current)) !== current
      )
        throw failure();
      entries.push(`${current}:${info.dev}:${info.ino}:${info.uid}:${info.mode}`);
      if (current === "/") break;
    }
    return entries.join("\n");
  }

  async #manifest(): Promise<{ protection: Protection; identity: string }> {
    const parents = await this.#parents(path.dirname(this.#manifestPath), [0]);
    const handle = await open(this.#manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.uid !== 0 || before.mode & 0o022 || before.size > 4096)
        throw failure();
      const bytes = await handle.readFile();
      const after = await handle.stat();
      const current = await lstat(this.#manifestPath);
      if (
        before.dev !== current.dev ||
        before.ino !== current.ino ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        before.size !== after.size
      )
        throw failure();
      const protection = parse(JSON.parse(bytes.toString("utf8")));
      return {
        protection,
        identity: `${parents}\n${before.dev}:${before.ino}:${before.ctimeMs}:${createHash("sha256").update(bytes).digest("hex")}`,
      };
    } finally {
      await handle.close();
    }
  }

  async verify(
    runtimeRoot: string,
    runtimeDigest: string,
    digest: (root: string) => Promise<string>,
    artifacts: readonly RuntimeArtifact[] = [],
  ): Promise<void> {
    const { complete } = await this.#prepare(runtimeRoot, runtimeDigest, digest, artifacts);
    await complete();
  }

  async begin(
    runtimeRoot: string,
    runtimeDigest: string,
    digest: (root: string) => Promise<string>,
    artifacts: readonly RuntimeArtifact[] = [],
    onSettled?: (outcome: { readonly ok: boolean; readonly durationMs: number }) => void,
  ): Promise<void> {
    const startedAt = Date.now();
    const { key, complete } = await this.#prepare(runtimeRoot, runtimeDigest, digest, artifacts);
    const settle = (ok: boolean) => {
      try {
        onSettled?.({ ok, durationMs: Date.now() - startedAt });
      } catch {}
    };
    complete().then(
      () => settle(true),
      (error: unknown) => {
        if (!isTransientAuditError(error)) this.#refused.set(key, error);
        settle(false);
      },
    );
  }

  async #prepare(
    runtimeRoot: string,
    runtimeDigest: string,
    digest: (root: string) => Promise<string>,
    artifacts: readonly RuntimeArtifact[],
  ): Promise<{ readonly key: string; readonly complete: () => Promise<void> }> {
    const { protection, identity } = await this.#manifest();
    if (runtimeRoot !== protection.runtimeRoot || runtimeDigest !== protection.runtimeDigest)
      throw failure();
    await this.#process(protection.runtimeUid);
    const parents = await this.#parents(runtimeRoot, [0, protection.deploymentUid]);
    const protectedArtifacts = artifacts.filter(
      (artifact) => canonical(artifact.path) && artifact.path.startsWith(`${runtimeRoot}/`),
    );
    const artifactIdentity = async () => {
      const entries: string[] = [];
      for (const artifact of protectedArtifacts) {
        const info = await lstat(artifact.path);
        if (!info.isFile() || info.uid !== 0 || info.mode & 0o022) throw failure();
        const ancestors = await this.#parents(path.dirname(artifact.path), [
          0,
          protection.deploymentUid,
        ]);
        entries.push(
          JSON.stringify([
            artifact,
            ancestors,
            info.dev,
            info.ino,
            info.size,
            info.mtimeMs,
            info.ctimeMs,
            info.uid,
            info.mode,
          ]),
        );
      }
      return entries.join("\n");
    };
    const artifactKey = await artifactIdentity();
    const key = `${identity}\n${parents}`;
    const complete = () =>
      this.#complete({
        key,
        artifactKey,
        runtimeRoot,
        runtimeDigest,
        digest,
        artifacts,
        protectedArtifacts,
        protection,
        identity,
        parents,
        artifactIdentity,
      });
    return { key, complete };
  }

  #bounded(work: Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("SANDBOX_RUNTIME_AUDIT_TIMEOUT")),
        this.#contentAuditTimeoutMs,
      );
      work.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async #complete(input: {
    readonly key: string;
    readonly artifactKey: string;
    readonly runtimeRoot: string;
    readonly runtimeDigest: string;
    readonly digest: (root: string) => Promise<string>;
    readonly artifacts: readonly RuntimeArtifact[];
    readonly protectedArtifacts: readonly RuntimeArtifact[];
    readonly protection: Protection;
    readonly identity: string;
    readonly parents: string;
    readonly artifactIdentity: () => Promise<string>;
  }): Promise<void> {
    const {
      key,
      artifactKey,
      runtimeRoot,
      runtimeDigest,
      digest,
      artifacts,
      protectedArtifacts,
      protection,
      identity,
      parents,
      artifactIdentity,
    } = input;
    if (this.#refused.has(key)) throw this.#refused.get(key);
    let audit = this.#audits.get(key);
    if (!audit) {
      this.#audits.clear();
      this.#artifactAudits.clear();
      audit = this.#bounded(
        (async () => {
          await this.#auditInstallation(runtimeRoot);
          if ((await digest(runtimeRoot)) !== runtimeDigest) throw failure();
          const latest = await this.#manifest();
          if (
            latest.identity !== identity ||
            (await this.#parents(runtimeRoot, [0, protection.deploymentUid])) !== parents
          )
            throw failure();
        })(),
      );
      this.#audits.set(key, audit);
    }
    try {
      await audit;
    } catch (error) {
      if (this.#audits.get(key) === audit) this.#audits.delete(key);
      throw error;
    }
    const artifactCacheKey = `${key}\n${artifactKey}`;
    let artifactAudit = this.#artifactAudits.get(artifactCacheKey);
    if (!artifactAudit) {
      artifactAudit = (async () => {
        for (const artifact of protectedArtifacts) await verifyArtifact(artifact);
        if ((await artifactIdentity()) !== artifactKey) throw failure();
      })();
      this.#artifactAudits.set(artifactCacheKey, artifactAudit);
    }
    try {
      await artifactAudit;
    } catch (error) {
      if (this.#artifactAudits.get(artifactCacheKey) === artifactAudit)
        this.#artifactAudits.delete(artifactCacheKey);
      throw error;
    }
    for (const artifact of artifacts)
      if (!protectedArtifacts.includes(artifact)) await verifyArtifact(artifact);
  }
}

const verifiers = new Map<string, ProtectedRuntimeVerifier>();
export interface ProtectedRuntimeVerifyOptions {
  readonly deferContentAudit?: boolean;
}

export async function verifyProtectedRuntime(
  runtimeRoot: string,
  runtimeDigest: string,
  digest: (root: string) => Promise<string>,
  artifacts: readonly RuntimeArtifact[] = [],
  options: ProtectedRuntimeVerifyOptions = {},
): Promise<boolean> {
  const filename = process.env["HIMAWARI_RUNTIME_PROTECTION_FILE"];
  if (filename === undefined) return false;
  let verifier = verifiers.get(filename);
  if (!verifier) {
    verifier = new ProtectedRuntimeVerifier(filename);
    verifiers.set(filename, verifier);
  }
  if (options.deferContentAudit === true) {
    await verifier.begin(runtimeRoot, runtimeDigest, digest, artifacts, (outcome) => {
      console.error(
        JSON.stringify({
          component: "platform-node",
          event: outcome.ok
            ? "sandbox_runtime.content_audit_completed"
            : "sandbox_runtime.content_audit_failed",
          durationMs: outcome.durationMs,
        }),
      );
    });
    return true;
  }
  await verifier.verify(runtimeRoot, runtimeDigest, digest, artifacts);
  return true;
}
