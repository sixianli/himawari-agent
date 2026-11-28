CREATE TABLE memory_generations_rebuilt (
  id TEXT PRIMARY KEY,
  checkpoint_job_id TEXT UNIQUE REFERENCES thread_checkpoint_jobs(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed_terminal')),
  model_descriptor_ref TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  output_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
  CHECK ((checkpoint_job_id IS NULL) = (thread_id IS NULL))
) STRICT;

INSERT INTO memory_generations_rebuilt (
  id, checkpoint_job_id, owner_id, agent_id, thread_id, status, model_descriptor_ref,
  policy_version, output_ref
)
SELECT
  id, checkpoint_job_id, owner_id, agent_id, thread_id, status, model_descriptor_ref,
  policy_version, output_ref
FROM memory_generations;

DROP TABLE memory_generations;

ALTER TABLE memory_generations_rebuilt RENAME TO memory_generations;
