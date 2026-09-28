import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import type { SandboxExecutionRecord } from "@himawari-agent/application";
import { ApplicationPortError, type PortErrorCode } from "@himawari-agent/application";
import {
  acquireStateRootLock,
  SqliteRunPayloadArtifactOperations,
} from "@himawari-agent/persistence-sqlite";
import {
  CONFIGURATION_SCHEMA_VERSION,
  EnvelopePayloadProtector,
  InMemoryDevelopmentSecretSource,
  initializeStateRoot,
} from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import { runAdminCli } from "../../apps/admin-cli/src/index.ts";
import {
  sandboxV2Admission as admission,
  sandboxV2Call as call,
} from "../fixtures/sandbox-execution-v2-fixture.ts";
import {
  AGENT_ID,
  OWNER_ID,
  openSandboxJournal,
  RUN_ID,
  SERVICE_AUTHORITY,
  T1,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

const roots: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sink() {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk.toString();
        callback();
      },
    }),
    value: () => value,
  };
}

function configuration(stateRoot: string) {
  const model = (ref: string, role: "primary" | "fallback" | "embedding") =>
    role === "embedding"
      ? {
          ref,
          role,
          provider: "provider-local",
          model: ref,
          version: "snapshot-1",
          capabilities: ["embedding"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          dimensions: 1536,
          allowedDataClassifications: ["public", "private", "sensitive", "restricted"],
          disclosure: "local_only",
          secretRef: null,
        }
      : {
          ref,
          role,
          provider: "provider-local",
          model: ref,
          version: "snapshot-1",
          priority: role === "primary" ? 1 : 2,
          name: role === "primary" ? "Primary fixture" : "Fallback fixture",
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          capabilities: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 1024,
          allowedDataClassifications: role === "fallback" ? ["private"] : ["public", "private"],
          disclosure: "local_only",
          secretRef: null,
        };
  return {
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    deploymentId: SERVICE_AUTHORITY.product.deploymentId,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    stateRoot,
    runtimeDirectory: path.join(stateRoot, "runtime"),
    cacheDirectory: path.join(stateRoot, "cache"),
    publicOrigin: "http://127.0.0.1",
    publicMode: false,
    modelDescriptors: [
      model("model-primary", "primary"),
      model("model-fallback", "fallback"),
      model("model-embedding", "embedding"),
    ],
    memory: {
      adapter: "mem0-oss",
      version: "3.1.7",
      storagePath: path.join(stateRoot, "data", "memory"),
      dimensions: 1536,
    },
    repositoryAllowlistRefs: [],
    secretReferences: [
      { ref: "payload-kek", version: "v1", purpose: "payload-encryption", scope: "agent" },
    ],
    budgets: {
      globalCostMicros: 0,
      perRunCostMicros: 0,
      perClassificationCostMicros: { public: 0, private: 0, sensitive: 0, restricted: 0 },
    },
    concurrency: { totalRuns: 1, foregroundReserved: 1, perCategory: {} },
    deadlines: { runMs: 1_000, workerRequestMs: 1_000, providerRequestMs: 1_000 },
  };
}

const CONTROL = `sandbox-control:${"a".repeat(64)}`;
const DIAGNOSTICS = {
  "runtime-tool-diagnostic:operation-cancelled": {
    stage: "accepted",
    reasonCode: "WORKER_CANCELLATION_OBSERVED",
  },
  [`${CONTROL}:diagnostic:host-unreachable`]: {
    command: "inspect",
    stage: "host",
    reasonCode: "SANDBOX_HOST_UNREACHABLE",
    diagnostic: { name: "Error", message: "connect ENOENT control.sock" },
  },
  [`${CONTROL}:observation:3`]: {
    resourceSequence: 3,
    observation: { phase: "finished", taskProcessExited: true },
  },
} as const;

async function diagnosedState() {
  const f = await openSandboxJournal();
  cleanups.push(f.close);
  const admitted = call(f, "admit", admission(f)).record;
  call(f, "start", {
    identity: admitted.plan.identity,
    expectedSequence: 1,
    policyDigest: admitted.facts.environment.policyDigest,
    authority: SERVICE_AUTHORITY,
    now: T1,
  });
  const record = call(f, "read", admitted.plan.identity) as SandboxExecutionRecord;
  const artifacts = new SqliteRunPayloadArtifactOperations(
    f.database,
    (code, message) => {
      throw new ApplicationPortError(code as PortErrorCode, message);
    },
    () => undefined,
  );
  const commit = async (
    operationKey: string,
    purpose: "trace" | "context",
    value: unknown,
    kekVersion = "v1",
  ) => {
    const protector = new EnvelopePayloadProtector({
      keys: new InMemoryDevelopmentSecretSource({
        [`payload-kek@${kekVersion}`]: new Uint8Array(32).fill(kekVersion === "v1" ? 0x11 : 0x33),
      }),
      activeKey: { keyRef: "payload-kek", kekVersion, dekVersion: "dek-v1" },
    });
    const payload = await protector.protect({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      ref: `payload-${operationKey}`,
      dataClassification: "private",
      contentType: "application/json",
      plaintext: new TextEncoder().encode(JSON.stringify(value)),
      createdAt: T1,
    });
    artifacts.execute("runPayloadArtifact.commit", {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      purpose,
      operationKey,
      payload,
      authority: {
        product: SERVICE_AUTHORITY.product,
        leaseId: SERVICE_AUTHORITY.lease.leaseId,
        leaseFencingToken: SERVICE_AUTHORITY.lease.fencingToken,
      },
      now: T1,
    });
  };
  for (const [operationKey, value] of Object.entries(DIAGNOSTICS))
    await commit(operationKey, "trace", value);
  await commit("runtime-tool-diagnostic:rotated-key", "trace", { stage: "lost" }, "v2");
  await commit(CONTROL, "trace", { control: { token: "SECRET-CONTROL-TOKEN" } });
  await commit("model-input:turn-1", "context", { text: "PRIVATE-MODEL-INPUT" });
  const observations = f.database
    .prepare(
      `SELECT sequence, json_extract(facts_json,'$.resource.supervision') AS supervision
       FROM sandbox_execution_observations WHERE job_id=? ORDER BY sequence`,
    )
    .all(record.plan.identity.jobId);
  f.database.pragma("wal_checkpoint(TRUNCATE)");

  const root = await mkdtemp(path.join(tmpdir(), "himawari-admin-diagnose-"));
  roots.push(root);
  const layout = await initializeStateRoot(path.join(root, "state"));
  await copyFile(
    path.join(f.resource.stateRoot, "product.sqlite"),
    path.join(layout.data, "product.sqlite"),
  );
  const configurationPath = path.join(root, "configuration.json");
  await writeFile(
    configurationPath,
    `${JSON.stringify(configuration(path.join(root, "state")))}\n`,
    { mode: 0o600 },
  );
  const secretDirectory = path.join(root, "secrets");
  await mkdir(secretDirectory, { mode: 0o700 });
  await writeFile(path.join(secretDirectory, "payload-kek.v1"), "11".repeat(32), { mode: 0o600 });
  return { record, observations, configurationPath, secretDirectory, stateRoot: layout.root };
}

describe("himawari diagnose run", () => {
  it("prints one run's sandbox journal and decrypted diagnostics while the service holds the state lock", async () => {
    const state = await diagnosedState();
    const lock = await acquireStateRootLock(state.stateRoot);
    cleanups.push(() => lock.release());
    const output = sink();
    const errors = sink();

    const exitCode = await runAdminCli(
      [
        "diagnose",
        "run",
        "--config",
        state.configurationPath,
        "--secret-dir",
        state.secretDirectory,
        "--run",
        RUN_ID,
      ],
      output.stream,
      errors.stream,
    );

    expect(errors.value()).toBe("");
    expect(exitCode).toBe(0);
    const report = JSON.parse(output.value());
    expect(report).toMatchObject({
      outputSchemaVersion: 1,
      command: "diagnose.run",
      run: { id: RUN_ID },
    });
    expect(report.sandboxJobs).toHaveLength(1);
    expect(report.sandboxJobs[0]).toMatchObject({
      jobId: state.record.plan.identity.jobId,
      toolCallId: state.record.plan.identity.toolCallId,
      sequence: state.record.facts.resource.sequence,
      supervision: state.record.facts.resource.supervision,
      cleanup: state.record.facts.resource.cleanup,
      recovery: null,
      intents: [],
    });
    expect(
      report.sandboxJobs[0].observations.map(
        (observation: { sequence: number; supervision: string }) => ({
          sequence: observation.sequence,
          supervision: observation.supervision,
        }),
      ),
    ).toEqual(state.observations);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining(
        Object.entries(DIAGNOSTICS).map(([operationKey, content]) => ({
          operationKey,
          createdAt: T1,
          content,
        })),
      ),
    );
    expect(report.diagnostics).toContainEqual({
      operationKey: "runtime-tool-diagnostic:rotated-key",
      createdAt: T1,
      errorCode: "PAYLOAD_KEY_UNAVAILABLE",
    });
    expect(report.diagnostics).toHaveLength(4);
    expect(output.value()).not.toContain("SECRET-CONTROL-TOKEN");
    expect(output.value()).not.toContain("PRIVATE-MODEL-INPUT");
  });

  it("rejects an unknown run and missing arguments without printing any record", async () => {
    const state = await diagnosedState();
    const run = async (args: readonly string[]) => {
      const output = sink();
      const errors = sink();
      const exitCode = await runAdminCli(args, output.stream, errors.stream);
      return { exitCode, output: output.value(), error: JSON.parse(errors.value()).error.code };
    };

    await expect(
      run([
        "diagnose",
        "run",
        "--config",
        state.configurationPath,
        "--secret-dir",
        state.secretDirectory,
        "--run",
        "run:missing",
      ]),
    ).resolves.toEqual({ exitCode: 1, output: "", error: "ADMIN_RUN_NOT_FOUND" });
    await expect(
      run(["diagnose", "run", "--config", state.configurationPath, "--run", RUN_ID]),
    ).resolves.toEqual({ exitCode: 1, output: "", error: "ADMIN_ARGUMENT_INVALID" });
  });
});
