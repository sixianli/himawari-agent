import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CAPABILITY_DEPLOYMENT_ERROR_CODES,
  CAPABILITY_DEPLOYMENT_MAX_BYTES,
  CAPABILITY_DEPLOYMENT_MAX_QUALIFICATION_AGE_MS,
  CapabilityDeploymentSnapshotLoader,
  revalidateCapabilityDeploymentSnapshot,
} from "../src/capabilities/capability-deployment.js";

const NOW = "2026-09-05T00:00:00.000Z";
const PLATFORM =
  process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "other";
const DIGEST = `sha256:${"a".repeat(64)}`;
const RESOURCE_DIGEST = `sha256:${"b".repeat(64)}`;
const ENDPOINT_DIGEST = `sha256:${"c".repeat(64)}`;
const CEILING = {
  maxWallTimeMs: 10_000,
  maxCpuTimeMs: 10_000,
  maxMemoryBytes: 64 * 1024 * 1024,
  maxOutputBytes: 16_384,
  maxProgressEvents: 32,
};

type JsonObject = Record<string, unknown>;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function processManifest(overrides: JsonObject = {}): JsonObject {
  return {
    manifestVersion: "capability.v2",
    ref: "fixture-program",
    displayName: "Fixture program",
    version: "1.0.0",
    source: { type: "program", locator: "artifact:fixture-program:1.0.0" },
    sourceIdentity: "publisher:fixture",
    integrity: DIGEST,
    artifact: {
      digest: DIGEST,
      signatureStatus: "verified",
      signerRef: "signer:fixture",
      rollbackArtifactRef: null,
    },
    operations: ["execute"],
    permissionRefs: [],
    isolation: "sandbox",
    scopes: {
      dataClassifications: ["public"],
      network: [],
      filesystem: ["workspace:fixture"],
      secrets: [],
    },
    cost: { currency: "USD", maxMicrosPerInvocation: 100 },
    health: { status: "healthy", checkedAt: NOW },
    reviewedBy: "reviewer:fixture",
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
      filesystem: ["workspace:fixture"],
    },
    ...overrides,
  };
}

function processBinding(overrides: JsonObject = {}): JsonObject {
  return {
    capabilityRef: "fixture-program",
    capabilityVersion: "1.0.0",
    artifactDigest: DIGEST,
    runtimeRoot: "/opt/himawari/capabilities/fixture-program/1.0.0/root",
    command: "/bin/fixture",
    workdirRef: "workspace:fixture",
    sandboxWorkdir: "/workspace",
    environment: {},
    availableExecutables: ["/bin/fixture"],
    resourceLimitExecutable: {
      sandboxPath: "/bin/prlimit",
      sha256: RESOURCE_DIGEST,
    },
    filesystem: [
      {
        scopeRef: "workspace:fixture",
        hostPath: "/var/lib/himawari/workspace",
        sandboxPath: "/workspace",
        access: "read_write",
      },
    ],
    maximumResourceCeiling: CEILING,
    mcpServerIdentity: null,
    mcpServerName: null,
    mcpServerVersion: null,
    mcpOperationMap: {},
    ...overrides,
  };
}

function processEntry(
  overrides: {
    readonly manifest?: JsonObject;
    readonly qualification?: JsonObject;
    readonly binding?: JsonObject;
  } = {},
): JsonObject {
  return {
    manifest: processManifest(overrides.manifest),
    qualification: {
      qualificationVersion: "capability-runtime-qualification.v1",
      platform: PLATFORM,
      runtimeIdentity: "fixture-qualifier:v1",
      productionSuitable: true,
      artifactDigest: DIGEST,
      enforcement: {
        filesystem: true,
        network: true,
        processes: true,
        secrets: true,
        resourceCeilings: true,
        termination: true,
      },
      reasonCodes: [],
      checkedAt: NOW,
      ...overrides.qualification,
    },
    binding: {
      kind: "process",
      value: processBinding(overrides.binding),
    },
  };
}

