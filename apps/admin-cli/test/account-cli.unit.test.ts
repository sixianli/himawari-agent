import { chmod, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { initializeStateRoot, parseProductConfiguration } from "@himawari-agent/platform-node";
import { expect, it } from "vitest";
import { runAdminCli } from "../src/index.js";

it(
  "creates and recovers an account through private files without printing credentials",
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-account-cli-"));
    const stateRoot = path.join(root, "state");
    const layout = await initializeStateRoot(stateRoot);
    const source = JSON.parse(
      await readFile(
        new URL(
          "../../../test/integration/fixtures/file-summary/configuration.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const config = parseProductConfiguration(
      {
        ...source,
        stateRoot,
        runtimeDirectory: layout.runtime,
        cacheDirectory: layout.cache,
        memory: { ...source.memory, storagePath: path.join(layout.data, "memory") },
        http: {
          listenHost: "127.0.0.1",
          listenPort: 8787,
          staticRoot: path.join(root, "browser"),
          sessionCookieName: "himawari_session",
          maximumBodyBytes: 262144,
          maximumStaticAssetBytes: 8388608,
          heartbeatMilliseconds: 15000,
        },
        identity: {
          kind: "built-in",
          sessionIdleMilliseconds: 86400000,
          sessionAbsoluteMilliseconds: 604800000,
          recentAuthentication: { maximumAgeMilliseconds: 900000, clockSkewMilliseconds: 30000 },
          csrf: { keySecretRef: "identity-csrf", ttlMilliseconds: 1800000 },
        },
        secretReferences: [
          ...source.secretReferences.filter(
            (entry: { purpose: string }) =>
              !["payload-encryption", "identity-csrf"].includes(entry.purpose),
          ),
          { ref: "payload-kek", version: "v1", purpose: "payload-encryption", scope: "agent" },
          { ref: "identity-csrf", version: "v1", purpose: "identity-csrf", scope: "agent" },
        ],
      },
      new Date().toISOString(),
    );
    const ownerId = config.ownerId;
    const agentId = config.agentId;
    const authority = {
      schemaVersion: 1,
      id: config.deploymentId,
      ownerId,
      agentId,
      revision: 1,
      status: "active",
      authorityEpoch: 1,
      fencingToken: 1,
      transferId: null,
    };
    await writeFile(layout.authorityFile, JSON.stringify(authority), { mode: 0o600 });
    const db = openQualifiedDatabase(path.join(layout.data, "product.sqlite"));
    applyMigrations(db, await loadBundledMigrations());
    db.prepare("INSERT INTO owners VALUES (?, 0)").run(ownerId);
    db.prepare("INSERT INTO agents VALUES (?, ?, 0)").run(agentId, ownerId);
    db.prepare("INSERT INTO deployments VALUES (?, ?, ?, 1, 'active', 1, 1, NULL)").run(
      config.deploymentId,
      ownerId,
      agentId,
    );
    db.close();
    const configFile = path.join(root, "configuration.json");
    const inputFile = path.join(root, "input.json");
    const outputFile = path.join(root, "enrollment.json");
    const secretDirectory = path.join(root, "secrets");
    await mkdir(secretDirectory, { mode: 0o700 });
    await writeFile(path.join(secretDirectory, "payload-kek.v1"), "11".repeat(32), { mode: 0o600 });
    await writeFile(
      configFile,
      JSON.stringify(
        Object.fromEntries(Object.entries(config).filter(([key]) => key !== "loadedAt")),
      ),
      { mode: 0o600 },
    );
    const password = "test-only-account-passphrase";
    await writeFile(inputFile, JSON.stringify({ username: "test-owner", password }), {
      mode: 0o600,
    });
    let printed = "";
    const sink = new Writable({
      write(chunk, _encoding, next) {
        printed += String(chunk);
        next();
      },
    });
    const args = [
      "--config",
      configFile,
      "--input",
      inputFile,
      "--output",
      outputFile,
      "--secret-dir",
      secretDirectory,
    ];
    try {
      await chmod(inputFile, 0o644);
      expect(await runAdminCli(["account", "create", ...args], sink, sink)).toBe(1);
      await expect(lstat(outputFile)).rejects.toMatchObject({ code: "ENOENT" });
      await chmod(inputFile, 0o600);
      expect(await runAdminCli(["account", "create", ...args], sink, sink), printed).toBe(0);
      expect((await lstat(outputFile)).mode & 0o077).toBe(0);
      const enrollment = JSON.parse(await readFile(outputFile, "utf8"));
      expect(enrollment.otpUri).toContain("otpauth://totp/");
      expect(enrollment.recoveryCodes).toHaveLength(10);
      expect(printed).not.toContain(password);
      expect(printed).not.toContain(enrollment.otpUri);
      expect(printed).not.toContain(enrollment.recoveryCodes[0]);
      expect(await runAdminCli(["account", "create", ...args], sink, sink)).toBe(1);
      expect(await runAdminCli(["account", "recover", ...args], sink, sink)).toBe(1);
      const nextArgs = args.map((value) =>
        value === outputFile ? path.join(root, "recovered.json") : value,
      );
      expect(
        await runAdminCli(
          ["account", "recover", ...nextArgs, "--confirm", `RECOVER_ACCOUNT_${ownerId}`],
          sink,
          sink,
        ),
        printed,
      ).toBe(0);
      const repo = await SqliteProductStateRepository.open({
        stateRoot,
        databasePath: path.join(layout.data, "product.sqlite"),
        minimumFreeBytes: 0,
      });
      try {
        expect(await repo.builtInIdentityState(ownerId, agentId).readAccount()).toMatchObject({
          revision: 2,
        });
        // The service lock also prevents an offline account mutation while this repository is open.
        expect(
          await runAdminCli(
            ["account", "recover", ...nextArgs, "--confirm", `RECOVER_ACCOUNT_${ownerId}`],
            sink,
            sink,
          ),
        ).toBe(1);
      } finally {
        await repo.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
