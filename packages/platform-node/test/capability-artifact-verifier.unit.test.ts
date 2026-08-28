import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { CapabilityManifest } from "@himawari-agent/application";
import { afterEach, describe, expect, it } from "vitest";
import {
  CAPABILITY_ARTIFACT_ERROR_CODES,
  FileCapabilityArtifactVerifier,
  type CapabilityArtifactBinding,
} from "../src/capabilities/artifact-verifier.js";

const NOW = "2026-08-28T08:00:00.000Z";
const roots: string[] = [];

function manifest(digest: string): CapabilityManifest {
  return {
    manifestVersion: "capability.v2",
    ref: "signed-program",
    displayName: "Signed program",
    version: "1.0.0",
    source: { type: "program", locator: "artifact:signed-program:1.0.0" },
    sourceIdentity: "publisher:fixture",
    integrity: digest,
    artifact: {
      digest,
      signatureStatus: "verified",
      signerRef: "signer:fixture",
      rollbackArtifactRef: null,
    },
    operations: ["execute"],
    permissionRefs: [],
    isolation: "sandbox",
    scopes: { dataClassifications: ["public"], network: [], filesystem: [], secrets: [] },
    cost: { currency: "USD", maxMicrosPerInvocation: 0 },
    health: { status: "unknown", checkedAt: null },
    reviewedBy: "owner",
    reviewedAt: NOW,
    contractCompatibility: ["capability-conformance.v1"],
    runtime: {
      kind: "program",
      argv: ["/bin/fixture"],
      environmentKeys: [],
      workdirRef: "workspace:fixture",
      stdin: "protected_payload",
      stdout: "protected_payload",
      subprocesses: [],
      network: [],
      filesystem: [],
    },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "himawari-artifact-"));
  roots.push(root);
  const artifactPath = path.join(root, "artifact.bin");
  const signaturePath = path.join(root, "artifact.sig");
  const bytes = Buffer.from("qualified artifact\n", "utf8");
  await writeFile(artifactPath, bytes, { mode: 0o600 });
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const keys = generateKeyPairSync("ed25519");
  await writeFile(
    signaturePath,
    sign(null, Buffer.from(digest, "utf8"), keys.privateKey).toString("base64"),
    { mode: 0o600 },
  );
  const binding: CapabilityArtifactBinding = {
    sourceLocator: "artifact:signed-program:1.0.0",
    artifactPath,
    signaturePath,
  };
  const verifier = new FileCapabilityArtifactVerifier({
    clock: { now: () => NOW },
    trust: {
      resolveBinding: async () => binding,
      resolveSigner: async () => keys.publicKey.export({ type: "spki", format: "pem" }),
    },
  });
  return { artifactPath, binding, digest, keys, verifier };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileCapabilityArtifactVerifier", () => {
  it("verifies an owned regular artifact digest and trusted Ed25519 signature", async () => {
    const value = await fixture();
    await expect(value.verifier.verify(manifest(value.digest))).resolves.toMatchObject({
      verified: true,
      artifactDigest: value.digest,
      signatureStatus: "verified",
      signerRef: "signer:fixture",
      reasonCodes: [],
    });
  });

  it("fails closed after artifact tamper and never trusts the declared digest", async () => {
    const value = await fixture();
    await writeFile(value.artifactPath, "tampered\n", { mode: 0o600 });
    await expect(value.verifier.verify(manifest(value.digest))).resolves.toMatchObject({
      verified: false,
      reasonCodes: [CAPABILITY_ARTIFACT_ERROR_CODES.ARTIFACT_DIGEST_MISMATCH],
    });
  });

  it("rejects symlink artifacts and group-writable metadata", async () => {
    const value = await fixture();
    const link = path.join(path.dirname(value.artifactPath), "artifact-link.bin");
    await symlink(value.artifactPath, link);
    const linked = new FileCapabilityArtifactVerifier({
      clock: { now: () => NOW },
      trust: {
        resolveBinding: async () => ({ ...value.binding, artifactPath: link }),
        resolveSigner: async () => value.keys.publicKey.export({ type: "spki", format: "pem" }),
      },
    });
    await expect(linked.verify(manifest(value.digest))).resolves.toMatchObject({
      verified: false,
      reasonCodes: [CAPABILITY_ARTIFACT_ERROR_CODES.ARTIFACT_METADATA_UNSAFE],
    });
    await chmod(value.artifactPath, 0o620);
    await expect(value.verifier.verify(manifest(value.digest))).resolves.toMatchObject({
      verified: false,
      reasonCodes: [CAPABILITY_ARTIFACT_ERROR_CODES.ARTIFACT_METADATA_UNSAFE],
    });
  });
});
