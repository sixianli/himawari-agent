import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  acquireStateRootLock,
  openQualifiedDatabase,
  readSqliteRuntimeStatus,
  type StateRootLock,
} from "@himawari-agent/persistence-sqlite";
import {
  initializeStateRoot,
  JsonFileConfigurationPort,
  parseServiceArguments,
  readAuthorityFile,
  readRestrictedExecutionTokenFile,
  SERVICE_RUNTIME_ERROR_CODES,
  stableErrorCode,
  waitForTerminationSignal,
  writeServiceDiagnostic,
} from "@himawari-agent/platform-node";
import { AgentServiceExecutionClient } from "./production-execution-client.js";

export const AGENT_SERVICE_ERROR_CODES = Object.freeze({
  AUTHORITY_INACTIVE: "AGENT_AUTHORITY_INACTIVE",
  AUTHORITY_MISMATCH: "AGENT_AUTHORITY_MISMATCH",
  SQLITE_UNQUALIFIED: "AGENT_SQLITE_UNQUALIFIED",
} as const);

export async function runAgentService(
  arguments_: readonly string[],
  output: NodeJS.WritableStream = process.stdout,
  errorOutput: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  let lock: StateRootLock | undefined;
  let worker: AgentServiceExecutionClient | undefined;
  try {
    const args = parseServiceArguments(arguments_);
    const configuration = await new JsonFileConfigurationPort(args.configurationPath).load();
    if (configuration.publicMode) {
      throw new Error(SERVICE_RUNTIME_ERROR_CODES.PUBLIC_MODE_INCOMPLETE);
    }
    const layout = await initializeStateRoot(configuration.stateRoot);
    lock = await acquireStateRootLock(configuration.stateRoot);
    const authority = await readAuthorityFile(layout);
    if (authority.status !== "active") {
      throw new Error(AGENT_SERVICE_ERROR_CODES.AUTHORITY_INACTIVE);
    }
    if (
      authority.id !== configuration.deploymentId ||
      authority.ownerId !== configuration.ownerId ||
      authority.agentId !== configuration.agentId
    ) {
      throw new Error(AGENT_SERVICE_ERROR_CODES.AUTHORITY_MISMATCH);
    }
    const database = openQualifiedDatabase(path.join(layout.data, "product.sqlite"));
    const sqlite = readSqliteRuntimeStatus(database);
    database.close();
    if (sqlite.quickCheck !== "ok") throw new Error(AGENT_SERVICE_ERROR_CODES.SQLITE_UNQUALIFIED);
    const credential = await readRestrictedExecutionTokenFile(args.workerTokenPath);
    let idSequence = 0;
    worker = new AgentServiceExecutionClient({
      socketPath: path.join(configuration.runtimeDirectory, "execution.sock"),
      credential,
      agentServiceInstanceId: `agent-service:${configuration.deploymentId}`,
      maximumBodyBytes: 65_536,
      requestTimeoutMs: configuration.deadlines.workerRequestMs,
      deploymentId: configuration.deploymentId,
      authorityEpoch: authority.authorityEpoch,
      fencingToken: authority.fencingToken,
      now: () => new Date().toISOString(),
      nextId: (scope) => {
        idSequence += 1;
        return `${scope}:${idSequence}:${randomUUID()}`;
      },
    });
    const handshake = await worker.start();
    writeServiceDiagnostic(output, {
      component: "agent-service",
      event: "service.ready",
      deploymentId: configuration.deploymentId,
      authorityEpoch: authority.authorityEpoch,
      fencingToken: authority.fencingToken,
      sqliteVersion: sqlite.sqliteVersion,
      workerSchemaVersion: handshake.payload.selectedSchemaVersion,
      publicMode: false,
    });
    const signal = await waitForTerminationSignal();
    writeServiceDiagnostic(output, {
      component: "agent-service",
      event: "service.draining",
      signal,
    });
    worker.stop();
    await lock.release();
    writeServiceDiagnostic(output, { component: "agent-service", event: "service.stopped" });
    return 0;
  } catch (error) {
    worker?.stop();
    await lock?.release().catch(() => undefined);
    writeServiceDiagnostic(errorOutput, {
      component: "agent-service",
      event: "service.failed",
      code: stableErrorCode(error),
    });
    return 1;
  }
}
