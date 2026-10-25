import path from "node:path";
import {
  acquireStateRootLock,
  SqliteSandboxReservationAdministration,
  SqliteUnconfirmedSandboxPurge,
} from "@himawari-agent/persistence-sqlite";
import { JsonFileConfigurationPort, writeServiceDiagnostic } from "@himawari-agent/platform-node";

export async function runSandboxCommand(
  args: readonly string[],
  output: NodeJS.WritableStream,
): Promise<unknown> {
  if (args[1] === "inspect-reservation" || args[1] === "confirm-reservation-cleanup") {
    const inspecting = args[1] === "inspect-reservation";
    if (!inspecting && !args.includes("--confirm")) throw new Error("ADMIN_CONFIRMATION_REQUIRED");
    if (
      args.length !== (inspecting ? 6 : 14) ||
      args[2] !== "--config" ||
      !args[3] ||
      args[4] !== "--job" ||
      !args[5] ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(args[5] ?? "") ||
      (!inspecting &&
        (args[6] !== "--digest" ||
          !/^sha256:[0-9a-f]{64}$/.test(args[7] ?? "") ||
          args[8] !== "--administrator" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(args[9] ?? "") ||
          args[10] !== "--evidence" ||
          !/^sha256:[0-9a-f]{64}$/.test(args[11] ?? "") ||
          args[12] !== "--confirm"))
    )
      throw new Error("ADMIN_ARGUMENT_INVALID");
    const configuration = await new JsonFileConfigurationPort(args[3]).load();
    const reservations = new SqliteSandboxReservationAdministration({
      stateRoot: configuration.stateRoot,
      databasePath: path.join(configuration.stateRoot, "data", "product.sqlite"),
      ownerId: configuration.ownerId,
      agentId: configuration.agentId,
      deploymentId: configuration.deploymentId,
    });
    if (inspecting)
      return {
        outputSchemaVersion: 1,
        command: "sandbox.inspect-reservation",
        ...reservations.inspect(args[5]),
      };
    writeServiceDiagnostic(output, {
      component: "admin-cli",
      event: "mutation.plan",
      action: "sandbox.confirm-reservation-cleanup",
      target: `deployment:${configuration.deploymentId}:job:${args[5]}`,
      stoppedServiceRequired: true,
      confirmation: args[7] as string,
    });
    return {
      outputSchemaVersion: 1,
      command: "sandbox.confirm-reservation-cleanup",
      ...(await reservations.confirm({
        jobId: args[5],
        digest: args[7] as string,
        administrator: args[9] as string,
        evidence: args[11] as string,
        confirmation: args[13] as string,
      })),
    };
  }
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
