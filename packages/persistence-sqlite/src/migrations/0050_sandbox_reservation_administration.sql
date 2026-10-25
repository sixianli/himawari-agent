CREATE TRIGGER sandbox_administrator_release_scope BEFORE INSERT ON sandbox_reservation_release_receipts
WHEN json_extract(NEW.verification_json,'$.schemaVersion')='sandbox-admin-reservation-release.v1'
  AND NOT EXISTS (
    SELECT 1 FROM sandbox_execution_records r
    JOIN runs run ON run.id=r.run_id AND run.owner_id=r.owner_id AND run.agent_id=r.agent_id
    JOIN run_coordination_checkpoints checkpoint ON checkpoint.run_id=run.id
      AND checkpoint.owner_id=run.owner_id AND checkpoint.agent_id=run.agent_id
    JOIN audit_records audit ON audit.id=json_extract(NEW.verification_json,'$.auditId')
    WHERE r.job_id=NEW.job_id AND r.preparation_state='reserved' AND r.started_at IS NULL
      AND r.start_policy_digest IS NULL AND r.reservation_stopped_at IS NOT NULL
      AND json_extract(r.plan_json,'$.backendRef')='srt' AND json_extract(r.plan_json,'$.mode')='foreground'
      AND json_extract(NEW.verification_json,'$.basis')='administrator_confirmed_cleanup'
      AND json_extract(NEW.verification_json,'$.environmentId')=r.environment_id
      AND json_extract(NEW.verification_json,'$.semanticFingerprint')=json_extract(r.plan_json,'$.semanticFingerprint')
      AND json_extract(NEW.verification_json,'$.stopRequestedAt')=r.reservation_stopped_at
      AND json_extract(NEW.verification_json,'$.checkedAt')=NEW.accepted_at
      AND json_extract(NEW.verification_json,'$.confirmation')='HOST_GROUP_ABSENT_FINAL_ABSENT_RELATED_PROCESSES_ABSENT'
      AND (SELECT count(*) FROM json_each(NEW.verification_json,'$.identity'))=(SELECT count(*) FROM json_each(r.plan_json,'$.identity'))
      AND NOT EXISTS (
        SELECT 1 FROM json_each(r.plan_json,'$.identity') expected
        LEFT JOIN json_each(NEW.verification_json,'$.identity') actual ON actual.key=expected.key
        WHERE actual.type IS NOT expected.type OR actual.value IS NOT expected.value
      )
      AND run.status='reconciling_external_result' AND checkpoint.phase='reconciling_external_result'
      AND checkpoint.terminal_status IS NULL AND checkpoint.output_kind IS NULL AND checkpoint.final_answer_ref IS NULL
      AND audit.owner_id=r.owner_id AND audit.agent_id=r.agent_id
      AND audit.action='sandbox.reservation_cleanup_confirmed' AND audit.target_ref=r.job_id
      AND audit.outcome='completed' AND audit.detail_ref IS NULL AND audit.occurred_at=NEW.accepted_at
      AND json_extract(NEW.authority_json,'$.schemaVersion')='sandbox-admin-reservation-authority.v1'
  )
BEGIN SELECT RAISE(ABORT,'Administrator release requires the original stopped reservation and audit'); END;
