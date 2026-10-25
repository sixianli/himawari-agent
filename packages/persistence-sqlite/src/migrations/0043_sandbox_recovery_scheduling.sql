-- Scheduling extends the existing recovery record, not execution authority.
-- Historical terminal attempts remain paused; discovery must recheck Run/resource facts.
UPDATE sandbox_execution_records
SET recovery_json=json_set(recovery_json,'$.nextAttemptAt',NULL)
WHERE recovery_json IS NOT NULL;
