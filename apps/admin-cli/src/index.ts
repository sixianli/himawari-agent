import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  SqliteGovernedDeletionAdapter,
  SqliteRecoveryPointAdapter,
  SqliteAuthorityTransferAdapter,
  acquireStateRootLock,
  applyMigrations,
  inspectSqliteDatabaseReadOnly,
  loadBundledMigrations,
  openQualifiedDatabase,
  type GovernedDeletionObjectType,
} from "@himawari-agent/persistence-sqlite";
import {
  EnvelopePayloadProtector,
  JsonFileConfigurationPort,
  RestrictedSecretFileSource,
  activateImportedAuthority,
  establishImportedAuthority,
  markAuthorityTransferPending,
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
    | "backup.restore"
    | "transfer.export"
    | "transfer.inspect"
    | "transfer.import"
    | "transfer.activate"
    | "transfer.abandon"
    | "delete.trash"
    | "delete.restore"
    | "delete.inspect"
    | "delete.purge"
    | "delete.purge-expired";
  readonly configurationPath: string;
  readonly confirmation: string | null;
  readonly secretDirectory: string | null;
  readonly backupId: string | null;
  readonly target: string | null;
  readonly transferId: string | null;
  readonly targetDeploymentId: string | null;
  readonly packageRoot: string | null;
  readonly packageRef: string | null;
  readonly preflightPath: string | null;
  readonly objectType: GovernedDeletionObjectType | null;
  readonly objectId: string | null;
  readonly asOf: string | null;
}

