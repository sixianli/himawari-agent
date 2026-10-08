import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import path from "node:path";
import type {
  SandboxAdministratorReservationReleaseVerification,
  SandboxRecoveryState,
  SandboxReservationReleaseReceipt,
} from "@himawari-agent/application";
import {
  createAgentId,
  createDeploymentId,
  createOwnerId,
  createThreadId,
} from "@himawari-agent/domain";
import {
  type SandboxExecutionPlanV2,
  sandboxExecutionPlanV2Schema,
} from "@himawari-agent/execution-contracts";
import BetterSqlite3 from "better-sqlite3";
import { readMigrationLedger } from "./migration-engine.ts";
import { RUN_RESOURCES_RELEASED_SQL } from "./sqlite-run-resource-guard.ts";
import { appendThreadGatewayEventInTransaction } from "./sqlite-thread-operations.ts";
import { acquireStateRootLock } from "./state-root-lock.ts";

export const SANDBOX_RESERVATION_ADMIN_CONFIRMATION =
  "HOST_GROUP_ABSENT_FINAL_ABSENT_RELATED_PROCESSES_ABSENT" as const;
export const SANDBOX_RESERVATION_ADMIN_ERROR_CODES = Object.freeze({
  ARGUMENT_INVALID: "ADMIN_ARGUMENT_INVALID",
  CONFIRMATION_REQUIRED: "ADMIN_CONFIRMATION_REQUIRED",
  TARGET_NOT_STOPPED: "ADMIN_TARGET_NOT_STOPPED",
  NOT_FOUND: "SANDBOX_RESERVATION_ADMIN_NOT_FOUND",
  NOT_ELIGIBLE: "SANDBOX_RESERVATION_ADMIN_NOT_ELIGIBLE",
  DIGEST_MISMATCH: "SANDBOX_RESERVATION_ADMIN_DIGEST_MISMATCH",
  SCHEMA_UNSUPPORTED: "SANDBOX_RESERVATION_ADMIN_SCHEMA_UNSUPPORTED",
} as const);

type Database = InstanceType<typeof BetterSqlite3>;
type Row = Record<string, unknown>;
type AdministratorReceipt = Extract<
  SandboxReservationReleaseReceipt,
  { readonly verification: SandboxAdministratorReservationReleaseVerification }
>;

