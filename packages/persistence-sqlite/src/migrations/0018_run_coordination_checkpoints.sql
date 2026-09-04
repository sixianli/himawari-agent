CREATE UNIQUE INDEX payloads_coordination_scope ON payloads(owner_id, agent_id, ref);

CREATE TABLE run_coordination_checkpoints (
  run_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0 AND revision <= 9007199254740991),
  phase TEXT NOT NULL CHECK (phase IN ('accepted', 'context_formed', 'workers_running', 'runtime_running', 'runtime_settled', 'reconciling_external_result', 'completed', 'failed', 'cancelled')),
  context_ref TEXT CHECK (context_ref IS NULL OR length(trim(context_ref)) > 0),
  runtime_event_count INTEGER NOT NULL CHECK (runtime_event_count >= 0 AND runtime_event_count <= 9007199254740991),
  last_trace_event_id TEXT REFERENCES trace_events(id) ON DELETE SET NULL,
  terminal_status TEXT CHECK (terminal_status IN ('completed', 'failed', 'cancelled')),
  output_kind TEXT CHECK (output_kind IN ('assistant-answer', 'no-answer')),
  final_answer_ref TEXT CHECK (final_answer_ref IS NULL OR length(trim(final_answer_ref)) > 0),
  diagnostic_code TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, agent_id, run_id),
  FOREIGN KEY (owner_id, agent_id, run_id) REFERENCES runs(owner_id, agent_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, agent_id, context_ref) REFERENCES payloads(owner_id, agent_id, ref) ON DELETE RESTRICT,
  FOREIGN KEY (owner_id, agent_id, final_answer_ref) REFERENCES payloads(owner_id, agent_id, ref) ON DELETE RESTRICT,
  CHECK ((output_kind IS 'assistant-answer') = (final_answer_ref IS NOT NULL))
) STRICT;

CREATE TABLE run_coordination_worker_results (
  run_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  worker_run_id TEXT NOT NULL CHECK (length(trim(worker_run_id)) > 0),
  result_ref TEXT NOT NULL CHECK (length(trim(result_ref)) > 0),
  PRIMARY KEY (run_id, worker_run_id),
  FOREIGN KEY (owner_id, agent_id, run_id) REFERENCES run_coordination_checkpoints(owner_id, agent_id, run_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, agent_id, result_ref) REFERENCES payloads(owner_id, agent_id, ref) ON DELETE RESTRICT
) STRICT;

