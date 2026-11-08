ALTER TABLE muse_intake_items ADD COLUMN gmail_message_id TEXT
  CHECK (
    gmail_message_id IS NULL OR
    (length(gmail_message_id) BETWEEN 1 AND 256 AND gmail_message_id NOT GLOB '*[^A-Za-z0-9_-]*')
  );
