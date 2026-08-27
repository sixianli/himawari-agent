import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  SqliteRecoveryPointAdapter,
  acquireStateRootLock,
  applyMigrations,
  inspectSqliteDatabaseReadOnly,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import {
  EnvelopePayloadProtector,
  JsonFileConfigurationPort,
  RestrictedSecretFileSource,
  readAuthorityFile,
  stableErrorCode,
  writeServiceDiagnostic,
} from "@himawari-agent/platform-node";

export const adminCliWorkspace = {
  applicationKind: "offline-admin",
  networkListener: false,
} as const;

export const ADMIN_CLI_ERROR_CODES = Object.freeze({
  ARGUMENT_INVALID: "ADMIN_ARGUMENT_INVALID",
  CONFIRMATION_REQUIRED: "ADMIN_CONFIRMATION_REQUIRED",
  TARGET_NOT_STOPPED: "ADMIN_TARGET_NOT_STOPPED",
} as const);

interface ParsedAdminCommand {
  readonly command:
    | "doctor"
    | "db.status"
    | "db.migrate"
    | "backup.create"
    | "backup.verify"
    | "backup.restore";
  readonly configurationPath: string;
  readonly confirmation: string | null;
  readonly secretDirectory: string | null;
  readonly backupId: string | null;
  readonly target: string | null;
}

function parseArguments(arguments_: readonly string[]): ParsedAdminCommand {
  let command: ParsedAdminCommand["command"];
  let offset: number;
  if (arguments_[0] === "doctor") {
    command = "doctor";
    offset = 1;
  } else if (arguments_[0] === "db" && arguments_[1] === "status") {
    command = "db.status";
    offset = 2;
  } else if (arguments_[0] === "db" && arguments_[1] === "migrate") {
    command = "db.migrate";
    offset = 2;
  } else if (arguments_[0] === "backup" && arguments_[1] === "create") {
    command = "backup.create";
    offset = 2;
  } else if (arguments_[0] === "backup" && arguments_[1] === "verify") {
    command = "backup.verify";
    offset = 2;
  } else if (arguments_[0] === "backup" && arguments_[1] === "restore") {
    command = "backup.restore";
    offset = 2;
  } else {
    throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
  }
  const values = new Map<string, string>();
  for (let index = offset; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || values.has(name)) {
      throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
    }
    values.set(name, value);
  }
  const common = ["--config"];
  const allowed =
    command === "db.migrate"
      ? [...common, "--confirm"]
      : command === "backup.create"
        ? [...common, "--secret-dir", "--backup-id"]
        : command === "backup.verify"
          ? [...common, "--secret-dir", "--backup"]
          : command === "backup.restore"
            ? [...common, "--secret-dir", "--backup", "--target", "--confirm"]
            : common;
  if (!values.has("--config") || [...values.keys()].some((key) => !allowed.includes(key))) {
    throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
  }
  const requiresBackupId = command === "backup.verify" || command === "backup.restore";
  if (
    (command.startsWith("backup.") && !values.has("--secret-dir")) ||
    (requiresBackupId && !values.has("--backup")) ||
    (command === "backup.restore" && !values.has("--target"))
  ) {
    throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
  }
  return Object.freeze({
    command,
    configurationPath: values.get("--config") as string,
    confirmation: values.get("--confirm") ?? null,
    secretDirectory: values.get("--secret-dir") ?? null,
    backupId: values.get("--backup") ?? values.get("--backup-id") ?? null,
    target: values.get("--target") ?? null,
  });
}

function stateLayout(stateRoot: string) {
  return Object.freeze({
    root: stateRoot,
    data: path.join(stateRoot, "data"),
    runtime: path.join(stateRoot, "runtime"),
    cache: path.join(stateRoot, "cache"),
    payloadCiphertext: path.join(stateRoot, "data", "payload-ciphertext"),
    authorityFile: path.join(stateRoot, "authority.json"),
  });
}

