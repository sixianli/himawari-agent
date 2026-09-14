import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  createApplicationServiceIdentityFactory,
  DurableHostWorkspaceStateAdapter,
  FileOperationService,
  hostDirectoryGrantStateKey,
  type IdempotentAgentCommand,
  type StateStorePort,
} from "@himawari-agent/application";
import { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import {
  ConstrainedHostFileSystem,
  JsonFileConfigurationPort,
} from "@himawari-agent/platform-node";

/** Offline owner administration. A directory grant is not an action approval;
 * model requests still require their own policy/disclosure decision and qualified Worker. */
export async function runWorkspaceCommand(args: readonly string[]): Promise<unknown> {
  const invalid = () => new Error("ADMIN_WORKSPACE_INPUT_INVALID");
  if (args[1] !== "grant") throw invalid();
  const values = new Map<string, string>();
  for (let i = 2; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !key ||
      !value ||
      !["--config", "--directory", "--host-id", "--id", "--expires-at", "--confirm"].includes(
        key,
      ) ||
      values.has(key)
    )
      throw invalid();
    values.set(key, value);
  }
  const configPath = values.get("--config"),
    directory = values.get("--directory"),
    hostId = values.get("--host-id"),
    id = values.get("--id"),
    expiresAt = values.get("--expires-at");
  if (
    !configPath ||
    !directory ||
    !hostId ||
    !id ||
    !expiresAt ||
    !path.isAbsolute(configPath) ||
    !path.isAbsolute(directory) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(hostId) ||
    !Number.isFinite(Date.parse(expiresAt))
  )
    throw invalid();
  const canonical = await realpath(directory);
  if (
    canonical !== directory ||
    values.get("--confirm") !== canonical ||
    Date.parse(expiresAt) <= Date.now()
  )
    throw invalid();
  const configuration = await new JsonFileConfigurationPort(configPath).load();
  const stateRoot = await realpath(configuration.stateRoot);
  if (
    canonical === stateRoot ||
    canonical.startsWith(`${stateRoot}/`) ||
    stateRoot.startsWith(`${canonical}/`) ||
    canonical === "/"
  )
    throw invalid();
  const repo = await SqliteProductStateRepository.open({
    stateRoot,
    databasePath: path.join(stateRoot, "data", "product.sqlite"),
  });
  const clock = { now: () => new Date().toISOString() };
  const authorityPort = repo.authorityLeasePort(clock);
  let claimed: Awaited<ReturnType<typeof authorityPort.claim>> | undefined;
  try {
    const deployment = await repo.deploymentAuthorityPort().read(configuration.deploymentId);
    if (
      !deployment ||
      deployment.status !== "active" ||
      deployment.ownerId !== configuration.ownerId ||
      deployment.agentId !== configuration.agentId
    )
      throw invalid();
    if (
      await repo.readScopedState(
        configuration.ownerId,
        configuration.agentId,
        hostDirectoryGrantStateKey(id),
      )
    )
      throw new Error("ADMIN_WORKSPACE_ALREADY_EXISTS");
    claimed = await authorityPort.claim(
      createApplicationServiceIdentityFactory().createAuthorityLease({
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        leaseId: `workspace-admin:${randomUUID()}`,
        holderId: `workspace-admin:${process.pid}`,
      }),
      60000,
    );
    const lease = claimed;
    const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const store: StateStorePort = {
      read: (key) => repo.readScopedState(configuration.ownerId, configuration.agentId, key),
      compareAndSet: async (input) => {
        if (input.key !== hostDirectoryGrantStateKey(id)) throw invalid();
        const fingerprint = hash(JSON.stringify(input));
        const result = await repo.commitStateAndEvents({
          command: {
            ownerId: configuration.ownerId,
            agentId: configuration.agentId,
            idempotencyKey:
              `workspace-admin:${fingerprint}` as IdempotentAgentCommand["idempotencyKey"],
            commandType: "owner.workspace.grant",
            commandFingerprint: fingerprint,
            authority: { leaseId: lease.lease.id, fencingToken: lease.fencingToken },
          },
          state: input,
          events: [],
          resultRef: `directory-grant:${id}`,
          committedAt: clock.now(),
        });
        return result.state;
      },
    };
    const service = new FileOperationService({
      state: new DurableHostWorkspaceStateAdapter(store),
      platform: new ConstrainedHostFileSystem(),
      digest: {
        digest: (bytes) => `sha256:${hash(bytes)}`,
        digestCanonical: (value) => `sha256:${hash(value)}`,
      },
      clock,
      ids: { next: () => id },
      hostId,
    });
    const grant = await service.grant({
      hostId,
      displayPath: canonical,
      operations: ["read", "create", "update"],
      dataClassification: "private",
      disclosure: "model",
      pathPolicy: "same_filesystem_no_links",
      mountPolicy: "fixed_device",
      authorizationRef: `owner-cli:${id}`,
      expiresAt,
      revokedAt: null,
    });
    await repo.auditLedger().append({
      id: `workspace-admin:${randomUUID()}`,
      ownerId: configuration.ownerId,
      agentId: configuration.agentId,
      action: "owner.workspace.grant",
      targetRef: grant.id,
      outcome: "completed",
      occurredAt: clock.now(),
    });
    return {
      grantId: grant.id,
      canonicalRootId: grant.canonicalRootId,
      directory: grant.displayPath,
      operations: grant.operations,
      expiresAt: grant.expiresAt,
    };
  } finally {
    if (claimed) await authorityPort.release(claimed.lease.id);
    await repo.close();
  }
}
