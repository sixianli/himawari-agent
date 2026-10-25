-- Recovery evidence is a separate protected trace artifact bound to the
-- original invocation. Never overwrite the original Worker output or replay it.
-- Older writers cannot authenticate this result source and must stay fenced.
SELECT 1;
