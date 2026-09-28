import { RUN_RESOURCES_RELEASED_SQL } from "./sqlite-run-resource-guard.ts";

export const SANDBOX_TOOL_RESULT_RECOVERY_SQL = `
  r.status='reconciling_external_result'
  AND c.phase='reconciling_external_result'
  AND c.diagnostic_code IN ('RUNTIME_TOOL_RESULT_UNKNOWN','RUNTIME_ATTEMPT_INTERRUPTED','PERSISTED_EXECUTION_RECONCILIATION_REQUIRED')
  AND c.terminal_status IS NULL AND c.output_kind IS NULL AND c.context_ref IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM sandbox_execution_records result
    WHERE result.owner_id=r.owner_id AND result.agent_id=r.agent_id AND result.run_id=r.id
      AND result.preparation_state<>'reserved'
      AND json_extract(result.plan_json,'$.mode')='foreground'
      AND json_extract(result.facts_json,'$.result.kind') IN ('result','error')
      AND json_extract(result.facts_json,'$.resource.supervision')='released'
  )
  AND NOT EXISTS (
    SELECT 1 FROM model_invocation_identities model
    WHERE model.owner_id=r.owner_id AND model.agent_id=r.agent_id AND model.run_id=r.id
      AND model.status IN ('reserved','started','unknown')
  )
  AND (${RUN_RESOURCES_RELEASED_SQL})`;