async function resourceStatus(
  resourcePath: string,
  expected: "directory" | "socket",
): Promise<"available" | "missing" | "unsafe"> {
  const info = await lstat(resourcePath).catch(() => undefined);
  if (!info) return "missing";
  const expectedType = expected === "directory" ? info.isDirectory() : info.isSocket();
  return expectedType && (info.mode & 0o077) === 0 ? "available" : "unsafe";
}

async function doctor(configurationPath: string) {
  const configuration = await new JsonFileConfigurationPort(configurationPath).load();
  const layout = stateLayout(configuration.stateRoot);
  const authority = await readAuthorityFile(layout).catch(() => undefined);
  const sqlite = await Promise.resolve()
    .then(() => inspectSqliteDatabaseReadOnly(path.join(layout.data, "product.sqlite")))
    .catch(() => undefined);
  const dependencies = Object.freeze({
    authority:
      authority?.status === "active" && authority.id === configuration.deploymentId
        ? "available"
        : "unavailable",
    schema: sqlite?.managed ? "available" : "unavailable",
    sqlite: sqlite?.quickCheck === "ok" ? "available" : "unavailable",
    payload: await resourceStatus(layout.payloadCiphertext, "directory"),
    worker: await resourceStatus(path.join(layout.runtime, "execution.sock"), "socket"),
    memory: await resourceStatus(configuration.memory.storagePath, "directory"),
    identity: configuration.publicMode ? "unavailable" : "not-required",
  });
  const ready = Object.entries(dependencies).every(
    ([name, status]) =>
      status === "available" || (name === "identity" && status === "not-required"),
  );
  return Object.freeze({
    schemaVersion: 1,
    command: "doctor",
    deploymentId: configuration.deploymentId,
    configurationSchema: configuration.schemaVersion,
    ready,
    dependencies,
  });
}

async function databaseStatus(configurationPath: string) {
  const configuration = await new JsonFileConfigurationPort(configurationPath).load();
  const status = inspectSqliteDatabaseReadOnly(
    path.join(configuration.stateRoot, "data", "product.sqlite"),
  );
  return Object.freeze({
    schemaVersion: 1,
    command: "db.status",
    deploymentId: configuration.deploymentId,
    ...status,
  });
}

async function migrate(
  configurationPath: string,
  confirmation: string | null,
  output: NodeJS.WritableStream,
) {
  const configuration = await new JsonFileConfigurationPort(configurationPath).load();
  writeServiceDiagnostic(output, {
    component: "admin-cli",
    event: "mutation.plan",
    action: "db.migrate",
    target: `deployment:${configuration.deploymentId}:product.sqlite`,
    stoppedServiceRequired: true,
    confirmation: "APPLY_MIGRATIONS",
  });
  if (confirmation !== "APPLY_MIGRATIONS") {
    throw new Error(ADMIN_CLI_ERROR_CODES.CONFIRMATION_REQUIRED);
  }
  const lock = await acquireStateRootLock(configuration.stateRoot).catch(() => {
    throw new Error(ADMIN_CLI_ERROR_CODES.TARGET_NOT_STOPPED);
  });
  try {
    const migrations = await loadBundledMigrations();
    const database = openQualifiedDatabase(
      path.join(configuration.stateRoot, "data", "product.sqlite"),
    );
    try {
      const result = applyMigrations(database, migrations);
      return Object.freeze({
        schemaVersion: 1,
        command: "db.migrate",
        deploymentId: configuration.deploymentId,
        currentSequence: result.currentSequence,
        appliedSequences: result.appliedSequences,
      });
    } finally {
      database.close();
    }
  } finally {
    await lock.release();
  }
}

function requiredSecret(
  configuration: Awaited<ReturnType<JsonFileConfigurationPort["load"]>>,
  purpose: "backup-encryption" | "payload-encryption",
) {
  const matches = configuration.secretReferences.filter((secret) => secret.purpose === purpose);
  if (matches.length !== 1) throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
  return matches[0] as (typeof matches)[number];
}

