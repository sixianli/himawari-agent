ALTER TABLE muse_reference_entries ADD COLUMN paired_message_id TEXT
  CHECK (paired_message_id IS NULL OR length(paired_message_id) BETWEEN 1 AND 256);
