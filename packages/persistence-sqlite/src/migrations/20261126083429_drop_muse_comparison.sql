DELETE FROM web_push_outbox WHERE source_key LIKE 'muse-channel:%';
DROP TABLE gap_case_marks;
DROP TABLE muse_reference_entries;
DROP TABLE muse_intake_conflicts;
DROP TABLE muse_intake_items;
DROP TABLE muse_intake_batches;
DROP TABLE muse_intake_channel;