async function recoveryAdapter(configurationPath: string, secretDirectory: string) {
  const configuration = await new JsonFileConfigurationPort(configurationPath).load();
  const layout = stateLayout(configuration.stateRoot);
  const authority = await readAuthorityFile(layout);
  if (
    authority.id !== configuration.deploymentId ||
    authority.ownerId !== configuration.ownerId ||
    authority.agentId !== configuration.agentId ||
    authority.status !== "active"
  ) {
    throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
  }
  const source = new RestrictedSecretFileSource(secretDirectory);
  const backupKey = requiredSecret(configuration, "backup-encryption");
  const payloadKey = requiredSecret(configuration, "payload-encryption");
  const payloadProtector = new EnvelopePayloadProtector({
    keys: source,
    activeKey: {
      keyRef: payloadKey.ref,
      kekVersion: payloadKey.version,
      dekVersion: "dek-v1",
    },
  });
  const expectedSchemaSequence = (await loadBundledMigrations()).at(-1)?.sequence;
  if (!expectedSchemaSequence) throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
  return Object.freeze({
    adapter: new SqliteRecoveryPointAdapter({
      stateRoot: configuration.stateRoot,
      databasePath: path.join(configuration.stateRoot, "data", "product.sqlite"),
      ownerId: configuration.ownerId,
      agentId: configuration.agentId,
      deploymentId: configuration.deploymentId,
      authorityEpoch: authority.authorityEpoch,
      keys: source,
      backupKey: { ref: backupKey.ref, version: backupKey.version },
      payloadProtector,
      expectedSchemaSequence,
    }),
  });
}

async function backupCommand(parsed: ParsedAdminCommand, output: NodeJS.WritableStream) {
  if (!parsed.secretDirectory) throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
  const { adapter } = await recoveryAdapter(parsed.configurationPath, parsed.secretDirectory);
  if (parsed.command === "backup.create") {
    const backupId = parsed.backupId ?? `backup-${randomUUID()}`;
    const report = await adapter.createNamed(backupId);
    return Object.freeze({ outputSchemaVersion: 1, command: "backup.create", ...report });
  }
  if (!parsed.backupId) throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
  const backupId = parsed.backupId;
  if (parsed.command === "backup.verify") {
    const report = await adapter.verifyNamed(backupId);
    return Object.freeze({ outputSchemaVersion: 1, command: "backup.verify", ...report });
  }
  if (!parsed.target) throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
  const confirmation = `RESTORE_${backupId}`;
  writeServiceDiagnostic(output, {
    component: "admin-cli",
    event: "mutation.plan",
    action: "backup.restore",
    target: parsed.target,
    backupId,
    stoppedServiceRequired: true,
    confirmation,
  });
  if (parsed.confirmation !== confirmation) {
    throw new Error(ADMIN_CLI_ERROR_CODES.CONFIRMATION_REQUIRED);
  }
  const report = await adapter.restoreNamed(backupId, parsed.target);
  return Object.freeze({ outputSchemaVersion: 1, command: "backup.restore", ...report });
}

export async function runAdminCli(
  arguments_: readonly string[],
  output: NodeJS.WritableStream = process.stdout,
  errorOutput: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  try {
    const parsed = parseArguments(arguments_);
    const result = parsed.command.startsWith("backup.")
      ? await backupCommand(parsed, output)
      : parsed.command === "doctor"
        ? await doctor(parsed.configurationPath)
        : parsed.command === "db.status"
          ? await databaseStatus(parsed.configurationPath)
          : await migrate(parsed.configurationPath, parsed.confirmation, output);
    output.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    errorOutput.write(`${JSON.stringify({ error: { code: stableErrorCode(error) } })}\n`);
    return 1;
  }
}