function sandboxEntry(): JsonObject {
  const entry = processEntry();
  return {
    ...entry,
    qualification: {
      ...(entry["qualification"] as JsonObject),
      platform: "darwin",
      runtimeIdentity: "srt:0.0.75",
      enforcement: {
        filesystem: true,
        network: true,
        processes: true,
        secrets: true,
        resourceCeilings: false,
        termination: false,
      },
      sandbox: {
        schemaVersion: "sandbox-runtime-qualification.v1",
        qualificationRef: "qualification:fixture",
        hostId: "host:fixture",
        profileRef: "host-readonly.v1",
        srtVersion: "0.0.75",
        platform: "darwin",
        architecture: "arm64",
        osRelease: "27.0.0",
        runtimeDigest: "d".repeat(64),
        runnerDigest: "e".repeat(64),
        evidenceDigest: "f".repeat(64),
        resourceMode: "observe_and_stop",
        terminationMode: "best_effort",
        guarantees: [
          "filesystem_default_deny",
          "network_allowlist",
          "clean_environment",
          "bounded_output",
          "wall_clock_stop",
          "resource_observation",
          "durable_start_admission",
          "unknown_quarantine",
          "restart_reconciliation",
          "best_effort_stop",
        ],
        limitations: ["detached_descendants_may_survive_stop"],
      },
    },
    binding: {
      kind: "sandbox",
      value: {
        schemaVersion: "sandbox-host-binding.v1",
        capabilityRef: "fixture-program",
        capabilityVersion: "1.0.0",
        artifactDigest: DIGEST,
        hostId: "host:fixture",
        profileRef: "host-readonly.v1",
        runtimeRoot: "/opt/runtime",
        runtimeDigest: "d".repeat(64),
        executable: { path: "/usr/bin/node", sha256: "a".repeat(64) },
        runner: { path: "/opt/runtime/runner.js", sha256: "e".repeat(64) },
        privateRoot: "/var/private-jobs",
        roots: [
          {
            canonicalRootId: "root:fixture",
            canonicalPath: "/work/project",
            device: "1",
            inode: "2",
          },
        ],
        readOnlyToolchainPaths: ["/usr/bin"],
        protectedPaths: [],
        allowedDomains: [],
        maximumResourceCeiling: CEILING,
      },
    },
  };
}

function endpointEntry(): JsonObject {
  return {
    manifest: {
      manifestVersion: "capability.v2",
      ref: "fixture-endpoint",
      displayName: "Fixture endpoint",
      version: "1.0.0",
      source: { type: "remote_api", locator: "endpoint:fixture" },
      sourceIdentity: "publisher:fixture",
      integrity: ENDPOINT_DIGEST,
      artifact: {
        digest: ENDPOINT_DIGEST,
        signatureStatus: "not_applicable",
        signerRef: null,
        rollbackArtifactRef: null,
      },
      operations: ["invoke"],
      permissionRefs: [],
      isolation: "remote",
      scopes: {
        dataClassifications: ["public"],
        network: [],
        filesystem: [],
        secrets: [],
      },
      cost: { currency: "USD", maxMicrosPerInvocation: 100 },
      health: { status: "healthy", checkedAt: NOW },
      reviewedBy: null,
      reviewedAt: null,
      contractCompatibility: ["capability-conformance.v1"],
      runtime: {
        kind: "remote_api",
        endpointIdentity: "endpoint:fixture",
        protectedReferenceOnly: true,
      },
    },
    qualification: {
      qualificationVersion: "capability-runtime-qualification.v1",
      platform: PLATFORM,
      runtimeIdentity: "fixture-endpoint-qualifier:v1",
      productionSuitable: true,
      artifactDigest: ENDPOINT_DIGEST,
      enforcement: {
        filesystem: true,
        network: true,
        processes: true,
        secrets: true,
        resourceCeilings: true,
        termination: true,
      },
      reasonCodes: [],
      checkedAt: NOW,
    },
    binding: {
      kind: "endpoint",
      value: {
        endpointIdentity: "endpoint:fixture",
        artifactDigest: ENDPOINT_DIGEST,
        url: "https://capability.example.test",
        allowedMethods: ["POST"],
        operations: {
          invoke: { method: "POST", path: "/invoke", secretHeaders: {} },
        },
        productionSuitable: true,
        allowLoopbackQualification: false,
      },
    },
  };
}

function snapshot(capabilities: readonly JsonObject[] = [processEntry()]): JsonObject {
  return {
    schemaVersion: "capability-deployment.v1",
    capabilities,
  };
}

