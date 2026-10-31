import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkAuditSchemaRange } from "../../scripts/check-audit-schema-range.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture({ migrations, declared }) {
  const root = mkdtempSync(join(tmpdir(), "audit-schema-range-"));
  roots.push(root);
  mkdirSync(join(root, "packages/persistence-sqlite/src/migrations"), { recursive: true });
  mkdirSync(join(root, "scripts/operations"), { recursive: true });
  for (const sequence of migrations)
    writeFileSync(
      join(
        root,
        `packages/persistence-sqlite/src/migrations/${String(sequence).padStart(4, "0")}_x.sql`,
      ),
      "",
    );
  writeFileSync(
    join(root, "scripts/operations/workspace-lifecycle-audit.mjs"),
    `export const SUPPORTED_SCHEMA_MAX = ${declared};\n`,
  );
  return root;
}

describe("audit script schema range check", () => {
  it("fails when a migration was added and the audit script still stops one short", () => {
    const root = fixture({ migrations: [1, 2, 67, 68], declared: 67 });
    expect(checkAuditSchemaRange({ root })).toEqual({ latest: 68, supported: 67, passed: false });
  });

  it("passes when the audit script names the latest migration", () => {
    const root = fixture({ migrations: [1, 2, 67, 68], declared: 68 });
    expect(checkAuditSchemaRange({ root }).passed).toBe(true);
  });
});
