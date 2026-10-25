-- Writer boundary: prepared copy saves retain grant revisions, input identities,
-- content digests and earlier per-file outcomes. Older writers must not ignore
-- these conditions when resuming a prepared operation. Preserve existing rows.
SELECT 1;
