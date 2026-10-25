import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runAdminCli } from "../../apps/admin-cli/src/index.ts";

type Json = Record<string, unknown>;

const PLATFORM = process.platform === "darwin" ? "darwin" : "linux";
const HOST = "host:upgrade-fixture";
const PROFILE = "host-readonly.v1";
const RUNTIME_DIGEST = "d".repeat(64);
const EVIDENCE_DIGEST = "f".repeat(64);
const RELEASE_4 = "/opt/himawari/releases/fourth/capabilities";
const RELEASE_5 = "/opt/himawari/releases/fifth/capabilities";
const PI_4 = "1".repeat(64);
const PI_5 = "3".repeat(64);
const EXA = "2".repeat(64);
const CEILING = {
  maxWallTimeMs: 10_000,
  maxCpuTimeMs: 10_000,
  maxMemoryBytes: 64 * 1024 * 1024,
  maxOutputBytes: 16_384,
  maxProgressEvents: 32,
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Capability {
  readonly ref: string;
  readonly runtimeRoot: string;
  readonly runner: string;
  readonly checkedAt: string;
  readonly reviewedAt?: string;
  readonly evidenceDigest?: string;
  readonly executable?: string;
  readonly runnerPath?: string;
  readonly change?: (manifest: Json) => void;
}

function at(offsetMs: number, base: number): string {
  return new Date(base + offsetMs).toISOString();
}

function entry(capability: Capability, ownerId: string): Json {
  const digest = `sha256:${capability.runner}`;
  const executable = capability.executable ?? `${capability.runtimeRoot}/node/bin/node`;
  const runnerPath =
    capability.runnerPath ?? `${capability.runtimeRoot}/runners/${capability.ref}.mjs`;
  const manifest: Json = {
    manifestVersion: "capability.v2",
    ref: capability.ref,
    displayName: `Upgrade ${capability.ref}`,
    version: "1.0.0",
    source: {
      type: "program",
      locator: `artifact:${path.posix.basename(path.posix.dirname(capability.runtimeRoot))}-${capability.ref}`,
    },
    sourceIdentity: "publisher:himawari",
    integrity: digest,
    artifact: {
      digest,
      signatureStatus: "verified",
      signerRef: "signer:host-qualification",
      rollbackArtifactRef: null,
    },
    operations: ["execute"],
    permissionRefs: [],
    isolation: "sandbox",
    scopes: {
      dataClassifications: ["private"],
      network: [],
      filesystem: ["workspace:upgrade"],
      secrets: [],
    },
    cost: { currency: "USD", maxMicrosPerInvocation: 0 },
    health: { status: "healthy", checkedAt: capability.checkedAt },
    reviewedBy: ownerId,
    reviewedAt: capability.reviewedAt ?? capability.checkedAt,
    contractCompatibility: ["capability-conformance.v1"],
    runtime: {
      kind: "program",
      argv: [executable, runnerPath, HOST, "worker-upgrade"],
      environmentKeys: [],
      workdirRef: "workspace:upgrade",
      stdin: "protected_payload",
      stdout: "protected_payload",
      subprocesses: [],
      network: [],
      filesystem: ["workspace:upgrade"],
    },
  };
  capability.change?.(manifest);
  return {
    manifest,
    qualification: {
      qualificationVersion: "capability-runtime-qualification.v1",
      platform: PLATFORM,
      runtimeIdentity: "srt:0.0.75",
      productionSuitable: true,
      artifactDigest: manifest["integrity"],
      enforcement: {
        filesystem: true,
        network: true,
        processes: true,
        secrets: true,
        resourceCeilings: false,
        termination: PLATFORM === "linux",
      },
      reasonCodes: [],
      checkedAt: capability.checkedAt,
      sandbox: {
        schemaVersion: "sandbox-runtime-qualification.v1",
        qualificationRef: "qualification:upgrade",
        hostId: HOST,
        profileRef: PROFILE,
        srtVersion: "0.0.75",
        platform: PLATFORM,
        architecture: PLATFORM === "darwin" ? "arm64" : "x64",
        osRelease: "27.0.0",
        runtimeDigest: RUNTIME_DIGEST,
        runnerDigest: capability.runner,
        evidenceDigest: capability.evidenceDigest ?? EVIDENCE_DIGEST,
        resourceMode: "observe_and_stop",
        terminationMode: PLATFORM === "darwin" ? "best_effort" : "verified_tree",
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
          ...(PLATFORM === "darwin"
            ? ["best_effort_stop"]
            : ["task_tree_termination", "worker_crash_cleanup"]),
        ],
        limitations: PLATFORM === "darwin" ? ["detached_descendants_may_survive_stop"] : [],
      },
    },
    binding: {
      kind: "sandbox",
      value: {
        schemaVersion: "sandbox-host-binding.v1",
        capabilityRef: capability.ref,
        capabilityVersion: manifest["version"],
        artifactDigest: manifest["integrity"],
        hostId: HOST,
        profileRef: PROFILE,
        runtimeRoot: capability.runtimeRoot,
        runtimeDigest: RUNTIME_DIGEST,
        executable: { path: executable, sha256: "a".repeat(64) },
        runner: { path: runnerPath, sha256: capability.runner },
        privateRoot: "/var/private-jobs",
        roots: [
          {
            canonicalRootId: "root:upgrade",
            canonicalPath: "/work/project",
            device: "1",
            inode: "2",
          },
        ],
        readOnlyToolchainPaths: ["/usr/bin"],
        protectedPaths: [],
        allowedDomains: [],
        maximumResourceCeiling: { ...CEILING },
      },
    },
  };
}

