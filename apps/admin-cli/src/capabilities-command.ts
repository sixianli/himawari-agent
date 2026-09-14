import { randomUUID } from "node:crypto";
import path from "node:path";
import { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import {
  JsonFileConfigurationPort,
  loadCapabilityDeploymentSnapshot,
} from "@himawari-agent/platform-node";

/** Register an explicitly confirmed, already-qualified installation. This command
 * neither runs qualification nor elevates an unqualified declaration. */
export async function runCapabilitiesCommand(args: readonly string[]): Promise<unknown> {
  const invalid = () => new Error("ADMIN_CAPABILITIES_INPUT_INVALID");
  if (
    args.length !== 6 ||
    args[1] !== "register" ||
    args[2] !== "--config" ||
    args[4] !== "--confirm" ||
    !args[3] ||
    !path.isAbsolute(args[3])
  )
    throw invalid();
  const config = await new JsonFileConfigurationPort(args[3]).load();
  if (!config.capabilityDeployment || args[5] !== config.capabilityDeployment.sha256)
    throw invalid();
  const loaded = await loadCapabilityDeploymentSnapshot(config.capabilityDeployment);
  if (loaded.manifests.some((manifest) => manifest.reviewedBy !== config.ownerId)) throw invalid();
  const repo = await SqliteProductStateRepository.open({
    stateRoot: config.stateRoot,
    databasePath: path.join(config.stateRoot, "data", "product.sqlite"),
  });
  try {
    const deployment = await repo.deploymentAuthorityPort().read(config.deploymentId);
    if (
      !deployment ||
      deployment.status !== "active" ||
      deployment.ownerId !== config.ownerId ||
      deployment.agentId !== config.agentId
    )
      throw invalid();
    const store = repo.capabilityStore(config.ownerId, config.agentId);
    const existing = await Promise.all(loaded.records.map((record) => store.get(record.ref)));
    for (let i = 0; i < loaded.records.length; i++) {
      const record = loaded.records[i],
        prior = existing[i];
      if (
        !record ||
        (prior &&
          (prior.lifecycle !== "active" ||
            JSON.stringify(prior.declaration) !== JSON.stringify(record.declaration)))
      )
        throw new Error("ADMIN_CAPABILITY_REVIEW_REQUIRED");
    }
    const created: string[] = [];
    for (let i = 0; i < loaded.records.length; i++) {
      const record = loaded.records[i];
      if (!record || existing[i]) continue;
      await store.create(record);
      created.push(record.ref);
      await repo.auditLedger().append({
        id: `installation-capability:${randomUUID()}`,
        ownerId: config.ownerId,
        agentId: config.agentId,
        action: "owner.capability.register",
        targetRef: record.ref,
        outcome: "completed",
        occurredAt: new Date().toISOString(),
      });
    }
    return {
      snapshotDigest: loaded.snapshotDigest,
      created,
      existing: loaded.records.length - created.length,
    };
  } finally {
    await repo.close();
  }
}