const machine = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const record = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keysAre = (value: Row, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 255 &&
  Array.from(value).every(
    (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
  );
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 1;
const sha256 = (value: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const fail = (code: string): never => {
  throw new Error(code);
};

export function readAdministratorReservationRelease(
  database: Database,
  plan: SandboxExecutionPlanV2,
  stoppedAt: string | undefined,
  acceptedAt: string,
  verification: unknown,
  authority: unknown,
  invalid: () => never,
): AdministratorReceipt {
  if (!record(verification) || !record(verification["identity"])) return invalid();
  const identity = verification["identity"];
  if (
    !keysAre(verification, [
      "schemaVersion",
      "basis",
      "identity",
      "environmentId",
      "semanticFingerprint",
      "stopRequestedAt",
      "checkedAt",
      "inspectionDigest",
      "administrator",
      "evidenceDigest",
      "confirmation",
      "actor",
      "auditId",
    ]) ||
    verification["schemaVersion"] !== "sandbox-admin-reservation-release.v1" ||
    verification["basis"] !== "administrator_confirmed_cleanup" ||
    !keysAre(identity, Object.keys(plan.identity)) ||
    Object.entries(plan.identity).some(([key, value]) => identity[key] !== value) ||
    verification["environmentId"] !== plan.environmentId ||
    verification["semanticFingerprint"] !== plan.semanticFingerprint ||
    !instant(stoppedAt) ||
    verification["stopRequestedAt"] !== stoppedAt ||
    !instant(acceptedAt) ||
    verification["checkedAt"] !== acceptedAt ||
    acceptedAt < stoppedAt ||
    !digest(verification["inspectionDigest"]) ||
    !machine(verification["administrator"]) ||
    !digest(verification["evidenceDigest"]) ||
    verification["confirmation"] !== SANDBOX_RESERVATION_ADMIN_CONFIRMATION ||
    !machine(verification["auditId"]) ||
    !record(verification["actor"]) ||
    !keysAre(verification["actor"], ["uid", "account", "hostname"]) ||
    !Number.isSafeInteger(verification["actor"]["uid"]) ||
    Number(verification["actor"]["uid"]) < 0 ||
    !text(verification["actor"]["account"]) ||
    !text(verification["actor"]["hostname"]) ||
    !record(authority) ||
    !keysAre(authority, ["schemaVersion", "verificationDigest"]) ||
    authority["schemaVersion"] !== "sandbox-admin-reservation-authority.v1" ||
    authority["verificationDigest"] !== sha256(verification)
  )
    return invalid();
  const audit = database
    .prepare(`SELECT 1 FROM audit_records
    WHERE id=? AND owner_id=? AND agent_id=? AND action='sandbox.reservation_cleanup_confirmed'
      AND target_ref=? AND outcome='completed' AND detail_ref IS NULL AND occurred_at=?`)
    .get(
      verification["auditId"],
      plan.identity.ownerId,
      plan.identity.agentId,
      plan.identity.jobId,
      acceptedAt,
    );
  if (!audit) return invalid();
  return {
    acceptedAt,
    verification: {
      schemaVersion: "sandbox-admin-reservation-release.v1",
      basis: "administrator_confirmed_cleanup",
      identity: plan.identity,
      environmentId: plan.environmentId,
      semanticFingerprint: plan.semanticFingerprint,
      stopRequestedAt: stoppedAt,
      checkedAt: acceptedAt,
      inspectionDigest: verification["inspectionDigest"],
      administrator: verification["administrator"],
      evidenceDigest: verification["evidenceDigest"],
      confirmation: SANDBOX_RESERVATION_ADMIN_CONFIRMATION,
      actor: {
        uid: Number(verification["actor"]["uid"]),
        account: verification["actor"]["account"],
        hostname: verification["actor"]["hostname"],
      },
      auditId: verification["auditId"],
    },
  };
}

export interface SandboxReservationAdministrationInspection {
  readonly digest: string;
  readonly record: {
    readonly jobId: string;
    readonly runId: string;
    readonly threadId: string;
    readonly environmentId: string;
    readonly semanticFingerprint: string;
    readonly stopRequestedAt: string;
    readonly preparationState: "reserved";
    readonly startedAt: null;
    readonly runRevision: number;
    readonly checkpointRevision: number;
    readonly leaseRevision: number;
    readonly threadRevision: number;
  };
  readonly confirmation: typeof SANDBOX_RESERVATION_ADMIN_CONFIRMATION;
}

export interface SandboxReservationAdministrationConfirmation {
  readonly jobId: string;
  readonly runId: string;
  readonly alreadyConfirmed: boolean;
  readonly receipt: AdministratorReceipt;
}

export class SqliteSandboxReservationAdministration {
  readonly #stateRoot: string;
  readonly #databasePath: string;
  readonly #owner: string;
  readonly #agent: string;
  readonly #deployment: string;

  constructor(options: {
    readonly stateRoot: string;
    readonly databasePath: string;
    readonly ownerId: string;
    readonly agentId: string;
    readonly deploymentId: string;
  }) {
    if (
      !machine(options.ownerId) ||
      !machine(options.agentId) ||
      !machine(options.deploymentId) ||
      typeof options.stateRoot !== "string" ||
      typeof options.databasePath !== "string"
    )
      fail(SANDBOX_RESERVATION_ADMIN_ERROR_CODES.ARGUMENT_INVALID);
    this.#stateRoot = path.resolve(options.stateRoot);
    this.#databasePath = path.resolve(options.databasePath);
    this.#owner = options.ownerId;
    this.#agent = options.agentId;
    this.#deployment = options.deploymentId;
    if (this.#databasePath !== path.join(this.#stateRoot, "data", "product.sqlite"))
      fail(SANDBOX_RESERVATION_ADMIN_ERROR_CODES.ARGUMENT_INVALID);
  }

  inspect(jobId: string): SandboxReservationAdministrationInspection {
    if (!machine(jobId)) fail(SANDBOX_RESERVATION_ADMIN_ERROR_CODES.ARGUMENT_INVALID);
    const canonicalRoot = this.#canonicalRoot();
    const database = new BetterSqlite3(path.join(canonicalRoot, "data", "product.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      database.pragma("query_only = ON");
      return database.transaction(() => {
        const sequence = this.#assertSchema(database, false);
        const target = this.#target(database, jobId);
        return this.#inspection(database, target, sequence);
      })();
    } finally {
      database.close();
    }
  }

  async confirm(input: {
    readonly jobId: string;
    readonly digest: string;
    readonly administrator: string;
    readonly evidence: string;
    readonly confirmation: string;
  }): Promise<SandboxReservationAdministrationConfirmation> {
    if (
      !machine(input.jobId) ||
      !digest(input.digest) ||
      !machine(input.administrator) ||
      !digest(input.evidence)
    )
      fail(SANDBOX_RESERVATION_ADMIN_ERROR_CODES.ARGUMENT_INVALID);
    if (input.confirmation !== SANDBOX_RESERVATION_ADMIN_CONFIRMATION)
      fail(SANDBOX_RESERVATION_ADMIN_ERROR_CODES.CONFIRMATION_REQUIRED);
    const canonicalRoot = this.#canonicalRoot();
    const lock = await acquireStateRootLock(canonicalRoot).catch(() =>
      fail(SANDBOX_RESERVATION_ADMIN_ERROR_CODES.TARGET_NOT_STOPPED),
    );
    let database: Database | undefined;
    try {
      if (this.#canonicalRoot() !== canonicalRoot)
        fail(SANDBOX_RESERVATION_ADMIN_ERROR_CODES.ARGUMENT_INVALID);
      database = new BetterSqlite3(path.join(canonicalRoot, "data", "product.sqlite"), {
        fileMustExist: true,
      });
      this.#assertSchema(database, true);
      database.pragma("foreign_keys = ON");
      database.pragma("synchronous = FULL");
      database.pragma("busy_timeout = 5000");
      const activeDatabase = database;
      return activeDatabase.transaction(() => this.#confirm(activeDatabase, input)).immediate();
    } finally {
      try {
        database?.close();
      } finally {
        await lock.release();
      }
    }
  }

  #canonicalRoot(): string {
    try {
      const root = realpathSync(this.#stateRoot);
      if (realpathSync(this.#databasePath) === path.join(root, "data", "product.sqlite"))
        return root;
    } catch {
      fail(SANDBOX_RESERVATION_ADMIN_ERROR_CODES.ARGUMENT_INVALID);
    }
    return fail(SANDBOX_RESERVATION_ADMIN_ERROR_CODES.ARGUMENT_INVALID);
  }

  #assertSchema(database: Database, writing: boolean): number {
    const ledger = readMigrationLedger(database);
    const current = ledger.at(-1)?.sequence ?? 0;
    const metadata = database
      .prepare(
        "SELECT key,value FROM schema_metadata WHERE key IN ('current_sequence','minimum_writer_sequence')",
      )
      .all() as { key: string; value: string }[];
    const declared = Number(metadata.find((row) => row.key === "current_sequence")?.value);
    const minimum = Number(metadata.find((row) => row.key === "minimum_writer_sequence")?.value);
    if (
      ![49, 50].includes(current) ||
      ledger.length !== current ||
      ledger.some((row, index) => row.sequence !== index + 1) ||
      declared !== current ||
      minimum !== current ||
      (writing && current !== 50)
    )
      fail(SANDBOX_RESERVATION_ADMIN_ERROR_CODES.SCHEMA_UNSUPPORTED);
    return current;
  }

  #target(database: Database, jobId: string): { row: Row; plan: SandboxExecutionPlanV2 } {
    const row = database
      .prepare(
        "SELECT * FROM sandbox_execution_records WHERE job_id=? AND owner_id=? AND agent_id=?",
      )
      .get(jobId, this.#owner, this.#agent) as Row | undefined;
    if (!row) return fail(SANDBOX_RESERVATION_ADMIN_ERROR_CODES.NOT_FOUND);
    let plan: SandboxExecutionPlanV2;
    try {
      plan = sandboxExecutionPlanV2Schema.parse(JSON.parse(String(row["plan_json"])));
    } catch {
      return fail(SANDBOX_RESERVATION_ADMIN_ERROR_CODES.NOT_ELIGIBLE);
    }
    if (
      plan.identity.jobId !== jobId ||
      plan.identity.ownerId !== this.#owner ||
      plan.identity.agentId !== this.#agent ||
      plan.executionLease.deploymentId !== this.#deployment
    )
      return fail(SANDBOX_RESERVATION_ADMIN_ERROR_CODES.NOT_FOUND);
    return { row, plan };
  }

  #snapshot(
    database: Database,
    plan: SandboxExecutionPlanV2,
    schema: number,
  ): Record<string, unknown> {
    const scope = {
      owner: this.#owner,
      agent: this.#agent,
      run: plan.identity.runId,
      thread: plan.identity.threadId,
      deployment: this.#deployment,
      scopeRef: plan.binding.scopeRef,
      inputRef: plan.inputRef,
    };
    const rows = (sql: string): Row[] => database.prepare(sql).all(scope) as Row[];
    const jobs =
      "SELECT job_id FROM sandbox_execution_records WHERE owner_id=@owner AND agent_id=@agent AND run_id=@run";
    const environments =
      "SELECT environment_id FROM execution_environments WHERE execution_job_id IN (SELECT execution_job_id FROM execution_jobs WHERE owner_id=@owner AND agent_id=@agent AND run_id=@run)";
    const snapshot: Record<string, unknown> = {
      schema,
      owner: this.#owner,
      agent: this.#agent,
      deployment: this.#deployment,
      runs: rows(
        "SELECT * FROM runs WHERE id=@run AND owner_id=@owner AND agent_id=@agent ORDER BY id",
      ),
      checkpoints: rows(
        "SELECT * FROM run_coordination_checkpoints WHERE run_id=@run AND owner_id=@owner AND agent_id=@agent ORDER BY run_id",
      ),
      leases: rows(
        "SELECT * FROM run_execution_leases WHERE run_id=@run AND owner_id=@owner AND agent_id=@agent ORDER BY run_id",
      ),
      threads: rows(
        "SELECT * FROM threads WHERE id=@thread AND owner_id=@owner AND agent_id=@agent ORDER BY id",
      ),
      owners: rows("SELECT * FROM owners WHERE id=@owner ORDER BY id"),
      agents: rows("SELECT * FROM agents WHERE id=@agent AND owner_id=@owner ORDER BY id"),
      deployments: rows(
        "SELECT * FROM deployments WHERE owner_id=@owner AND agent_id=@agent ORDER BY id",
      ),
      authorityLeases: rows(
        "SELECT * FROM authority_leases WHERE owner_id=@owner AND agent_id=@agent ORDER BY id",
      ),
      executions: rows(
        "SELECT * FROM sandbox_execution_records WHERE owner_id=@owner AND agent_id=@agent AND run_id=@run ORDER BY job_id",
      ),
      queue: rows(
        "SELECT * FROM sandbox_admission_queue WHERE owner_id=@owner AND agent_id=@agent AND run_id=@run ORDER BY sequence",
      ),
      queueBindings: rows(
        "SELECT * FROM sandbox_queue_authority_bindings WHERE job_id IN (SELECT job_id FROM sandbox_admission_queue WHERE owner_id=@owner AND agent_id=@agent AND run_id=@run) ORDER BY job_id,revision",
      ),
      legacyJobs: rows(
        "SELECT * FROM sandbox_jobs WHERE owner_id=@owner AND agent_id=@agent AND run_id=@run ORDER BY job_id",
      ),
      legacyOccupancy: rows(
        "SELECT * FROM sandbox_legacy_occupancy WHERE job_id IN (SELECT job_id FROM sandbox_jobs WHERE owner_id=@owner AND agent_id=@agent AND run_id=@run) ORDER BY job_id",
      ),
      executionJobs: rows(
        "SELECT * FROM execution_jobs WHERE owner_id=@owner AND agent_id=@agent AND run_id=@run ORDER BY execution_job_id",
      ),
      invocationReceipts: rows(
        "SELECT * FROM capability_invocation_receipts WHERE owner_id=@owner AND agent_id=@agent AND run_id=@run ORDER BY receipt_ref",
      ),
      handles: rows("SELECT * FROM capability_handles WHERE run_id=@run ORDER BY id"),
      capabilities: rows(
        "SELECT * FROM capability_declarations WHERE id IN (SELECT capability_id FROM capability_handles WHERE run_id=@run) AND owner_id=@owner AND agent_id=@agent ORDER BY id",
      ),
      grants: rows("SELECT * FROM grants WHERE owner_id=@owner AND agent_id=@agent ORDER BY id"),
      scopeRecords: rows(
        "SELECT * FROM product_state_records WHERE owner_id=@owner AND agent_id=@agent ORDER BY key",
      ),
      artifacts: rows(
        "SELECT * FROM run_payload_artifacts WHERE owner_id=@owner AND agent_id=@agent AND run_id=@run ORDER BY purpose,operation_key",
      ),
      payloadMetadata:
        rows(`SELECT ref,owner_id,agent_id,classification,storage_kind,content_digest,encryption_algorithm,key_ref,lifecycle_state,created_at,content_type,encryption_metadata_json
        FROM payloads WHERE owner_id=@owner AND agent_id=@agent AND (ref=@scopeRef OR ref=@inputRef
          OR ref IN (SELECT payload_ref FROM run_payload_artifacts WHERE owner_id=@owner AND agent_id=@agent AND run_id=@run)
          OR ref IN (SELECT context_ref FROM run_coordination_checkpoints WHERE owner_id=@owner AND agent_id=@agent AND run_id=@run)) ORDER BY ref`),
    };
    for (const [table, order] of [
      ["sandbox_workspace_occupancy", "job_id,scope_ref"],
      ["sandbox_workspace_barriers", "job_id,barrier_id"],
      ["sandbox_execution_intents", "intent_id"],
      ["sandbox_execution_observations", "job_id,sequence"],
      ["sandbox_operation_observations", "job_id,revision"],
      ["sandbox_release_receipts", "job_id"],
      ["sandbox_reservation_release_receipts", "job_id"],
    ] as const)
      snapshot[table] = rows(`SELECT * FROM ${table} WHERE job_id IN (${jobs}) ORDER BY ${order}`);
    for (const [table, order] of [
      ["execution_environments", "environment_id"],
      ["execution_environment_stop_intents", "environment_id,stop_fence"],
      ["execution_environment_leases", "environment_id,scope_ref"],
      ["execution_environment_calls", "environment_id,invocation_id"],
      ["execution_environment_release_receipts", "environment_id"],
    ] as const)
      snapshot[table] = rows(
        `SELECT * FROM ${table} WHERE environment_id IN (${environments}) ORDER BY ${order}`,
      );
    return snapshot;
  }

  #inspection(
    database: Database,
    target: { row: Row; plan: SandboxExecutionPlanV2 },
    schema: number,
  ): SandboxReservationAdministrationInspection {
    const { row, plan } = target;
    const scope = {
      owner: this.#owner,
      agent: this.#agent,
      run: plan.identity.runId,
      job: plan.identity.jobId,
      thread: plan.identity.threadId,
      deployment: this.#deployment,
      resourceNow: new Date().toISOString(),
    };
    const run = database
      .prepare("SELECT * FROM runs WHERE id=@run AND owner_id=@owner AND agent_id=@agent")
      .get(scope) as Row | undefined;
    const checkpoint = database
      .prepare(
        "SELECT * FROM run_coordination_checkpoints WHERE run_id=@run AND owner_id=@owner AND agent_id=@agent",
      )
      .get(scope) as Row | undefined;
    const lease = database
      .prepare(
        "SELECT * FROM run_execution_leases WHERE run_id=@run AND owner_id=@owner AND agent_id=@agent",
      )
      .get(scope) as Row | undefined;
    const thread = database
      .prepare("SELECT * FROM threads WHERE id=@thread AND owner_id=@owner AND agent_id=@agent")
      .get(scope) as Row | undefined;
    const deployment = database
      .prepare(
        "SELECT * FROM deployments WHERE id=@deployment AND owner_id=@owner AND agent_id=@agent AND status='active'",
      )
      .get(scope) as Row | undefined;
    const resourcesReleased = RUN_RESOURCES_RELEASED_SQL.replace(
      "WHERE resource.owner_id=r.owner_id",
      "WHERE resource.job_id<>@job AND resource.owner_id=r.owner_id",
    );
    const eligibleResources = database
      .prepare(`SELECT 1 FROM runs r WHERE id=@run AND owner_id=@owner AND agent_id=@agent
      AND (${resourcesReleased})
      AND NOT EXISTS (SELECT 1 FROM sandbox_execution_intents WHERE job_id IN (
        SELECT job_id FROM sandbox_execution_records WHERE owner_id=@owner AND agent_id=@agent AND run_id=@run) AND acknowledged_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM sandbox_workspace_barriers WHERE job_id=@job AND resolved_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM execution_environment_leases WHERE released_at IS NULL AND environment_id IN (
        SELECT environment_id FROM execution_environments WHERE execution_job_id IN (
          SELECT execution_job_id FROM execution_jobs WHERE owner_id=@owner AND agent_id=@agent AND run_id=@run)))`)
      .get(scope);
    let recovery: unknown;
    try {
      recovery = JSON.parse(String(row["recovery_json"]));
    } catch {
      recovery = null;
    }
    if (
      row["preparation_state"] !== "reserved" ||
      row["started_at"] !== null ||
      row["start_policy_digest"] !== null ||
      !instant(row["reservation_stopped_at"]) ||
      plan.backendRef !== "srt" ||
      plan.mode !== "foreground" ||
      row["run_id"] !== plan.identity.runId ||
      row["environment_id"] !== plan.environmentId ||
      row["attempt_id"] !== plan.identity.attemptId ||
      row["receipt_ref"] !== plan.identity.receiptRef ||
      row["invocation_id"] !== plan.identity.invocationId ||
      !run ||
      run["status"] !== "reconciling_external_result" ||
      run["thread_id"] !== plan.identity.threadId ||
      !checkpoint ||
      checkpoint["phase"] !== "reconciling_external_result" ||
      checkpoint["terminal_status"] !== null ||
      checkpoint["output_kind"] !== null ||
      checkpoint["final_answer_ref"] !== null ||
      !thread ||
      thread["status"] !== "open" ||
      !lease ||
      lease["deployment_id"] !== this.#deployment ||
      !deployment ||
      !positive(deployment["authority_epoch"]) ||
      !positive(deployment["fencing_token"]) ||
      !record(recovery) ||
      !positive(recovery["revision"]) ||
      !eligibleResources ||
      database
        .prepare("SELECT 1 FROM sandbox_reservation_release_receipts WHERE job_id=?")
        .get(plan.identity.jobId)
    )
      return fail(SANDBOX_RESERVATION_ADMIN_ERROR_CODES.NOT_ELIGIBLE);
    return {
      digest: sha256(this.#snapshot(database, plan, schema)),
      record: {
        jobId: plan.identity.jobId,
        runId: plan.identity.runId,
        threadId: String(thread["id"]),
        environmentId: plan.environmentId,
        semanticFingerprint: plan.semanticFingerprint,
        stopRequestedAt: row["reservation_stopped_at"],
        preparationState: "reserved",
        startedAt: null,
        runRevision: Number(run["revision"]),
        checkpointRevision: Number(checkpoint["revision"]),
        leaseRevision: Number(lease["revision"]),
        threadRevision: Number(thread["revision"]),
      },
      confirmation: SANDBOX_RESERVATION_ADMIN_CONFIRMATION,
    };
  }

  #confirm(
    database: Database,
    input: {
      jobId: string;
      digest: string;
      administrator: string;
      evidence: string;
      confirmation: string;
    },
  ): SandboxReservationAdministrationConfirmation {
    this.#assertSchema(database, true);
    const target = this.#target(database, input.jobId);
    const { row, plan } = target;
    const existing = database
      .prepare(
        "SELECT accepted_at,verification_json,authority_json FROM sandbox_reservation_release_receipts WHERE job_id=?",
      )
      .get(input.jobId) as Row | undefined;
    if (existing) {
      const receipt = readAdministratorReservationRelease(
        database,
        plan,
        typeof row["reservation_stopped_at"] === "string"
          ? row["reservation_stopped_at"]
          : undefined,
        String(existing["accepted_at"]),
        JSON.parse(String(existing["verification_json"])),
        JSON.parse(String(existing["authority_json"])),
        () => fail(SANDBOX_RESERVATION_ADMIN_ERROR_CODES.NOT_ELIGIBLE),
      );
      if (
        receipt.verification.inspectionDigest !== input.digest ||
        receipt.verification.administrator !== input.administrator ||
        receipt.verification.evidenceDigest !== input.evidence
      )
        return fail(SANDBOX_RESERVATION_ADMIN_ERROR_CODES.DIGEST_MISMATCH);
      return { jobId: input.jobId, runId: plan.identity.runId, alreadyConfirmed: true, receipt };
    }
    const inspection = this.#inspection(database, target, 50);
    if (inspection.digest !== input.digest)
      return fail(SANDBOX_RESERVATION_ADMIN_ERROR_CODES.DIGEST_MISMATCH);
    const now = new Date().toISOString();
    if (now < inspection.record.stopRequestedAt)
      return fail(SANDBOX_RESERVATION_ADMIN_ERROR_CODES.NOT_ELIGIBLE);
    const user = userInfo();
    const actor = { uid: user.uid, account: user.username, hostname: hostname() };
    if (
      !Number.isSafeInteger(actor.uid) ||
      actor.uid < 0 ||
      !text(actor.account) ||
      !text(actor.hostname)
    )
      return fail(SANDBOX_RESERVATION_ADMIN_ERROR_CODES.NOT_ELIGIBLE);
    const identityDigest = createHash("sha256")
      .update(JSON.stringify([this.#owner, this.#agent, input.jobId]))
      .digest("hex");
    const auditId = `sandbox-admin-audit:${identityDigest}`;
    const verification: SandboxAdministratorReservationReleaseVerification = {
      schemaVersion: "sandbox-admin-reservation-release.v1",
      basis: "administrator_confirmed_cleanup",
      identity: plan.identity,
      environmentId: plan.environmentId,
      semanticFingerprint: plan.semanticFingerprint,
      stopRequestedAt: inspection.record.stopRequestedAt,
      checkedAt: now,
      inspectionDigest: input.digest,
      administrator: input.administrator,
      evidenceDigest: input.evidence,
      confirmation: SANDBOX_RESERVATION_ADMIN_CONFIRMATION,
      actor,
      auditId,
    };
    database
      .prepare(`INSERT INTO audit_records(id,owner_id,agent_id,action,target_ref,outcome,detail_ref,occurred_at)
      VALUES(?,?,?,'sandbox.reservation_cleanup_confirmed',?,'completed',NULL,?)`)
      .run(auditId, this.#owner, this.#agent, input.jobId, now);
    database
      .prepare(
        "INSERT INTO sandbox_reservation_release_receipts(job_id,accepted_at,verification_json,authority_json) VALUES(?,?,?,?)",
      )
      .run(
        input.jobId,
        now,
        JSON.stringify(verification),
        JSON.stringify({
          schemaVersion: "sandbox-admin-reservation-authority.v1",
          verificationDigest: sha256(verification),
        }),
      );
    database
      .prepare(
        "UPDATE sandbox_workspace_occupancy SET released_at=? WHERE job_id=? AND released_at IS NULL",
      )
      .run(now, input.jobId);
    const previousRecovery = JSON.parse(String(row["recovery_json"])) as SandboxRecoveryState;
    const recovery: SandboxRecoveryState = {
      ...previousRecovery,
      revision: previousRecovery.revision + 1,
      status: "resolved",
      finishedAt: now,
      reasonCode: "SANDBOX_ADMINISTRATOR_CONFIRMED_CLEANUP",
      nextAttemptAt: null,
    };
    database
      .prepare("UPDATE sandbox_execution_records SET recovery_json=? WHERE job_id=?")
      .run(JSON.stringify(recovery), input.jobId);
    database
      .prepare(
        "UPDATE runs SET status='failed',revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND agent_id=?",
      )
      .run(now, plan.identity.runId, this.#owner, this.#agent);
    database
      .prepare(`UPDATE run_coordination_checkpoints SET phase='failed',terminal_status='failed',revision=revision+1,
      diagnostic_code='SANDBOX_ADMINISTRATOR_CONFIRMED_CLEANUP',updated_at=? WHERE run_id=? AND owner_id=? AND agent_id=?`)
      .run(now, plan.identity.runId, this.#owner, this.#agent);
    database
      .prepare(
        "UPDATE run_execution_leases SET revision=revision+1,released_at=COALESCE(released_at,?) WHERE run_id=? AND owner_id=? AND agent_id=?",
      )
      .run(now, plan.identity.runId, this.#owner, this.#agent);
    const changedThread = database
      .prepare(
        "UPDATE threads SET revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND agent_id=? RETURNING revision",
      )
      .get(now, inspection.record.threadId, this.#owner, this.#agent) as { revision: number };
    const deployment = database
      .prepare(
        "SELECT authority_epoch,fencing_token FROM deployments WHERE id=? AND owner_id=? AND agent_id=? AND status='active'",
      )
      .get(this.#deployment, this.#owner, this.#agent) as {
      authority_epoch: number;
      fencing_token: number;
    };
    appendThreadGatewayEventInTransaction(database, {
      ownerId: createOwnerId(this.#owner),
      agentId: createAgentId(this.#agent),
      threadId: createThreadId(inspection.record.threadId),
      threadRevision: changedThread.revision,
      eventId: `sandbox-admin-event:${identityDigest}`,
      commandId: `sandbox-admin-command:${identityDigest}`,
      commandType: "run.failed",
      resultRef: null,
      committedAt: now,
      authority: {
        deploymentId: createDeploymentId(this.#deployment),
        authorityEpoch: deployment.authority_epoch,
        fencingToken: deployment.fencing_token,
      },
    });
    return {
      jobId: input.jobId,
      runId: plan.identity.runId,
      alreadyConfirmed: false,
      receipt: { acceptedAt: now, verification },
    };
  }
}
