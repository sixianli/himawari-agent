import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  acquireStateRootLock,
  applyMigrations,
  inspectSqliteDatabaseReadOnly,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import {
  JsonFileConfigurationPort,
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
  readonly command: "doctor" | "db.status" | "db.migrate";
  readonly configurationPath: string;
  readonly confirmation: string | null;
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
  if (
    !values.has("--config") ||
    [...values.keys()].some((key) => !["--config", "--confirm"].includes(key))
  ) {
    throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
  }
  if (command !== "db.migrate" && values.has("--confirm")) {
    throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
  }
  return Object.freeze({
    command,
    configurationPath: values.get("--config") as string,
    confirmation: values.get("--confirm") ?? null,
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

export async function runAdminCli(
  arguments_: readonly string[],
  output: NodeJS.WritableStream = process.stdout,
  errorOutput: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  try {
    const parsed = parseArguments(arguments_);
    const result =
      parsed.command === "doctor"
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
