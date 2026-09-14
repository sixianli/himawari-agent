import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { digestRegularFile } from "./artifact-verifier.js";

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

/** A deployment administrator, not the runtime user, owns this authority.
 * Instances retain only a successful audit of one exact installation identity.
 * This is not a TTL cache and cannot qualify a writable installation. */
export class ProtectedRuntimeVerifier {
  readonly #manifestPath: string;
  readonly #audits = new Map<string, Promise<void>>();
  readonly #artifactAudits = new Map<string, Promise<void>>();
  constructor(manifestPath: string) {
    if (!canonical(manifestPath)) throw failure();
    this.#manifestPath = manifestPath;
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

  async #auditPermissions(root: string): Promise<void> {
    const info = await lstat(root);
    // ACL write grants are covered by the group-class mask bits. The runtime
    // must not own any descendant, including helper executables and scripts.
    if (info.uid !== 0 || info.mode & 0o022 || (!info.isFile() && !info.isDirectory()))
      throw failure();
    if (info.isDirectory())
      for (const entry of await readdir(root)) await this.#auditPermissions(path.join(root, entry));
  }

  async verify(
    runtimeRoot: string,
    runtimeDigest: string,
    digest: (root: string) => Promise<string>,
    artifacts: readonly RuntimeArtifact[] = [],
  ): Promise<void> {
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
    let audit = this.#audits.get(key);
    if (!audit) {
      // A version switch invalidates the previous audit even if it later switches
      // back. Concurrent callers share only the same in-flight initial audit.
      this.#audits.clear();
      this.#artifactAudits.clear();
      audit = (async () => {
        await this.#auditPermissions(runtimeRoot);
        if ((await digest(runtimeRoot)) !== runtimeDigest) throw failure();
        const latest = await this.#manifest();
        if (
          latest.identity !== identity ||
          (await this.#parents(runtimeRoot, [0, protection.deploymentUid])) !== parents
        )
          throw failure();
      })();
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
    // Protection applies only to this installation; external executables retain
    // their per-invocation byte verification, even if the runtime is protected.
    for (const artifact of artifacts)
      if (!protectedArtifacts.includes(artifact)) await verifyArtifact(artifact);
  }
}

const verifiers = new Map<string, ProtectedRuntimeVerifier>();
export async function verifyProtectedRuntime(
  runtimeRoot: string,
  runtimeDigest: string,
  digest: (root: string) => Promise<string>,
  artifacts: readonly RuntimeArtifact[] = [],
): Promise<boolean> {
  const filename = process.env["HIMAWARI_RUNTIME_PROTECTION_FILE"];
  if (filename === undefined) return false;
  let verifier = verifiers.get(filename);
  if (!verifier) {
    verifier = new ProtectedRuntimeVerifier(filename);
    verifiers.set(filename, verifier);
  }
  await verifier.verify(runtimeRoot, runtimeDigest, digest, artifacts);
  return true;
}
