import path from "node:path";
import {
  acquireStateRootLock,
  SqliteUnconfirmedSandboxPurge,
} from "@himawari-agent/persistence-sqlite";
import { JsonFileConfigurationPort, writeServiceDiagnostic } from "@himawari-agent/platform-node";

export async function runSandboxCommand(
  args: readonly string[],
  output: NodeJS.WritableStream,
): Promise<unknown> {
  const listing = args[1] === "list-unconfirmed" && args.length === 4;
  const purging =
    args[1] === "purge-unconfirmed" &&
    args.length === 6 &&
    args[4] === "--digest" &&
    /^sha256:[0-9a-f]{64}$/.test(args[5] ?? "");
  if ((!listing && !purging) || args[2] !== "--config" || !args[3])
    throw new Error("ADMIN_ARGUMENT_INVALID");
  const configuration = await new JsonFileConfigurationPort(args[3]).load();
  const records = new SqliteUnconfirmedSandboxPurge({
    databasePath: path.join(configuration.stateRoot, "data", "product.sqlite"),
    ownerId: configuration.ownerId,
    agentId: configuration.agentId,
  });
  if (listing)
    return { outputSchemaVersion: 1, command: "sandbox.list-unconfirmed", ...records.list() };
  const digest = args[5] as string;
  writeServiceDiagnostic(output, {
    component: "admin-cli",
    event: "mutation.plan",
    action: "sandbox.purge-unconfirmed",
    target: `deployment:${configuration.deploymentId}:product.sqlite`,
    stoppedServiceRequired: true,
    confirmation: digest,
  });
  const lock = await acquireStateRootLock(configuration.stateRoot).catch(() => {
    throw new Error("ADMIN_TARGET_NOT_STOPPED");
  });
  try {
    const { deletedJobIds, counts } = records.purge(digest);
    return {
      outputSchemaVersion: 1,
      command: "sandbox.purge-unconfirmed",
      digest,
      deletedJobIds,
      counts,
    };
  } finally {
    await lock.release();
  }
}