interface ActivationPreflightEvidence {
  readonly schemaVersion: 1;
  readonly transferId: string;
  readonly deploymentId: string;
  readonly authorityEpoch: number;
  readonly secretReferencesReady: boolean;
  readonly doctorReady: boolean;
  readonly publicIngressReady: boolean;
  readonly evidenceRef: string;
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
  } else if (arguments_[0] === "transfer" && arguments_[1] === "export") {
    command = "transfer.export";
    offset = 2;
  } else if (arguments_[0] === "transfer" && arguments_[1] === "inspect") {
    command = "transfer.inspect";
    offset = 2;
  } else if (arguments_[0] === "transfer" && arguments_[1] === "import") {
    command = "transfer.import";
    offset = 2;
  } else if (arguments_[0] === "transfer" && arguments_[1] === "activate") {
    command = "transfer.activate";
    offset = 2;
  } else if (arguments_[0] === "transfer" && arguments_[1] === "abandon") {
    command = "transfer.abandon";
    offset = 2;
  } else if (arguments_[0] === "delete" && arguments_[1] === "trash") {
    command = "delete.trash";
    offset = 2;
  } else if (arguments_[0] === "delete" && arguments_[1] === "restore") {
    command = "delete.restore";
    offset = 2;
  } else if (arguments_[0] === "delete" && arguments_[1] === "inspect") {
    command = "delete.inspect";
    offset = 2;
  } else if (arguments_[0] === "delete" && arguments_[1] === "purge") {
    command = "delete.purge";
    offset = 2;
  } else if (arguments_[0] === "delete" && arguments_[1] === "purge-expired") {
    command = "delete.purge-expired";
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
            : command === "transfer.export"
              ? [
                  ...common,
                  "--secret-dir",
                  "--transfer-id",
                  "--target-deployment",
                  "--package-root",
                  "--confirm",
                ]
              : command === "transfer.inspect"
                ? [...common, "--secret-dir", "--package"]
                : command === "transfer.import"
                  ? [...common, "--secret-dir", "--package", "--confirm"]
                  : command === "transfer.activate"
                    ? [...common, "--secret-dir", "--transfer-id", "--preflight", "--confirm"]
                    : command === "transfer.abandon"
                      ? [...common, "--secret-dir", "--transfer-id", "--confirm"]
                      : command === "delete.purge-expired"
                        ? [...common, "--as-of", "--confirm"]
                        : command === "delete.inspect"
                          ? [...common, "--type", "--id"]
                          : command.startsWith("delete.")
                            ? [...common, "--type", "--id", "--confirm"]
                            : common;
  if (!values.has("--config") || [...values.keys()].some((key) => !allowed.includes(key))) {
    throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
  }
  const requiresBackupId = command === "backup.verify" || command === "backup.restore";
  const transferCommand = command.startsWith("transfer.");
  if (
    (command.startsWith("backup.") && !values.has("--secret-dir")) ||
    (requiresBackupId && !values.has("--backup")) ||
    (command === "backup.restore" && !values.has("--target"))
  ) {
    throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
  }
  if (
    (transferCommand && !values.has("--secret-dir")) ||
    (command === "transfer.export" &&
      (!values.has("--transfer-id") ||
        !values.has("--target-deployment") ||
        !values.has("--package-root"))) ||
    ((command === "transfer.inspect" || command === "transfer.import") &&
      !values.has("--package")) ||
    ((command === "transfer.activate" || command === "transfer.abandon") &&
      !values.has("--transfer-id")) ||
    (command === "transfer.activate" && !values.has("--preflight"))
  ) {
    throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
  }
  const deletionTypes = new Set(["thread", "run", "task", "memory", "payload"]);
  if (
    (command === "delete.purge-expired" && !values.has("--as-of")) ||
    (command.startsWith("delete.") &&
      command !== "delete.purge-expired" &&
      (!values.has("--type") ||
        !values.has("--id") ||
        !deletionTypes.has(values.get("--type") ?? ""))) ||
    ((command === "delete.trash" || command === "delete.restore") &&
      !["thread", "task", "memory"].includes(values.get("--type") ?? ""))
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
    transferId: values.get("--transfer-id") ?? null,
    targetDeploymentId: values.get("--target-deployment") ?? null,
    packageRoot: values.get("--package-root") ?? null,
    packageRef: values.get("--package") ?? null,
    preflightPath: values.get("--preflight") ?? null,
    objectType: (values.get("--type") as GovernedDeletionObjectType | undefined) ?? null,
    objectId: values.get("--id") ?? null,
    asOf: values.get("--as-of") ?? null,
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
  purpose: "backup-encryption" | "payload-encryption" | "transfer-recipient",
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

async function activationPreflight(pathInput: string | null) {
  if (!pathInput || !path.isAbsolute(pathInput)) return null;
  const preflightPath = path.resolve(pathInput);
  const info = await lstat(preflightPath).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0) {
    throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(preflightPath, "utf8"));
  } catch {
    throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
  }
  const record = value as Record<string, unknown>;
  const candidate = record as Partial<ActivationPreflightEvidence>;
  const fields = Object.keys(record).sort();
  const expected = [
    "authorityEpoch",
    "deploymentId",
    "doctorReady",
    "evidenceRef",
    "publicIngressReady",
    "schemaVersion",
    "secretReferencesReady",
    "transferId",
  ].sort();
  if (
    JSON.stringify(fields) !== JSON.stringify(expected) ||
    candidate.schemaVersion !== 1 ||
    typeof candidate.transferId !== "string" ||
    typeof candidate.deploymentId !== "string" ||
    !Number.isSafeInteger(candidate.authorityEpoch) ||
    typeof candidate.secretReferencesReady !== "boolean" ||
    typeof candidate.doctorReady !== "boolean" ||
    typeof candidate.publicIngressReady !== "boolean" ||
    typeof candidate.evidenceRef !== "string" ||
    candidate.evidenceRef.length === 0
  ) {
    throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
  }
  return Object.freeze(record as unknown as ActivationPreflightEvidence);
}

