-- Queue recovery changes dispatch eligibility. Older writers must not interpret
-- this protected-continuation link as an ordinary runtime_running checkpoint.
CREATE TRIGGER sandbox_queue_recovery_valid
BEFORE INSERT ON sandbox_admission_queue
WHEN json_type(NEW.request_json, '$.recovery') IS NOT NULL
 AND NOT COALESCE(
   json_extract(NEW.request_json, '$.recovery.version') = 'queued-tool-batch.v1'
   AND length(trim(json_extract(NEW.request_json, '$.recovery.continuationRef'))) > 0
   AND length(trim(json_extract(NEW.request_json, '$.recovery.toolCallId'))) > 0
   AND json_extract(NEW.request_json, '$.recovery.authority.deploymentId') = json_extract(NEW.request_json, '$.invocation.authority.product.deploymentId')
   AND json_extract(NEW.request_json, '$.recovery.authority.authorityEpoch') = json_extract(NEW.request_json, '$.invocation.authority.product.authorityEpoch')
   AND json_extract(NEW.request_json, '$.recovery.authority.fencingToken') = json_extract(NEW.request_json, '$.invocation.authority.product.fencingToken'), 0)
BEGIN SELECT RAISE(ABORT, 'Invalid original queue recovery binding'); END;
