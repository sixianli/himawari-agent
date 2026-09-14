import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import {
  applyMigrations,
  inspectSqliteDatabaseReadOnly,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import { expect, it } from "vitest";
import { runAdminCli } from "../src/index.js";

it("upgrades an existing database with a private verified pre-migration snapshot", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "himawari-migrate-cli-")));
  try {
    const config = JSON.parse(
      await readFile(
        new URL(
          "../../../test/integration/fixtures/file-summary/configuration.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const stateRoot = path.join(root, "state");
    await mkdir(path.join(stateRoot, "data"), { recursive: true, mode: 0o700 });
    const input = path.join(root, "configuration.json");
    await writeFile(
      input,
      JSON.stringify({
        ...config,
        stateRoot,
        runtimeDirectory: path.join(stateRoot, "runtime"),
        cacheDirectory: path.join(stateRoot, "cache"),
        memory: { ...config.memory, storagePath: path.join(stateRoot, "data", "memory") },
      }),
    );
    const databasePath = path.join(stateRoot, "data", "product.sqlite");
    const migrations = await loadBundledMigrations();
    const db = openQualifiedDatabase(databasePath);
    applyMigrations(db, migrations.slice(0, 29));
    db.prepare("INSERT INTO owners (id, revision) VALUES (?, ?)").run("existing-owner", 7);
    db.close();
    let output = "",
      error = "";
    const stdout = new Writable({
      write(chunk, _encoding, done) {
        output += String(chunk);
        done();
      },
    });
    const stderr = new Writable({
      write(chunk, _encoding, done) {
        error += String(chunk);
        done();
      },
    });
    expect(
      await runAdminCli(
        ["db", "migrate", "--config", input, "--confirm", "APPLY_MIGRATIONS"],
        stdout,
        stderr,
      ),
      error,
    ).toBe(0);
    expect(inspectSqliteDatabaseReadOnly(databasePath).schemaSequence).toBe(migrations.length);
    const result = JSON.parse(output.trim().split("\n").at(-1) ?? "");
    expect(result.snapshotPath).toBeTypeOf("string");
    expect(inspectSqliteDatabaseReadOnly(result.snapshotPath).schemaSequence).toBe(29);
    expect((await lstat(path.dirname(result.snapshotPath))).mode & 0o077).toBe(0);
    expect((await lstat(result.snapshotPath)).mode & 0o077).toBe(0);
    const after = openQualifiedDatabase(databasePath);
    expect(after.prepare("SELECT revision FROM owners WHERE id = ?").get("existing-owner")).toEqual(
      { revision: 7 },
    );
    after.close();
    const before = await readdir(path.join(stateRoot, "data"));
    output = "";
    expect(
      await runAdminCli(
        ["db", "migrate", "--config", input, "--confirm", "APPLY_MIGRATIONS"],
        stdout,
        stderr,
      ),
    ).toBe(0);
    expect(JSON.parse(output.trim().split("\n").at(-1) ?? "").snapshotPath).toBeNull();
    expect(await readdir(path.join(stateRoot, "data"))).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