async function cli(...args: string[]) {
  let output = "";
  let errors = "";
  const stdout = new Writable({
    write(chunk, _encoding, done) {
      output += String(chunk);
      done();
    },
  });
  const stderr = new Writable({
    write(chunk, _encoding, done) {
      errors += String(chunk);
      done();
    },
  });
  const code = await runAdminCli(args, stdout, stderr);
  return {
    code,
    output: output ? (JSON.parse(output) as Json) : undefined,
    error: errors ? (JSON.parse(errors) as { error: { code: string } }).error.code : undefined,
  };
}

async function installation() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "himawari-capability-upgrade-")));
  roots.push(root);
  const source = JSON.parse(
    await readFile(new URL("./fixtures/file-summary/configuration.json", import.meta.url), "utf8"),
  ) as Json & { ownerId: string; memory: Json };
  const stateRoot = path.join(root, "state");
  const configuration = {
    ...source,
    stateRoot,
    runtimeDirectory: path.join(stateRoot, "runtime"),
    cacheDirectory: path.join(stateRoot, "cache"),
    memory: { ...source.memory, storagePath: path.join(stateRoot, "data", "memory") },
  };
  const initial = path.join(root, "initial.json");
  await writeFile(initial, JSON.stringify(configuration), { mode: 0o600 });
  expect((await cli("init", "--config", initial)).code).toBe(0);
  let written = 0;
  const snapshot = async (capabilities: readonly Capability[]) => {
    written += 1;
    const bytes = Buffer.from(
      JSON.stringify({
        schemaVersion: "capability-deployment.v1",
        capabilities: capabilities.map((capability) => entry(capability, source.ownerId)),
      }),
      "utf8",
    );
    const snapshotPath = path.join(root, `snapshot-${written}.json`);
    await writeFile(snapshotPath, bytes, { mode: 0o600 });
    await chmod(snapshotPath, 0o600);
    const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const configPath = path.join(root, `configuration-${written}.json`);
    await writeFile(
      configPath,
      JSON.stringify({ ...configuration, capabilityDeployment: { snapshotPath, sha256 } }),
      { mode: 0o600 },
    );
    await chmod(configPath, 0o600);
    return { configPath, sha256, entries: capabilities.map((c) => entry(c, source.ownerId)) };
  };
  const register = async (deployment: { configPath: string; sha256: string }) =>
    cli(
      "capabilities",
      "register",
      "--config",
      deployment.configPath,
      "--confirm",
      deployment.sha256,
    );
  const plan = async (deployment: { configPath: string }) =>
    cli("capabilities", "upgrade-plan", "--config", deployment.configPath);
  const upgrade = async (deployment: { configPath: string }, planDigest: string) =>
    cli("capabilities", "upgrade", "--config", deployment.configPath, "--confirm", planDigest);
  const readback = () => {
    const database = openQualifiedDatabase(path.join(stateRoot, "data", "product.sqlite"));
    try {
      return {
        capabilities: (
          database
            .prepare(
              "SELECT id, revision, integrity, status, record_json AS recordJson FROM capability_declarations ORDER BY id",
            )
            .all() as {
            id: string;
            revision: number;
            integrity: string;
            status: string;
            recordJson: string;
          }[]
        ).map(({ recordJson, ...row }) => ({ ...row, record: JSON.parse(recordJson) as Json })),
        audit: database
          .prepare(
            "SELECT action, target_ref AS targetRef, outcome FROM audit_records WHERE action LIKE 'owner.capability.%' ORDER BY rowid",
          )
          .all(),
      };
    } finally {
      database.close();
    }
  };
  return { root, ownerId: source.ownerId, snapshot, register, plan, upgrade, readback };
}

