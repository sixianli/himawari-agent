DELETE FROM web_push_outbox WHERE source_key LIKE 'proposal:%';
DROP TABLE owner_proposals;
