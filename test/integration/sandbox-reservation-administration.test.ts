import { spawnSync } from "node:child_process";
import { mkdir, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import {
  ApplicationPortError,
  type PortErrorCode,
  type SandboxExecutionPreparationPort,
} from "@himawari-agent/application";
import { isSandboxReservationNeverStarted } from "@himawari-agent/application/sandbox-execution-projection";
import { createRunExecutionLeaseId } from "@himawari-agent/domain";
import { sandboxExecutionReservationSchema } from "@himawari-agent/execution-contracts";
import {
  acquireStateRootLock,
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import { CONFIGURATION_SCHEMA_VERSION } from "@himawari-agent/platform-node";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { runAdminCli } from "../../apps/admin-cli/src/index.ts";
import { RUN_RESOURCES_RELEASED_SQL } from "../../packages/persistence-sqlite/src/sqlite-run-resource-guard.ts";
import { SqliteRunDispatchOperations } from "../../packages/persistence-sqlite/src/sqlite-run-dispatch-operations.ts";
import { SANDBOX_RESERVATION_NEVER_STARTED_SQL } from "../../packages/persistence-sqlite/src/sqlite-sandbox-reservation-never-started.ts";
import { sandboxV2Admission } from "../fixtures/sandbox-execution-v2-fixture.ts";
import {
  AGENT_ID,
  OTHER_AGENT_ID,
  OTHER_OWNER_ID,
  OWNER_ID,
  openSandboxJournal,
  operationsForDatabase,
  SERVICE_AUTHORITY,
  T1,
  T2,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

const CONFIRMATION = "HOST_GROUP_ABSENT_FINAL_ABSENT_RELATED_PROCESSES_ABSENT";
const ADMINISTRATOR = "administrator:fixture-operator";
const EVIDENCE = `sha256:${"a".repeat(64)}`;
const cleanups: (() => Promise<void>)[] = [];

type Database = ReturnType<typeof openQualifiedDatabase>;
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Row = Record<string, unknown>;
type Inspection = {
  command: string;
  digest: string;
  record: Row & { jobId: string; runId: string };
  confirmation: string;
};

afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

function configuration(stateRoot: string) {
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
      {
        ref: "model-primary",
        role: "primary",
        provider: "provider-local",
        model: "model-primary",
        version: "snapshot-1",
        priority: 1,
        name: "Primary fixture",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        capabilities: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
        allowedDataClassifications: ["public", "private"],
        disclosure: "local_only",
        secretRef: null,
      },
      {
        ref: "model-embedding",
        role: "embedding",
        provider: "provider-local",
        model: "model-embedding",
        version: "snapshot-1",
        capabilities: ["embedding"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        dimensions: 1536,
        allowedDataClassifications: ["public", "private", "sensitive", "restricted"],
        disclosure: "local_only",
        secretRef: null,
      },
    ],
    memory: {
      adapter: "mem0-oss",
      version: "3.3.1",
      storagePath: path.join(stateRoot, "data", "memory"),
      dimensions: 1536,
    },
    repositoryAllowlistRefs: [],
    secretReferences: [],
    budgets: {
      globalCostMicros: 0,
      perRunCostMicros: 0,
      perClassificationCostMicros: { public: 0, private: 0, sensitive: 0, restricted: 0 },
    },
    concurrency: { totalRuns: 1, foregroundReserved: 1, perCategory: {} },
    deadlines: { runMs: 1000, workerRequestMs: 1000, providerRequestMs: 1000 },
  };
}

function preparationCall<K extends keyof SandboxExecutionPreparationPort>(
  database: Database,
  method: K,
  input: Parameters<SandboxExecutionPreparationPort[K]>[0],
): Awaited<ReturnType<SandboxExecutionPreparationPort[K]>> {
  return operationsForDatabase(database).execute(`capabilityInvocation.sandboxV2.${method}`, {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    input,
  }) as Awaited<ReturnType<SandboxExecutionPreparationPort[K]>>;
}

async function fixture(options: { stopped?: boolean; bound?: boolean; schemaSequence?: 49 } = {}) {
  const seeded = await openSandboxJournal();
  cleanups.push(seeded.close);
  const request = sandboxV2Admission(seeded);
  const reservation = sandboxExecutionReservationSchema.parse({
    schemaVersion: "sandbox-preparation.v1",
    identity: request.plan.identity,
    environmentId: request.plan.environmentId,
    resourceRef: null,
    mode: request.plan.mode,
    workspaceConflictRefs: request.workspaces.map((claim) => claim.ref),
    sequence: 1,
    createdAt: request.plan.requestedAt,
  });
  const reserved = preparationCall(seeded.database, "reserve", { ...request, reservation });
  if (options.bound) {
    preparationCall(seeded.database, "bindAndStart", {
      identity: request.plan.identity,
      expectedSequence: 1,
      authority: SERVICE_AUTHORITY,
      now: T1,
      facts: {
        ...request.facts,
        environment: { ...request.facts.environment, policyDigest: "9".repeat(64) },
        resource: { ...request.facts.resource, policyDigest: "9".repeat(64), sequence: 2 },
      },
    });
  } else if (options.stopped !== false) {
    preparationCall(seeded.database, "interruptReservation", {
      identity: request.plan.identity,
      authority: SERVICE_AUTHORITY,
      now: T1,
      reasonCode: "SANDBOX_UNBOUND_ENVIRONMENT_UNKNOWN",
    });
  }
  seeded.database
    .prepare("UPDATE runs SET status='reconciling_external_result',revision=3 WHERE id=?")
    .run(request.plan.identity.runId);
  seeded.database
    .prepare("UPDATE threads SET revision=2 WHERE id=?")
    .run(request.plan.identity.threadId);
  seeded.database
    .prepare(`INSERT INTO run_coordination_checkpoints
      (run_id,owner_id,agent_id,revision,phase,context_ref,runtime_event_count,
       last_trace_event_id,terminal_status,output_kind,final_answer_ref,diagnostic_code,updated_at)
      VALUES (?,?,?,4,'reconciling_external_result','payload-capability-invocation-trigger',
        7,NULL,NULL,NULL,NULL,'RUNTIME_TOOL_RESULT_UNKNOWN',?)`)
    .run(request.plan.identity.runId, OWNER_ID, AGENT_ID, T1);
  seeded.database.pragma("wal_checkpoint(TRUNCATE)");
  seeded.database.close();
  const stateRoot = seeded.resource.stateRoot;
  await mkdir(path.join(stateRoot, "data"), { mode: 0o700 });
  const databasePath = path.join(stateRoot, "data", "product.sqlite");
  await rename(path.join(stateRoot, "product.sqlite"), databasePath);
  if (options.schemaSequence === 49) {
    const source = openQualifiedDatabase(databasePath);
    const legacyPath = path.join(stateRoot, "data", "product-schema49.sqlite");
    const legacy = openQualifiedDatabase(legacyPath);
    try {
      applyMigrations(legacy, (await loadBundledMigrations()).slice(0, 49));
      legacy.pragma("foreign_keys=OFF");
      const tables = legacy
        .prepare(`SELECT name FROM sqlite_schema
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
          AND name NOT IN ('schema_migration_ledger','schema_metadata') ORDER BY name`)
        .pluck()
        .all() as string[];
      legacy
        .transaction(() => {
          for (const table of tables) {
            const rows = source.prepare(`SELECT * FROM ${table}`).all() as Row[];
            for (const row of rows) {
              const columns = Object.keys(row);
              legacy
                .prepare(`INSERT INTO ${table} (${columns.join(",")})
              VALUES (${columns.map(() => "?").join(",")})`)
                .run(...columns.map((column) => row[column]));
            }
          }
        })
        .immediate();
      legacy.pragma("foreign_keys=ON");
      expect(legacy.pragma("foreign_key_check")).toEqual([]);
      source.pragma("wal_checkpoint(TRUNCATE)");
      legacy.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      source.close();
      legacy.close();
    }
    await rename(legacyPath, databasePath);
  }
  const configurationPath = path.join(stateRoot, "configuration.json");
  await writeFile(configurationPath, JSON.stringify(configuration(stateRoot)), { mode: 0o600 });
  return { stateRoot, databasePath, configurationPath, request, admission: reserved.admission };
}

function withDatabase<T>(f: Fixture, read: (database: Database) => T): T {
  const database = openQualifiedDatabase(f.databasePath);
  try {
    return read(database);
  } finally {
    database.close();
  }
}

function snapshot(f: Fixture) {
  return withDatabase(f, (database) => {
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .pluck()
      .all() as string[];
    return Object.fromEntries(
      tables.map((table) => [
        table,
        database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    ) as Record<string, Row[]>;
  });
}

function auditWorkspaceLifecycle(f: Fixture) {
  const result = spawnSync(
    process.execPath,
    [
      path.resolve("scripts/operations/workspace-lifecycle-audit.mjs"),
      "--database",
      f.databasePath,
      "--owner",
      OWNER_ID,
      "--agent",
      AGENT_ID,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    mode: string;
    schemaSequence: number;
    liveHostVerified: boolean;
    repairEligible: boolean;
    rows: (Row & { reasons: string[]; requiredEvidence: string[] })[];
  };
}

function sink() {
  let content = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        content += chunk.toString();
        callback();
      },
    }),
    value: () => content,
  };
}

async function cli(args: string[]) {
  const output = sink();
  const error = sink();
  const code = await runAdminCli(args, output.stream, error.stream);
  const lines = output.value().trim().split("\n").filter(Boolean);
  return {
    code,
    output: output.value(),
    error: error.value(),
    result: lines.length ? JSON.parse(lines.at(-1) as string) : null,
  };
}

function inspectArgs(f: Fixture, jobId = f.request.plan.identity.jobId) {
  return ["sandbox", "inspect-reservation", "--config", f.configurationPath, "--job", jobId];
}

async function inspect(f: Fixture): Promise<Inspection> {
  const result = await cli(inspectArgs(f));
  expect(result).toMatchObject({ code: 0, error: "" });
  expect(result.result).toMatchObject({
    command: "sandbox.inspect-reservation",
    digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    record: { jobId: f.request.plan.identity.jobId, runId: f.request.plan.identity.runId },
    confirmation: CONFIRMATION,
  });
  return result.result as Inspection;
}

function confirmArgs(f: Fixture, digest: string) {
  return [
    "sandbox",
    "confirm-reservation-cleanup",
    "--config",
    f.configurationPath,
    "--job",
    f.request.plan.identity.jobId,
    "--digest",
    digest,
    "--administrator",
    ADMINISTRATOR,
    "--evidence",
    EVIDENCE,
    "--confirm",
    CONFIRMATION,
  ];
}

async function rejectsUnchanged(f: Fixture, args: string[], code: string) {
  const before = snapshot(f);
  expect(await cli(args)).toMatchObject({ code: 1, error: expect.stringContaining(code) });
  expect(snapshot(f)).toEqual(before);
}

function cloneRow(database: Database, table: string, key: string, value: string, changes: Row) {
  const row = database.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(value) as Row;
  if (!row) throw new Error("ADMINISTRATION_FIXTURE_ROW_MISSING");
  const copy = { ...row, ...changes };
  const columns = Object.keys(copy);
  database
    .prepare(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    )
    .run(...columns.map((column) => copy[column]));
}

function addOtherReservation(f: Fixture, database: Database) {
  const original = f.request.plan.identity;
  const identity = {
    ...original,
    jobId: "job-other-resource",
    attemptId: "attempt-other-resource",
    receiptRef: "receipt-other-resource",
    invocationId: "invocation-other-resource",
  };
  cloneRow(database, "capability_invocation_receipts", "receipt_ref", original.receiptRef, {
    receipt_ref: identity.receiptRef,
    invocation_id: identity.invocationId,
    idempotency_key: "idempotency-other-resource",
  });
  const row = database
    .prepare("SELECT plan_json,facts_json FROM sandbox_execution_records WHERE job_id=?")
    .get(original.jobId) as { plan_json: string; facts_json: string };
  const plan = {
    ...JSON.parse(row.plan_json),
    identity,
    environmentId: "environment-other-resource",
  };
  const facts = { ...JSON.parse(row.facts_json), identity, environmentId: plan.environmentId };
  cloneRow(database, "sandbox_execution_records", "job_id", original.jobId, {
    job_id: identity.jobId,
    attempt_id: identity.attemptId,
    receipt_ref: identity.receiptRef,
    invocation_id: identity.invocationId,
    environment_id: plan.environmentId,
    plan_json: JSON.stringify(plan),
    facts_json: JSON.stringify(facts),
  });
}

describe("[R2-L4][prod-sandbox-D2-admin] offline reservation administration", () => {
  it("seeds a stopped real reservation with preserved occupancy and an expired execution lease", async () => {
    const f = await fixture();
    withDatabase(f, (database) => {
      const admission = preparationCall(database, "readAdmission", f.request.plan.identity);
      expect(admission).toMatchObject({ phase: "reserved", stopRequestedAt: T1 });
      expect(
        database.prepare("SELECT started_at FROM sandbox_execution_records").pluck().get(),
      ).toBeNull();
      expect(
        database.prepare("SELECT released_at FROM sandbox_workspace_occupancy").pluck().get(),
      ).toBeNull();
      expect(database.prepare("SELECT expires_at FROM run_execution_leases").pluck().get()).toBe(
        T2,
      );
      expect(
        database.prepare("SELECT count(*) FROM sandbox_reservation_release_receipts").pluck().get(),
      ).toBe(0);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    });
  });

  it("inspects one scoped reservation without changing rows, taking the service lock or claiming host proof", async () => {
    const f = await fixture();
    const before = snapshot(f);
    const files = await readdir(f.stateRoot);
    const lock = await acquireStateRootLock(f.stateRoot);
    try {
      const first = await inspect(f);
      expect(await inspect(f)).toEqual(first);
      expect(snapshot(f)).toEqual(before);
      expect(first.record).not.toHaveProperty("hostGroupAbsent", true);
      expect(first.record).not.toHaveProperty("finalAbsent", true);
      expect(first.record).not.toHaveProperty("relatedProcessesAbsent", true);
    } finally {
      await lock.release();
    }
    expect(await readdir(f.stateRoot)).toEqual(files);
  });

  it.each([
    ["--job", "../private-job", "ADMIN_ARGUMENT_INVALID"],
    ["--administrator", "", "ADMIN_ARGUMENT_INVALID"],
    ["--administrator", "private administrator note", "ADMIN_ARGUMENT_INVALID"],
    ["--administrator", "../administrator", "ADMIN_ARGUMENT_INVALID"],
    ["--evidence", "", "ADMIN_ARGUMENT_INVALID"],
    ["--evidence", "missing-evidence", "ADMIN_ARGUMENT_INVALID"],
    ["--evidence", `sha256:${"a".repeat(63)}`, "ADMIN_ARGUMENT_INVALID"],
    ["--digest", "unconfirmed", "ADMIN_ARGUMENT_INVALID"],
    ["--confirm", "", "ADMIN_CONFIRMATION_REQUIRED"],
    ["--confirm", "HOST_GROUP_ABSENT", "ADMIN_CONFIRMATION_REQUIRED"],
  ])("rejects invalid %s value %s without writing", async (flag, value, code) => {
    const f = await fixture();
    const listed = await inspect(f);
    const args = confirmArgs(f, listed.digest);
    const index = args.indexOf(flag);
    args[index + 1] = value;
    await rejectsUnchanged(f, args, code);
  });

  it.each([
    ["inspect-reservation", "path-like", "../private-job"],
    ["inspect-reservation", "multiline", "job-private\nADMINISTRATION_FIXTURE_PRIVATE_BODY"],
    ["confirm-reservation-cleanup", "path-like", "../private-job"],
    [
      "confirm-reservation-cleanup",
      "multiline",
      "job-private\nADMINISTRATION_FIXTURE_PRIVATE_BODY",
    ],
  ])(
    "rejects %s %s Job IDs without disclosing them in CLI records",
    async (command, _kind, jobId) => {
      const f = await fixture();
      const listed = await inspect(f);
      const args =
        command === "inspect-reservation" ? inspectArgs(f) : confirmArgs(f, listed.digest);
      args[args.indexOf("--job") + 1] = jobId;
      const before = snapshot(f);
      const result = await cli(args);
      expect(result).toMatchObject({
        code: 1,
        error: expect.stringContaining("ADMIN_ARGUMENT_INVALID"),
      });
      expect(snapshot(f)).toEqual(before);
      const records = [result.output, result.error].flatMap((content) =>
        content
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown),
      );
      const serializedRecords = JSON.stringify(records);
      expect(serializedRecords).not.toContain(JSON.stringify(jobId).slice(1, -1));
      for (const fragment of jobId.split("\n")) expect(serializedRecords).not.toContain(fragment);
    },
  );

  it.each(["--digest", "--administrator", "--evidence", "--confirm"])(
    "requires %s explicitly",
    async (flag) => {
      const f = await fixture();
      const listed = await inspect(f);
      const args = confirmArgs(f, listed.digest);
      args.splice(args.indexOf(flag), 2);
      await rejectsUnchanged(
        f,
        args,
        flag === "--confirm" ? "ADMIN_CONFIRMATION_REQUIRED" : "ADMIN_ARGUMENT_INVALID",
      );
    },
  );

  it("refuses mutation while a live service owns the state root", async () => {
    const f = await fixture();
    const listed = await inspect(f);
    const lock = await acquireStateRootLock(f.stateRoot);
    try {
      await rejectsUnchanged(f, confirmArgs(f, listed.digest), "ADMIN_TARGET_NOT_STOPPED");
    } finally {
      await lock.release();
    }
  });

  it.each(["database outside state root", "different root containing original database"])(
    "rejects a static symlink binding to %s without writing",
    async (binding) => {
      const f = await fixture();
      const listed = await inspect(f);
      if (binding === "database outside state root") {
        const heldPath = path.join(f.stateRoot, "held-product.sqlite");
        await rename(f.databasePath, heldPath);
        await symlink(heldPath, f.databasePath);
      } else {
        const targetRoot = path.join(f.stateRoot, "different-state-root");
        await mkdir(path.join(targetRoot, "data"), { recursive: true, mode: 0o700 });
        await symlink(f.databasePath, path.join(targetRoot, "data", "product.sqlite"));
        const aliasRoot = path.join(f.stateRoot, "alias-state-root");
        await symlink(targetRoot, aliasRoot);
        await writeFile(f.configurationPath, JSON.stringify(configuration(aliasRoot)), {
          mode: 0o600,
        });
      }
      await rejectsUnchanged(f, inspectArgs(f), "ADMIN_ARGUMENT_INVALID");
      await rejectsUnchanged(f, confirmArgs(f, listed.digest), "ADMIN_ARGUMENT_INVALID");
    },
  );

  it.each([
    ["run revision", "UPDATE runs SET revision=revision+1"],
    ["checkpoint revision", "UPDATE run_coordination_checkpoints SET revision=revision+1"],
    [
      "recovery revision",
      "UPDATE sandbox_execution_records SET recovery_json=json_set(recovery_json,'$.revision',2)",
    ],
    ["execution lease revision", "UPDATE run_execution_leases SET revision=revision+1"],
    [
      "occupancy claim",
      "UPDATE sandbox_workspace_occupancy SET claim_json=json_set(claim_json,'$.canonicalRootId','changed-root')",
    ],
  ])("rejects an old digest after the %s changes", async (_name, sql) => {
    const f = await fixture();
    const listed = await inspect(f);
    withDatabase(f, (database) => database.exec(sql));
    await rejectsUnchanged(
      f,
      confirmArgs(f, listed.digest),
      "SANDBOX_RESERVATION_ADMIN_DIGEST_MISMATCH",
    );
  });

  it("never exposes or disposes a job outside the configured owner and agent", async () => {
    const f = await fixture();
    const listed = await inspect(f);
    await writeFile(
      f.configurationPath,
      JSON.stringify({
        ...configuration(f.stateRoot),
        ownerId: OTHER_OWNER_ID,
        agentId: OTHER_AGENT_ID,
      }),
      { mode: 0o600 },
    );
    await rejectsUnchanged(f, inspectArgs(f), "SANDBOX_RESERVATION_ADMIN_NOT_FOUND");
    await rejectsUnchanged(f, confirmArgs(f, listed.digest), "SANDBOX_RESERVATION_ADMIN_NOT_FOUND");
  });

  it("never exposes or disposes a reservation from a different deployment", async () => {
    const f = await fixture();
    const listed = await inspect(f);
    await writeFile(
      f.configurationPath,
      JSON.stringify({
        ...configuration(f.stateRoot),
        deploymentId: "deployment-other-administrator",
      }),
      { mode: 0o600 },
    );
    await rejectsUnchanged(f, inspectArgs(f), "SANDBOX_RESERVATION_ADMIN_NOT_FOUND");
    await rejectsUnchanged(f, confirmArgs(f, listed.digest), "SANDBOX_RESERVATION_ADMIN_NOT_FOUND");
  });

  it("inspects Schema49 without migrating it and refuses to dispose it with a Schema50 writer", async () => {
    const f = await fixture({ schemaSequence: 49 });
    const before = snapshot(f);
    const listed = await inspect(f);
    expect(snapshot(f)).toEqual(before);
    await rejectsUnchanged(
      f,
      confirmArgs(f, listed.digest),
      "SANDBOX_RESERVATION_ADMIN_SCHEMA_UNSUPPORTED",
    );
    withDatabase(f, (database) => {
      expect(
        database.prepare("SELECT max(sequence) FROM schema_migration_ledger").pluck().get(),
      ).toBe(49);
      expect(
        database
          .prepare("SELECT value FROM schema_metadata WHERE key='current_sequence'")
          .pluck()
          .get(),
      ).toBe("49");
    });
  });

  it("migrates a stopped Schema49 reservation through the public CLI before administrator disposition without replay", async () => {
    const f = await fixture({ schemaSequence: 49 });
    const before = snapshot(f);
    expect(before["runs"]?.[0]).toMatchObject({ status: "reconciling_external_result" });
    expect(before["run_coordination_checkpoints"]?.[0]).toMatchObject({
      phase: "reconciling_external_result",
      terminal_status: null,
      output_kind: null,
      final_answer_ref: null,
    });
    expect(before["sandbox_execution_records"]?.[0]).toMatchObject({
      preparation_state: "reserved",
      reservation_stopped_at: T1,
      started_at: null,
    });
    expect(before["sandbox_workspace_occupancy"]).not.toHaveLength(0);
    expect(before["sandbox_workspace_occupancy"]?.every((row) => row["released_at"] === null)).toBe(
      true,
    );
    const migration = await cli([
      "db",
      "migrate",
      "--config",
      f.configurationPath,
      "--confirm",
      "APPLY_MIGRATIONS",
    ]);
    expect(migration).toMatchObject({
      code: 0,
      error: "",
      result: {
        command: "db.migrate",
        currentSequence: 50,
        appliedSequences: [50],
        snapshotPath: expect.any(String),
      },
    });
    const snapshotPath = migration.result.snapshotPath as string;
    expect(path.dirname(path.dirname(snapshotPath))).toBe(path.join(f.stateRoot, "data"));
    expect(path.basename(path.dirname(snapshotPath))).toMatch(/^pre-migration-/);
    expect(path.basename(snapshotPath)).toBe("product.sqlite");
    const saved = new BetterSqlite3(snapshotPath, { readonly: true, fileMustExist: true });
    try {
      expect(saved.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(saved.pragma("foreign_key_check")).toEqual([]);
      expect(saved.prepare("SELECT max(sequence) FROM schema_migration_ledger").pluck().get()).toBe(
        49,
      );
      expect(saved.prepare("SELECT key,value FROM schema_metadata ORDER BY key").all()).toEqual([
        { key: "current_sequence", value: "49" },
        { key: "minimum_writer_sequence", value: "49" },
      ]);
      for (const [table, rows] of Object.entries(before))
        expect(saved.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(rows);
    } finally {
      saved.close();
    }
    const migrated = snapshot(f);
    for (const [table, rows] of Object.entries(before)) {
      if (table !== "schema_migration_ledger" && table !== "schema_metadata")
        expect(migrated[table]).toEqual(rows);
    }
    withDatabase(f, (database) => {
      expect(
        database.prepare("SELECT max(sequence) FROM schema_migration_ledger").pluck().get(),
      ).toBe(50);
      expect(database.prepare("SELECT key,value FROM schema_metadata ORDER BY key").all()).toEqual([
        { key: "current_sequence", value: "50" },
        { key: "minimum_writer_sequence", value: "50" },
      ]);
    });
    const listed = await inspect(f);
    const confirmed = await cli(confirmArgs(f, listed.digest));
    expect(confirmed).toMatchObject({
      code: 0,
      error: "",
      result: {
        command: "sandbox.confirm-reservation-cleanup",
        alreadyConfirmed: false,
        receipt: {
          verification: {
            schemaVersion: "sandbox-admin-reservation-release.v1",
            basis: "administrator_confirmed_cleanup",
            identity: f.request.plan.identity,
            inspectionDigest: listed.digest,
          },
        },
      },
    });
    const after = snapshot(f);
    expect(after["runs"]?.[0]).toMatchObject({ status: "failed" });
    expect(after["run_coordination_checkpoints"]?.[0]).toMatchObject({
      phase: "failed",
      terminal_status: "failed",
      output_kind: null,
      final_answer_ref: null,
      diagnostic_code: "SANDBOX_ADMINISTRATOR_CONFIRMED_CLEANUP",
    });
    expect(after["sandbox_reservation_release_receipts"]).toHaveLength(1);
    expect(
      JSON.parse(String(after["sandbox_reservation_release_receipts"]?.[0]?.["verification_json"])),
    ).toEqual(confirmed.result.receipt.verification);
    expect(after["sandbox_workspace_occupancy"]?.every((row) => row["released_at"] !== null)).toBe(
      true,
    );
    expect(after["sandbox_execution_records"]?.[0]).toMatchObject({
      plan_json: before["sandbox_execution_records"]?.[0]?.["plan_json"],
      facts_json: before["sandbox_execution_records"]?.[0]?.["facts_json"],
      preparation_state: "reserved",
      reservation_stopped_at: T1,
      started_at: null,
    });
    for (const table of [
      "payloads",
      "run_payload_artifacts",
      "sandbox_execution_observations",
      "sandbox_operation_observations",
      "sandbox_execution_intents",
      "capability_invocation_receipts",
      "capability_handles",
      "model_invocation_identities",
      "model_budget_allocations",
    ])
      expect(after[table]).toEqual(before[table]);
    withDatabase(f, (database) => {
      const admission = preparationCall(database, "readAdmission", f.request.plan.identity);
      expect(admission).toMatchObject({
        phase: "reserved",
        workspaceBlocked: false,
        releaseReceipt: { verification: confirmed.result.receipt.verification },
      });
      if (admission?.phase !== "reserved")
        throw new Error("ADMINISTRATION_RESERVATION_READBACK_MISSING");
      expect(
        isSandboxReservationNeverStarted(admission.plan, admission.releaseReceipt?.verification),
      ).toBe(false);
      expect(() =>
        preparationCall(database, "authorizeReservationResult", {
          identity: f.request.plan.identity,
          authority: SERVICE_AUTHORITY,
          executionLease: admission.plan.executionLease,
          now: T1,
          deadlineAt: T2,
        }),
      ).toThrow("Reservation result is not permanently released");
      expect(database.pragma("foreign_key_check")).toEqual([]);
    });
    expect(snapshot(f)).toEqual(after);
  });

  it("refuses unknown future schema metadata without migrating or writing", async () => {
    const f = await fixture();
    const listed = await inspect(f);
    withDatabase(f, (database) =>
      database.exec(`UPDATE schema_metadata SET value='51'
      WHERE key IN ('current_sequence','minimum_writer_sequence')`),
    );
    await rejectsUnchanged(f, inspectArgs(f), "SANDBOX_RESERVATION_ADMIN_SCHEMA_UNSUPPORTED");
    await rejectsUnchanged(
      f,
      confirmArgs(f, listed.digest),
      "SANDBOX_RESERVATION_ADMIN_SCHEMA_UNSUPPORTED",
    );
  });

  it("rejects an unknown job without creating state", async () => {
    const f = await fixture();
    await rejectsUnchanged(f, inspectArgs(f, "job-missing"), "SANDBOX_RESERVATION_ADMIN_NOT_FOUND");
    const args = confirmArgs(f, `sha256:${"b".repeat(64)}`);
    args[args.indexOf("--job") + 1] = "job-missing";
    await rejectsUnchanged(f, args, "SANDBOX_RESERVATION_ADMIN_NOT_FOUND");
  });

  it.each([
    ["not stopped", { stopped: false }],
    ["already bound", { bound: true }],
  ])("rejects a reservation that is %s", async (_name, options) => {
    const f = await fixture(options);
    await rejectsUnchanged(f, inspectArgs(f), "SANDBOX_RESERVATION_ADMIN_NOT_ELIGIBLE");
  });

  it.each([
    [
      "started",
      "UPDATE sandbox_execution_records SET started_at='2026-09-04T00:00:01.000Z',start_policy_digest='" +
        "9".repeat(64) +
        "'",
    ],
    [
      "non SRT",
      "UPDATE sandbox_execution_records SET plan_json=json_set(plan_json,'$.backendRef','task-environment')",
    ],
    [
      "background",
      "UPDATE sandbox_execution_records SET plan_json=json_set(plan_json,'$.mode','background')",
    ],
    ["non reconciling Run", "UPDATE runs SET status='running'"],
    ["terminal Run", "UPDATE runs SET status='completed'"],
    [
      "non reconciling checkpoint",
      "UPDATE run_coordination_checkpoints SET phase='runtime_running'",
    ],
    ["terminal checkpoint", "UPDATE run_coordination_checkpoints SET terminal_status='completed'"],
  ])("rejects %s state instead of inferring cleanup from null start", async (_name, sql) => {
    const f = await fixture();
    withDatabase(f, (database) => database.exec(sql));
    await rejectsUnchanged(f, inspectArgs(f), "SANDBOX_RESERVATION_ADMIN_NOT_ELIGIBLE");
  });

  it.each([
    "barrier",
    "queued",
    "continue pending",
    "continue dispatched",
    "other reservation",
    "legacy",
    "task environment",
  ])("retains all state while a %s obligation remains", async (obligation) => {
    const f = await fixture();
    withDatabase(f, (database) => {
      const identity = f.request.plan.identity;
      if (obligation === "barrier") {
        database
          .prepare(`INSERT INTO sandbox_workspace_barriers
            (job_id,barrier_id,kind,reason_code,created_at)
            VALUES (?,'barrier-admin-fixture','control_unacknowledged','SANDBOX_CONTROL_ACK_PENDING',?)`)
          .run(identity.jobId, T1);
      } else if (obligation === "queued") {
        database
          .prepare(`INSERT INTO sandbox_admission_queue
            (job_id,owner_id,agent_id,run_id,host_id,handle_ref,deadline_at,status,request_json,claims_json)
            VALUES ('job-queued-admin',?,?,?,?,?,?,'queued','{}','[]')`)
          .run(OWNER_ID, AGENT_ID, identity.runId, identity.hostId, f.request.plan.handleRef, T2);
      } else if (obligation.startsWith("continue")) {
        database
          .prepare(`INSERT INTO sandbox_execution_intents
            (intent_id,job_id,kind,sequence,operation_revision,authority_json,created_at,dispatched_at)
            VALUES ('intent-admin-fixture',?,'continue',1,0,?,?,?)`)
          .run(
            identity.jobId,
            JSON.stringify(SERVICE_AUTHORITY),
            T1,
            obligation === "continue dispatched" ? T1 : null,
          );
      } else if (obligation === "other reservation") {
        addOtherReservation(f, database);
      } else if (obligation === "legacy") {
        database
          .prepare(`INSERT INTO sandbox_jobs
            (job_id,attempt_id,receipt_ref,owner_id,agent_id,run_id,invocation_id,sequence,plan_json,observation_json)
            VALUES ('job-legacy-admin','attempt-legacy-admin',?,?,?,?,?,1,?,?)`)
          .run(
            identity.receiptRef,
            OWNER_ID,
            AGENT_ID,
            identity.runId,
            "legacy-admin-invocation",
            JSON.stringify(f.request.plan),
            JSON.stringify({ state: "prepared", cleanup: "unknown" }),
          );
      } else {
        database
          .prepare(`INSERT INTO execution_jobs
            (execution_job_id,owner_id,agent_id,run_id,host_id,created_at)
            VALUES ('execution-job-admin',?,?,?,?,?)`)
          .run(OWNER_ID, AGENT_ID, identity.runId, identity.hostId, T1);
        database
          .prepare(`INSERT INTO execution_environments
            (environment_id,execution_job_id,role,generation,state,rotation_reason,backend_ref,
             envelope_json,envelope_digest,policy_digest,image_digest,runner_digest,deadline_at,
             create_intent_id,created_at,updated_at)
            VALUES ('environment-admin','execution-job-admin','primary',1,'reserved','initial',
              'container','{}',?,?,?, ?,?,'create-admin',?,?)`)
          .run("a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64), T2, T1, T1);
      }
    });
    await rejectsUnchanged(f, inspectArgs(f), "SANDBOX_RESERVATION_ADMIN_NOT_ELIGIBLE");
    await rejectsUnchanged(
      f,
      confirmArgs(f, `sha256:${"b".repeat(64)}`),
      "SANDBOX_RESERVATION_ADMIN_NOT_ELIGIBLE",
    );
  });

  it("rolls the whole disposition back when durable audit insertion fails", async () => {
    const f = await fixture();
    const listed = await inspect(f);
    withDatabase(f, (database) =>
      database.exec(`CREATE TRIGGER administration_audit_failure
      BEFORE INSERT ON audit_records BEGIN SELECT RAISE(ABORT,'ADMINISTRATION_FIXTURE_AUDIT_FAILURE'); END`),
    );
    await rejectsUnchanged(f, confirmArgs(f, listed.digest), "SQLITE_CONSTRAINT_TRIGGER");
  });

  it("rolls all prior disposition writes back when the final Thread notification insert fails", async () => {
    const f = await fixture();
    const listed = await inspect(f);
    withDatabase(f, (database) =>
      database.exec(`CREATE TRIGGER administration_notification_failure
      BEFORE INSERT ON thread_gateway_events
      BEGIN SELECT RAISE(ABORT,'ADMINISTRATION_FIXTURE_NOTIFICATION_FAILURE'); END`),
    );
    await rejectsUnchanged(f, confirmArgs(f, listed.digest), "SQLITE_CONSTRAINT_TRIGGER");
  });

  it("rejects administrator assertions through the ordinary Host release port", async () => {
    const f = await fixture();
    const listed = await inspect(f);
    const before = snapshot(f);
    const verification = {
      schemaVersion: "sandbox-admin-reservation-release.v1",
      basis: "administrator_confirmed_cleanup",
      identity: f.request.plan.identity,
      environmentId: f.request.plan.environmentId,
      semanticFingerprint:
        f.admission.phase === "reserved" ? f.admission.plan.semanticFingerprint : "",
      stopRequestedAt: T1,
      checkedAt: T1,
      inspectionDigest: listed.digest,
      administrator: ADMINISTRATOR,
      evidenceDigest: EVIDENCE,
      confirmation: CONFIRMATION,
      actor: { uid: userInfo().uid, account: userInfo().username, hostname: hostname() },
      auditId: "audit-forged-administrator-assertion",
    };
    withDatabase(f, (database) => {
      expect(() =>
        preparationCall(database, "releaseReservation", {
          identity: f.request.plan.identity,
          authority: SERVICE_AUTHORITY,
          now: T1,
          verification: verification as unknown as Parameters<
            SandboxExecutionPreparationPort["releaseReservation"]
          >[0]["verification"],
        }),
      ).toThrow("Invalid reservation release verification");
    });
    expect(snapshot(f)).toEqual(before);
  });

  it("atomically records administrator cleanup, fails the Run and preserves unknown execution history", async () => {
    const f = await fixture();
    const listed = await inspect(f);
    const before = snapshot(f);
    const result = await cli(confirmArgs(f, listed.digest));
    expect(result).toMatchObject({ code: 0, error: "" });
    expect(result.result).toMatchObject({
      command: "sandbox.confirm-reservation-cleanup",
      jobId: f.request.plan.identity.jobId,
      runId: f.request.plan.identity.runId,
      alreadyConfirmed: false,
      receipt: {
        acceptedAt: expect.any(String),
        verification: {
          schemaVersion: "sandbox-admin-reservation-release.v1",
          basis: "administrator_confirmed_cleanup",
          identity: f.request.plan.identity,
          environmentId: f.request.plan.environmentId,
          semanticFingerprint:
            f.admission.phase === "reserved" ? f.admission.plan.semanticFingerprint : "",
          stopRequestedAt: T1,
          checkedAt: expect.any(String),
          inspectionDigest: listed.digest,
          administrator: ADMINISTRATOR,
          evidenceDigest: EVIDENCE,
          confirmation: CONFIRMATION,
          actor: { uid: userInfo().uid, account: userInfo().username, hostname: hostname() },
          auditId: expect.any(String),
        },
      },
    });
    const after = snapshot(f);
    const receipt = after["sandbox_reservation_release_receipts"]?.[0];
    expect(after["sandbox_reservation_release_receipts"]).toHaveLength(1);
    expect(JSON.parse(String(receipt?.["verification_json"]))).toEqual(
      result.result.receipt.verification,
    );
    expect(after["runs"]?.[0]).toMatchObject({ status: "failed", revision: 4 });
    expect(after["run_coordination_checkpoints"]?.[0]).toMatchObject({
      phase: "failed",
      terminal_status: "failed",
      revision: 5,
      context_ref: "payload-capability-invocation-trigger",
      runtime_event_count: 7,
      output_kind: null,
      final_answer_ref: null,
      diagnostic_code: "SANDBOX_ADMINISTRATOR_CONFIRMED_CLEANUP",
    });
    expect(
      after["sandbox_workspace_occupancy"]?.every(
        (row) => row["released_at"] === receipt?.["accepted_at"],
      ),
    ).toBe(true);
    expect(
      JSON.parse(String(after["sandbox_execution_records"]?.[0]?.["recovery_json"])),
    ).toMatchObject({
      status: "resolved",
      reasonCode: "SANDBOX_ADMINISTRATOR_CONFIRMED_CLEANUP",
      nextAttemptAt: null,
    });
    const executionLease = after["run_execution_leases"]?.[0];
    expect(executionLease).toMatchObject({ revision: 2, released_at: receipt?.["accepted_at"] });
    expect(executionLease?.["expires_at"]).toBe(
      before["run_execution_leases"]?.[0]?.["expires_at"],
    );
    expect(executionLease?.["execution_lease_id"]).toBe(
      before["run_execution_leases"]?.[0]?.["execution_lease_id"],
    );
    expect(after["threads"]?.[0]).toMatchObject({ revision: 3 });
    expect(after["thread_gateway_events"]).toHaveLength(1);
    expect(after["thread_gateway_events"]?.[0]).toMatchObject({
      event_type: "run.failed",
      thread_revision: 3,
      owner_id: OWNER_ID,
      agent_id: AGENT_ID,
    });
    expect(after["audit_records"]).toHaveLength(1);
    expect(after["audit_records"]?.[0]).toMatchObject({
      id: result.result.receipt.verification.auditId,
      action: "sandbox.reservation_cleanup_confirmed",
      outcome: "completed",
      target_ref: f.request.plan.identity.jobId,
    });
    for (const table of [
      "payloads",
      "run_payload_artifacts",
      "sandbox_execution_observations",
      "sandbox_operation_observations",
      "sandbox_execution_intents",
      "capability_invocation_receipts",
      "capability_handles",
      "authority_leases",
      "deployments",
      "model_invocation_identities",
      "model_budget_allocations",
    ])
      expect(after[table]).toEqual(before[table]);
    const originalExecution = before["sandbox_execution_records"]?.[0];
    expect(after["sandbox_execution_records"]?.[0]).toMatchObject({
      plan_json: originalExecution?.["plan_json"],
      facts_json: originalExecution?.["facts_json"],
      admission_json: originalExecution?.["admission_json"],
      sequence: originalExecution?.["sequence"],
      started_at: null,
      start_policy_digest: null,
      preparation_state: "reserved",
      reservation_stopped_at: T1,
    });
    withDatabase(f, (database) => {
      expect(
        Number(
          database
            .prepare("SELECT value FROM schema_metadata WHERE key='minimum_writer_sequence'")
            .pluck()
            .get(),
        ),
      ).toBe(50);
      expect(
        database
          .prepare(`SELECT 1 FROM runs r WHERE id=@runId AND (${RUN_RESOURCES_RELEASED_SQL})`)
          .get({ resourceNow: receipt?.["accepted_at"], runId: f.request.plan.identity.runId }),
      ).toBeDefined();
      expect(database.pragma("foreign_key_check")).toEqual([]);
    });
    const audit = auditWorkspaceLifecycle(f);
    expect(audit).toMatchObject({
      mode: "read_only",
      schemaSequence: 50,
      liveHostVerified: false,
      repairEligible: false,
    });
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      jobId: f.request.plan.identity.jobId,
      activeClaims: 0,
      reservationReleaseBasis: "administrator_confirmed_cleanup",
    });
    expect(audit.rows[0]?.reasons).toEqual(
      expect.arrayContaining([
        "ADMINISTRATOR_CONFIRMED_CLEANUP",
        "RESULT_UNRESOLVED",
        "EFFECT_UNRESOLVED",
      ]),
    );
    expect(audit.rows[0]?.requiredEvidence).toContain("ORIGINAL_OPERATION_EFFECT_PROOF");
    expect(snapshot(f)).toEqual(after);
  });

  it("returns the immutable original receipt on repetition without another audit, event or lease change", async () => {
    const f = await fixture();
    const listed = await inspect(f);
    const first = await cli(confirmArgs(f, listed.digest));
    expect(first.code).toBe(0);
    const before = snapshot(f);
    const second = await cli(confirmArgs(f, listed.digest));
    expect(second).toMatchObject({
      code: 0,
      error: "",
      result: { alreadyConfirmed: true, receipt: first.result.receipt },
    });
    expect(snapshot(f)).toEqual(before);
    withDatabase(f, (database) => {
      expect(() =>
        database
          .prepare("UPDATE sandbox_reservation_release_receipts SET authority_json='{}'")
          .run(),
      ).toThrow();
      expect(() =>
        database
          .prepare("UPDATE sandbox_reservation_release_receipts SET verification_json='{}'")
          .run(),
      ).toThrow();
    });
    const changedEvidence = confirmArgs(f, listed.digest);
    changedEvidence[changedEvidence.indexOf("--evidence") + 1] = `sha256:${"b".repeat(64)}`;
    expect((await cli(changedEvidence)).code).toBe(1);
    const changedAdministrator = confirmArgs(f, listed.digest);
    changedAdministrator[changedAdministrator.indexOf("--administrator") + 1] =
      "administrator:different-operator";
    expect((await cli(changedAdministrator)).code).toBe(1);
    expect(snapshot(f)).toEqual(before);
  });

  it.each([
    ["missing audit", "DELETE FROM audit_records"],
    ["changed audit", "UPDATE audit_records SET target_ref='job-other-administrator'"],
    [
      "changed plan identity",
      "UPDATE sandbox_execution_records SET plan_json=json_set(plan_json,'$.identity.attemptId','attempt-other-administrator')",
    ],
  ])("rejects persisted administrator evidence with %s", async (_name, sql) => {
    const f = await fixture();
    const listed = await inspect(f);
    expect((await cli(confirmArgs(f, listed.digest))).code).toBe(0);
    withDatabase(f, (database) => database.exec(sql));
    const before = snapshot(f);
    withDatabase(f, (database) => {
      expect(() => preparationCall(database, "readAdmission", f.request.plan.identity)).toThrow(
        ApplicationPortError,
      );
    });
    expect(snapshot(f)).toEqual(before);
  });

  it("reads administrator disposition durably without granting never-started delivery or Run replay", async () => {
    const f = await fixture();
    const listed = await inspect(f);
    expect((await cli(confirmArgs(f, listed.digest))).code).toBe(0);
    const before = snapshot(f);
    const database = openQualifiedDatabase(f.databasePath);
    try {
      const admission = preparationCall(database, "readAdmission", f.request.plan.identity);
      expect(admission).toMatchObject({
        phase: "reserved",
        workspaceBlocked: false,
        releaseReceipt: { verification: { basis: "administrator_confirmed_cleanup" } },
      });
      if (admission?.phase !== "reserved")
        throw new Error("ADMINISTRATION_RESERVATION_READBACK_MISSING");
      expect(() =>
        preparationCall(database, "releaseReservation", {
          identity: f.request.plan.identity,
          authority: SERVICE_AUTHORITY,
          now: T1,
          verification: admission.releaseReceipt?.verification as Parameters<
            SandboxExecutionPreparationPort["releaseReservation"]
          >[0]["verification"],
        }),
      ).toThrow("Invalid reservation release verification");
      expect(
        isSandboxReservationNeverStarted(admission.plan, admission.releaseReceipt?.verification),
      ).toBe(false);
      expect(
        database
          .prepare(`SELECT 1 FROM sandbox_execution_records result
        JOIN sandbox_reservation_release_receipts reservation ON reservation.job_id=result.job_id
        WHERE result.job_id=? AND ${SANDBOX_RESERVATION_NEVER_STARTED_SQL}`)
          .get(f.request.plan.identity.jobId),
      ).toBeUndefined();
      expect(() =>
        preparationCall(database, "authorizeReservationResult", {
          identity: f.request.plan.identity,
          authority: SERVICE_AUTHORITY,
          executionLease: admission.plan.executionLease,
          now: T1,
          deadlineAt: T2,
        }),
      ).toThrow("Reservation result is not permanently released");
      const dispatch = new SqliteRunDispatchOperations(
        database,
        {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          authority: SERVICE_AUTHORITY.product,
          authorityLease: SERVICE_AUTHORITY.lease,
          consumerId: "administrator-replay-check",
        },
        (code, message, details): never => {
          throw new ApplicationPortError(code as PortErrorCode, message, details);
        },
      );
      const now = new Date().toISOString();
      await expect(
        dispatch.assertHeld({
          runId: f.request.plan.identity.runId,
          expectedLeaseRevision: 1,
          executionLeaseId: "sandbox-lease",
          at: T1,
        }),
      ).rejects.toBeInstanceOf(ApplicationPortError);
      expect(await dispatch.listClaimable({ now, limit: 100 })).toEqual([]);
      await expect(
        dispatch.claim({
          runId: f.request.plan.identity.runId,
          expectedRunRevision: 4,
          expectedLeaseRevision: 2,
          executionLeaseId: createRunExecutionLeaseId("forbidden-admin-replay"),
          claimedAt: now,
          expiresAt: new Date(Date.parse(now) + 1000).toISOString(),
        }),
      ).rejects.toBeInstanceOf(ApplicationPortError);
    } finally {
      database.close();
    }
    expect(snapshot(f)).toEqual(before);
  });
});
