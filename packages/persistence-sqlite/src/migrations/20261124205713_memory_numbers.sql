CREATE TABLE memory_number_counters (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  last_number INTEGER NOT NULL CHECK (last_number >= 0),
  PRIMARY KEY (owner_id, agent_id)
) STRICT;

CREATE TABLE memory_numbers (
  memory_id TEXT PRIMARY KEY REFERENCES memory_records(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  number INTEGER NOT NULL CHECK (number >= 1),
  UNIQUE (owner_id, agent_id, number)
) STRICT;

INSERT INTO memory_numbers (memory_id, owner_id, agent_id, number)
SELECT id, owner_id, agent_id,
  ROW_NUMBER() OVER (PARTITION BY owner_id, agent_id ORDER BY COALESCE(recorded_at, updated_at), id)
FROM memory_records;

INSERT INTO memory_number_counters (owner_id, agent_id, last_number)
SELECT owner_id, agent_id, MAX(number) FROM memory_numbers GROUP BY owner_id, agent_id;

CREATE TRIGGER memory_numbers_assign
AFTER INSERT ON memory_records
BEGIN
  INSERT INTO memory_number_counters (owner_id, agent_id, last_number)
  VALUES (NEW.owner_id, NEW.agent_id, 1)
  ON CONFLICT (owner_id, agent_id) DO UPDATE SET last_number = last_number + 1;
  INSERT INTO memory_numbers (memory_id, owner_id, agent_id, number)
  SELECT NEW.id, NEW.owner_id, NEW.agent_id, last_number
  FROM memory_number_counters
  WHERE owner_id = NEW.owner_id AND agent_id = NEW.agent_id;
END;
