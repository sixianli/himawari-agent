import { sandboxUnrecoverableResultOperationKey } from "@himawari-agent/execution-contracts";
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
            AND (json_extract(result.plan_json,'$.backendRef')='srt'
              OR json_extract(result.facts_json,'$.environment.kind')='container')
            AND json_extract(result.plan_json,'$.originalDeadlineAt')>@resourceNow
            AND NOT EXISTS (SELECT 1 FROM run_payload_artifacts attempted
              WHERE attempted.owner_id=r.owner_id AND attempted.agent_id=r.agent_id AND attempted.run_id=r.id
                AND attempted.purpose='trace'
                AND attempted.operation_key='${sandboxUnrecoverableResultOperationKey("")}'
                  ||json_extract(result.plan_json,'$.identity.invocationId'))
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

export const RUN_EXPIRED_RECONCILIATION_SQL = `
  r.status='reconciling_external_result'
  AND c.phase='reconciling_external_result'
  AND c.terminal_status IS NULL AND c.output_kind IS NULL
  AND (
    (c.diagnostic_code='RUNTIME_TOOL_RESULT_UNKNOWN' AND NOT (${SANDBOX_TOOL_RESULT_RECOVERY_SQL})
      AND NOT EXISTS (
        SELECT 1 FROM model_invocation_identities model
        WHERE model.owner_id=r.owner_id AND model.agent_id=r.agent_id AND model.run_id=r.id
          AND model.status IN ('reserved','started','unknown')))
    OR (EXISTS (SELECT 1 FROM sandbox_execution_records expired
    WHERE expired.owner_id=r.owner_id AND expired.agent_id=r.agent_id AND expired.run_id=r.id
      AND json_extract(expired.plan_json,'$.originalDeadlineAt')<=@resourceNow)
  AND NOT EXISTS (SELECT 1 FROM sandbox_execution_records pending
    WHERE pending.owner_id=r.owner_id AND pending.agent_id=r.agent_id AND pending.run_id=r.id
      AND (json_extract(pending.plan_json,'$.originalDeadlineAt') IS NULL
        OR json_extract(pending.plan_json,'$.originalDeadlineAt')>@resourceNow)))
    OR (c.diagnostic_code='RUN_EXECUTION_DEADLINE_EXCEEDED'
      AND NOT EXISTS (SELECT 1 FROM sandbox_execution_records any_record
        WHERE any_record.owner_id=r.owner_id AND any_record.agent_id=r.agent_id AND any_record.run_id=r.id)
      AND NOT EXISTS (
        SELECT 1 FROM model_invocation_identities model
        WHERE model.owner_id=r.owner_id AND model.agent_id=r.agent_id AND model.run_id=r.id
          AND model.status IN ('reserved','started')))
  )
  AND (${RUN_RESOURCES_RELEASED_SQL})`;
