import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertWritableSchema,
  bundledSchemaFingerprint,
  buildChatExport,
  buildPortableExport,
  CHAT_FORMAT_VERSION,
  CHAT_SEALED_FILE,
  DATA_EXPORT_ERROR_CODES,
  DataExportError,
  importPortableExport,
  LATEST_MIGRATION_SEQUENCE,
  openQualifiedDatabase,
  parsePortable,
  SEALED_FILE,
  readPortableDirectory,
  verifyChatExport,
  verifyIntegrity,
  writePortableDirectory,
} from "@himawari-agent/persistence-sqlite";
import {
  createDataExportTextPolicy,
  EnvelopePayloadProtector,
  JsonFileConfigurationPort,
  RestrictedSecretFileSource,
  writeServiceDiagnostic,
} from "@himawari-agent/platform-node";
import { lockStoppedTarget } from "./stopped-target-lock.js";

const VALUE_OPTIONS = [
  "--config",
  "--operator",
  "--confirm",
  "--secret-dir",
  "--out",
  "--from",
  "--locale",
  "--passphrase-file",
] as const;
const FLAG_OPTIONS = ["--with-evidence", "--dry-run", "--allow-unsealed"] as const;

export const DATA_COMMAND_ERROR_CODES = Object.freeze({
  ARGUMENT_INVALID: "ADMIN_DATA_ARGUMENT_INVALID",
  CONFIRMATION_REQUIRED: "ADMIN_CONFIRMATION_REQUIRED",
  PASSPHRASE_FILE_UNSAFE: "ADMIN_DATA_PASSPHRASE_FILE_UNSAFE",
  UNSEALED_WITHHELD: "ADMIN_DATA_UNSEALED_WITHHELD",
} as const);

interface ParsedData {
  readonly action: "export" | "export-chats" | "inspect" | "import";
  readonly values: Map<string, string>;
  readonly flags: Set<string>;
}

