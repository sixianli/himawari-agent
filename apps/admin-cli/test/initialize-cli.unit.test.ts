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
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { expect, it } from "vitest";
import { runAdminCli } from "../src/index.js";

it("initializes one product identity and refuses repeated or escaping targets", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "himawari-init-cli-")));
  try {
    const source = JSON.parse(
      await readFile(
        new URL(
          "../../../test/integration/fixtures/file-summary/configuration.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const stateRoot = path.join(root, "state");
    const config = {
      ...source,
      stateRoot,
      runtimeDirectory: path.join(stateRoot, "runtime"),
      cacheDirectory: path.join(stateRoot, "cache"),
      memory: { ...source.memory, storagePath: path.join(stateRoot, "data", "memory") },
    };
    const input = path.join(root, "input.json");
    await writeFile(input, JSON.stringify(config), { mode: 0o600 });
    let output = "";
    let errors = "";
    const stdout = new Writable({
      write(chunk, _encoding, done) {
        output += String(chunk);
        done();
      },
    });
    const stderr = new Writable({
      write(chunk, _encoding, done) {
        errors += String(chunk);
        done();
      },
    });
    expect(await runAdminCli(["init", "--config", input], stdout, stderr)).toBe(0);
    expect(errors).toBe("");
    expect(JSON.parse(output)).toMatchObject({ command: "init", stateRoot, accountReady: false });
    const authority = JSON.parse(await readFile(path.join(stateRoot, "authority.json"), "utf8"));
    expect(authority).toMatchObject({
      ownerId: config.ownerId,
      agentId: config.agentId,
      id: config.deploymentId,
      status: "active",
      authorityEpoch: 1,
      fencingToken: 1,
    });
    const storedConfig = path.join(stateRoot, "configuration.json");
    expect(JSON.parse(await readFile(storedConfig, "utf8"))).toEqual(config);
    expect((await lstat(storedConfig)).mode & 0o077).toBe(0);
    const db = openQualifiedDatabase(path.join(stateRoot, "data", "product.sqlite"));
    try {
      expect(db.prepare("SELECT id FROM owners").all()).toEqual([{ id: config.ownerId }]);
      expect(db.prepare("SELECT id, owner_id FROM agents").all()).toEqual([
        { id: config.agentId, owner_id: config.ownerId },
      ]);
      expect(db.prepare("SELECT status, authority_epoch FROM deployments").all()).toEqual([
        { status: "active", authority_epoch: 1 },
      ]);
      expect(db.prepare("SELECT action FROM audit_records").all()).toEqual([
        { action: "installation.initialized" },
      ]);
    } finally {
      db.close();
    }
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { mode: 0o700 });
    const grantArgs = [
      "workspace",
      "grant",
      "--config",
      storedConfig,
      "--directory",
      workspace,
      "--host-id",
      "host:test",
      "--id",
      "directory:test",
      "--expires-at",
      new Date(Date.now() + 3600000).toISOString(),
      "--confirm",
      workspace,
    ];
    output = "";
    errors = "";
    expect(await runAdminCli(grantArgs, stdout, stderr), errors).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      grantId: "directory:test",
      directory: workspace,
      operations: ["read", "create", "update"],
    });
    const grantDb = openQualifiedDatabase(path.join(stateRoot, "data", "product.sqlite"));
    try {
      const row = grantDb
        .prepare("SELECT owner_id,agent_id,value_json FROM product_state_records WHERE key = ?")
        .get("host-workspace:directory-grant:directory:test") as {
        owner_id: string;
        agent_id: string;
        value_json: string;
      };
      expect(row).toMatchObject({ owner_id: config.ownerId, agent_id: config.agentId });
      expect(JSON.parse(row.value_json)).toMatchObject({ disclosure: "model", revokedAt: null });
      expect(grantDb.prepare("SELECT count(*) n FROM approval_requests").get()).toEqual({ n: 0 });
    } finally {
      grantDb.close();
    }
    errors = "";
    expect(await runAdminCli(grantArgs, stdout, stderr)).toBe(1);
    expect(errors).toContain("ADMIN_WORKSPACE_ALREADY_EXISTS");
    const withoutConfirmation = grantArgs.slice(0, -2);
    expect(await runAdminCli(withoutConfirmation, stdout, stderr)).toBe(1);
    const before = await readFile(path.join(stateRoot, "authority.json"));
    errors = "";
    expect(await runAdminCli(["init", "--config", input], stdout, stderr)).toBe(1);
    expect(errors).toContain("INITIALIZATION_TARGET_EXISTS");
    expect(await readFile(path.join(stateRoot, "authority.json"))).toEqual(before);
    const unsafeRoot = path.join(root, "unsafe-state");
    await writeFile(input, JSON.stringify({ ...config, stateRoot: unsafeRoot }));
    errors = "";
    expect(await runAdminCli(["init", "--config", input], stdout, stderr)).toBe(1);
    expect(errors).toContain("CONFIGURATION_INVALID_VALUE");
    expect(await readdir(root)).not.toContain("unsafe-state");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
