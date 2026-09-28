import type { PayloadRecord } from "@himawari-agent/application";
import BetterSqlite3 from "better-sqlite3";

const DIAGNOSTIC_OPERATION_KEYS = `(a.operation_key LIKE 'runtime-tool-diagnostic:%'
  OR a.operation_key GLOB 'sandbox-control:*:diagnostic:*'
  OR a.operation_key GLOB 'sandbox-control:*:observation:*')`;

export interface RunDiagnosticsObservation {
  readonly sequence: number;
  readonly occurredAt: string | null;
  readonly supervision: string | null;
  readonly cleanup: string | null;
  readonly reasonCode: string | null;
  readonly resultKind: string | null;
  readonly resultReasonCode: string | null;
}

export interface RunDiagnosticsSandboxJob {
  readonly jobId: string;
  readonly invocationId: string;
  readonly toolCallId: string | null;
  readonly startedAt: string | null;
  readonly sequence: number;
  readonly supervision: string | null;
  readonly cleanup: string | null;
  readonly reasonCode: string | null;
  readonly recovery: unknown;
  readonly observations: readonly RunDiagnosticsObservation[];
  readonly intents: readonly {
    readonly kind: string;
    readonly sequence: number;
    readonly createdAt: string;
    readonly dispatchedAt: string | null;
    readonly acknowledgedAt: string | null;
  }[];
}

export interface RunDiagnosticsSnapshot {
  readonly run: {
    readonly id: string;
    readonly threadId: string | null;
    readonly status: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly sandboxJobs: readonly RunDiagnosticsSandboxJob[];
  readonly diagnosticPayloads: readonly {
    readonly operationKey: string;
    readonly createdAt: string;
    readonly payload: PayloadRecord;
  }[];
}

interface PayloadRow {
  readonly operationKey: string;
  readonly createdAt: string;
  readonly ref: string;
  readonly dataClassification: PayloadRecord["dataClassification"];
  readonly contentType: string;
  readonly ciphertext: Uint8Array | null;
  readonly encryptionMetadataJson: string;
  readonly contentDigest: string;
  readonly payloadCreatedAt: string;
}

export function readRunDiagnostics(options: {
  readonly databasePath: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly runId: string;
}): RunDiagnosticsSnapshot | undefined {
  const database = new BetterSqlite3(options.databasePath, { readonly: true, fileMustExist: true });
  try {
    const scope = { owner: options.ownerId, agent: options.agentId, run: options.runId };
    const run = database
      .prepare(
        `SELECT id, thread_id AS threadId, status, created_at AS createdAt, updated_at AS updatedAt
         FROM runs WHERE owner_id=@owner AND agent_id=@agent AND id=@run`,
      )
      .get(scope) as RunDiagnosticsSnapshot["run"] | undefined;
    if (!run) return undefined;
    const jobs = database
      .prepare(
        `SELECT job_id AS jobId, invocation_id AS invocationId,
           json_extract(plan_json,'$.identity.toolCallId') AS toolCallId,
           started_at AS startedAt, sequence,
           json_extract(facts_json,'$.resource.supervision') AS supervision,
           json_extract(facts_json,'$.resource.cleanup') AS cleanup,
           json_extract(facts_json,'$.resource.reasonCode') AS reasonCode,
           recovery_json AS recoveryJson
         FROM sandbox_execution_records
         WHERE owner_id=@owner AND agent_id=@agent AND run_id=@run
         ORDER BY started_at, job_id`,
      )
      .all(scope) as (Omit<RunDiagnosticsSandboxJob, "recovery" | "observations" | "intents"> & {
      readonly recoveryJson: string | null;
    })[];
    const observations = database.prepare(
      `SELECT sequence,
         json_extract(facts_json,'$.resource.occurredAt') AS occurredAt,
         json_extract(facts_json,'$.resource.supervision') AS supervision,
         json_extract(facts_json,'$.resource.cleanup') AS cleanup,
         json_extract(facts_json,'$.resource.reasonCode') AS reasonCode,
         json_extract(facts_json,'$.result.kind') AS resultKind,
         json_extract(facts_json,'$.result.reasonCode') AS resultReasonCode
       FROM sandbox_execution_observations WHERE job_id=? ORDER BY sequence`,
    );
    const intents = database.prepare(
      `SELECT kind, sequence, created_at AS createdAt, dispatched_at AS dispatchedAt,
         acknowledged_at AS acknowledgedAt
       FROM sandbox_execution_intents WHERE job_id=? ORDER BY created_at, intent_id`,
    );
    const payloads = database
      .prepare(
        `SELECT a.operation_key AS operationKey, a.created_at AS createdAt, p.ref,
           p.classification AS dataClassification, p.content_type AS contentType,
           p.ciphertext, p.encryption_metadata_json AS encryptionMetadataJson,
           p.content_digest AS contentDigest, p.created_at AS payloadCreatedAt
         FROM run_payload_artifacts a
         JOIN payloads p ON p.owner_id=a.owner_id AND p.agent_id=a.agent_id AND p.ref=a.payload_ref
         WHERE a.owner_id=@owner AND a.agent_id=@agent AND a.run_id=@run
           AND a.purpose='trace' AND ${DIAGNOSTIC_OPERATION_KEYS}
         ORDER BY a.created_at, a.operation_key`,
      )
      .all(scope) as PayloadRow[];
    return {
      run,
      sandboxJobs: jobs.map(({ recoveryJson, ...job }) => ({
        ...job,
        recovery: recoveryJson ? JSON.parse(recoveryJson) : null,
        observations: observations.all(job.jobId) as RunDiagnosticsObservation[],
        intents: intents.all(job.jobId) as RunDiagnosticsSandboxJob["intents"],
      })),
      diagnosticPayloads: payloads.map((row) => ({
        operationKey: row.operationKey,
        createdAt: row.createdAt,
        payload: {
          ref: row.ref,
          dataClassification: row.dataClassification,
          contentType: row.contentType,
          ciphertext: row.ciphertext ? new Uint8Array(row.ciphertext) : new Uint8Array(),
          encryption: JSON.parse(row.encryptionMetadataJson) as PayloadRecord["encryption"],
          contentDigest: row.contentDigest,
          createdAt: row.payloadCreatedAt,
        },
      })),
    };
  } finally {
    database.close();
  }
}
