ALTER TABLE subthreads ADD COLUMN progress_ref TEXT
  CHECK (progress_ref IS NULL OR length(progress_ref) BETWEEN 1 AND 256);

ALTER TABLE subthreads ADD COLUMN progress_at TEXT
  CHECK (progress_at IS NULL OR progress_at GLOB '????-??-??T??:??:??.???Z');

ALTER TABLE subthreads ADD COLUMN asked_at TEXT
  CHECK (asked_at IS NULL OR asked_at GLOB '????-??-??T??:??:??.???Z');

ALTER TABLE subthreads ADD COLUMN budget_micros INTEGER
  CHECK (budget_micros IS NULL OR budget_micros BETWEEN 1 AND 1000000000);

ALTER TABLE subthreads ADD COLUMN budget_hit_at TEXT
  CHECK (budget_hit_at IS NULL OR budget_hit_at GLOB '????-??-??T??:??:??.???Z');
