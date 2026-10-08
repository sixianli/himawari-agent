import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const operationKey =
  "sandbox-control:efdbaa6bc845776bf390c13237664e2dcc83bc9a95c856b57f17480a3a0887cb:diagnostic:preparation-failure";
const diagnosticFields = ["stage", "reasonCode", "hostStage", "systemCode", "hostDetail"];
const detailFields = [
  "code",
  "command",
  "phase",
  "elapsedMs",
  "messageAgeMs",
  "deadlineRemainingMs",
  "expectedSequence",
  "receivedSequence",
];
const failureCodes = new Set([
  "DIAGNOSTIC_ARGUMENT_INVALID",
  "DIAGNOSTIC_CONFIGURATION_INVALID",
  "DIAGNOSTIC_RUNTIME_UNAVAILABLE",
  "DIAGNOSTIC_DATABASE_READ_FAILED",
  "DIAGNOSTIC_ARTIFACT_NOT_FOUND",
  "DIAGNOSTIC_ARTIFACT_AMBIGUOUS",
  "DIAGNOSTIC_PAYLOAD_INVALID",
  "DIAGNOSTIC_PAYLOAD_READ_FAILED",
  "DIAGNOSTIC_DECRYPT_FAILED",
  "DIAGNOSTIC_JSON_INVALID",
  "DIAGNOSTIC_SCHEMA_INVALID",
  "DIAGNOSTIC_READ_FAILED",
]);

class DiagnosticFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function selectFields(value, allowed) {
  return Object.fromEntries(
    allowed.filter((name) => Object.hasOwn(value, name)).map((name) => [name, value[name]]),
  );
}

export function diagnosticFailureOutput(error) {
  return {
    errorCode:
      error instanceof DiagnosticFailure && failureCodes.has(error.code)
        ? error.code
        : "DIAGNOSTIC_READ_FAILED",
  };
}

export function preparationDiagnosticOutput(value, schema) {
  try {
    if (!record(value)) throw new DiagnosticFailure("DIAGNOSTIC_SCHEMA_INVALID");
    const selected = selectFields(value, diagnosticFields);
    if (selected.hostDetail !== null) {
      if (!record(selected.hostDetail)) throw new DiagnosticFailure("DIAGNOSTIC_SCHEMA_INVALID");
      selected.hostDetail = selectFields(selected.hostDetail, detailFields);
    }
    const checked = schema.parse(selected);
    return {
      stage: checked.stage,
      reasonCode: checked.reasonCode,
      hostStage: checked.hostStage,
      systemCode: checked.systemCode,
      hostDetail:
        checked.hostDetail === null
          ? null
          : {
              code: checked.hostDetail.code,
              command: checked.hostDetail.command,
              phase: checked.hostDetail.phase,
            },
      fieldNames: diagnosticFields.filter((name) => Object.hasOwn(value, name)),
      hostDetailFieldNames:
        value.hostDetail === null
          ? []
          : detailFields.filter((name) => Object.hasOwn(value.hostDetail, name)),
    };
  } catch {
    throw new DiagnosticFailure("DIAGNOSTIC_SCHEMA_INVALID");
  }
}

export function productionDiagnosticRequest(args) {
  if (args.length !== 0) throw new DiagnosticFailure("DIAGNOSTIC_ARGUMENT_INVALID");
  return {
    runtimeRoot: "/opt/himawari/releases/2026-10-07-first/lib/himawari-agent",
    configurationPath: "/etc/himawari/config.json",
    stateRoot: "/var/lib/himawari/state",
    expectedOwnerId: "owner:first-production",
    expectedAgentId: "agent:first-production",
  };
}