async function writeSnapshot(value: JsonObject, mode = 0o600) {
  const root = await mkdtemp(path.join(os.tmpdir(), "himawari-capability-deployment-"));
  roots.push(root);
  const snapshotPath = path.join(root, "deployment.json");
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  await writeFile(snapshotPath, bytes, { mode });
  return {
    root,
    snapshotPath,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function loader(snapshotPath: string, digest: string, options: JsonObject = {}) {
  return new CapabilityDeploymentSnapshotLoader({
    snapshotPath,
    sha256: digest,
    platform: process.platform,
    now: () => NOW,
    maximumQualificationAgeMs: CAPABILITY_DEPLOYMENT_MAX_QUALIFICATION_AGE_MS,
    ...options,
  });
}

async function expectDeploymentError(
  promise: Promise<unknown>,
  code: (typeof CAPABILITY_DEPLOYMENT_ERROR_CODES)[keyof typeof CAPABILITY_DEPLOYMENT_ERROR_CODES],
) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("capability deployment snapshot loader", () => {
  it("loads a qualified process snapshot into immutable manifests, records, adapters, and bindings", async () => {
    const value = await writeSnapshot(snapshot([processEntry(), endpointEntry()]));
    const loaded = await loader(value.snapshotPath, value.digest).load();

    expect(loaded.snapshotDigest).toBe(value.digest);
    expect(loaded.manifests).toHaveLength(2);
    expect(loaded.manifests[0]?.ref).toBe("fixture-program");
    expect(loaded.records[0]?.declaration).toEqual(loaded.manifests[0]);
    expect(loaded.records[0]?.approvalRefs).toEqual([]);
    expect(loaded.adapters[0]).toMatchObject({
      capabilityId: "fixture-program",
      capabilityVersion: "1.0.0",
      artifactDigest: DIGEST,
      runtimeKind: "program",
      operations: ["execute"],
    });
    expect(loaded.adapters[1]).toMatchObject({
      capabilityId: "fixture-endpoint",
      runtimeKind: "remote_api",
      operations: ["invoke"],
    });
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.snapshot)).toBe(true);
    expect(Object.isFrozen(loaded.snapshot.capabilities[0])).toBe(true);
    expect(Object.isFrozen(loaded.manifests)).toBe(true);
    expect(Object.isFrozen(loaded.records[0])).toBe(true);
    const processManifestValue = loaded.manifests[0];
    const endpointManifestValue = loaded.manifests[1];
    if (!processManifestValue || !endpointManifestValue) {
      throw new Error("fixture manifests were not loaded");
    }
    await expect(loaded.bindings.resolveProcess(processManifestValue)).resolves.toMatchObject({
      capabilityRef: "fixture-program",
      artifactDigest: DIGEST,
    });
    await expect(loaded.bindings.resolveEndpoint(processManifestValue)).resolves.toBeUndefined();
    await expect(loaded.bindings.resolveEndpoint(endpointManifestValue)).resolves.toMatchObject({
      endpointIdentity: "endpoint:fixture",
      artifactDigest: ENDPOINT_DIGEST,
    });
  });

  it("loads explicit Mac limitations without exposing a legacy process binding", async () => {
    const value = await writeSnapshot(snapshot([sandboxEntry()]));
    const loaded = await loader(value.snapshotPath, value.digest, { platform: "darwin" }).load();
    expect(loaded.snapshot.capabilities[0]?.qualification).toMatchObject({
      enforcement: { resourceCeilings: false, termination: false },
      sandbox: { terminationMode: "best_effort" },
    });
    const manifest = loaded.manifests[0];
    if (!manifest) throw new Error("missing fixture manifest");
    await expect(loaded.bindings.resolveProcess(manifest)).resolves.toBeUndefined();
  });

  it.each(["hostId", "profileRef", "runtimeDigest", "runnerDigest"])(
    "rejects qualification with mismatched %s",
    async (field) => {
      const entry = sandboxEntry();
      const qualification = entry["qualification"] as JsonObject;
      (qualification["sandbox"] as JsonObject)[field] = field.endsWith("Digest")
        ? "0".repeat(64)
        : "different";
      const value = await writeSnapshot(snapshot([entry]));
      await expectDeploymentError(
        loader(value.snapshotPath, value.digest, { platform: "darwin" }).load(),
        CAPABILITY_DEPLOYMENT_ERROR_CODES.QUALIFICATION_INVALID,
      );
    },
  );

  it("does not use Mac sandbox evidence to relax legacy enforcement", async () => {
    const entry = sandboxEntry();
    entry["binding"] = processEntry()["binding"];
    const value = await writeSnapshot(snapshot([entry]));
    await expectDeploymentError(
      loader(value.snapshotPath, value.digest, { platform: "darwin" }).load(),
      CAPABILITY_DEPLOYMENT_ERROR_CODES.QUALIFICATION_INVALID,
    );
    const legacy = processEntry();
    const qualification = legacy["qualification"] as JsonObject;
    (qualification["enforcement"] as JsonObject)["termination"] = false;
    const legacyValue = await writeSnapshot(snapshot([legacy]));
    await expectDeploymentError(
      loader(legacyValue.snapshotPath, legacyValue.digest).load(),
      CAPABILITY_DEPLOYMENT_ERROR_CODES.QUALIFICATION_INVALID,
    );
  });

  it("rejects tampered bytes and unsafe snapshot metadata", async () => {
    const value = await writeSnapshot(snapshot());
    await writeFile(value.snapshotPath, `${JSON.stringify(snapshot())}\n`, { mode: 0o600 });
    await expectDeploymentError(
      loader(value.snapshotPath, value.digest).load(),
      CAPABILITY_DEPLOYMENT_ERROR_CODES.DIGEST_MISMATCH,
    );

    const insecure = await writeSnapshot(snapshot(), 0o640);
    await expectDeploymentError(
      loader(insecure.snapshotPath, insecure.digest).load(),
      CAPABILITY_DEPLOYMENT_ERROR_CODES.FILE_UNSAFE,
    );

    const link = path.join(insecure.root, "deployment-link.json");
    await symlink(insecure.snapshotPath, link);
    await expectDeploymentError(
      loader(link, insecure.digest).load(),
      CAPABILITY_DEPLOYMENT_ERROR_CODES.FILE_UNSAFE,
    );
  });

  it("rejects snapshots over the configured bound before JSON parsing", async () => {
    const value = await writeSnapshot({ ...snapshot(), padding: "x".repeat(128) });
    await expectDeploymentError(
      loader(value.snapshotPath, value.digest, { maximumBytes: 64 }).load(),
      CAPABILITY_DEPLOYMENT_ERROR_CODES.TOO_LARGE,
    );
    expect(CAPABILITY_DEPLOYMENT_MAX_BYTES).toBeGreaterThan(64);
  });

  it("requires a normalized absolute path, canonical schema version, and non-zero digest", async () => {
    const value = await writeSnapshot(snapshot());
    expect(
      () =>
        new CapabilityDeploymentSnapshotLoader({
          snapshotPath: "relative/deployment.json",
          sha256: value.digest,
        }),
    ).toThrowError(
      expect.objectContaining({ code: CAPABILITY_DEPLOYMENT_ERROR_CODES.PATH_UNSAFE }),
    );
    expect(
      () =>
        new CapabilityDeploymentSnapshotLoader({
          snapshotPath: value.snapshotPath,
          sha256: `sha256:${"0".repeat(64)}`,
        }),
    ).toThrowError(
      expect.objectContaining({ code: CAPABILITY_DEPLOYMENT_ERROR_CODES.INVALID_VALUE }),
    );

    const unsupported = await writeSnapshot({ ...snapshot(), schemaVersion: "v0" });
    await expectDeploymentError(
      loader(unsupported.snapshotPath, unsupported.digest).load(),
      CAPABILITY_DEPLOYMENT_ERROR_CODES.INVALID_VALUE,
    );
  });

  it("rejects unknown fields recursively and duplicate capability identities", async () => {
    const unknown = await writeSnapshot({ ...snapshot(), unknown: true });
    await expectDeploymentError(
      loader(unknown.snapshotPath, unknown.digest).load(),
      CAPABILITY_DEPLOYMENT_ERROR_CODES.UNKNOWN_FIELD,
    );

    const nestedUnknown = await writeSnapshot(
      snapshot([processEntry({ manifest: { unexpected: true } })]),
    );
    await expectDeploymentError(
      loader(nestedUnknown.snapshotPath, nestedUnknown.digest).load(),
      CAPABILITY_DEPLOYMENT_ERROR_CODES.UNKNOWN_FIELD,
    );

    const duplicate = await writeSnapshot(snapshot([processEntry(), processEntry()]));
    await expectDeploymentError(
      loader(duplicate.snapshotPath, duplicate.digest).load(),
      CAPABILITY_DEPLOYMENT_ERROR_CODES.DUPLICATE_CAPABILITY,
    );
  });

  it("requires a current production-suitable qualification", async () => {
    const wrongPlatform = await writeSnapshot(
      snapshot([
        processEntry({ qualification: { platform: PLATFORM === "darwin" ? "linux" : "darwin" } }),
      ]),
    );
    await expectDeploymentError(
      loader(wrongPlatform.snapshotPath, wrongPlatform.digest).load(),
      CAPABILITY_DEPLOYMENT_ERROR_CODES.PLATFORM_MISMATCH,
    );

    const notSuitable = await writeSnapshot(
      snapshot([processEntry({ qualification: { productionSuitable: false } })]),
    );
    await expectDeploymentError(
      loader(notSuitable.snapshotPath, notSuitable.digest).load(),
      CAPABILITY_DEPLOYMENT_ERROR_CODES.QUALIFICATION_INVALID,
    );

    const stale = await writeSnapshot(
      snapshot([processEntry({ qualification: { checkedAt: "2026-09-04T23:59:00.000Z" } })]),
    );
    await expectDeploymentError(
      loader(stale.snapshotPath, stale.digest, { maximumQualificationAgeMs: 1_000 }).load(),
      CAPABILITY_DEPLOYMENT_ERROR_CODES.QUALIFICATION_STALE,
    );

    const future = await writeSnapshot(
      snapshot([processEntry({ qualification: { checkedAt: "2026-09-05T00:00:01.000Z" } })]),
    );
    await expectDeploymentError(
      loader(future.snapshotPath, future.digest).load(),
      CAPABILITY_DEPLOYMENT_ERROR_CODES.QUALIFICATION_INVALID,
    );
  });

  it("rejects binding identity and semantic mismatches before producing a projection", async () => {
    const wrongIdentity = await writeSnapshot(
      snapshot([processEntry({ binding: { capabilityVersion: "2.0.0" } })]),
    );
    await expectDeploymentError(
      loader(wrongIdentity.snapshotPath, wrongIdentity.digest).load(),
      CAPABILITY_DEPLOYMENT_ERROR_CODES.BINDING_MISMATCH,
    );

    const wrongCommand = await writeSnapshot(
      snapshot([processEntry({ binding: { command: "/bin/other" } })]),
    );
    await expectDeploymentError(
      loader(wrongCommand.snapshotPath, wrongCommand.digest).load(),
      CAPABILITY_DEPLOYMENT_ERROR_CODES.BINDING_MISMATCH,
    );

    const wrongKind = await writeSnapshot({
      ...snapshot(),
      capabilities: [
        {
          ...processEntry(),
          binding: {
            kind: "endpoint",
            value: {
              endpointIdentity: "fixture-endpoint",
              artifactDigest: DIGEST,
              url: "https://capability.example.test",
              allowedMethods: ["POST"],
              operations: {
                execute: { method: "POST", path: "/execute", secretHeaders: {} },
              },
              productionSuitable: true,
              allowLoopbackQualification: false,
            },
          },
        },
      ],
    });
    await expectDeploymentError(
      loader(wrongKind.snapshotPath, wrongKind.digest).load(),
      CAPABILITY_DEPLOYMENT_ERROR_CODES.BINDING_MISMATCH,
    );
  });
});

it("keeps an unchanged boot admission usable while rejecting stale boots and changed files", async () => {
  const value = await writeSnapshot(snapshot([processEntry()]));
  const admitted = await loader(value.snapshotPath, value.digest).load();
  await expectDeploymentError(
    loader(value.snapshotPath, value.digest, { now: () => "2026-09-05T01:00:00.000Z" }).load(),
    CAPABILITY_DEPLOYMENT_ERROR_CODES.QUALIFICATION_STALE,
  );
  expect(await revalidateCapabilityDeploymentSnapshot(admitted)).toBe(admitted);
  await writeFile(value.snapshotPath, JSON.stringify(snapshot([endpointEntry()])));
  await expectDeploymentError(
    revalidateCapabilityDeploymentSnapshot(admitted),
    CAPABILITY_DEPLOYMENT_ERROR_CODES.DIGEST_MISMATCH,
  );
});
