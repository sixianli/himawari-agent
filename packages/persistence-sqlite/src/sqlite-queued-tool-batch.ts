import type { SandboxQueuedToolBatch } from "@himawari-agent/application";
import type Database from "better-sqlite3";

/** Aliases r/c denote the canonical Run and checkpoint. A queue is evidence of
 * non-admission, never permission to bypass the current authorization checks. */
export const QUEUED_TOOL_BATCH_SQL = `r.status='running' AND c.phase='runtime_running'
  AND c.terminal_status IS NULL AND c.context_ref IS NOT NULL
  AND (SELECT COUNT(*) FROM sandbox_admission_queue pending
    WHERE pending.owner_id=r.owner_id AND pending.agent_id=r.agent_id
      AND pending.run_id=r.id AND pending.status='queued')=1
  AND EXISTS (SELECT 1 FROM sandbox_admission_queue q
    JOIN run_payload_artifacts a ON a.owner_id=q.owner_id AND a.agent_id=q.agent_id
      AND a.run_id=q.run_id AND a.purpose='trace'
      AND a.operation_key='runtime-continuation:' || json_extract(q.request_json,'$.recovery.continuationRef')
      AND a.payload_ref=json_extract(q.request_json,'$.recovery.continuationRef')
    JOIN payloads p ON p.ref=a.payload_ref AND p.owner_id=a.owner_id AND p.agent_id=a.agent_id
      AND p.lifecycle_state='active' AND p.content_type='application/json'
    WHERE q.owner_id=r.owner_id AND q.agent_id=r.agent_id AND q.run_id=r.id AND q.status='queued'
      AND json_extract(q.request_json,'$.recovery.version')='queued-tool-batch.v1'
      AND length(json_extract(q.request_json,'$.recovery.toolCallId'))>0
      AND NOT EXISTS (SELECT 1 FROM capability_invocation_receipts receipt
        WHERE receipt.owner_id=q.owner_id AND receipt.agent_id=q.agent_id AND receipt.run_id=q.run_id
          AND (receipt.invocation_id=json_extract(q.request_json,'$.plan.identity.invocationId')
            OR receipt.handle_ref=q.handle_ref))
      AND NOT EXISTS (SELECT 1 FROM sandbox_execution_records admitted
        WHERE admitted.owner_id=q.owner_id AND admitted.agent_id=q.agent_id
          AND admitted.run_id=q.run_id AND admitted.invocation_id=json_extract(q.request_json,'$.plan.identity.invocationId'))
      AND NOT EXISTS (SELECT 1 FROM sandbox_jobs admitted
        WHERE admitted.owner_id=q.owner_id AND admitted.agent_id=q.agent_id
          AND json_extract(admitted.plan_json,'$.identity.runId')=q.run_id
          AND json_extract(admitted.plan_json,'$.identity.invocationId')=json_extract(q.request_json,'$.plan.identity.invocationId'))
  )`;

export function readQueuedToolBatch(
  db: Database.Database,
  ownerId: string,
  agentId: string,
  runId: string,
): SandboxQueuedToolBatch | undefined {
  const row = db
    .prepare(`SELECT json_extract(q.request_json,'$.recovery') AS recovery
    FROM runs r JOIN run_coordination_checkpoints c ON c.run_id=r.id AND c.owner_id=r.owner_id AND c.agent_id=r.agent_id
    JOIN sandbox_admission_queue q ON q.run_id=r.id AND q.owner_id=r.owner_id AND q.agent_id=r.agent_id AND q.status='queued'
    WHERE r.id=? AND r.owner_id=? AND r.agent_id=? AND (${QUEUED_TOOL_BATCH_SQL})`)
    .get(runId, ownerId, agentId) as { recovery: string } | undefined;
  return row ? (JSON.parse(row.recovery) as SandboxQueuedToolBatch) : undefined;
}
