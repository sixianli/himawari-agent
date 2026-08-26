CREATE TABLE owner_identity_bindings (
  owner_id TEXT PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
  external_subject_ref TEXT NOT NULL UNIQUE,
  bound_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled'))
) STRICT;

CREATE UNIQUE INDEX product_sessions_authentication_ref_unique
  ON product_sessions(authentication_ref);
