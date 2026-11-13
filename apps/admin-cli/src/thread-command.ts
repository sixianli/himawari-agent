import path from "node:path";
import type { ThreadPromptBundleScope } from "@himawari-agent/application";
import {
  assertWritableSchema,
  bundledSchemaFingerprint,
  LATEST_MIGRATION_SEQUENCE,
  openQualifiedDatabase,
  requestThreadPromptRebuild,
} from "@himawari-agent/persistence-sqlite";
import { JsonFileConfigurationPort, writeServiceDiagnostic } from "@himawari-agent/platform-node";
import { lockStoppedTarget } from "./stopped-target-lock.js";

const OPTIONS = ["--config", "--thread", "--reason", "--operator", "--confirm"] as const;

export const THREAD_COMMAND_ERROR_CODES = Object.freeze({
  ARGUMENT_INVALID: "ADMIN_THREAD_ARGUMENT_INVALID",
  CONFIRMATION_REQUIRED: "ADMIN_CONFIRMATION_REQUIRED",
  TARGET_NOT_STOPPED: "ADMIN_TARGET_NOT_STOPPED",
} as const);

export async function runThreadCommand(
  arguments_: readonly string[],
  output: NodeJS.WritableStream,
  now: () => string = () => new Date().toISOString(),
): Promise<unknown> {
  if (arguments_[0] !== "thread" || arguments_[1] !== "prompt" || arguments_[2] !== "rebuild")
    throw new Error(THREAD_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
  const values = new Map<string, string>();
  for (let index = 3; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !name ||
      !value ||
      !(OPTIONS as readonly string[]).includes(name) ||
      value.startsWith("--") ||
      values.has(name)
    )
      throw new Error(THREAD_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
    values.set(name, value);
  }
  const configurationPath = values.get("--config");
  const threadId = values.get("--thread");
  const reason = values.get("--reason");
  const operator = values.get("--operator");
  if (
    !configurationPath ||
    !threadId ||
    !reason ||
    !operator ||
    reason.trim().length === 0 ||
    reason.length > 500 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._@:-]{0,127}$/.test(operator) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(threadId)
  )
    throw new Error(THREAD_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
  const thread = threadId as ThreadPromptBundleScope["threadId"];
  const configuration = await new JsonFileConfigurationPort(configurationPath).load();
  const confirmation = `REBUILD_PROMPT_${thread}`;
  writeServiceDiagnostic(output, {
    component: "admin-cli",
    event: "mutation.plan",
    action: "thread.prompt.rebuild",
    target: `thread:${thread}`,
    stoppedServiceRequired: true,
    confirmation,
  });
  if (values.get("--confirm") !== confirmation)
    throw new Error(THREAD_COMMAND_ERROR_CODES.CONFIRMATION_REQUIRED);
  const lock = await lockStoppedTarget(configuration.stateRoot);
  try {
    const database = openQualifiedDatabase(
      path.join(configuration.stateRoot, "data", "product.sqlite"),
    );
    try {
      assertWritableSchema(database, LATEST_MIGRATION_SEQUENCE, bundledSchemaFingerprint());
      const record = requestThreadPromptRebuild(database, {
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        threadId: thread,
        reason,
        operator,
        now: now(),
      });
      return Object.freeze({
        outputSchemaVersion: 1,
        command: "thread.prompt.rebuild",
        threadId: thread,
        generation: record.generation,
        supersededAt: record.supersededAt,
        rebuildReason: record.rebuildReason,
        rebuildOperator: record.rebuildOperator,
      });
    } finally {
      database.close();
    }
  } finally {
    await lock.release();
  }
}
