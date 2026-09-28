/** Correlated with the canonical runs row `r`; bind resourceNow to the current
 * transaction clock. Journal writers authenticate receipts before storing them.
 * A release alone is insufficient while a later barrier or queued dispatch lives.
 */
export const RUN_RESOURCES_RELEASED_SQL = `
  NOT EXISTS (
    SELECT 1 FROM sandbox_execution_records resource
    WHERE resource.owner_id=r.owner_id AND resource.agent_id=r.agent_id AND resource.run_id=r.id
      AND (
        (resource.preparation_state='reserved' AND NOT EXISTS (
          SELECT 1 FROM sandbox_reservation_release_receipts receipt
          WHERE receipt.job_id=resource.job_id AND receipt.accepted_at<=@resourceNow
        ))
        OR (resource.preparation_state<>'reserved' AND NOT EXISTS (
          SELECT 1 FROM sandbox_release_receipts receipt
          WHERE receipt.job_id=resource.job_id AND receipt.accepted_at<=@resourceNow
        ))
        OR EXISTS (SELECT 1 FROM sandbox_workspace_occupancy claim
          WHERE claim.job_id=resource.job_id AND claim.released_at IS NULL)
        OR EXISTS (SELECT 1 FROM sandbox_workspace_barriers barrier
          WHERE barrier.job_id=resource.job_id AND barrier.resolved_at IS NULL)
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM sandbox_admission_queue queued
    WHERE queued.owner_id=r.owner_id AND queued.agent_id=r.agent_id AND queued.run_id=r.id
      AND (queued.status='queued' OR (queued.status='admitted' AND NOT EXISTS (
        SELECT 1 FROM sandbox_execution_records resource
        WHERE resource.job_id=queued.job_id AND resource.owner_id=r.owner_id
          AND resource.agent_id=r.agent_id AND resource.run_id=r.id
      ) AND NOT EXISTS (
        SELECT 1 FROM deletion_tombstones deleted
        WHERE deleted.object_type='sandbox_execution' AND deleted.object_id=queued.job_id
          AND deleted.owner_id=r.owner_id AND deleted.agent_id=r.agent_id
          AND deleted.status='verified'
      )))
  )
  AND NOT EXISTS (
    SELECT 1 FROM sandbox_legacy_occupancy occupancy JOIN sandbox_jobs job USING(job_id)
    WHERE job.owner_id=r.owner_id AND job.agent_id=r.agent_id AND job.run_id=r.id
      AND occupancy.released_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM execution_environments environment
    JOIN execution_jobs job ON job.execution_job_id=environment.execution_job_id
    WHERE job.owner_id=r.owner_id AND job.agent_id=r.agent_id AND job.run_id=r.id
      AND NOT EXISTS (
        SELECT 1 FROM execution_environment_release_receipts receipt
        WHERE receipt.environment_id=environment.environment_id AND receipt.accepted_at<=@resourceNow
      )
  )`;

/** The only reconciliation state that may be claimed for result delivery.
 * Uses existing aliases r/c; it confers no model or tool execution authority. */
export const RUN_COMPLETION_RECOVERY_SQL = `
  r.status IN ('running','reconciling_external_result')
  AND ((c.phase='runtime_settled' AND c.terminal_status='completed')
    OR (c.phase='reconciling_external_result'
      AND c.diagnostic_code='RUN_RESOURCE_CLEANUP_UNCONFIRMED'
      AND (c.terminal_status IS NULL OR c.terminal_status='completed')))
  AND (c.output_kind='no-answer' OR (c.output_kind='assistant-answer' AND c.final_answer_ref IS NOT NULL))
  AND EXISTS (SELECT 1 FROM run_payload_artifacts input
    JOIN payloads payload ON payload.ref=input.payload_ref
      AND payload.owner_id=input.owner_id AND payload.agent_id=input.agent_id
    WHERE input.owner_id=r.owner_id AND input.agent_id=r.agent_id AND input.run_id=r.id
      AND input.purpose='context' AND input.operation_key='run-execution-input:v1'
      AND payload.lifecycle_state='active')
  AND (${RUN_RESOURCES_RELEASED_SQL})`;

export const RUN_EXPIRED_RECONCILIATION_SQL = `
  r.status='reconciling_external_result'
  AND c.phase='reconciling_external_result'
  AND c.terminal_status IS NULL AND c.output_kind IS NULL
  AND EXISTS (SELECT 1 FROM sandbox_execution_records expired
    WHERE expired.owner_id=r.owner_id AND expired.agent_id=r.agent_id AND expired.run_id=r.id
      AND json_extract(expired.plan_json,'$.originalDeadlineAt')<=@resourceNow)
  AND NOT EXISTS (SELECT 1 FROM sandbox_execution_records pending
    WHERE pending.owner_id=r.owner_id AND pending.agent_id=r.agent_id AND pending.run_id=r.id
      AND (json_extract(pending.plan_json,'$.originalDeadlineAt') IS NULL
        OR json_extract(pending.plan_json,'$.originalDeadlineAt')>@resourceNow))
  AND (${RUN_RESOURCES_RELEASED_SQL})`;