async function transferAdapter(parsed: ParsedAdminCommand) {
  if (!parsed.secretDirectory) throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
  const configuration = await new JsonFileConfigurationPort(parsed.configurationPath).load();
  const layout = stateLayout(configuration.stateRoot);
  const authority = await readAuthorityFile(layout).catch(() => undefined);
  const source = new RestrictedSecretFileSource(parsed.secretDirectory);
  const payloadKey = requiredSecret(configuration, "payload-encryption");
  const recipientKey = requiredSecret(configuration, "transfer-recipient");
  const preflight = await activationPreflight(parsed.preflightPath);
  const packageRoot = parsed.packageRoot
    ? path.resolve(parsed.packageRoot)
    : parsed.packageRef
      ? path.dirname(path.resolve(parsed.packageRef))
      : path.join(configuration.stateRoot, "transfers");
  return new SqliteAuthorityTransferAdapter({
    stateRoot: configuration.stateRoot,
    databasePath: path.join(configuration.stateRoot, "data", "product.sqlite"),
    packageRoot,
    ownerId: configuration.ownerId,
    agentId: configuration.agentId,
    deploymentId: configuration.deploymentId,
    authorityEpoch: authority?.authorityEpoch ?? 0,
    fencingToken: authority?.fencingToken ?? 0,
    productVersion: "0.0.0",
    adapterVersions: [
      "persistence-sqlite@0.0.0",
      `memory-mem0@${configuration.memory.version}`,
      "runtime-pi@0.0.0",
    ],
    memoryVersion: configuration.memory.version,
    memoryStoragePath: configuration.memory.storagePath,
    excludedSecretRefs: configuration.secretReferences.map((secret) => secret.ref),
    keys: source,
    packageKey: { ref: recipientKey.ref, version: recipientKey.version },
    packagePayloadKey: { ref: recipientKey.ref, version: recipientKey.version },
    activePayloadKey: { ref: payloadKey.ref, version: payloadKey.version },
    payloadProtector: new EnvelopePayloadProtector({
      keys: source,
      activeKey: {
        keyRef: payloadKey.ref,
        kekVersion: payloadKey.version,
        dekVersion: "dek-v1",
      },
    }),
    authority: {
      markSourcePending: async (input) => {
        await markAuthorityTransferPending(layout, input);
      },
      establishTargetInactive: async (input) => {
        await establishImportedAuthority(layout, input);
      },
      activateTarget: async (input) => {
        await activateImportedAuthority(layout, input);
      },
    },
    activationPreflight: {
      check: async (input) => {
        const requiredKeysReady = await Promise.all([
          source.resolve(payloadKey.ref, payloadKey.version),
          source.resolve(recipientKey.ref, recipientKey.version),
        ])
          .then((values) => values.every((value) => value.byteLength === 32))
          .catch(() => false);
        if (
          !requiredKeysReady ||
          !preflight ||
          preflight.transferId !== input.transferId ||
          preflight.deploymentId !== input.deploymentId ||
          preflight.authorityEpoch !== input.authorityEpoch
        ) {
          return {
            secretReferencesReady: false,
            doctorReady: false,
            publicIngressReady: false,
            evidenceRef: "",
          };
        }
        return {
          secretReferencesReady: preflight.secretReferencesReady as boolean,
          doctorReady: preflight.doctorReady as boolean,
          publicIngressReady: preflight.publicIngressReady as boolean,
          evidenceRef: preflight.evidenceRef as string,
        };
      },
    },
  });
}

async function transferCommand(parsed: ParsedAdminCommand, output: NodeJS.WritableStream) {
  const adapter = await transferAdapter(parsed);
  if (parsed.command === "transfer.export") {
    if (!parsed.transferId || !parsed.targetDeploymentId || !parsed.packageRoot) {
      throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
    }
    const confirmation = `EXPORT_${parsed.transferId}`;
    writeServiceDiagnostic(output, {
      component: "admin-cli",
      event: "mutation.plan",
      action: "transfer.export",
      target: parsed.targetDeploymentId,
      transferId: parsed.transferId,
      stoppedServiceRequired: true,
      confirmation,
    });
    if (parsed.confirmation !== confirmation) {
      throw new Error(ADMIN_CLI_ERROR_CODES.CONFIRMATION_REQUIRED);
    }
    const manifest = await adapter.exportNamed({
      transferId: parsed.transferId,
      targetDeploymentId: parsed.targetDeploymentId,
    });
    return Object.freeze({ outputSchemaVersion: 1, command: "transfer.export", ...manifest });
  }
  if (parsed.command === "transfer.inspect") {
    if (!parsed.packageRef) throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
    const manifest = await adapter.inspect(parsed.packageRef);
    return Object.freeze({ outputSchemaVersion: 1, command: "transfer.inspect", ...manifest });
  }
  if (parsed.command === "transfer.import") {
    if (!parsed.packageRef) throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
    const manifest = await adapter.inspect(parsed.packageRef);
    const configuration = await new JsonFileConfigurationPort(parsed.configurationPath).load();
    const confirmation = `IMPORT_${manifest.transferId}`;
    writeServiceDiagnostic(output, {
      component: "admin-cli",
      event: "mutation.plan",
      action: "transfer.import",
      target: `deployment:${configuration.deploymentId}`,
      transferId: manifest.transferId,
      stoppedServiceRequired: true,
      confirmation,
    });
    if (parsed.confirmation !== confirmation) {
      throw new Error(ADMIN_CLI_ERROR_CODES.CONFIRMATION_REQUIRED);
    }
    const state = await adapter.importPackage(parsed.packageRef);
    return Object.freeze({ outputSchemaVersion: 1, command: "transfer.import", ...state });
  }
  if (!parsed.transferId) throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
  const action = parsed.command === "transfer.activate" ? "ACTIVATE" : "ABANDON";
  const confirmation = `${action}_${parsed.transferId}`;
  writeServiceDiagnostic(output, {
    component: "admin-cli",
    event: "mutation.plan",
    action: parsed.command,
    target: `transfer:${parsed.transferId}`,
    transferId: parsed.transferId,
    stoppedServiceRequired: true,
    confirmation,
  });
  if (parsed.confirmation !== confirmation) {
    throw new Error(ADMIN_CLI_ERROR_CODES.CONFIRMATION_REQUIRED);
  }
  if (parsed.command === "transfer.activate") {
    const preflight = await activationPreflight(parsed.preflightPath);
    const epoch = preflight?.authorityEpoch;
    if (typeof epoch !== "number") throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
    const state = await adapter.activateNamed(parsed.transferId, epoch);
    return Object.freeze({ outputSchemaVersion: 1, command: "transfer.activate", ...state });
  }
  const state = await adapter.abandonNamed(parsed.transferId);
  return Object.freeze({ outputSchemaVersion: 1, command: "transfer.abandon", ...state });
}

