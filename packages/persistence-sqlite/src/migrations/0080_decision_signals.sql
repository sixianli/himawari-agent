CREATE TABLE decision_signals (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  decision_id TEXT NOT NULL REFERENCES decision_ledger(id) ON DELETE CASCADE,
  signal TEXT NOT NULL CHECK (signal IN ('opened', 'undone', 'replied')),
  occurred_at TEXT NOT NULL CHECK (occurred_at GLOB '????-??-??T??:??:??.???Z'),
  delay_ms INTEGER NOT NULL CHECK (delay_ms >= 0 AND delay_ms <= 9007199254740991),
  detail TEXT NOT NULL CHECK (json_valid(detail) AND json_type(detail) = 'object'),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 256),
  recorded_at TEXT NOT NULL CHECK (recorded_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (decision_id, signal, source_ref)
) STRICT;

CREATE INDEX decision_signals_decision_index ON decision_signals(decision_id, signal);

CREATE TRIGGER decision_signals_no_update BEFORE UPDATE ON decision_signals
BEGIN SELECT RAISE(ABORT, 'DECISION_SIGNAL_IMMUTABLE'); END;

CREATE TRIGGER decision_signals_no_delete BEFORE DELETE ON decision_signals
WHEN EXISTS (SELECT 1 FROM decision_ledger WHERE id = OLD.decision_id)
  AND EXISTS (SELECT 1 FROM agents WHERE id = OLD.agent_id)
  AND EXISTS (SELECT 1 FROM owners WHERE id = OLD.owner_id)
BEGIN SELECT RAISE(ABORT, 'DECISION_SIGNAL_IMMUTABLE'); END;

INSERT INTO decision_signals (
  id, owner_id, agent_id, decision_id, signal, occurred_at, delay_ms, detail, source_ref, recorded_at
)
SELECT 'signal:backfill:' || lower(hex(randomblob(16))), decision.owner_id, decision.agent_id, decision.id, 'opened',
  feedback.opened_at,
  max(0, CAST(round((julianday(feedback.opened_at) - julianday(feedback.first_sent_at)) * 86400000) AS INTEGER)),
  '{"backfilled":true}', feedback.source_key, feedback.opened_at
FROM decision_ledger decision
JOIN web_push_feedback feedback
  ON feedback.owner_id = decision.owner_id AND feedback.agent_id = decision.agent_id
  AND feedback.source_key = decision.push_source_key
WHERE decision.kind = 'proactive' AND feedback.opened_at IS NOT NULL;