const base = () => Date.now() - 120_000;

function fourth(start: number): Capability[] {
  return [
    { ref: "pi", runtimeRoot: RELEASE_4, runner: PI_4, checkedAt: at(0, start) },
    { ref: "exa", runtimeRoot: RELEASE_4, runner: EXA, checkedAt: at(0, start) },
  ];
}

function fifth(
  start: number,
  pi: Partial<Capability> = {},
  exa: Partial<Capability> = {},
): Capability[] {
  return [
    {
      ref: "pi",
      runtimeRoot: RELEASE_5,
      runner: PI_5,
      checkedAt: at(60_000, start),
      reviewedAt: at(30_000, start),
      ...pi,
    },
    {
      ref: "exa",
      runtimeRoot: RELEASE_4,
      runner: EXA,
      checkedAt: at(0, start),
      ...exa,
    },
  ];
}

describe("[R2-L11] owner-confirmed capability runner upgrade", () => {
  it("[R2-L11] upgrades a same-version runner and installation directory after the owner confirms the plan", async () => {
    const start = base();
    const state = await installation();
    const registered = await state.snapshot(fourth(start));
    expect(await state.register(registered)).toMatchObject({
      code: 0,
      output: { created: ["pi", "exa"], existing: 0 },
    });
    const before = state.readback();
    const candidate = await state.snapshot(fifth(start));

    const planned = await state.plan(candidate);
    expect(planned).toMatchObject({ code: 0, error: undefined });
    expect(planned.output).toEqual({
      snapshotDigest: candidate.sha256,
      planDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      upgrades: [
        {
          ref: "pi",
          version: "1.0.0",
          fromIntegrity: `sha256:${PI_4}`,
          toIntegrity: `sha256:${PI_5}`,
          fromRuntimeRoot: RELEASE_4,
          toRuntimeRoot: RELEASE_5,
        },
      ],
      current: ["exa"],
    });
    expect(state.readback()).toEqual(before);

    const planDigest = String(planned.output?.["planDigest"]);
    expect(await state.upgrade(candidate, planDigest)).toEqual({
      code: 0,
      output: {
        snapshotDigest: candidate.sha256,
        planDigest,
        upgraded: ["pi"],
        current: ["exa"],
      },
      error: undefined,
    });
    const after = state.readback();
    const [exaAfter, piAfter] = after.capabilities;
    expect(exaAfter).toEqual(before.capabilities[0]);
    const piBefore = before.capabilities[1]?.record as Json;
    const candidatePi = candidate.entries[0] as Json;
    expect(piAfter).toMatchObject({
      id: "pi",
      revision: 2,
      integrity: `sha256:${PI_5}`,
      status: "active",
    });
    expect(piAfter?.record).toEqual({
      ...piBefore,
      revision: 2,
      lifecycle: "active",
      declaration: candidatePi["manifest"],
      runtimeQualification: candidatePi["qualification"],
      rollbackDeclaration: piBefore["declaration"],
      rollbackQualification: piBefore["runtimeQualification"],
      lastVersionTransition: {
        fromVersion: "1.0.0",
        toVersion: "1.0.0",
        outcome: "activated",
        occurredAt: expect.any(String),
        qualification: candidatePi["qualification"],
        externalEffectsRolledBack: false,
        productStateRolledBack: false,
      },
      pendingDeclaration: null,
      pendingUpdateAssessment: null,
      permissionExpansion: false,
      updatedAt: expect.any(String),
    });
    expect(after.audit).toEqual([
      ...before.audit,
      { action: "owner.capability.upgrade", targetRef: "pi", outcome: "completed" },
    ]);

    expect(await state.register(candidate)).toMatchObject({
      code: 0,
      output: { created: [], existing: 2 },
    });
    expect(await state.upgrade(candidate, planDigest)).toMatchObject({
      code: 1,
      error: "ADMIN_CAPABILITY_PLAN_MISMATCH",
    });
    const replanned = await state.plan(candidate);
    expect(replanned.output).toMatchObject({ upgrades: [], current: ["pi", "exa"] });
    expect(await state.upgrade(candidate, String(replanned.output?.["planDigest"]))).toMatchObject({
      code: 0,
      output: { upgraded: [], current: ["pi", "exa"] },
    });
    expect(state.readback()).toEqual(after);
  });

  it("[R2-L11] rejects malformed commands and an unconfirmed plan without writing", async () => {
    const start = base();
    const state = await installation();
    const registered = await state.snapshot(fourth(start));
    await state.register(registered);
    const before = state.readback();
    const candidate = await state.snapshot(fifth(start));
    const planDigest = String((await state.plan(candidate)).output?.["planDigest"]);
    for (const args of [
      ["capabilities", "upgrade-plan", "--config"],
      ["capabilities", "upgrade-plan", "--config", "relative.json"],
      ["capabilities", "upgrade-plan", "--config", candidate.configPath, "--confirm", planDigest],
      ["capabilities", "upgrade", "--config", candidate.configPath],
      ["capabilities", "upgrade", "--config", candidate.configPath, "--force", planDigest],
      ["capabilities", "upgrade", "--config", candidate.configPath, "--confirm", planDigest, "x"],
    ]) {
      expect(await cli(...args)).toMatchObject({
        code: 1,
        error: "ADMIN_CAPABILITIES_INPUT_INVALID",
      });
    }
    expect(await state.upgrade(candidate, `sha256:${"0".repeat(64)}`)).toMatchObject({
      code: 1,
      error: "ADMIN_CAPABILITY_PLAN_MISMATCH",
    });
    const foreign = await state.snapshot(
      fifth(start, { change: (manifest) => Object.assign(manifest, { reviewedBy: "someone" }) }),
    );
    expect(await state.plan(foreign)).toMatchObject({
      code: 1,
      error: "ADMIN_CAPABILITIES_INPUT_INVALID",
    });
    expect(state.readback()).toEqual(before);
  });

  it.each<[string, (manifest: Json) => void]>([
    ["display name", (manifest) => Object.assign(manifest, { displayName: "Renamed" })],
    ["version", (manifest) => Object.assign(manifest, { version: "1.0.1" })],
    ["operations", (manifest) => Object.assign(manifest, { operations: ["execute", "write"] })],
    [
      "data scope",
      (manifest) =>
        Object.assign(manifest, {
          scopes: {
            ...(manifest["scopes"] as Json),
            dataClassifications: ["private", "sensitive"],
          },
        }),
    ],
    [
      "signer",
      (manifest) =>
        Object.assign(manifest, {
          artifact: { ...(manifest["artifact"] as Json), signerRef: "signer:other" },
        }),
    ],
    [
      "host argument",
      (manifest) => {
        const runtime = manifest["runtime"] as { argv: string[] };
        runtime.argv[2] = "host:other";
      },
    ],
    [
      "environment",
      (manifest) =>
        Object.assign(manifest, {
          runtime: { ...(manifest["runtime"] as Json), environmentKeys: ["HOME"] },
        }),
    ],
  ])("[R2-L11] requires a new registration review when the %s changes", async (_field, change) => {
    const start = base();
    const state = await installation();
    await state.register(await state.snapshot(fourth(start)));
    const before = state.readback();
    expect(await state.plan(await state.snapshot(fifth(start, { change })))).toMatchObject({
      code: 1,
      error: "ADMIN_CAPABILITY_REVIEW_REQUIRED",
    });
    expect(state.readback()).toEqual(before);
  });

  it.each<[string, Partial<Capability>]>([
    ["a renamed runner inside the installation", { runnerPath: `${RELEASE_5}/runners/pi-v2.mjs` }],
    [
      "executable and runner from different old directories",
      { executable: `${RELEASE_5}/bin/node` },
    ],
    ["an executable that moved outside the installation", { executable: "/usr/bin/node" }],
  ])("[R2-L11] rejects %s", async (_case, pi) => {
    const start = base();
    const state = await installation();
    await state.register(await state.snapshot(fourth(start)));
    const before = state.readback();
    expect(await state.plan(await state.snapshot(fifth(start, pi)))).toMatchObject({
      code: 1,
      error: "ADMIN_CAPABILITY_REVIEW_REQUIRED",
    });
    expect(state.readback()).toEqual(before);
  });

  it("[R2-L11] rejects an executable path that is the installation directory itself", async () => {
    const start = base();
    const state = await installation();
    const registered = await state.register(
      await state.snapshot(
        fourth(start).map((capability) =>
          capability.ref === "pi" ? { ...capability, executable: RELEASE_4 } : capability,
        ),
      ),
    );
    expect(registered.code).toBe(0);
    const before = state.readback();
    expect(before.capabilities.map((row) => row.id)).toEqual(["exa", "pi"]);
    expect(
      await state.plan(await state.snapshot(fifth(start, { executable: RELEASE_5 }))),
    ).toMatchObject({ code: 1, error: "ADMIN_CAPABILITY_REVIEW_REQUIRED" });
    expect(state.readback()).toEqual(before);
  });

  it("[R2-L11] refuses capabilities that were never registered or are not active", async () => {
    const start = base();
    const state = await installation();
    const [, exa] = fourth(start);
    if (!exa) throw new Error("missing fixture capability");
    await state.register(await state.snapshot([exa]));
    const candidate = await state.snapshot(fifth(start));
    expect(await state.plan(candidate)).toMatchObject({
      code: 1,
      error: "ADMIN_CAPABILITY_NOT_REGISTERED",
    });

    const second = await installation();
    await second.register(await second.snapshot(fourth(start)));
    const database = openQualifiedDatabase(
      path.join(second.root, "state", "data", "product.sqlite"),
    );
    try {
      const row = database
        .prepare("SELECT record_json AS recordJson FROM capability_declarations WHERE id = 'pi'")
        .get() as { recordJson: string };
      database
        .prepare(
          "UPDATE capability_declarations SET status = 'disabled', record_json = ? WHERE id = 'pi'",
        )
        .run(JSON.stringify({ ...JSON.parse(row.recordJson), lifecycle: "disabled" }));
    } finally {
      database.close();
    }
    const before = second.readback();
    expect(await second.plan(await second.snapshot(fifth(start)))).toMatchObject({
      code: 1,
      error: "ADMIN_CAPABILITY_REVIEW_REQUIRED",
    });
    expect(second.readback()).toEqual(before);
  });

  it("[R2-L11] keeps the five-minute qualification limit for upgrades", async () => {
    const start = base();
    const state = await installation();
    await state.register(await state.snapshot(fourth(start)));
    const before = state.readback();
    const stale = await state.snapshot(fifth(start, { checkedAt: at(-6 * 60_000, Date.now()) }));
    expect(await state.plan(stale)).toMatchObject({
      code: 1,
      error: "CAPABILITY_DEPLOYMENT_QUALIFICATION_STALE",
    });
    expect(state.readback()).toEqual(before);
  });

  it("[R2-L11] binds the confirmation to stable content, not to the health check time", async () => {
    const start = base();
    const state = await installation();
    await state.register(await state.snapshot(fourth(start)));
    const first = await state.snapshot(fifth(start));
    const restarted = await state.snapshot(
      fifth(
        start,
        { checkedAt: at(61_000, start) },
        { checkedAt: at(61_000, start), reviewedAt: at(0, start) },
      ),
    );
    const requalified = await state.snapshot(fifth(start, { evidenceDigest: "e".repeat(64) }));
    const firstDigest = (await state.plan(first)).output?.["planDigest"];
    expect((await state.plan(restarted)).output?.["planDigest"]).toBe(firstDigest);
    expect((await state.plan(requalified)).output?.["planDigest"]).not.toBe(firstDigest);
    expect(await state.upgrade(restarted, String(firstDigest))).toMatchObject({
      code: 0,
      output: { upgraded: ["pi"], current: ["exa"] },
    });
  });

  it("[R2-L11] moves an unchanged runner into the new installation directory", async () => {
    const start = base();
    const state = await installation();
    await state.register(await state.snapshot(fourth(start)));
    const before = state.readback();
    const candidate = await state.snapshot(fifth(start, {}, { runtimeRoot: RELEASE_5 }));
    const planned = await state.plan(candidate);
    expect(planned.output).toMatchObject({
      upgrades: [
        { ref: "pi", fromRuntimeRoot: RELEASE_4, toRuntimeRoot: RELEASE_5 },
        {
          ref: "exa",
          fromIntegrity: `sha256:${EXA}`,
          toIntegrity: `sha256:${EXA}`,
          fromRuntimeRoot: RELEASE_4,
          toRuntimeRoot: RELEASE_5,
        },
      ],
      current: [],
    });
    expect(await state.upgrade(candidate, String(planned.output?.["planDigest"]))).toMatchObject({
      code: 0,
      output: { upgraded: ["pi", "exa"], current: [] },
    });
    const after = state.readback();
    const exa = after.capabilities[0];
    expect(exa).toMatchObject({ id: "exa", revision: 2, integrity: `sha256:${EXA}` });
    expect(exa?.record["declaration"]).toEqual((candidate.entries[1] as Json)["manifest"]);
    expect(after.audit).toEqual([
      ...before.audit,
      { action: "owner.capability.upgrade", targetRef: "pi", outcome: "completed" },
      { action: "owner.capability.upgrade", targetRef: "exa", outcome: "completed" },
    ]);
  });
});