function parse(arguments_: readonly string[]): ParsedData {
  const action = arguments_[1];
  if (
    arguments_[0] !== "data" ||
    (action !== "export" &&
      action !== "export-chats" &&
      action !== "inspect" &&
      action !== "import")
  )
    throw new Error(DATA_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let index = 2;
  while (index < arguments_.length) {
    const name = arguments_[index] ?? "";
    if ((FLAG_OPTIONS as readonly string[]).includes(name)) {
      if (flags.has(name)) throw new Error(DATA_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
      flags.add(name);
      index += 1;
      continue;
    }
    const value = arguments_[index + 1];
    if (
      !(VALUE_OPTIONS as readonly string[]).includes(name) ||
      !value ||
      value.startsWith("--") ||
      values.has(name)
    )
      throw new Error(DATA_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
    values.set(name, value);
    index += 2;
  }
  return { action, values, flags };
}

async function readPassphrase(file: string | undefined): Promise<string | undefined> {
  if (file === undefined) return undefined;
  const status = await lstat(file);
  if (!status.isFile() || (status.mode & 0o177) !== 0)
    throw new Error(DATA_COMMAND_ERROR_CODES.PASSPHRASE_FILE_UNSAFE);
  const text = (await readFile(file, "utf8")).replace(/\r?\n$/, "");
  if (text.length < 12) throw new Error(DATA_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
  return text;
}

function requirePayloadKey(configuration: Awaited<ReturnType<JsonFileConfigurationPort["load"]>>) {
  const matches = configuration.secretReferences.filter(
    (secret) => secret.purpose === "payload-encryption",
  );
  if (matches.length !== 1) throw new Error(DATA_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
  return matches[0] as (typeof matches)[number];
}

function totalWithheld(withheld: { texts: number; memories: number; decisions: number }) {
  return withheld.texts + withheld.memories + withheld.decisions;
}

export async function runDataCommand(
  arguments_: readonly string[],
  output: NodeJS.WritableStream,
  now: () => string = () => new Date().toISOString(),
): Promise<unknown> {
  const { action, values, flags } = parse(arguments_);
  if (action === "inspect") {
    const from = values.get("--from");
    if (!from) throw new Error(DATA_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
    let declaredFormat: unknown;
    try {
      const manifestPath = path.join(from, "manifest.json");
      const handle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw new DataExportError(
            DATA_EXPORT_ERROR_CODES.PATH_UNSAFE,
            "manifest.json 打不开或是符号链接",
          );
        },
      );
      let peeked = "";
      if (handle) {
        try {
          const manifestStat = await handle.stat();
          if (!manifestStat.isFile() || manifestStat.size > 128 * 1024 * 1024)
            throw new DataExportError(
              DATA_EXPORT_ERROR_CODES.PATH_UNSAFE,
              "manifest.json 不是普通文件或太大",
            );
          peeked = await handle.readFile("utf8");
        } finally {
          await handle.close();
        }
      }
      declaredFormat = peeked
        ? (JSON.parse(peeked) as { format?: unknown } | null)?.format
        : undefined;
    } catch (error) {
      if (error instanceof DataExportError) throw error;
      throw new DataExportError(DATA_EXPORT_ERROR_CODES.MANIFEST_INVALID, "清单不是有效的 JSON");
    }
    const files = await readPortableDirectory(
      from,
      declaredFormat === CHAT_FORMAT_VERSION
        ? { maximumFiles: 200_000, maximumTotalBytes: 2 * 1024 * 1024 * 1024 }
        : {},
    );
    if (declaredFormat === CHAT_FORMAT_VERSION) {
      const chats = verifyChatExport(files, LATEST_MIGRATION_SEQUENCE);
      return Object.freeze({
        outputSchemaVersion: 1,
        command: "data.inspect",
        format: chats.format,
        exportedAt: chats.exportedAt,
        counts: chats.counts,
        withheld: chats.withheld,
        omitted: chats.omitted,
        sealed: files.has(CHAT_SEALED_FILE),
      });
    }
    const manifest = verifyIntegrity(files, LATEST_MIGRATION_SEQUENCE);
    parsePortable(files, LATEST_MIGRATION_SEQUENCE);
    return Object.freeze({
      outputSchemaVersion: 1,
      command: "data.inspect",
      format: manifest.format,
      exportedAt: manifest.exportedAt,
      counts: manifest.counts,
      withheld: manifest.withheld,
      omitted: manifest.omitted,
      sealed: files.has(SEALED_FILE),
    });
  }
  const configurationPath = values.get("--config");
  const operator = values.get("--operator");
  const secretDirectory = values.get("--secret-dir");
  if (
    !configurationPath ||
    !secretDirectory ||
    !operator ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._@:-]{0,127}$/.test(operator)
  )
    throw new Error(DATA_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
  const configuration = await new JsonFileConfigurationPort(configurationPath).load();
  const scope = { ownerId: configuration.ownerId, agentId: configuration.agentId };
  const payloadKey = requirePayloadKey(configuration);
  const protector = new EnvelopePayloadProtector({
    keys: new RestrictedSecretFileSource(secretDirectory),
    activeKey: { keyRef: payloadKey.ref, kekVersion: payloadKey.version, dekVersion: "dek-v1" },
  });
  const passphrase = await readPassphrase(values.get("--passphrase-file"));
  const lock = await lockStoppedTarget(configuration.stateRoot);
  try {
    const database = openQualifiedDatabase(
      path.join(configuration.stateRoot, "data", "product.sqlite"),
    );
    try {
      assertWritableSchema(database, LATEST_MIGRATION_SEQUENCE, bundledSchemaFingerprint());
      if (action === "export") {
        const out = values.get("--out");
        if (!out) throw new Error(DATA_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
        const result = await buildPortableExport({
          database,
          scope,
          migrationSequence: LATEST_MIGRATION_SEQUENCE,
          protector,
          policy: createDataExportTextPolicy(),
          now,
          ...(passphrase === undefined ? {} : { sealPassphrase: passphrase }),
          withEvidence: flags.has("--with-evidence"),
        });
        writeServiceDiagnostic(output, {
          component: "admin-cli",
          event: "export.plan",
          action: "data.export",
          target: `agent:${configuration.agentId}`,
          stoppedServiceRequired: true,
          withheldTexts: result.manifest.withheld.texts,
          withheldMemories: result.manifest.withheld.memories,
          withheldDecisions: result.manifest.withheld.decisions,
          sealed: passphrase !== undefined,
        });
        if (
          totalWithheld(result.manifest.withheld) > 0 &&
          passphrase === undefined &&
          !flags.has("--allow-unsealed")
        )
          throw new Error(DATA_COMMAND_ERROR_CODES.UNSEALED_WITHHELD);
        await writePortableDirectory(out, result.files);
        return Object.freeze({
          outputSchemaVersion: 1,
          command: "data.export",
          operator,
          out,
          counts: result.manifest.counts,
          withheld: result.manifest.withheld,
          sealed: passphrase !== undefined,
        });
      }
      if (action === "export-chats") {
        const out = values.get("--out");
        if (!out) throw new Error(DATA_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
        const result = await buildChatExport({
          database,
          scope,
          migrationSequence: LATEST_MIGRATION_SEQUENCE,
          protector,
          policy: createDataExportTextPolicy(),
          now,
          maximumBytes: 256 * 1024 * 1024,
          ...(passphrase === undefined ? {} : { sealPassphrase: passphrase }),
        });
        writeServiceDiagnostic(output, {
          component: "admin-cli",
          event: "export.plan",
          action: "data.export-chats",
          target: `agent:${configuration.agentId}`,
          stoppedServiceRequired: true,
          withheldMessages: result.manifest.withheld.messages,
          sealed: passphrase !== undefined,
        });
        if (
          result.manifest.withheld.texts > 0 &&
          passphrase === undefined &&
          !flags.has("--allow-unsealed")
        )
          throw new Error(DATA_COMMAND_ERROR_CODES.UNSEALED_WITHHELD);
        await writePortableDirectory(out, result.files);
        return Object.freeze({
          outputSchemaVersion: 1,
          command: "data.export-chats",
          operator,
          out,
          counts: result.manifest.counts,
          withheld: result.manifest.withheld,
          sealed: passphrase !== undefined,
        });
      }
      const from = values.get("--from");
      if (!from) throw new Error(DATA_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
      const confirmation = `IMPORT_DATA_${configuration.agentId}`;
      const dryRun = flags.has("--dry-run");
      if (!dryRun && values.get("--confirm") !== confirmation) {
        writeServiceDiagnostic(output, {
          component: "admin-cli",
          event: "mutation.plan",
          action: "data.import",
          target: `agent:${configuration.agentId}`,
          stoppedServiceRequired: true,
          backupRequired: true,
          confirmation,
        });
        throw new Error(DATA_COMMAND_ERROR_CODES.CONFIRMATION_REQUIRED);
      }
      const files = await readPortableDirectory(from);
      const report = importPortableExport(files, {
        database,
        scope,
        migrationSequence: LATEST_MIGRATION_SEQUENCE,
        protector,
        now,
        dryRun,
        ...(passphrase === undefined ? {} : { passphrase }),
      });
      return Object.freeze({
        outputSchemaVersion: 1,
        command: "data.import",
        operator,
        ...(await report),
      });
    } finally {
      database.close();
    }
  } finally {
    await lock.release();
  }
}
