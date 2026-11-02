import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BROWSER_STORAGE_KEYS,
  browserStorageKeys,
  checkSettingsScope,
} from "../../scripts/check-settings-scope.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture({ sql, storage = "const KEY_PREFIX = 'x';", extra = {} }) {
  const root = mkdtempSync(join(tmpdir(), "settings-scope-"));
  roots.push(root);
  mkdirSync(join(root, "packages/persistence-sqlite/src/migrations"), { recursive: true });
  mkdirSync(join(root, "apps/control-center/src"), { recursive: true });
  writeFileSync(join(root, "packages/persistence-sqlite/src/migrations/0001_x.sql"), sql);
  writeFileSync(join(root, "apps/control-center/src/browser-storage.ts"), storage);
  for (const [name, content] of Object.entries(extra))
    writeFileSync(join(root, "apps/control-center/src", name), content);
  return root;
}

describe("settings scope check", () => {
  it("fails when a setting is added to a table that has one row per device", () => {
    const root = fixture({
      sql: `CREATE TABLE web_push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  quiet_hours_enabled INTEGER NOT NULL
) STRICT;
ALTER TABLE web_push_subscriptions ADD COLUMN notify_digest INTEGER;
`,
    });
    const { problems } = checkSettingsScope({ root });
    expect(problems.map((problem) => problem.split("：")[0])).toEqual([
      "SETTING_STORED_PER_DEVICE web_push_subscriptions.quiet_hours_enabled",
      "SETTING_STORED_PER_DEVICE web_push_subscriptions.notify_digest",
    ]);
  });

  it("passes for an account-wide settings table", () => {
    const root = fixture({
      sql: `CREATE TABLE web_push_account_kinds (
  owner_id TEXT NOT NULL,
  notify_run INTEGER NOT NULL
) STRICT;
`,
    });
    expect(checkSettingsScope({ root }).passed).toBe(true);
  });

  it("fails on an undeclared browser storage key and on code that bypasses the storage class", () => {
    const root = fixture({
      sql: "",
      storage: [
        "const a = `$",
        "{KEY_PREFIX}.draft.$",
        "{id}`; const b = `$",
        "{KEY_PREFIX}.sidebarOpen`;",
      ].join(""),
      extra: { "panel.tsx": "window.localStorage.setItem('k', 'v');" },
    });
    const { problems } = checkSettingsScope({ root });
    expect(problems.map((problem) => problem.split(" ")[0])).toEqual([
      "BROWSER_KEY_UNDECLARED",
      "BROWSER_STORAGE_BYPASS",
    ]);
  });

  it("passes on the real repository, and the scan really finds every declared browser key", () => {
    expect(checkSettingsScope().problems).toEqual([]);
    expect([...browserStorageKeys()].sort()).toEqual(Object.keys(BROWSER_STORAGE_KEYS).sort());
  });
});
