import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentId, createDeploymentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import { initializeStateRoot, writeAuthorityFile } from "@himawari-agent/platform-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
let testRoot = "";
let prefix = "";
let stateRoot = "";
let configurationPath = "";
let publicConfigurationPath = "";
let tokenPath = "";
let secretDirectory = "";
const children = new Set<ChildProcessWithoutNullStreams>();

function configuration(publicMode = false) {
  return {
    schemaVersion: "himawari.configuration.v1",
    deploymentId: "deployment-service-integration",
    ownerId: "owner-service-integration",
    agentId: "agent-service-integration",
    stateRoot,
    runtimeDirectory: path.join(stateRoot, "runtime"),
    cacheDirectory: path.join(stateRoot, "cache"),
    publicOrigin: publicMode ? "https://agent.example.test" : "http://127.0.0.1:8787",
    publicMode,
    modelDescriptors: [
      {
        ref: "model-primary",
        role: "primary",
        provider: "deterministic",
        model: "primary-fixture",
        version: "1.0.0",
        priority: 1,
        name: "Primary fixture",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        capabilities: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
        allowedDataClassifications: ["public", "private"],
        disclosure: "local_only",
        secretRef: null,
      },
      {
        ref: "model-fallback",
        role: "fallback",
        provider: "deterministic",
        model: "fallback-fixture",
        version: "1.0.0",
        priority: 2,
        name: "Fallback fixture",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        capabilities: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
        allowedDataClassifications: ["private"],
        disclosure: "local_only",
        secretRef: null,
      },
      {
        ref: "model-embedding",
        role: "embedding",
        provider: "deterministic",
        model: "embedding-fixture",
        version: "1.0.0",
        capabilities: ["embedding"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        dimensions: 16,
        allowedDataClassifications: ["public", "private"],
        disclosure: "local_only",
        secretRef: null,
      },
    ],
    memory: {
      adapter: "mem0-oss",
      version: "3.1.7",
      storagePath: path.join(stateRoot, "data", "memory"),
      dimensions: 16,
    },
    repositoryAllowlistRefs: [],
    secretReferences: [
      {
        ref: "worker-boot-service-integration",
        version: "v1",
        purpose: "worker-auth",
        scope: "local-services",
      },
      {
        ref: "payload-kek",
        version: "v1",
        purpose: "payload-encryption",
        scope: "agent",
      },
      {
        ref: "backup-kek",
        version: "v1",
        purpose: "backup-encryption",
        scope: "agent",
      },
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
    concurrency: { totalRuns: 2, foregroundReserved: 1, perCategory: {} },
    deadlines: { runMs: 30_000, workerRequestMs: 2_000, providerRequestMs: 2_000 },
  };
}

beforeAll(async () => {
  testRoot = await mkdtemp(path.join(os.tmpdir(), "himawari-installable-services-"));
  prefix = path.join(testRoot, "prefix");
  stateRoot = await mkdtemp("/tmp/hma-state-");
  configurationPath = path.join(testRoot, "configuration.json");
  publicConfigurationPath = path.join(testRoot, "configuration-public.json");
  const build = spawnSync("npm", ["run", "build:node"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (build.status !== 0) throw new Error(`Node runtime build failed: ${build.stderr}`);
  const install = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "scripts/install-node-runtime.mjs"), "--prefix", prefix],
    { cwd: testRoot, encoding: "utf8" },
  );
  if (install.status !== 0) throw new Error(`Node runtime install failed: ${install.stderr}`);

  const layout = await initializeStateRoot(stateRoot);
  await mkdir(path.join(layout.data, "memory"), { mode: 0o700 });
  await writeAuthorityFile(layout, {
    id: createDeploymentId("deployment-service-integration"),
    ownerId: createOwnerId("owner-service-integration"),
    agentId: createAgentId("agent-service-integration"),
    revision: 1,
    status: "active",
    authorityEpoch: 1,
    fencingToken: 1,
    transferId: null,
  });
  const database = openQualifiedDatabase(path.join(layout.data, "product.sqlite"));
  applyMigrations(database, await loadBundledMigrations());
  database
    .prepare("INSERT INTO owners (id, revision) VALUES ('owner-service-integration', 0)")
    .run();
  database
    .prepare(
      "INSERT INTO agents (id, owner_id, revision) VALUES ('agent-service-integration', 'owner-service-integration', 0)",
    )
    .run();
  database
    .prepare(
      `INSERT INTO deployments (
        id, owner_id, agent_id, revision, status, authority_epoch, fencing_token
      ) VALUES (
        'deployment-service-integration', 'owner-service-integration',
        'agent-service-integration', 0, 'active', 1, 1
      )`,
    )
    .run();
  database.close();
  tokenPath = path.join(layout.runtime, "worker-token.json");
  await writeFile(
    tokenPath,
    JSON.stringify({
      tokenRef: "worker-boot-service-integration",
      tokenValue: "0123456789abcdef0123456789abcdef",
    }),
    { mode: 0o600 },
  );
  await writeFile(configurationPath, JSON.stringify(configuration()), { mode: 0o600 });
  await writeFile(publicConfigurationPath, JSON.stringify(configuration(true)), { mode: 0o600 });
  secretDirectory = path.join(testRoot, "secrets");
  await mkdir(secretDirectory, { mode: 0o700 });
  await writeFile(path.join(secretDirectory, "payload-kek.v1"), "33".repeat(32), {
    mode: 0o600,
  });
  await writeFile(path.join(secretDirectory, "backup-kek.v1"), "44".repeat(32), {
    mode: 0o600,
  });
  await writeFile(path.join(secretDirectory, "transfer-recipient.v1"), "55".repeat(32), {
    mode: 0o600,
  });
  await chmod(configurationPath, 0o600);
  await chmod(publicConfigurationPath, 0o600);
}, 120_000);

afterAll(async () => {
  for (const child of children) child.kill("SIGKILL");
  await rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function executable(name: string): string {
  return path.join(prefix, "bin", name);
}

function serviceArguments(configPath = configurationPath, workerTokenPath = tokenPath) {
  return [
    "--config",
    configPath,
    "--worker-token-file",
    workerTokenPath,
    "--profile",
    "production",
  ];
}

async function startService(
  name: string,
  expectedComponent: string,
  additionalExpected: readonly string[] = [],
) {
  const child = spawn(executable(name), serviceArguments(), {
    cwd: testRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  await waitForOutput(child, `"component":"${expectedComponent}"`, additionalExpected);
  return child;
}

async function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string,
  additionalExpected: readonly string[] = [],
) {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    let errors = "";
    const timeout = setTimeout(
      () => reject(new Error(`Service output timed out: ${errors}`)),
      5_000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (
        output.includes(expected) &&
        output.includes('"event":"service.ready"') &&
        additionalExpected.every((entry) => output.includes(entry))
      ) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8");
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Service exited before ready with ${code}: ${errors}`));
    });
  });
}

async function stopService(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
  child.kill(signal);
  const code = await exit;
  children.delete(child);
  return code;
}

function runInstalled(name: string, arguments_: readonly string[]) {
  return spawnSync(executable(name), arguments_, { cwd: testRoot, encoding: "utf8" });
}

function lastJson(output: string): Record<string, unknown> & { readonly packageRef?: unknown } {
  return JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
}

describe("installable Node services and admin CLI", () => {
  it("installs a source-independent production runtime without testing adapters", async () => {
    expect(
      JSON.parse(
        await readFile(path.join(prefix, "lib/himawari-agent/runtime-manifest.json"), "utf8"),
      ),
    ).toMatchObject({
      schemaVersion: 1,
      entrypoints: {
        himawari: "node_modules/@himawari-agent/admin-cli/dist/main.js",
      },
      externalDependencies: {
        "@earendil-works/pi-ai": "0.84.2",
        "@earendil-works/pi-coding-agent": "0.84.2",
      },
    });
    await expect(
      access(path.join(prefix, "lib/himawari-agent/node_modules/@himawari-agent/testing")),
    ).rejects.toBeDefined();
    const invalid = runInstalled("himawari", []);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("ADMIN_ARGUMENT_INVALID");
    expect(`${invalid.stdout}${invalid.stderr}`).not.toContain(repositoryRoot);
  });

  it("starts, diagnoses, locks, drains, force-restarts and rejects unsafe profiles", async () => {
    let worker = await startService("himawari-execution-worker", "execution-worker");
    let agent = await startService("himawari-agent-service", "agent-service", [
      '"modelPath":"deterministic-descriptor-only"',
      '"embeddingDescriptorRef":"model-embedding"',
      '"embeddingDimensions":16',
    ]);

    const doctor = runInstalled("himawari", ["doctor", "--config", configurationPath]);
    expect(doctor.status).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      command: "doctor",
      ready: true,
      dependencies: { authority: "available", sqlite: "available", worker: "available" },
    });
    const dbStatus = runInstalled("himawari", ["db", "status", "--config", configurationPath]);
    expect(dbStatus.status).toBe(0);
    expect(JSON.parse(dbStatus.stdout)).toMatchObject({
      command: "db.status",
      managed: true,
      schemaSequence: 15,
      quickCheck: "ok",
    });

    const duplicate = spawnSync(executable("himawari-agent-service"), serviceArguments(), {
      cwd: testRoot,
      encoding: "utf8",
      timeout: 3_000,
    });
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain("SQLITE_STATE_ROOT_LOCKED");
    const unconfirmed = runInstalled("himawari", ["db", "migrate", "--config", configurationPath]);
    expect(unconfirmed.status).toBe(1);
    expect(unconfirmed.stderr).toContain("ADMIN_CONFIRMATION_REQUIRED");
    const lockedMutation = runInstalled("himawari", [
      "db",
      "migrate",
      "--config",
      configurationPath,
      "--confirm",
      "APPLY_MIGRATIONS",
    ]);
    expect(lockedMutation.status).toBe(1);
    expect(lockedMutation.stderr).toContain("ADMIN_TARGET_NOT_STOPPED");

    expect(await stopService(agent, "SIGTERM")).toBe(0);
    expect(await stopService(worker, "SIGKILL")).toBeNull();
    worker = await startService("himawari-execution-worker", "execution-worker");
    agent = await startService("himawari-agent-service", "agent-service");
    expect(await stopService(agent, "SIGTERM")).toBe(0);
    expect(await stopService(worker, "SIGTERM")).toBe(0);

    const missingSecret = runInstalled(
      "himawari-execution-worker",
      serviceArguments(configurationPath, path.join(testRoot, "missing-token")),
    );
    expect(missingSecret.status).toBe(1);
    expect(missingSecret.stderr).toContain("EXECUTION_UDS_AUTHENTICATION_FAILED");
    const publicMode = runInstalled(
      "himawari-agent-service",
      serviceArguments(publicConfigurationPath),
    );
    expect(publicMode.status).toBe(1);
    expect(publicMode.stderr).toContain("SERVICE_PUBLIC_MODE_INCOMPLETE");

    const invalidConfigurationPath = path.join(testRoot, "configuration-invalid.json");
    await writeFile(
      invalidConfigurationPath,
      JSON.stringify({ ...configuration(), unknownField: true }),
      { mode: 0o600 },
    );
    const invalidConfiguration = runInstalled(
      "himawari-execution-worker",
      serviceArguments(invalidConfigurationPath),
    );
    expect(invalidConfiguration.status).toBe(1);
    expect(invalidConfiguration.stderr).toContain("CONFIGURATION_UNKNOWN_FIELD");

    const safetyRecoveryPoint = runInstalled("himawari", [
      "backup",
      "create",
      "--config",
      configurationPath,
      "--secret-dir",
      secretDirectory,
      "--backup-id",
      "backup-before-corruption-check",
    ]);
    expect(safetyRecoveryPoint.status).toBe(0);
    await writeFile(path.join(stateRoot, "data", "product.sqlite"), "not-a-sqlite-database");
    const unsafeSqlite = runInstalled("himawari-agent-service", serviceArguments());
    expect(unsafeSqlite.status).toBe(1);
    expect(unsafeSqlite.stderr).toMatch(/SQLITE_(NOTADB|MIGRATION_INTEGRITY_CHECK_FAILED)/);
    const recovered = runInstalled("himawari", [
      "backup",
      "restore",
      "--config",
      configurationPath,
      "--secret-dir",
      secretDirectory,
      "--backup",
      "backup-before-corruption-check",
      "--target",
      stateRoot,
      "--confirm",
      "RESTORE_backup-before-corruption-check",
    ]);
    expect(recovered.status).toBe(0);
    expect(`${missingSecret.stderr}${publicMode.stderr}`).not.toContain("0123456789abcdef");
  }, 15_000);

  it("executes a real recovery drill through the installed himawari CLI", () => {
    const created = runInstalled("himawari", [
      "backup",
      "create",
      "--config",
      configurationPath,
      "--secret-dir",
      secretDirectory,
      "--backup-id",
      "backup-installed-drill",
    ]);
    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({
      command: "backup.create",
      backupId: "backup-installed-drill",
      fullIntegrityCheck: "ok",
    });
    const verified = runInstalled("himawari", [
      "backup",
      "verify",
      "--config",
      configurationPath,
      "--secret-dir",
      secretDirectory,
      "--backup",
      "backup-installed-drill",
    ]);
    expect(verified.status).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      command: "backup.verify",
      backupId: "backup-installed-drill",
      quickIntegrityCheck: "ok",
    });

    const databasePath = path.join(stateRoot, "data", "product.sqlite");
    const changed = openQualifiedDatabase(databasePath);
    changed
      .prepare(
        `INSERT INTO gateway_read_model_metadata (key, value, updated_at)
        VALUES ('installed-restore-proof', 'after-backup', '2026-08-27T00:00:00.000Z')`,
      )
      .run();
    changed.close();

    const restored = runInstalled("himawari", [
      "backup",
      "restore",
      "--config",
      configurationPath,
      "--secret-dir",
      secretDirectory,
      "--backup",
      "backup-installed-drill",
      "--target",
      stateRoot,
      "--confirm",
      "RESTORE_backup-installed-drill",
    ]);
    expect(restored.status, restored.stderr).toBe(0);
    expect(restored.stdout).toContain('"command":"backup.restore"');
    const restoredDatabase = openQualifiedDatabase(databasePath);
    try {
      expect(
        restoredDatabase
          .prepare(
            "SELECT value FROM gateway_read_model_metadata WHERE key = 'installed-restore-proof'",
          )
          .pluck()
          .get(),
      ).toBeUndefined();
    } finally {
      restoredDatabase.close();
    }
  });

  it("executes a stopped authority transfer through the installed himawari CLI", async () => {
    const targetStateRoot = path.join(testRoot, "transfer-target");
    await mkdir(targetStateRoot, { mode: 0o700 });
    const targetConfigurationPath = path.join(testRoot, "transfer-target-configuration.json");
    const targetConfiguration = {
      ...configuration(),
      deploymentId: "deployment-service-integration-hermes",
      stateRoot: targetStateRoot,
      runtimeDirectory: path.join(targetStateRoot, "runtime"),
      cacheDirectory: path.join(targetStateRoot, "cache"),
      memory: {
        ...configuration().memory,
        storagePath: path.join(targetStateRoot, "data", "memory"),
      },
      secretReferences: [
        {
          ref: "target-payload-kek",
          version: "v1",
          purpose: "payload-encryption",
          scope: "agent",
        },
        {
          ref: "transfer-recipient",
          version: "v1",
          purpose: "transfer-recipient",
          scope: "agent",
        },
      ],
    };
    await writeFile(targetConfigurationPath, JSON.stringify(targetConfiguration), { mode: 0o600 });
    const targetSecrets = path.join(testRoot, "transfer-target-secrets");
    await mkdir(targetSecrets, { mode: 0o700 });
    await writeFile(path.join(targetSecrets, "target-payload-kek.v1"), "66".repeat(32), {
      mode: 0o600,
    });
    await writeFile(path.join(targetSecrets, "transfer-recipient.v1"), "55".repeat(32), {
      mode: 0o600,
    });
    const packageRoot = path.join(testRoot, "transfer-packages");
    const exported = runInstalled("himawari", [
      "transfer",
      "export",
      "--config",
      configurationPath,
      "--secret-dir",
      secretDirectory,
      "--transfer-id",
      "transfer-installed-drill",
      "--target-deployment",
      "deployment-service-integration-hermes",
      "--package-root",
      packageRoot,
      "--confirm",
      "EXPORT_transfer-installed-drill",
    ]);
    expect(exported.status, exported.stderr).toBe(0);
    const packageRef = lastJson(exported.stdout).packageRef as string;
    expect(packageRef).toBe(path.join(packageRoot, "transfer-installed-drill"));

    const inspected = runInstalled("himawari", [
      "transfer",
      "inspect",
      "--config",
      targetConfigurationPath,
      "--secret-dir",
      targetSecrets,
      "--package",
      packageRef,
    ]);
    expect(inspected.status).toBe(0);
    expect(lastJson(inspected.stdout)).toMatchObject({
      command: "transfer.inspect",
      transferId: "transfer-installed-drill",
      authorityEpoch: 2,
    });

    const imported = runInstalled("himawari", [
      "transfer",
      "import",
      "--config",
      targetConfigurationPath,
      "--secret-dir",
      targetSecrets,
      "--package",
      packageRef,
      "--confirm",
      "IMPORT_transfer-installed-drill",
    ]);
    expect(imported.status).toBe(0);
    expect(lastJson(imported.stdout)).toMatchObject({
      command: "transfer.import",
      status: "inactive_ready",
    });

    const preflightPath = path.join(testRoot, "transfer-installed-preflight.json");
    await writeFile(
      preflightPath,
      JSON.stringify({
        schemaVersion: 1,
        transferId: "transfer-installed-drill",
        deploymentId: "deployment-service-integration-hermes",
        authorityEpoch: 2,
        secretReferencesReady: true,
        doctorReady: true,
        publicIngressReady: true,
        evidenceRef: "installed-cli:transfer-drill",
      }),
      { mode: 0o600 },
    );
    const activated = runInstalled("himawari", [
      "transfer",
      "activate",
      "--config",
      targetConfigurationPath,
      "--secret-dir",
      targetSecrets,
      "--transfer-id",
      "transfer-installed-drill",
      "--preflight",
      preflightPath,
      "--confirm",
      "ACTIVATE_transfer-installed-drill",
    ]);
    expect(activated.status).toBe(0);
    expect(lastJson(activated.stdout)).toMatchObject({
      command: "transfer.activate",
      status: "activated",
      authorityEpoch: 2,
    });
    const targetDatabase = openQualifiedDatabase(
      path.join(targetStateRoot, "data", "product.sqlite"),
    );
    try {
      expect(
        targetDatabase
          .prepare("SELECT COUNT(*) FROM deployments WHERE status = 'active'")
          .pluck()
          .get(),
      ).toBe(1);
    } finally {
      targetDatabase.close();
    }
  });
});
