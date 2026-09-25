import { createHash } from "node:crypto";
import type {
  ExecutionEnvironmentCall,
  ExecutionEnvironmentRecord,
  ExecutionEnvironmentReleaseReceipt,
  ExecutionEnvironmentStopIntent,
  SandboxWorkspaceClaim,
} from "@himawari-agent/application";
import {
  workspaceClaimsConflict as conflicts,
  workspaceClaimCovers as covers,
} from "@himawari-agent/application/workspace-claims";
import {
  EXECUTION_ENVIRONMENT_V1,
  type ExecutionEnvironmentStopProof,
  executionEnvelopeSchema,
  executionEnvironmentLocatorSchema,
  executionEnvironmentStopProofSchema,
} from "@himawari-agent/execution-contracts";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";
import { parseWorkspaceClaims } from "./sqlite-sandbox-execution-operations.ts";

interface Dependencies {
  authority(value: unknown, owner: string, agent: string, now: string): void;
  disk(): void;
  assertAvailable(
    claims: readonly SandboxWorkspaceClaim[],
    exceptEnvironment: string,
    now: string,
  ): void;
}
interface EnvironmentRow {
  environmentId: string;
  executionJobId: string;
  ownerId: string;
  agentId: string;
  runId: string;
  hostId: string;
  role: "primary" | "network_helper";
  generation: number;
  state: ExecutionEnvironmentRecord["state"];
  rotationReason: ExecutionEnvironmentRecord["rotationReason"];
  backendRef: string;
  envelope: string;
  envelopeDigest: string;
  policyDigest: string;
  imageDigest: string;
  runnerDigest: string;
  deadlineAt: string;
  createIntentId: string;
  createDispatchedAt: string | null;
  locator: string | null;
  stopFence: number;
  reasonCode: string | null;
  createdAt: string;
}
type Input = Record<string, unknown>;

const COLUMNS = `e.environment_id AS environmentId, e.execution_job_id AS executionJobId,
  j.owner_id AS ownerId, j.agent_id AS agentId, j.run_id AS runId, j.host_id AS hostId,
  e.role, e.generation, e.state, e.rotation_reason AS rotationReason, e.backend_ref AS backendRef,
  e.envelope_json AS envelope, e.envelope_digest AS envelopeDigest, e.policy_digest AS policyDigest,
  e.image_digest AS imageDigest, e.runner_digest AS runnerDigest, e.deadline_at AS deadlineAt,
  e.create_intent_id AS createIntentId, e.create_dispatched_at AS createDispatchedAt,
  e.locator_json AS locator, e.stop_fence AS stopFence, e.reason_code AS reasonCode,
  e.created_at AS createdAt
  FROM execution_environments e JOIN execution_jobs j ON j.execution_job_id=e.execution_job_id`;
