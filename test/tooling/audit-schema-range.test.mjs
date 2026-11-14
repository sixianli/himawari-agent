import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkAuditSchemaRange } from "../../scripts/check-audit-schema-range.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture({ legacy = 2, declared = 2, files = {}, reviewed = [] }) {
  const root = mkdtempSync(join(tmpdir(), "audit-schema-range-"));
  roots.push(root);
  mkdirSync(join(root, "packages/persistence-sqlite/src/migrations"), { recursive: true });
  mkdirSync(join(root, "scripts/operations"), { recursive: true });
  writeFileSync(
    join(root, "packages/persistence-sqlite/src/migration-engine.ts"),
    Array.from({ length: legacy }, (_, index) => `    sequence: ${index + 1},\n`).join(""),
  );
  for (let sequence = 1; sequence <= legacy; sequence += 1)
    writeFileSync(
      join(
        root,
        `packages/persistence-sqlite/src/migrations/${String(sequence).padStart(4, "0")}_x.sql`,
      ),
      "",
    );
  for (const [name, sql] of Object.entries(files))
    writeFileSync(join(root, `packages/persistence-sqlite/src/migrations/${name}`), sql);
  writeFileSync(
    join(root, "scripts/operations/workspace-lifecycle-audit.mjs"),
    `export const LEGACY_MIGRATION_COUNT = ${declared};\nexport const AUDIT_READ_TABLES = Object.freeze(["sandbox_jobs", "runs"]);\nexport const AUDIT_REVIEWED_MIGRATIONS = Object.freeze([${reviewed.map((id) => `"${id}"`).join(", ")}]);\n`,
  );
  return root;
}

describe("audit script schema range check", () => {
  it("passes when new migrations leave the audit tables alone", () => {
    const root = fixture({
      files: { "20261114010000_other.sql": "CREATE TABLE other_table (id TEXT);" },
    });
    expect(checkAuditSchemaRange({ root }).passed).toBe(true);
  });

  it("fails when a new migration touches a table the audit reads and nobody reviewed it", () => {
    const root = fixture({
      files: { "20261114010000_jobs.sql": "ALTER TABLE sandbox_jobs ADD COLUMN extra TEXT;" },
    });
    const result = checkAuditSchemaRange({ root });
    expect(result.passed).toBe(false);
    expect(result.unreviewed).toEqual([{ id: "20261114010000", tables: ["sandbox_jobs"] }]);
  });

  it("passes once the migration is listed as reviewed", () => {
    const root = fixture({
      files: { "20261114010000_jobs.sql": "ALTER TABLE sandbox_jobs ADD COLUMN extra TEXT;" },
      reviewed: ["20261114010000"],
    });
    expect(checkAuditSchemaRange({ root }).passed).toBe(true);
  });

  it("fails when the audit script's legacy count differs from the engine's frozen list", () => {
    const root = fixture({ legacy: 3, declared: 2 });
    expect(checkAuditSchemaRange({ root })).toMatchObject({
      legacy: 3,
      declared: 2,
      passed: false,
    });
  });

  it("fails when someone adds a new four-digit migration file", () => {
    const root = fixture({ files: { "0003_late.sql": "" } });
    const result = checkAuditSchemaRange({ root });
    expect(result.numberedBeyondLegacy).toEqual([3]);
    expect(result.passed).toBe(false);
  });
});
