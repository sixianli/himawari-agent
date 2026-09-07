CREATE TABLE run_coordination_checkpoints_next (
  run_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0 AND revision <= 9007199254740991),
  phase TEXT NOT NULL CHECK (phase IN ('accepted', 'context_formed', 'workers_running', 'runtime_running', 'awaiting_approval', 'runtime_settled', 'reconciling_external_result', 'completed', 'failed', 'cancelled')),
  context_ref TEXT CHECK (context_ref IS NULL OR length(trim(context_ref)) > 0),
  runtime_event_count INTEGER NOT NULL CHECK (runtime_event_count >= 0 AND runtime_event_count <= 9007199254740991),
  last_trace_event_id TEXT REFERENCES trace_events(id) ON DELETE SET NULL,
  terminal_status TEXT CHECK (terminal_status IN ('completed', 'failed', 'cancelled')),
  output_kind TEXT CHECK (output_kind IN ('assistant-answer', 'no-answer')),
  final_answer_ref TEXT CHECK (final_answer_ref IS NULL OR length(trim(final_answer_ref)) > 0),
  diagnostic_code TEXT,
  updated_at TEXT NOT NULL,
  suspension_json TEXT CHECK (suspension_json IS NULL OR json_valid(suspension_json)),
  UNIQUE (owner_id, agent_id, run_id),
  FOREIGN KEY (owner_id, agent_id, run_id) REFERENCES runs(owner_id, agent_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, agent_id, context_ref) REFERENCES payloads(owner_id, agent_id, ref) ON DELETE RESTRICT,
  FOREIGN KEY (owner_id, agent_id, final_answer_ref) REFERENCES payloads(owner_id, agent_id, ref) ON DELETE RESTRICT,
  CHECK ((output_kind IS 'assistant-answer') = (final_answer_ref IS NOT NULL))
) STRICT;

CREATE TABLE run_coordination_worker_results_next (
  run_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  worker_run_id TEXT NOT NULL CHECK (length(trim(worker_run_id)) > 0),
  result_ref TEXT NOT NULL CHECK (length(trim(result_ref)) > 0),
  PRIMARY KEY (run_id, worker_run_id),
  FOREIGN KEY (owner_id, agent_id, run_id) REFERENCES run_coordination_checkpoints_next(owner_id, agent_id, run_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, agent_id, result_ref) REFERENCES payloads(owner_id, agent_id, ref) ON DELETE RESTRICT
) STRICT;

INSERT INTO run_coordination_checkpoints_next SELECT *, NULL FROM run_coordination_checkpoints;
INSERT INTO run_coordination_worker_results_next SELECT * FROM run_coordination_worker_results;
DROP TABLE run_coordination_worker_results;
DROP TABLE run_coordination_checkpoints;
ALTER TABLE run_coordination_checkpoints_next RENAME TO run_coordination_checkpoints;
ALTER TABLE run_coordination_worker_results_next RENAME TO run_coordination_worker_results;
