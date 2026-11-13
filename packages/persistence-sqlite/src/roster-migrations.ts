import { createHash } from "node:crypto";
import type { MigrationDefinition } from "./migration-engine.js";

const ROSTER_INITIAL_SQL = `
CREATE TABLE tenants (
  tenant_id TEXT PRIMARY KEY
    CHECK (
      length(tenant_id) BETWEEN 1 AND 32
      AND tenant_id NOT GLOB '*[^a-z0-9-]*'
      AND tenant_id NOT GLOB '-*'
      AND tenant_id NOT GLOB '*-'
    ),
  email TEXT NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 254),
  external_subject_ref TEXT UNIQUE CHECK (external_subject_ref IS NULL OR length(external_subject_ref) = 64),
  owner_id TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL UNIQUE,
  deployment_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('owner', 'member', 'trial')),
  status TEXT NOT NULL CHECK (status IN ('invited', 'provisioning', 'active', 'maintenance', 'suspended', 'failed')),
  created_at TEXT NOT NULL,
  expires_at TEXT
) STRICT;

CREATE TABLE limits (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('tenant', 'others_total', 'default_new')),
  tenant_id TEXT REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  metric TEXT NOT NULL CHECK (metric IN ('calls', 'tokens', 'usd_estimate')),
  monthly_limit INTEGER CHECK (monthly_limit IS NULL OR monthly_limit >= 0),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((scope_kind = 'tenant') = (tenant_id IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX limits_scope_metric ON limits (scope_kind, ifnull(tenant_id, ''), metric);

CREATE TABLE usage_monthly (
  tenant_id TEXT NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(month, 6, 2) BETWEEN '01' AND '12'),
  calls INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  usd_estimate_micros INTEGER NOT NULL DEFAULT 0 CHECK (usd_estimate_micros >= 0),
  unknown_price_calls INTEGER NOT NULL DEFAULT 0 CHECK (unknown_price_calls >= 0),
  PRIMARY KEY (tenant_id, month)
) STRICT;

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  tenant_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail))
) STRICT;

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
) STRICT;

INSERT INTO meta (key, value) VALUES ('revision', 0);

CREATE TRIGGER tenants_revision_insert AFTER INSERT ON tenants
BEGIN UPDATE meta SET value = value + 1 WHERE key = 'revision'; END;
CREATE TRIGGER tenants_revision_update AFTER UPDATE ON tenants
BEGIN UPDATE meta SET value = value + 1 WHERE key = 'revision'; END;
CREATE TRIGGER tenants_revision_delete AFTER DELETE ON tenants
BEGIN UPDATE meta SET value = value + 1 WHERE key = 'revision'; END;
CREATE TRIGGER limits_revision_insert AFTER INSERT ON limits
BEGIN UPDATE meta SET value = value + 1 WHERE key = 'revision'; END;
CREATE TRIGGER limits_revision_update AFTER UPDATE ON limits
BEGIN UPDATE meta SET value = value + 1 WHERE key = 'revision'; END;
CREATE TRIGGER limits_revision_delete AFTER DELETE ON limits
BEGIN UPDATE meta SET value = value + 1 WHERE key = 'revision'; END;
`;

function definition(
  sequence: number,
  name: string,
  changeSet: string,
  sql: string,
): MigrationDefinition {
  return Object.freeze({
    sequence,
    name,
    changeSet,
    phase: "expand" as const,
    sql,
    digest: createHash("sha256").update(sql).digest("hex"),
  });
}

export const ROSTER_MIGRATIONS: readonly MigrationDefinition[] = Object.freeze([
  definition(1, "initial_roster_schema", "initial-roster-schema", ROSTER_INITIAL_SQL),
]);
