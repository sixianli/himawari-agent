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
        allowedDataClassifications: ["public"],
        disclosure: "local_only",
        secretRef: null,
      },
      {
        ref: "model-embedding",
        role: "embedding",
        provider: "deterministic",
        model: "embedding-fixture",
        version: "1.0.0",
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
  await chmod(configurationPath, 0o600);
  await chmod(publicConfigurationPath, 0o600);
}, 30_000);

afterAll(async () => {
  for (const child of children) child.kill("SIGKILL");
  await rm(testRoot, { recursive: true, force: true });
  await rm(stateRoot, { recursive: true, force: true });
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

async function startService(name: string, expectedComponent: string) {
  const child = spawn(executable(name), serviceArguments(), {
    cwd: testRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  await waitForOutput(child, `"component":"${expectedComponent}"`);
  return child;
}

async function waitForOutput(child: ChildProcessWithoutNullStreams, expected: string) {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    let errors = "";
    const timeout = setTimeout(
      () => reject(new Error(`Service output timed out: ${errors}`)),
      5_000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(expected) && output.includes('"event":"service.ready"')) {
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
    let agent = await startService("himawari-agent-service", "agent-service");

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
      schemaSequence: 13,
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

    await writeFile(path.join(stateRoot, "data", "product.sqlite"), "not-a-sqlite-database");
    const unsafeSqlite = runInstalled("himawari-agent-service", serviceArguments());
    expect(unsafeSqlite.status).toBe(1);
    expect(unsafeSqlite.stderr).toMatch(/SQLITE_(NOTADB|MIGRATION_INTEGRITY_CHECK_FAILED)/);
    expect(`${missingSecret.stderr}${publicMode.stderr}`).not.toContain("0123456789abcdef");
  });
});