const ROTATION_REASONS = ["initial", "expansion", "revocation", "expiry", "failure"];
const STOP_REASONS = [
  "run_finished",
  "run_cancelled",
  "expansion",
  "revocation",
  "expiry",
  "failure",
  "supervision_lost",
];
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const instant = (value: unknown): value is string =>
  typeof value === "string" && new Date(value).toISOString() === value;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class SqliteExecutionEnvironmentOperations {
  private readonly db: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly dependencies: Dependencies;
  constructor(db: Database.Database, fail: SqliteApplicationFailure, dependencies: Dependencies) {
    this.db = db;
    this.fail = fail;
    this.dependencies = dependencies;
  }

  execute(operation: string, raw: unknown, owner: string, agent: string): unknown {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return this.fail("PORT_INVALID_OPERATION", "Invalid execution environment request");
    const input = raw as Input;
    if (operation === "read") return this.read(this.id(input["environmentId"]), owner, agent);
    if (operation === "readRun") return this.readRun(this.id(input["runId"]), owner, agent);
    if (operation === "listUnreleased") return this.listUnreleased(input, owner, agent);
    const writes: Record<
      string,
      (input: Input, owner: string, agent: string, now: string) => unknown
    > = {
      reserve: (value, o, a, now) => this.reserve(value, o, a, now),
      beginCreate: (value, o, a, now) => this.beginCreate(value, o, a, now),
      recordCreated: (value, o, a, now) => this.recordCreated(value, o, a, now),
      recordCreateUnknown: (value, o, a, now) => this.recordCreateUnknown(value, o, a, now),
      linkCall: (value, o, a, now) => this.linkCall(value, o, a, now),
      completeCall: (value, o, a, now) => this.completeCall(value, o, a, now),
      requestStop: (value, o, a, now) => this.requestStop(value, o, a, now),
      acknowledgeStop: (value, o, a, now) => this.acknowledgeStop(value, o, a, now),
      acceptRelease: (value, o, a, now) => this.acceptRelease(value, o, a, now),
    };
    const write = writes[operation];
    if (!write)
      return this.fail("PORT_INVALID_OPERATION", "Unknown execution environment operation");
    const now = input["now"];
    if (!instant(now)) return this.fail("PORT_INVALID_OPERATION", "Invalid environment clock");
    return this.db.transaction(() => {
      this.dependencies.authority(input["authority"], owner, agent, now);
      this.dependencies.disk();
      return write(input, owner, agent, now);
    })();
  }

  private reserve(input: Input, owner: string, agent: string, now: string) {
    const runId = this.id(input["runId"]);
    const hostId = this.id(input["hostId"]);
    const role = input["role"];
    const rotationReason = input["rotationReason"];
    const backendRef = this.id(input["backendRef"]);
    const ids = input["ids"] as Input | undefined;
    if (
      (role !== "primary" && role !== "network_helper") ||
      !ROTATION_REASONS.includes(rotationReason as string) ||
      !digest(input["policyDigest"]) ||
      !digest(input["imageDigest"]) ||
      !digest(input["runnerDigest"]) ||
      !instant(input["deadlineAt"]) ||
      !ids ||
      !id(ids["executionJobId"]) ||
      !id(ids["environmentId"]) ||
      !id(ids["createIntentId"])
    )
      return this.fail("PORT_INVALID_OPERATION", "Invalid execution environment reservation");
    if (Date.parse(input["deadlineAt"] as string) <= Date.parse(now))
      return this.fail("PORT_CONFLICT", "Execution environment deadline has passed", {
        reasonCode: "EXECUTION_BINDING_CHANGED",
      });
    const envelope = executionEnvelopeSchema.parse(input["envelope"]);
    const leases = this.claims(input["leases"], hostId);
    const covered =
      leases.length === envelope.directories.length &&
      envelope.directories.every(
        (directory) =>
          directory.hostId === hostId &&
          leases.filter(
            (lease) =>
              lease.file === undefined &&
              lease.canonicalRootId === directory.canonicalRootId &&
              lease.access === directory.access,
          ).length === 1,
      ) &&
      (role === "primary" || leases.length === 0);
    if (!covered)
      return this.fail("PORT_INVALID_OPERATION", "Environment lease must match its envelope");
    const run = this.db
      .prepare("SELECT status FROM runs WHERE owner_id=? AND agent_id=? AND id=?")
      .get(owner, agent, runId) as { status: string } | undefined;
    if (!run || ["completed", "failed", "cancelled"].includes(run.status))
      return this.fail("PORT_CONFLICT", "Run cannot own a new execution environment", {
        reasonCode: "EXECUTION_BINDING_CHANGED",
      });
    let job = this.db
      .prepare(
        "SELECT execution_job_id AS executionJobId, host_id AS hostId FROM execution_jobs WHERE owner_id=? AND agent_id=? AND run_id=?",
      )
      .get(owner, agent, runId) as { executionJobId: string; hostId: string } | undefined;
    if (job && job.hostId !== hostId)
      return this.fail("PORT_CONFLICT", "Execution job belongs to another host", {
        reasonCode: "EXECUTION_BINDING_CHANGED",
      });
    if (!job) {
      job = { executionJobId: ids["executionJobId"] as string, hostId };
      this.db
        .prepare(
          "INSERT INTO execution_jobs(execution_job_id,owner_id,agent_id,run_id,host_id,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(job.executionJobId, owner, agent, runId, hostId, now);
    }
    const current = this.db
      .prepare(
        "SELECT environment_id AS environmentId, generation, state FROM execution_environments WHERE execution_job_id=? AND role=? ORDER BY generation DESC LIMIT 1",
      )
      .get(job.executionJobId, role) as
      | { environmentId: string; generation: number; state: string }
      | undefined;
    if (current && current.state !== "released")
      return { record: this.readScoped(current.environmentId, owner, agent), applied: false };
    const generation = (current?.generation ?? 0) + 1;
    if ((generation === 1) !== (rotationReason === "initial"))
      return this.fail("PORT_INVALID_OPERATION", "Rotation reason does not match generation");
    this.dependencies.assertAvailable(leases, "", now);
    const envelopeJson = JSON.stringify(envelope);
    this.db
      .prepare(
        `INSERT INTO execution_environments(environment_id,execution_job_id,role,generation,state,rotation_reason,
        backend_ref,envelope_json,envelope_digest,policy_digest,image_digest,runner_digest,deadline_at,create_intent_id,
        created_at,updated_at) VALUES(?,?,?,?,'reserved',?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        ids["environmentId"],
        job.executionJobId,
        role,
        generation,
        rotationReason,
        backendRef,
        envelopeJson,
        createHash("sha256").update(envelopeJson).digest("hex"),
        input["policyDigest"],
        input["imageDigest"],
        input["runnerDigest"],
        input["deadlineAt"],
        ids["createIntentId"],
        now,
        now,
      );
    const insertLease = this.db.prepare(
      "INSERT INTO execution_environment_leases(environment_id,scope_ref,host_id,claim_json) VALUES(?,?,?,?)",
    );
    for (const lease of leases)
      insertLease.run(ids["environmentId"], lease.ref, lease.hostId, JSON.stringify(lease));
    return { record: this.readScoped(ids["environmentId"] as string, owner, agent), applied: true };
  }

  private beginCreate(input: Input, owner: string, agent: string, now: string) {
    const row = this.row(input, owner, agent);
    if (row.state !== "reserved" || row.stopFence !== 0)
      return this.changed("Creation cannot start");
    this.db
      .prepare(
        "UPDATE execution_environments SET state='creating', create_dispatched_at=?, updated_at=? WHERE environment_id=? AND state='reserved' AND stop_fence=0",
      )
      .run(now, now, row.environmentId);
    return this.readScoped(row.environmentId, owner, agent);
  }

  private recordCreated(input: Input, owner: string, agent: string, now: string) {
    const locator = executionEnvironmentLocatorSchema.parse(input["locator"]);
    const row = this.row(input, owner, agent);
    if (
      row.state === "released" ||
      row.createDispatchedAt === null ||
      locator.createIntentId !== row.createIntentId ||
      locator.backendRef !== row.backendRef
    )
      return this.changed("Created environment does not match its create intent");
    if (row.locator !== null) {
      if (!same(JSON.parse(row.locator), locator))
        return this.changed("Created environment locator changed");
    } else {
      const executable =
        row.stopFence === 0 && (row.state === "creating" || row.state === "unknown");
      this.db
        .prepare(
          "UPDATE execution_environments SET locator_json=?, state=?, reason_code=NULL, updated_at=? WHERE environment_id=?",
        )
        .run(JSON.stringify(locator), executable ? "ready" : row.state, now, row.environmentId);
    }
    const record = this.readScoped(row.environmentId, owner, agent);
    return { record, executable: record.state === "ready" || record.state === "running" };
  }

  private recordCreateUnknown(input: Input, owner: string, agent: string, now: string) {
    const reasonCode = this.id(input["reasonCode"]);
    const row = this.row(input, owner, agent);
    if (row.state === "creating")
      this.db
        .prepare(
          "UPDATE execution_environments SET state='unknown', reason_code=?, updated_at=? WHERE environment_id=?",
        )
        .run(reasonCode, now, row.environmentId);
    else if (row.state !== "unknown")
      return this.changed("Only a dispatched creation can be unknown");
    return this.readScoped(row.environmentId, owner, agent);
  }

  private linkCall(input: Input, owner: string, agent: string, now: string) {
    const invocationId = this.id(input["invocationId"]);
    const receiptRef = this.id(input["receiptRef"]);
    const row = this.row(input, owner, agent);
    if (!Number.isSafeInteger(input["expectedStopFence"]))
      return this.fail("PORT_INVALID_OPERATION", "Invalid expected stop fence");
    const claims = this.claims(input["claims"], row.hostId);
    if (
      (row.state !== "ready" && row.state !== "running") ||
      row.stopFence !== input["expectedStopFence"]
    )
      return this.changed("Environment no longer accepts calls");
    const receipt = this.db
      .prepare(
        "SELECT run_id AS runId, invocation_id AS invocationId FROM capability_invocation_receipts WHERE receipt_ref=? AND owner_id=? AND agent_id=?",
      )
      .get(receiptRef, owner, agent) as { runId: string; invocationId: string } | undefined;
    if (!receipt || receipt.runId !== row.runId || receipt.invocationId !== invocationId)
      return this.changed("Receipt does not belong to this environment");
    const existing = this.db
      .prepare(
        "SELECT environment_id AS environmentId, invocation_id AS invocationId, claims_json AS claims FROM execution_environment_calls WHERE receipt_ref=? OR (environment_id=? AND invocation_id=?)",
      )
      .all(receiptRef, row.environmentId, invocationId) as {
      environmentId: string;
      invocationId: string;
      claims: string;
    }[];
    if (existing.length > 0) {
      const [call] = existing;
      if (
        existing.length === 1 &&
        call?.environmentId === row.environmentId &&
        call.invocationId === invocationId &&
        same(JSON.parse(call.claims), claims)
      )
        return { record: this.readScoped(row.environmentId, owner, agent), applied: false };
      return this.changed("Call is already linked differently");
    }
    const leases = this.leases(row.environmentId);
    if (!claims.every((claim) => leases.some((lease) => covers(lease, claim))))
      return this.fail("PORT_CONFLICT", "Call exceeds the environment envelope", {
        reasonCode: "EXECUTION_ENVELOPE_EXCEEDED",
      });
    const open = this.db
      .prepare(
        "SELECT claims_json AS claims FROM execution_environment_calls WHERE environment_id=? AND completed_at IS NULL",
      )
      .all(row.environmentId) as { claims: string }[];
    for (const call of open)
      for (const other of JSON.parse(call.claims) as SandboxWorkspaceClaim[])
        if (claims.some((claim) => conflicts(claim, other)))
          return this.fail(
            "PORT_CONFLICT",
            "An earlier call in this environment holds the target",
            {
              reasonCode: "WORKSPACE_OCCUPIED",
            },
          );
    this.db
      .prepare(
        "INSERT INTO execution_environment_calls(environment_id,invocation_id,receipt_ref,claims_json,linked_at) VALUES(?,?,?,?,?)",
      )
      .run(row.environmentId, invocationId, receiptRef, JSON.stringify(claims), now);
    this.db
      .prepare(
        "UPDATE execution_environments SET state='running', updated_at=? WHERE environment_id=? AND state='ready'",
      )
      .run(now, row.environmentId);
    return { record: this.readScoped(row.environmentId, owner, agent), applied: true };
  }

  private completeCall(input: Input, owner: string, agent: string, now: string) {
    const invocationId = this.id(input["invocationId"]);
    const row = this.row(input, owner, agent);
    const updated = this.db
      .prepare(
        "UPDATE execution_environment_calls SET completed_at=coalesce(completed_at, ?) WHERE environment_id=? AND invocation_id=?",
      )
      .run(now, row.environmentId, invocationId);
    if (updated.changes !== 1) return this.fail("PORT_NOT_FOUND", "Environment call not found");
    return this.readScoped(row.environmentId, owner, agent);
  }

  private requestStop(input: Input, owner: string, agent: string, now: string) {
    const stopIntentId = this.id(input["stopIntentId"]);
    const reason = input["reason"];
    const refs = input["stoppedResourceRefs"];
    if (
      !STOP_REASONS.includes(reason as string) ||
      !Array.isArray(refs) ||
      refs.length > 256 ||
      !refs.every(id) ||
      new Set(refs).size !== refs.length
    )
      return this.fail("PORT_INVALID_OPERATION", "Invalid environment stop request");
    const row = this.row(input, owner, agent);
    if (row.state === "released" || row.stopFence > 0)
      return { record: this.readScoped(row.environmentId, owner, agent), applied: false };
    const fence = row.stopFence + 1;
    this.db
      .prepare(
        "UPDATE execution_environments SET state='stop_requested', stop_fence=?, updated_at=? WHERE environment_id=? AND stop_fence=?",
      )
      .run(fence, now, row.environmentId, row.stopFence);
    this.db
      .prepare(
        `INSERT INTO execution_environment_stop_intents(environment_id,stop_fence,stop_intent_id,reason,
        stopped_resource_refs_json,requested_at,authority_json) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        row.environmentId,
        fence,
        stopIntentId,
        reason,
        JSON.stringify(refs),
        now,
        JSON.stringify(input["authority"]),
      );
    return { record: this.readScoped(row.environmentId, owner, agent), applied: true };
  }

  private acknowledgeStop(input: Input, owner: string, agent: string, now: string) {
    const stopIntentId = this.id(input["stopIntentId"]);
    const row = this.row(input, owner, agent);
    const updated = this.db
      .prepare(
        "UPDATE execution_environment_stop_intents SET acknowledged_at=coalesce(acknowledged_at, ?) WHERE environment_id=? AND stop_intent_id=?",
      )
      .run(now, row.environmentId, stopIntentId);
    if (updated.changes !== 1) return this.changed("Stop intent not found");
    return this.readScoped(row.environmentId, owner, agent);
  }

  private acceptRelease(input: Input, owner: string, agent: string, now: string) {
    const raw = input["proof"] as Input | undefined;
    const proof: ExecutionEnvironmentStopProof | { basis: "create_not_dispatched" } =
      raw && raw["basis"] === "create_not_dispatched" && Object.keys(raw).length === 1
        ? { basis: "create_not_dispatched" }
        : executionEnvironmentStopProofSchema.parse(raw);
    const row = this.row(input, owner, agent);
    if (row.state === "released")
      return { record: this.readScoped(row.environmentId, owner, agent), applied: false };
    const intent = this.stopIntent(row.environmentId);
    if (row.state !== "stop_requested" || !intent || intent.stopFence !== row.stopFence)
      return this.changed("Release requires the current stop request");
    if (proof.basis === "create_not_dispatched") {
      if (row.createDispatchedAt !== null)
        return this.changed("A dispatched creation needs a backend proof");
    } else {
      if (
        !same(proof.identity, this.identity(row)) ||
        proof.createIntentId !== row.createIntentId ||
        proof.stopIntentId !== intent.stopIntentId ||
        proof.stopFence !== row.stopFence ||
        (proof.basis === "verified_stopped"
          ? row.locator === null || !same(JSON.parse(row.locator), proof.locator)
          : row.locator !== null || row.createDispatchedAt === null)
      )
        return this.changed("Stop proof belongs to another environment or stop");
      if (
        Date.parse(proof.checkedAt) > Date.parse(now) ||
        Date.parse(proof.validUntil) <= Date.parse(now)
      )
        return this.fail("PORT_CONFLICT", "Stop proof is not currently valid", {
          reasonCode: "EXECUTION_STOP_UNCONFIRMED",
        });
    }
    this.db
      .prepare(
        "INSERT INTO execution_environment_release_receipts(environment_id,basis,stop_fence,accepted_at,proof_json,authority_json) VALUES(?,?,?,?,?,?)",
      )
      .run(
        row.environmentId,
        proof.basis,
        row.stopFence,
        now,
        proof.basis === "create_not_dispatched" ? null : JSON.stringify(proof),
        JSON.stringify(input["authority"]),
      );
    this.db
      .prepare(
        "UPDATE execution_environment_leases SET released_at=? WHERE environment_id=? AND released_at IS NULL",
      )
      .run(now, row.environmentId);
    this.db
      .prepare(
        "UPDATE execution_environments SET state='released', updated_at=? WHERE environment_id=?",
      )
      .run(now, row.environmentId);
    return { record: this.readScoped(row.environmentId, owner, agent), applied: true };
  }

  private read(environmentId: string, owner: string, agent: string) {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} WHERE e.environment_id=? AND j.owner_id=? AND j.agent_id=?`)
      .get(environmentId, owner, agent) as EnvironmentRow | undefined;
    return row ? this.record(row) : undefined;
  }

  private readRun(runId: string, owner: string, agent: string) {
    const job = this.db
      .prepare(
        "SELECT execution_job_id AS executionJobId FROM execution_jobs WHERE owner_id=? AND agent_id=? AND run_id=?",
      )
      .get(owner, agent, runId) as { executionJobId: string } | undefined;
    if (!job) return undefined;
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} WHERE e.execution_job_id=? ORDER BY e.role, e.generation`)
      .all(job.executionJobId) as EnvironmentRow[];
    return {
      executionJobId: job.executionJobId,
      environments: rows.map((row) => this.record(row)),
    };
  }

  private listUnreleased(input: Input, owner: string, agent: string) {
    const after = input["afterEnvironmentId"];
    const limit = input["limit"];
    if (
      (after !== null && !id(after)) ||
      !Number.isSafeInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > 1000
    )
      return this.fail("PORT_INVALID_OPERATION", "Invalid environment page");
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} WHERE e.state != 'released' AND j.owner_id=? AND j.agent_id=? AND e.environment_id > ? ORDER BY e.environment_id LIMIT ?`,
      )
      .all(owner, agent, after ?? "", limit) as EnvironmentRow[];
    return rows.map((row) => this.record(row));
  }

  private row(input: Input, owner: string, agent: string): EnvironmentRow {
    const environmentId = this.id(input["environmentId"]);
    const row = this.db
      .prepare(`SELECT ${COLUMNS} WHERE e.environment_id=? AND j.owner_id=? AND j.agent_id=?`)
      .get(environmentId, owner, agent) as EnvironmentRow | undefined;
    if (!row) return this.fail("PORT_NOT_FOUND", "Execution environment not found");
    return row;
  }

  private readScoped(
    environmentId: string,
    owner: string,
    agent: string,
  ): ExecutionEnvironmentRecord {
    const record = this.read(environmentId, owner, agent);
    if (!record) return this.fail("PORT_NOT_FOUND", "Execution environment not found");
    return record;
  }

  private identity(row: EnvironmentRow) {
    return {
      schemaVersion: EXECUTION_ENVIRONMENT_V1,
      ownerId: row.ownerId,
      agentId: row.agentId,
      runId: row.runId,
      hostId: row.hostId,
      executionJobId: row.executionJobId,
      environmentId: row.environmentId,
      environmentGeneration: row.generation,
      role: row.role,
    };
  }

  private record(row: EnvironmentRow): ExecutionEnvironmentRecord {
    const calls = this.db
      .prepare(
        "SELECT invocation_id AS invocationId, receipt_ref AS receiptRef, claims_json AS claims, linked_at AS linkedAt, completed_at AS completedAt FROM execution_environment_calls WHERE environment_id=? ORDER BY rowid",
      )
      .all(row.environmentId) as (Omit<ExecutionEnvironmentCall, "claims"> & { claims: string })[];
    const receipt = this.db
      .prepare(
        "SELECT basis, stop_fence AS stopFence, accepted_at AS acceptedAt, proof_json AS proof FROM execution_environment_release_receipts WHERE environment_id=?",
      )
      .get(row.environmentId) as
      | {
          basis: ExecutionEnvironmentReleaseReceipt["basis"];
          stopFence: number;
          acceptedAt: string;
          proof: string | null;
        }
      | undefined;
    const releaseReceipt: ExecutionEnvironmentReleaseReceipt | null = !receipt
      ? null
      : receipt.basis === "create_not_dispatched"
        ? {
            basis: "create_not_dispatched",
            stopFence: receipt.stopFence,
            acceptedAt: receipt.acceptedAt,
          }
        : (() => {
            const proof = executionEnvironmentStopProofSchema.parse(
              JSON.parse(receipt.proof ?? "null"),
            );
            return {
              basis: proof.basis,
              stopFence: receipt.stopFence,
              acceptedAt: receipt.acceptedAt,
              proof,
            };
          })();
    return Object.freeze({
      identity: this.identity(row),
      state: row.state,
      rotationReason: row.rotationReason,
      backendRef: row.backendRef,
      envelope: executionEnvelopeSchema.parse(JSON.parse(row.envelope)),
      envelopeDigest: row.envelopeDigest,
      policyDigest: row.policyDigest,
      imageDigest: row.imageDigest,
      runnerDigest: row.runnerDigest,
      deadlineAt: row.deadlineAt,
      createIntentId: row.createIntentId,
      createDispatchedAt: row.createDispatchedAt,
      locator:
        row.locator === null
          ? null
          : executionEnvironmentLocatorSchema.parse(JSON.parse(row.locator)),
      stopFence: row.stopFence,
      stopIntent: this.stopIntent(row.environmentId),
      releaseReceipt,
      leases: this.leases(row.environmentId),
      calls: calls.map((call) => ({
        ...call,
        claims: JSON.parse(call.claims) as SandboxWorkspaceClaim[],
      })),
      reasonCode: row.reasonCode,
      createdAt: row.createdAt,
    });
  }

  private stopIntent(environmentId: string): ExecutionEnvironmentStopIntent | null {
    const intent = this.db
      .prepare(
        `SELECT stop_intent_id AS stopIntentId, stop_fence AS stopFence, reason,
        stopped_resource_refs_json AS refs, requested_at AS requestedAt, acknowledged_at AS acknowledgedAt
        FROM execution_environment_stop_intents WHERE environment_id=? ORDER BY stop_fence DESC LIMIT 1`,
      )
      .get(environmentId) as
      | (Omit<ExecutionEnvironmentStopIntent, "stoppedResourceRefs"> & { refs: string })
      | undefined;
    if (!intent) return null;
    const { refs, ...rest } = intent;
    return { ...rest, stoppedResourceRefs: JSON.parse(refs) as string[] };
  }

  private leases(environmentId: string): SandboxWorkspaceClaim[] {
    return (
      this.db
        .prepare(
          "SELECT claim_json AS claim FROM execution_environment_leases WHERE environment_id=? ORDER BY scope_ref",
        )
        .all(environmentId) as { claim: string }[]
    ).map((row) => JSON.parse(row.claim) as SandboxWorkspaceClaim);
  }

  private claims(raw: unknown, hostId: string): SandboxWorkspaceClaim[] {
    if (!Array.isArray(raw) || raw.length > 64)
      return this.fail("PORT_INVALID_OPERATION", "Invalid environment workspace claims");
    const claims = parseWorkspaceClaims(raw, hostId, this.fail);
    if (new Set(claims.map((claim) => claim.ref)).size !== claims.length)
      return this.fail("PORT_INVALID_OPERATION", "Duplicate environment workspace claim");
    return claims;
  }

  private id(value: unknown): string {
    if (!id(value))
      return this.fail("PORT_INVALID_OPERATION", "Invalid execution environment locator");
    return value;
  }

  private changed(message: string): never {
    return this.fail("PORT_CONFLICT", message, { reasonCode: "EXECUTION_BINDING_CHANGED" });
  }
}
