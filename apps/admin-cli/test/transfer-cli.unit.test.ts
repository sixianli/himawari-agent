import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import {
  CONFIGURATION_SCHEMA_VERSION,
  initializeStateRoot,
  writeAuthorityFile,
} from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import { runAdminCli } from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sink() {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk.toString();
        callback();
      },
    }),
    value: () => value,
  };
}

function result(output: string): Record<string, unknown> & { readonly packageRef?: unknown } {
  const lines = output.trim().split("\n");
  return JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
}

function configuration(stateRoot: string, deploymentId: string, payloadKey: string) {
  return {
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    deploymentId,
    ownerId: "owner-transfer-cli",
    agentId: "agent-transfer-cli",
    stateRoot,
    runtimeDirectory: path.join(stateRoot, "runtime"),
    cacheDirectory: path.join(stateRoot, "cache"),
    publicOrigin: "http://127.0.0.1",
    publicMode: false,
    modelDescriptors: [
      {
        ref: "model-primary",
        role: "primary",
        provider: "provider-local",
        model: "model-a",
        version: "snapshot-1",
        allowedDataClassifications: ["public", "private"],
        disclosure: "local_only",
        secretRef: null,
      },
      {
        ref: "model-fallback",
        role: "fallback",
        provider: "provider-local",
        model: "model-b",
        version: "snapshot-1",
        allowedDataClassifications: ["public"],
        disclosure: "local_only",
        secretRef: null,
      },
      {
        ref: "model-embedding",
        role: "embedding",
        provider: "provider-local",
        model: "embed-a",
        version: "snapshot-1",
        allowedDataClassifications: ["public", "private", "sensitive", "restricted"],
        disclosure: "local_only",
        secretRef: null,
      },
    ],
    memory: {
      adapter: "mem0-oss",
      version: "3.1.7",
      storagePath: path.join(stateRoot, "data", "memory"),
      dimensions: 1536,
    },
    repositoryAllowlistRefs: [],
    secretReferences: [
      { ref: payloadKey, version: "v1", purpose: "payload-encryption", scope: "agent" },
      {
        ref: "transfer-recipient",
        version: "v1",
        purpose: "transfer-recipient",
        scope: "agent",
      },
    ],
    budgets: {
      globalCostMicros: 0,
      perRunCostMicros: 0,
      perClassificationCostMicros: { public: 0, private: 0, sensitive: 0, restricted: 0 },
    },
    concurrency: { totalRuns: 1, foregroundReserved: 1, perCategory: {} },
    deadlines: { runMs: 1_000, workerRequestMs: 1_000, providerRequestMs: 1_000 },
  };
}

async function writeSecrets(directory: string, payloadKey: string, payloadByte: string) {
  await mkdir(directory, { mode: 0o700 });
  await writeFile(path.join(directory, `${payloadKey}.v1`), payloadByte.repeat(32), {
    mode: 0o600,
  });
  await writeFile(path.join(directory, "transfer-recipient.v1"), "33".repeat(32), {
    mode: 0o600,
  });
}

