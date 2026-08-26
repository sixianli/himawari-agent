CREATE TEMP TABLE migration_0005_reliable_event_verification (
  verified INTEGER NOT NULL CHECK (verified = 1)
) STRICT;

INSERT INTO migration_0005_reliable_event_verification (verified)
SELECT CASE
  WHEN (SELECT COUNT(*) FROM reliable_events) = (SELECT COUNT(*) FROM reliable_events_v2)
    AND NOT EXISTS (
      SELECT id, owner_id, agent_id, idempotency_key, topic, payload_ref, publication_state,
        claim_id, claim_expires_at, occurred_at, published_at, acknowledgement_ref
      FROM reliable_events
      EXCEPT
      SELECT id, owner_id, agent_id, idempotency_key, topic, payload_ref, publication_state,
        claim_id, claim_expires_at, occurred_at, published_at, acknowledgement_ref
      FROM reliable_events_v2
    )
  THEN 1
  ELSE 0
END;

DROP TABLE migration_0005_reliable_event_verification;
