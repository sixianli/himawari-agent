import { RUN_RESOURCES_RELEASED_SQL } from "./sqlite-run-resource-guard.ts";
import { SANDBOX_RESERVATION_NEVER_STARTED_SQL } from "./sqlite-sandbox-reservation-never-started.ts";

export const SANDBOX_TOOL_RESULT_RECOVERY_SQL = `
  r.status='reconciling_external_result'
  AND c.phase='reconciling_external_result'
  AND c.diagnostic_code IN ('RUNTIME_TOOL_RESULT_UNKNOWN','RUNTIME_ATTEMPT_INTERRUPTED','PERSISTED_EXECUTION_RECONCILIATION_REQUIRED','SERVICE_STOPPING')
  AND c.terminal_status IS NULL AND c.output_kind IS NULL AND c.context_ref IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM sandbox_execution_records result
    WHERE result.owner_id=r.owner_id AND result.agent_id=r.agent_id AND result.run_id=r.id
      AND json_extract(result.plan_json,'$.mode')='foreground'
      AND ((result.preparation_state<>'reserved'
        AND (json_extract(result.facts_json,'$.result.kind') IN ('result','error')
          OR (COALESCE(json_extract(result.facts_json,'$.result.kind'),'unknown')='unknown'
            AND json_extract(result.plan_json,'$.backendRef')='srt'
            AND json_extract(result.plan_json,'$.originalDeadlineAt')>@resourceNow
            AND EXISTS (SELECT 1 FROM sandbox_release_receipts released WHERE released.job_id=result.job_id AND released.accepted_at<=@resourceNow)
            AND (EXISTS (SELECT 1 FROM run_payload_artifacts stream
              WHERE stream.owner_id=r.owner_id AND stream.agent_id=r.agent_id AND stream.run_id=r.id
                AND stream.purpose='trace' AND stream.operation_key LIKE 'sandbox-stream-end:%')
              OR EXISTS (SELECT 1 FROM deployments deployment
              WHERE deployment.id=json_extract(result.plan_json,'$.executionLease.deploymentId')
                AND deployment.owner_id=r.owner_id AND deployment.agent_id=r.agent_id AND deployment.status='active'
                AND (deployment.authority_epoch>json_extract(result.plan_json,'$.executionLease.authorityEpoch')
                  OR (deployment.authority_epoch=json_extract(result.plan_json,'$.executionLease.authorityEpoch')
                    AND deployment.fencing_token>json_extract(result.plan_json,'$.executionLease.fencingToken')))))))
        AND json_extract(result.facts_json,'$.resource.supervision')='released')
        OR (result.preparation_state='reserved' AND EXISTS (
          SELECT 1 FROM sandbox_reservation_release_receipts reservation
          WHERE reservation.job_id=result.job_id AND reservation.accepted_at<=@resourceNow
            AND ${SANDBOX_RESERVATION_NEVER_STARTED_SQL}
        )))
  )
  AND NOT EXISTS (
    SELECT 1 FROM model_invocation_identities model
    WHERE model.owner_id=r.owner_id AND model.agent_id=r.agent_id AND model.run_id=r.id
      AND model.status IN ('reserved','started','unknown')
  )
  AND (${RUN_RESOURCES_RELEASED_SQL})`;
