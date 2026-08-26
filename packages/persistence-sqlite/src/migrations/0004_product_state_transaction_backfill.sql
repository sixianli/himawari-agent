INSERT INTO reliable_events_v2 (
  id,
  owner_id,
  agent_id,
  idempotency_key,
  topic,
  payload_ref,
  publication_state,
  claim_id,
  claim_expires_at,
  occurred_at,
  published_at,
  acknowledgement_ref
)
SELECT
  id,
  owner_id,
  agent_id,
  idempotency_key,
  topic,
  payload_ref,
  publication_state,
  claim_id,
  claim_expires_at,
  occurred_at,
  published_at,
  acknowledgement_ref
FROM reliable_events;