async function deletionCommand(parsed: ParsedAdminCommand, output: NodeJS.WritableStream) {
  const configuration = await new JsonFileConfigurationPort(parsed.configurationPath).load();
  const adapter = new SqliteGovernedDeletionAdapter({
    stateRoot: configuration.stateRoot,
    databasePath: path.join(configuration.stateRoot, "data", "product.sqlite"),
    ownerId: configuration.ownerId,
    agentId: configuration.agentId,
  });
  if (parsed.command === "delete.purge-expired") {
    if (!parsed.asOf || !Number.isFinite(Date.parse(parsed.asOf))) {
      throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
    }
    const confirmation = "PURGE_EXPIRED_TRASH";
    writeServiceDiagnostic(output, {
      component: "admin-cli",
      event: "mutation.plan",
      action: parsed.command,
      target: `trash:expired-before:${parsed.asOf}`,
      stoppedServiceRequired: true,
      confirmation,
    });
    if (parsed.confirmation !== confirmation) {
      throw new Error(ADMIN_CLI_ERROR_CODES.CONFIRMATION_REQUIRED);
    }
    const reports = await adapter.purgeExpiredTrash(parsed.asOf);
    return Object.freeze({
      outputSchemaVersion: 1,
      command: parsed.command,
      asOf: parsed.asOf,
      purgedCount: reports.length,
      reports,
    });
  }
  if (!parsed.objectType || !parsed.objectId) {
    throw new Error(ADMIN_CLI_ERROR_CODES.ARGUMENT_INVALID);
  }
  if (parsed.command === "delete.inspect") {
    return Object.freeze({
      outputSchemaVersion: 1,
      command: parsed.command,
      report: adapter.inspect(parsed.objectType, parsed.objectId) ?? null,
    });
  }
  const confirmationAction =
    parsed.command === "delete.trash"
      ? "TRASH"
      : parsed.command === "delete.restore"
        ? "RESTORE"
        : "DELETE";
  const confirmation = `${confirmationAction}_${parsed.objectType}_${parsed.objectId}`;
  const threadImpact =
    parsed.objectType === "thread"
      ? adapter.inspectThreadImpact(parsed.objectId)
      : { associatedTaskIds: [], activeTaskIds: [] };
  writeServiceDiagnostic(output, {
    component: "admin-cli",
    event: "mutation.plan",
    action: parsed.command,
    target: `${parsed.objectType}:${parsed.objectId}`,
    stoppedServiceRequired: true,
    associatedTaskIds: threadImpact.associatedTaskIds,
    activeTaskIds: threadImpact.activeTaskIds,
    confirmation,
  });
  if (parsed.confirmation !== confirmation) {
    throw new Error(ADMIN_CLI_ERROR_CODES.CONFIRMATION_REQUIRED);
  }
  const report =
    parsed.command === "delete.trash"
      ? await adapter.trashObject({
          objectType: parsed.objectType as "thread" | "task" | "memory",
          objectId: parsed.objectId,
        })
      : parsed.command === "delete.restore"
        ? await adapter.restoreObject({
            objectType: parsed.objectType as "thread" | "task" | "memory",
            objectId: parsed.objectId,
          })
        : await adapter.deleteImmediately({
            objectType: parsed.objectType,
            objectId: parsed.objectId,
          });
  return Object.freeze({ outputSchemaVersion: 1, command: parsed.command, ...report });
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
      : parsed.command.startsWith("transfer.")
        ? await transferCommand(parsed, output)
        : parsed.command.startsWith("delete.")
          ? await deletionCommand(parsed, output)
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
