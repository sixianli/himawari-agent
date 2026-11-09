CREATE TABLE memory_consolidation_change_basis (
  change_id TEXT NOT NULL REFERENCES memory_consolidation_changes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  PRIMARY KEY (change_id, position),
  UNIQUE (change_id, memory_id)
) STRICT;

CREATE INDEX memory_consolidation_change_basis_memory_index
  ON memory_consolidation_change_basis(memory_id);

INSERT OR IGNORE INTO memory_consolidation_change_basis (change_id, position, memory_id)
SELECT c.id, CAST(j.key AS INTEGER), j.value
FROM memory_consolidation_changes AS c
JOIN decision_ledger AS l
  ON l.kind = 'consolidation'
 AND l.owner_id = c.owner_id
 AND l.agent_id = c.agent_id
 AND l.subject_ref = c.memory_id
 AND l.checked_at = c.created_at
 AND l.outcome = c.action
 AND json_extract(l.inputs, '$.batchId') = c.consolidation_id
JOIN json_each(l.inputs, '$.memoryIds') AS j
WHERE EXISTS (SELECT 1 FROM memory_records AS m WHERE m.id = j.value);

INSERT OR IGNORE INTO memory_consolidation_change_basis (change_id, position, memory_id)
SELECT c.id, 0, c.memory_id
FROM memory_consolidation_changes AS c
WHERE c.action <> 'reflect'
  AND NOT EXISTS (SELECT 1 FROM memory_consolidation_change_basis AS b WHERE b.change_id = c.id);

INSERT OR IGNORE INTO memory_consolidation_change_basis (change_id, position, memory_id)
SELECT c.id, 1, c.related_memory_id
FROM memory_consolidation_changes AS c
WHERE c.action <> 'reflect'
  AND c.related_memory_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM memory_consolidation_change_basis AS b
    WHERE b.change_id = c.id AND b.memory_id = c.related_memory_id
  );

INSERT OR IGNORE INTO memory_consolidation_change_basis (change_id, position, memory_id)
SELECT c.id, 0, c.related_memory_id
FROM memory_consolidation_changes AS c
WHERE c.action = 'reflect'
  AND c.related_memory_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM memory_consolidation_change_basis AS b WHERE b.change_id = c.id);
