import path from "node:path";
import { readRunDiagnostics } from "@himawari-agent/persistence-sqlite";
import {
  EnvelopePayloadProtector,
  JsonFileConfigurationPort,
  RestrictedSecretFileSource,
  stableErrorCode,
} from "@himawari-agent/platform-node";

const FLAGS = ["--config", "--secret-dir", "--run"] as const;

function flags(args: readonly string[]) {
  if (args[1] !== "run" || args.length !== 2 + FLAGS.length * 2)
    throw new Error("ADMIN_ARGUMENT_INVALID");
  const values = new Map<string, string>();
  for (let index = 2; index < args.length; index += 2) {
    const name = args[index] as string;
    const value = args[index + 1];
    if (!FLAGS.includes(name as (typeof FLAGS)[number]) || values.has(name) || !value)
      throw new Error("ADMIN_ARGUMENT_INVALID");
    values.set(name, value);
  }
  return {
    configurationPath: values.get("--config") as string,
    secretDirectory: values.get("--secret-dir") as string,
    runId: values.get("--run") as string,
  };
}

export async function runDiagnoseCommand(args: readonly string[]): Promise<unknown> {
  const { configurationPath, secretDirectory, runId } = flags(args);
  const configuration = await new JsonFileConfigurationPort(configurationPath).load();
  const payloadKeys = configuration.secretReferences.filter(
    (secret) => secret.purpose === "payload-encryption",
  );
  const payloadKey = payloadKeys[0];
  if (payloadKeys.length !== 1 || !payloadKey) throw new Error("ADMIN_ARGUMENT_INVALID");
  const snapshot = readRunDiagnostics({
    databasePath: path.join(configuration.stateRoot, "data", "product.sqlite"),
    ownerId: configuration.ownerId,
    agentId: configuration.agentId,
    runId,
  });
  if (!snapshot) throw new Error("ADMIN_RUN_NOT_FOUND");
  const protector = new EnvelopePayloadProtector({
    keys: new RestrictedSecretFileSource(secretDirectory),
    activeKey: { keyRef: payloadKey.ref, kekVersion: payloadKey.version, dekVersion: "dek-v1" },
  });
  const diagnostics = [];
  for (const { operationKey, createdAt, payload } of snapshot.diagnosticPayloads) {
    try {
      const plaintext = await protector.unprotect({
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        payload,
      });
      diagnostics.push({
        operationKey,
        createdAt,
        content: JSON.parse(new TextDecoder().decode(plaintext)),
      });
    } catch (error) {
      diagnostics.push({ operationKey, createdAt, errorCode: stableErrorCode(error) });
    }
  }
  return {
    outputSchemaVersion: 1,
    command: "diagnose.run",
    run: snapshot.run,
    sandboxJobs: snapshot.sandboxJobs,
    diagnostics,
  };
}
