ALTER TABLE payloads ADD COLUMN encryption_metadata_json TEXT
  CHECK (encryption_metadata_json IS NULL OR json_valid(encryption_metadata_json));