export async function readRestrictedDiagnostic(request) {
  let database;
  let failureCode = "DIAGNOSTIC_ARGUMENT_INVALID";
  try {
    if (
      ![request.runtimeRoot, request.configurationPath, request.stateRoot].every((value) =>
        typeof value === "string" ? path.isAbsolute(value) : false,
      ) ||
      !request.expectedOwnerId ||
      !request.expectedAgentId
    )
      throw new DiagnosticFailure(failureCode);
    failureCode = "DIAGNOSTIC_CONFIGURATION_INVALID";
    const configuration = JSON.parse(await readFile(request.configurationPath, "utf8"));
    if (
      !record(configuration) ||
      configuration.stateRoot !== request.stateRoot ||
      configuration.ownerId !== request.expectedOwnerId ||
      configuration.agentId !== request.expectedAgentId ||
      !Array.isArray(configuration.secretReferences)
    )
      throw new DiagnosticFailure(failureCode);
    const payloadKeys = configuration.secretReferences.filter(
      (secret) => record(secret) && secret.purpose === "payload-encryption",
    );
    if (
      payloadKeys.length !== 1 ||
      typeof payloadKeys[0].ref !== "string" ||
      typeof payloadKeys[0].version !== "string"
    )
      throw new DiagnosticFailure(failureCode);
    const payloadKey = payloadKeys[0];
    failureCode = "DIAGNOSTIC_RUNTIME_UNAVAILABLE";
    const modulePath = (name, leaf) =>
      pathToFileURL(
        path.join(request.runtimeRoot, "node_modules", "@himawari-agent", name, "dist", leaf),
      ).href;
    const [protectorModule, secretModule, fileModule, contractsModule] = await Promise.all([
      import(modulePath("platform-node", "payload-protector.js")),
      import(modulePath("platform-node", "host-secret-source.js")),
      import(modulePath("platform-node", "ciphertext-file-store.js")),
      import(modulePath("execution-contracts", "sandbox-execution-v2.js")),
    ]);
    const require = createRequire(path.join(request.runtimeRoot, "package.json"));
    const BetterSqlite3 = require(path.join(request.runtimeRoot, "node_modules", "better-sqlite3"));
    failureCode = "DIAGNOSTIC_DATABASE_READ_FAILED";
    database = new BetterSqlite3(path.join(request.stateRoot, "data", "product.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    database.pragma("query_only = ON");
    if (database.pragma("query_only", { simple: true }) !== 1)
      throw new DiagnosticFailure(failureCode);
    const rows = database
      .prepare(
        `SELECT p.ref, p.classification AS dataClassification, p.content_type AS contentType,
          p.storage_kind AS storageKind, p.ciphertext, p.ciphertext_path AS ciphertextPath,
          p.encryption_metadata_json AS encryptionMetadataJson,
          p.content_digest AS contentDigest, p.created_at AS createdAt,
          a.content_digest AS artifactContentDigest, a.content_type AS artifactContentType
        FROM run_payload_artifacts a
        JOIN payloads p ON p.ref=a.payload_ref AND p.owner_id=a.owner_id AND p.agent_id=a.agent_id
        WHERE a.operation_key=? AND a.owner_id=? AND a.agent_id=? AND a.purpose='trace'
          AND a.classification='restricted' AND p.classification='restricted'
          AND p.lifecycle_state='active'
        LIMIT 2`,
      )
      .all(operationKey, configuration.ownerId, configuration.agentId);
    if (rows.length === 0) throw new DiagnosticFailure("DIAGNOSTIC_ARTIFACT_NOT_FOUND");
    if (rows.length !== 1) throw new DiagnosticFailure("DIAGNOSTIC_ARTIFACT_AMBIGUOUS");
    const row = rows[0];
    failureCode = "DIAGNOSTIC_PAYLOAD_INVALID";
    if (
      row.contentDigest !== row.artifactContentDigest ||
      row.contentType !== row.artifactContentType ||
      typeof row.encryptionMetadataJson !== "string" ||
      !["sqlite_blob", "ciphertext_file"].includes(row.storageKind)
    )
      throw new DiagnosticFailure(failureCode);
    const encryption = JSON.parse(row.encryptionMetadataJson);
    const payload = {
      ref: row.ref,
      dataClassification: row.dataClassification,
      contentType: row.contentType,
      ciphertext: new Uint8Array(),
      encryption,
      contentDigest: row.contentDigest,
      createdAt: row.createdAt,
      storage:
        row.storageKind === "ciphertext_file"
          ? {
              kind: "ciphertext_file",
              relativePath: row.ciphertextPath,
              ciphertextDigest: encryption.ciphertextDigest,
            }
          : { kind: "inline" },
    };
    failureCode = "DIAGNOSTIC_PAYLOAD_READ_FAILED";
    if (payload.storage.kind === "ciphertext_file") {
      payload.ciphertext = await new fileModule.ContentAddressedCiphertextStore(
        path.join(request.stateRoot, "data", "payload-ciphertext"),
      ).read(payload.storage);
    } else {
      if (!(row.ciphertext instanceof Uint8Array)) throw new DiagnosticFailure(failureCode);
      payload.ciphertext = new Uint8Array(row.ciphertext);
    }
    failureCode = "DIAGNOSTIC_DECRYPT_FAILED";
    const protector = new protectorModule.EnvelopePayloadProtector({
      keys: new secretModule.SystemdCredentialSecretSource(path.join(request.stateRoot, "secrets")),
      activeKey: { keyRef: payloadKey.ref, kekVersion: payloadKey.version, dekVersion: "dek-v1" },
    });
    const plaintext = await protector.unprotect({
      ownerId: configuration.ownerId,
      agentId: configuration.agentId,
      payload,
    });
    failureCode = "DIAGNOSTIC_JSON_INVALID";
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    return preparationDiagnosticOutput(value, contractsModule.sandboxPreparationDiagnosticSchema);
  } catch (error) {
    if (error instanceof DiagnosticFailure) throw error;
    throw new DiagnosticFailure(failureCode);
  } finally {
    try {
      database?.close();
    } catch {}
  }
}

if (process.argv[1] === "-") {
  try {
    const output = await readRestrictedDiagnostic(
      productionDiagnosticRequest(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(diagnosticFailureOutput(error))}\n`);
    process.exitCode = 1;
  }
}