describe("authority-transfer admin CLI", () => {
  it("requires confirmations and runs export, inspect, import and activate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-transfer-cli-"));
    roots.push(root);
    const sourceRoot = path.join(root, "source");
    const sourceLayout = await initializeStateRoot(sourceRoot);
    await mkdir(path.join(sourceLayout.data, "memory"), { mode: 0o700 });
    await writeAuthorityFile(sourceLayout, {
      id: "deployment-transfer-cli-source" as never,
      ownerId: "owner-transfer-cli" as never,
      agentId: "agent-transfer-cli" as never,
      revision: 0,
      status: "active",
      authorityEpoch: 3,
      fencingToken: 5,
      transferId: null,
    });
    const database = openQualifiedDatabase(path.join(sourceLayout.data, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES ('owner-transfer-cli', 0)").run();
    database
      .prepare(
        "INSERT INTO agents (id, owner_id, revision) VALUES ('agent-transfer-cli', 'owner-transfer-cli', 0)",
      )
      .run();
    database
      .prepare(
        `INSERT INTO deployments (
          id, owner_id, agent_id, revision, status, authority_epoch, fencing_token
        ) VALUES (
          'deployment-transfer-cli-source', 'owner-transfer-cli', 'agent-transfer-cli',
          0, 'active', 3, 5
        )`,
      )
      .run();
    database.close();

    const targetRoot = path.join(root, "target");
    await mkdir(targetRoot, { mode: 0o700 });
    const sourceConfiguration = path.join(root, "source-configuration.json");
    const targetConfiguration = path.join(root, "target-configuration.json");
    await writeFile(
      sourceConfiguration,
      `${JSON.stringify(
        configuration(sourceRoot, "deployment-transfer-cli-source", "source-payload-kek"),
      )}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      targetConfiguration,
      `${JSON.stringify(
        configuration(targetRoot, "deployment-transfer-cli-target", "target-payload-kek"),
      )}\n`,
      { mode: 0o600 },
    );
    const sourceSecrets = path.join(root, "source-secrets");
    const targetSecrets = path.join(root, "target-secrets");
    await writeSecrets(sourceSecrets, "source-payload-kek", "11");
    await writeSecrets(targetSecrets, "target-payload-kek", "22");
    const packageRoot = path.join(root, "packages");

    const unconfirmed = sink();
    const unconfirmedError = sink();
    expect(
      await runAdminCli(
        [
          "transfer",
          "export",
          "--config",
          sourceConfiguration,
          "--secret-dir",
          sourceSecrets,
          "--transfer-id",
          "transfer-cli-drill",
          "--target-deployment",
          "deployment-transfer-cli-target",
          "--package-root",
          packageRoot,
        ],
        unconfirmed.stream,
        unconfirmedError.stream,
      ),
    ).toBe(1);
    expect(unconfirmed.value()).toContain('"confirmation":"EXPORT_transfer-cli-drill"');
    expect(unconfirmedError.value()).toContain("ADMIN_CONFIRMATION_REQUIRED");

    const exported = sink();
    expect(
      await runAdminCli(
        [
          "transfer",
          "export",
          "--config",
          sourceConfiguration,
          "--secret-dir",
          sourceSecrets,
          "--transfer-id",
          "transfer-cli-drill",
          "--target-deployment",
          "deployment-transfer-cli-target",
          "--package-root",
          packageRoot,
          "--confirm",
          "EXPORT_transfer-cli-drill",
        ],
        exported.stream,
        sink().stream,
      ),
    ).toBe(0);
    const packageRef = result(exported.value()).packageRef as string;
    expect(packageRef).toBe(path.join(packageRoot, "transfer-cli-drill"));

    const inspected = sink();
    expect(
      await runAdminCli(
        [
          "transfer",
          "inspect",
          "--config",
          targetConfiguration,
          "--secret-dir",
          targetSecrets,
          "--package",
          packageRef,
        ],
        inspected.stream,
        sink().stream,
      ),
    ).toBe(0);
    expect(result(inspected.value())).toMatchObject({
      command: "transfer.inspect",
      transferId: "transfer-cli-drill",
      authorityEpoch: 4,
    });

    const imported = sink();
    expect(
      await runAdminCli(
        [
          "transfer",
          "import",
          "--config",
          targetConfiguration,
          "--secret-dir",
          targetSecrets,
          "--package",
          packageRef,
          "--confirm",
          "IMPORT_transfer-cli-drill",
        ],
        imported.stream,
        sink().stream,
      ),
    ).toBe(0);
    expect(result(imported.value())).toMatchObject({
      command: "transfer.import",
      status: "inactive_ready",
    });

    const preflightPath = path.join(root, "preflight.json");
    await writeFile(
      preflightPath,
      `${JSON.stringify({
        schemaVersion: 1,
        transferId: "transfer-cli-drill",
        deploymentId: "deployment-transfer-cli-target",
        authorityEpoch: 4,
        secretReferencesReady: true,
        doctorReady: true,
        publicIngressReady: true,
        evidenceRef: "cli-drill:preflight",
      })}\n`,
      { mode: 0o600 },
    );
    const activated = sink();
    expect(
      await runAdminCli(
        [
          "transfer",
          "activate",
          "--config",
          targetConfiguration,
          "--secret-dir",
          targetSecrets,
          "--transfer-id",
          "transfer-cli-drill",
          "--preflight",
          preflightPath,
          "--confirm",
          "ACTIVATE_transfer-cli-drill",
        ],
        activated.stream,
        sink().stream,
      ),
    ).toBe(0);
    expect(result(activated.value())).toMatchObject({
      command: "transfer.activate",
      status: "activated",
      authorityEpoch: 4,
    });
  });
});
