DROP INDEX reliable_events_pending_index;
DROP TABLE reliable_events;
ALTER TABLE reliable_events_v2 RENAME TO reliable_events;