CREATE TEMP TABLE coordination_checkpoint_migration (
  key TEXT, owner_id TEXT, agent_id TEXT, revision INTEGER, value_json TEXT, updated_at TEXT
);
CREATE TEMP TRIGGER coordination_checkpoint_validate BEFORE INSERT ON coordination_checkpoint_migration BEGIN
  SELECT CASE WHEN NOT json_valid(NEW.value_json) THEN RAISE(ABORT, 'CHECKPOINT_MIGRATION_INVALID_JSON:' || NEW.key) END;
  SELECT CASE WHEN typeof(NEW.revision) != 'integer' OR NEW.revision < 1 OR NEW.revision > 9007199254740991
    THEN RAISE(ABORT, 'CHECKPOINT_MIGRATION_INVALID_REVISION:' || NEW.key) END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM runs WHERE id = substr(NEW.key, 16)
    AND owner_id = NEW.owner_id AND agent_id = NEW.agent_id)
    THEN RAISE(ABORT, 'CHECKPOINT_MIGRATION_RUN_SCOPE:' || NEW.key) END;
  SELECT CASE WHEN json_type(NEW.value_json, '$.runtimeEventCount') = 'integer'
    AND json_extract(NEW.value_json, '$.runtimeEventCount') > 9007199254740991
    THEN RAISE(ABORT, 'CHECKPOINT_MIGRATION_UNSAFE_INTEGER:' || NEW.key) END;
  SELECT CASE WHEN (json_type(NEW.value_json, '$.contextRef') = 'text'
      AND length(trim(json_extract(NEW.value_json, '$.contextRef'))) = 0)
    OR (json_type(NEW.value_json, '$.lastTraceEventId') = 'text'
      AND length(trim(json_extract(NEW.value_json, '$.lastTraceEventId'))) = 0)
    OR (json_type(NEW.value_json, '$.diagnosticCode') = 'text'
      AND length(trim(json_extract(NEW.value_json, '$.diagnosticCode'))) = 0)
    THEN RAISE(ABORT, 'CHECKPOINT_MIGRATION_EMPTY_FIELD:' || NEW.key) END;
  SELECT CASE WHEN EXISTS (SELECT key FROM json_each(NEW.value_json)
    GROUP BY key HAVING count(*) > 1)
    THEN RAISE(ABORT, 'CHECKPOINT_MIGRATION_DUPLICATE_FIELD:' || NEW.key) END;
  SELECT CASE WHEN json_type(NEW.value_json) IS NOT 'object'
    OR json_extract(NEW.value_json, '$.phase') NOT IN ('accepted', 'context_formed', 'workers_running', 'runtime_running', 'runtime_settled', 'reconciling_external_result', 'completed', 'failed', 'cancelled')
    OR json_type(NEW.value_json, '$.phase') IS NOT 'text'
    OR json_type(NEW.value_json, '$.contextRef') IS NULL
    OR json_type(NEW.value_json, '$.contextRef') NOT IN ('null', 'text')
    OR json_type(NEW.value_json, '$.workerResults') IS NOT 'object'
    OR json_type(NEW.value_json, '$.runtimeEventCount') IS NOT 'integer'
    OR json_extract(NEW.value_json, '$.runtimeEventCount') < 0
    OR json_type(NEW.value_json, '$.lastTraceEventId') IS NULL
    OR json_type(NEW.value_json, '$.lastTraceEventId') NOT IN ('null', 'text')
    OR (json_type(NEW.value_json, '$.lastTraceEventId') IS 'text' AND length(trim(json_extract(NEW.value_json, '$.lastTraceEventId'))) = 0)
    OR json_type(NEW.value_json, '$.terminalStatus') IS NULL
    OR json_type(NEW.value_json, '$.terminalStatus') NOT IN ('null', 'text')
    OR (json_type(NEW.value_json, '$.terminalStatus') IS 'text' AND json_extract(NEW.value_json, '$.terminalStatus') NOT IN ('completed', 'failed', 'cancelled'))
    OR coalesce(json_type(NEW.value_json, '$.diagnosticCode'), 'null') NOT IN ('null', 'text')
    OR (json_type(NEW.value_json, '$.diagnosticCode') IS 'text' AND length(trim(json_extract(NEW.value_json, '$.diagnosticCode'))) = 0)
    OR EXISTS (SELECT 1 FROM json_each(NEW.value_json) WHERE key NOT IN ('phase', 'contextRef', 'workerResults', 'runtimeEventCount', 'lastTraceEventId', 'terminalStatus', 'output', 'diagnosticCode'))
    THEN RAISE(ABORT, 'CHECKPOINT_MIGRATION_INVALID_SHAPE:' || NEW.key) END;
  SELECT CASE WHEN coalesce(json_type(NEW.value_json, '$.output'), 'null') NOT IN ('null', 'object')
    OR (json_type(NEW.value_json, '$.output') IS 'object' AND (
      json_extract(NEW.value_json, '$.output.kind') IS NULL
      OR json_extract(NEW.value_json, '$.output.kind') NOT IN ('assistant-answer', 'no-answer')
      OR (json_extract(NEW.value_json, '$.output.kind') = 'assistant-answer' AND
        (json_type(NEW.value_json, '$.output.contentRef') IS NOT 'text' OR length(trim(json_extract(NEW.value_json, '$.output.contentRef'))) = 0))
      OR (json_extract(NEW.value_json, '$.output.kind') = 'no-answer' AND json_type(NEW.value_json, '$.output.contentRef') IS NOT NULL)
      OR EXISTS (SELECT 1 FROM json_each(NEW.value_json, '$.output') WHERE key NOT IN ('kind', 'contentRef'))
      OR EXISTS (SELECT key FROM json_each(NEW.value_json, '$.output') GROUP BY key HAVING count(*) > 1)))
    THEN RAISE(ABORT, 'CHECKPOINT_MIGRATION_INVALID_OUTPUT:' || NEW.key) END;
  SELECT CASE WHEN EXISTS (SELECT key FROM json_each(NEW.value_json, '$.workerResults')
    GROUP BY key HAVING count(*) > 1)
    THEN RAISE(ABORT, 'CHECKPOINT_MIGRATION_DUPLICATE_WORKER_ID:' || NEW.key) END;
  SELECT CASE WHEN json_type(NEW.value_json, '$.lastTraceEventId') = 'text' AND NOT EXISTS (
    SELECT 1 FROM trace_events WHERE id = json_extract(NEW.value_json, '$.lastTraceEventId')
        AND owner_id = NEW.owner_id AND agent_id = NEW.agent_id AND run_id = substr(NEW.key, 16))
    THEN RAISE(ABORT, 'CHECKPOINT_MIGRATION_TRACE_SCOPE:' || NEW.key) END;
  SELECT CASE WHEN (json_type(NEW.value_json, '$.contextRef') = 'text' AND NOT EXISTS (
    SELECT 1 FROM payloads WHERE ref = json_extract(NEW.value_json, '$.contextRef')
      AND owner_id = NEW.owner_id AND agent_id = NEW.agent_id AND lifecycle_state = 'active'))
    OR (json_extract(NEW.value_json, '$.output.kind') = 'assistant-answer' AND NOT EXISTS (
      SELECT 1 FROM payloads WHERE ref = json_extract(NEW.value_json, '$.output.contentRef')
        AND owner_id = NEW.owner_id AND agent_id = NEW.agent_id AND lifecycle_state = 'active'))
    OR EXISTS (SELECT 1 FROM json_each(NEW.value_json, '$.workerResults') worker WHERE worker.type != 'text'
      OR length(trim(worker.key)) = 0 OR length(trim(worker.value)) = 0 OR NOT EXISTS (SELECT 1 FROM payloads WHERE ref = worker.value
        AND owner_id = NEW.owner_id AND agent_id = NEW.agent_id AND lifecycle_state = 'active'))
    THEN RAISE(ABORT, 'CHECKPOINT_MIGRATION_PAYLOAD_SCOPE:' || NEW.key) END;
