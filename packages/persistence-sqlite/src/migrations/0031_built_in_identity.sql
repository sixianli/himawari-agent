CREATE TABLE built_in_accounts (
  owner_id TEXT PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
  account_json TEXT NOT NULL CHECK (json_valid(account_json)),
  last_totp_counter INTEGER NOT NULL DEFAULT -1,
  attempt_window TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)
) STRICT;

CREATE TABLE built_in_challenges (
  digest TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES built_in_accounts(owner_id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  challenge_json TEXT NOT NULL CHECK (json_valid(challenge_json))
) STRICT;
CREATE INDEX built_in_challenges_owner_expiry ON built_in_challenges(owner_id, expires_at);

-- The product session remains the only authenticated browser session.
CREATE TABLE built_in_session_credentials (
  session_id TEXT PRIMARY KEY REFERENCES product_sessions(id) ON DELETE CASCADE,
  credential_revision INTEGER NOT NULL CHECK (credential_revision >= 1)
) STRICT;
