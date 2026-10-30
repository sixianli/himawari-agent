ALTER TABLE owner_preferences ADD COLUMN theme TEXT CHECK (
  theme IS NULL OR theme IN ('light', 'dark', 'system')
);

ALTER TABLE owner_preferences ADD COLUMN model_ref TEXT CHECK (
  model_ref IS NULL OR length(model_ref) BETWEEN 1 AND 128
);

ALTER TABLE owner_preferences ADD COLUMN thinking_level TEXT CHECK (
  thinking_level IS NULL
  OR thinking_level IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
);

ALTER TABLE owner_preferences ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