END;

INSERT INTO coordination_checkpoint_migration SELECT key, owner_id, agent_id, revision, value_json, updated_at
FROM product_state_records WHERE substr(key, 1, 15) = 'run-checkpoint:';

INSERT INTO run_coordination_checkpoints SELECT substr(key, 16), owner_id, agent_id, revision,
  json_extract(value_json, '$.phase'), json_extract(value_json, '$.contextRef'),
  json_extract(value_json, '$.runtimeEventCount'), json_extract(value_json, '$.lastTraceEventId'),
  json_extract(value_json, '$.terminalStatus'), json_extract(value_json, '$.output.kind'),
  json_extract(value_json, '$.output.contentRef'),
  CASE WHEN json_extract(value_json, '$.terminalStatus') = 'completed' AND json_extract(value_json, '$.output') IS NULL
    THEN 'RUNTIME_COMPLETION_OUTPUT_MISSING' ELSE json_extract(value_json, '$.diagnosticCode') END,
  updated_at FROM coordination_checkpoint_migration;

INSERT INTO run_coordination_worker_results SELECT substr(legacy.key, 16), legacy.owner_id,
  legacy.agent_id, worker.key, worker.value FROM coordination_checkpoint_migration legacy,
  json_each(legacy.value_json, '$.workerResults') worker;

DELETE FROM product_state_records WHERE substr(key, 1, 15) = 'run-checkpoint:';
DROP TRIGGER coordination_checkpoint_validate;
DROP TABLE coordination_checkpoint_migration;

CREATE TRIGGER product_state_reject_coordination_insert BEFORE INSERT ON product_state_records
WHEN substr(NEW.key, 1, 15) = 'run-checkpoint:' BEGIN
  SELECT RAISE(ABORT, 'Run coordination checkpoints require the typed store');
END;
CREATE TRIGGER product_state_reject_coordination_update BEFORE UPDATE ON product_state_records
WHEN substr(NEW.key, 1, 15) = 'run-checkpoint:' BEGIN
  SELECT RAISE(ABORT, 'Run coordination checkpoints require the typed store');
END;
