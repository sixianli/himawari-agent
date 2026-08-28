import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  CapabilityArtifactVerification,
  CapabilityArtifactVerifierPort,
  CapabilityManifest,
  ClockPort,
} from "@himawari-agent/application";

export const CAPABILITY_ARTIFACT_ERROR_CODES = Object.freeze({
  ARTIFACT_NOT_BOUND: "CAPABILITY_ARTIFACT_NOT_BOUND",
  ARTIFACT_PATH_UNSAFE: "CAPABILITY_ARTIFACT_PATH_UNSAFE",
  ARTIFACT_METADATA_UNSAFE: "CAPABILITY_ARTIFACT_METADATA_UNSAFE",
  ARTIFACT_DIGEST_MISMATCH: "CAPABILITY_ARTIFACT_DIGEST_MISMATCH",
  ARTIFACT_SIGNATURE_MISSING: "CAPABILITY_ARTIFACT_SIGNATURE_MISSING",
  ARTIFACT_SIGNER_UNTRUSTED: "CAPABILITY_ARTIFACT_SIGNER_UNTRUSTED",
  ARTIFACT_SIGNATURE_INVALID: "CAPABILITY_ARTIFACT_SIGNATURE_INVALID",
  ARTIFACT_READ_FAILED: "CAPABILITY_ARTIFACT_READ_FAILED",
} as const);

export interface CapabilityArtifactBinding {
  readonly sourceLocator: string;
  readonly artifactPath: string;
  readonly signaturePath: string | null;
}

export interface CapabilityArtifactTrustRoot {
  resolveBinding(sourceLocator: string): Promise<CapabilityArtifactBinding | undefined>;
  resolveSigner(signerRef: string): Promise<string | Uint8Array | undefined>;
}

function safeFileMode(mode: number): boolean {
  return (mode & 0o022) === 0;
}

async function digestRegularFile(filePath: string): Promise<string> {
  if (!path.isAbsolute(filePath)) throw new Error("path-not-absolute");
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || !safeFileMode(before.mode)) {
    throw new Error("unsafe-artifact-metadata");
  }
  if (typeof process.getuid === "function" && before.uid !== process.getuid() && before.uid !== 0) {
    throw new Error("unsafe-artifact-owner");
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("artifact-changed-before-open");
    }
    const hash = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) hash.update(chunk as Uint8Array);
    const after = await handle.stat();
    if (
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      opened.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("artifact-changed-during-read");
    }
    return `sha256:${hash.digest("hex")}`;
  } finally {
    await handle.close();
  }
}

async function readRestrictedSignature(signaturePath: string): Promise<Uint8Array> {
  if (!path.isAbsolute(signaturePath)) throw new Error("signature-path-not-absolute");
  const info = await lstat(signaturePath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    !safeFileMode(info.mode) ||
    info.size < 64 ||
    info.size > 16_384
  ) {
    throw new Error("unsafe-signature-metadata");
  }
  const raw = await readFile(signaturePath);
  const text = raw.toString("utf8").trim();
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return new Uint8Array(Buffer.from(text, "base64"));
  return new Uint8Array(raw);
}

function failure(
  manifest: CapabilityManifest,
  now: string,
  reasonCode: string,
  artifactDigest = manifest.integrity,
): CapabilityArtifactVerification {
  return Object.freeze({
    verificationVersion: "capability-artifact-verification.v1",
    artifactDigest,
    signatureStatus: manifest.artifact.signatureStatus,
    signerRef: manifest.artifact.signerRef,
    verified: false,
    reasonCodes: Object.freeze([reasonCode]),
    verifiedAt: now,
  });
}

export class FileCapabilityArtifactVerifier implements CapabilityArtifactVerifierPort {
  readonly #trust: CapabilityArtifactTrustRoot;
  readonly #clock: ClockPort;

  constructor(options: { readonly trust: CapabilityArtifactTrustRoot; readonly clock: ClockPort }) {
    this.#trust = options.trust;
    this.#clock = options.clock;
  }

  async verify(manifest: CapabilityManifest): Promise<CapabilityArtifactVerification> {
    const now = this.#clock.now();
    let binding: CapabilityArtifactBinding | undefined;
    try {
      binding = await this.#trust.resolveBinding(manifest.source.locator);
    } catch {
      return failure(manifest, now, CAPABILITY_ARTIFACT_ERROR_CODES.ARTIFACT_NOT_BOUND);
    }
    if (!binding || binding.sourceLocator !== manifest.source.locator) {
      return failure(manifest, now, CAPABILITY_ARTIFACT_ERROR_CODES.ARTIFACT_NOT_BOUND);
    }
    if (!path.isAbsolute(binding.artifactPath)) {
      return failure(manifest, now, CAPABILITY_ARTIFACT_ERROR_CODES.ARTIFACT_PATH_UNSAFE);
    }
    let digest: string;
    try {
      digest = await digestRegularFile(binding.artifactPath);
    } catch (error) {
      const code =
        error instanceof Error && /metadata|owner|changed/.test(error.message)
          ? CAPABILITY_ARTIFACT_ERROR_CODES.ARTIFACT_METADATA_UNSAFE
          : CAPABILITY_ARTIFACT_ERROR_CODES.ARTIFACT_READ_FAILED;
      return failure(manifest, now, code);
    }
    if (digest !== manifest.integrity || digest !== manifest.artifact.digest) {
      return failure(
        manifest,
        now,
        CAPABILITY_ARTIFACT_ERROR_CODES.ARTIFACT_DIGEST_MISMATCH,
        digest,
      );
    }
    if (manifest.artifact.signatureStatus === "not_applicable") {
      return Object.freeze({
        verificationVersion: "capability-artifact-verification.v1",
        artifactDigest: digest,
        signatureStatus: "not_applicable",
        signerRef: null,
        verified: true,
        reasonCodes: Object.freeze([]),
        verifiedAt: now,
      });
    }
    if (!manifest.artifact.signerRef || !binding.signaturePath) {
      return failure(
        manifest,
        now,
        CAPABILITY_ARTIFACT_ERROR_CODES.ARTIFACT_SIGNATURE_MISSING,
        digest,
      );
    }
    const signer = await this.#trust
      .resolveSigner(manifest.artifact.signerRef)
      .catch(() => undefined);
    if (!signer) {
      return failure(
        manifest,
        now,
        CAPABILITY_ARTIFACT_ERROR_CODES.ARTIFACT_SIGNER_UNTRUSTED,
        digest,
      );
    }
    try {
      const signature = await readRestrictedSignature(binding.signaturePath);
      const verified = verifySignature(
        null,
        Buffer.from(digest, "utf8"),
        createPublicKey(typeof signer === "string" ? signer : Buffer.from(signer)),
        signature,
      );
      if (!verified) {
        return failure(
          manifest,
          now,
          CAPABILITY_ARTIFACT_ERROR_CODES.ARTIFACT_SIGNATURE_INVALID,
          digest,
        );
      }
    } catch {
      return failure(
        manifest,
        now,
        CAPABILITY_ARTIFACT_ERROR_CODES.ARTIFACT_SIGNATURE_INVALID,
        digest,
      );
    }
    return Object.freeze({
      verificationVersion: "capability-artifact-verification.v1",
      artifactDigest: digest,
      signatureStatus: "verified",
      signerRef: manifest.artifact.signerRef,
      verified: true,
      reasonCodes: Object.freeze([]),
      verifiedAt: now,
    });
  }
}
