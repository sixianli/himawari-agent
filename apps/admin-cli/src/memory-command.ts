import path from "node:path";
import {
  assertWritableSchema,
  bundledSchemaFingerprint,
  LATEST_MIGRATION_SEQUENCE,
  openQualifiedDatabase,
  planMemoryReindex,
  restoreIdleArchivesAndClearMemoryIndex,
} from "@himawari-agent/persistence-sqlite";
import { JsonFileConfigurationPort, writeServiceDiagnostic } from "@himawari-agent/platform-node";
import { lockStoppedTarget } from "./stopped-target-lock.js";

const OPTIONS = ["--config", "--operator", "--confirm"] as const;

export const MEMORY_COMMAND_ERROR_CODES = Object.freeze({
  ARGUMENT_INVALID: "ADMIN_MEMORY_ARGUMENT_INVALID",
  CONFIRMATION_REQUIRED: "ADMIN_CONFIRMATION_REQUIRED",
  TARGET_NOT_STOPPED: "ADMIN_TARGET_NOT_STOPPED",
} as const);

export async function runMemoryCommand(
  arguments_: readonly string[],
  output: NodeJS.WritableStream,
  now: () => string = () => new Date().toISOString(),
): Promise<unknown> {
  if (arguments_[0] !== "memory" || arguments_[1] !== "reindex")
    throw new Error(MEMORY_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
  const values = new Map<string, string>();
  for (let index = 2; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !name ||
      !value ||
      !(OPTIONS as readonly string[]).includes(name) ||
      value.startsWith("--") ||
      values.has(name)
    )
      throw new Error(MEMORY_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
    values.set(name, value);
  }
  const configurationPath = values.get("--config");
  const operator = values.get("--operator");
  if (!configurationPath || !operator || !/^[a-zA-Z0-9][a-zA-Z0-9._@:-]{0,127}$/.test(operator))
    throw new Error(MEMORY_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
  const configuration = await new JsonFileConfigurationPort(configurationPath).load();
  const scope = { ownerId: configuration.ownerId, agentId: configuration.agentId };
  const confirmation = `REINDEX_MEMORY_${configuration.agentId}`;
  const lock = await lockStoppedTarget(configuration.stateRoot);
  try {
    const database = openQualifiedDatabase(
      path.join(configuration.stateRoot, "data", "product.sqlite"),
    );
    try {
      assertWritableSchema(database, LATEST_MIGRATION_SEQUENCE, bundledSchemaFingerprint());
      const plan = planMemoryReindex(database, scope);
      writeServiceDiagnostic(output, {
        component: "admin-cli",
        event: "mutation.plan",
        action: "memory.reindex",
        target: `agent:${configuration.agentId}`,
        stoppedServiceRequired: true,
        backupRequired: true,
        idleArchivesToRestore: plan.idleArchivesToRestore,
        indexedMemories: plan.indexedMemories,
        activeMemories: plan.activeMemories,
        embeddedEpisodes: plan.embeddedEpisodes,
        confirmation,
      });
      if (values.get("--confirm") !== confirmation)
        throw new Error(MEMORY_COMMAND_ERROR_CODES.CONFIRMATION_REQUIRED);
      const result = restoreIdleArchivesAndClearMemoryIndex(database, { ...scope, now: now() });
      return Object.freeze({
        outputSchemaVersion: 1,
        command: "memory.reindex",
        operator,
        restored: result.restored,
        clearedIndexRows: result.clearedIndexRows,
        clearedEpisodeVectors: result.clearedEpisodeVectors,
      });
    } finally {
      database.close();
    }
  } finally {
    await lock.release();
  }
}
