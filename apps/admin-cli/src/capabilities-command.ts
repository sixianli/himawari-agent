import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  type CapabilityRegistryRegistration,
  type CapabilityRegistryUpgrade,
  type CapabilityRunnerUpgradePlan,
  planCapabilityRunnerUpgrade,
  upgradedCapabilityRecord,
} from "@himawari-agent/application";
import { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import {
  JsonFileConfigurationPort,
  type LoadedCapabilityDeployment,
  loadCapabilityDeploymentSnapshot,
} from "@himawari-agent/platform-node";

type ProductConfiguration = Awaited<ReturnType<JsonFileConfigurationPort["load"]>>;

const invalid = () => new Error("ADMIN_CAPABILITIES_INPUT_INVALID");

/** Register an explicitly confirmed, already-qualified installation. This command
 * neither runs qualification nor elevates an unqualified declaration. */
export async function runCapabilitiesCommand(args: readonly string[]): Promise<unknown> {
  if (
    args[1] === "register" &&
    args.length === 6 &&
    args[2] === "--config" &&
    args[4] === "--confirm"
  )
    return register(args[3], args[5]);
  const reviewed = args.at(-1) === "--reviewed";
  const command = reviewed ? args.slice(0, -1) : args;
  if (command[1] === "upgrade-plan" && command.length === 4 && command[2] === "--config")
    return upgrade(command[3], undefined, reviewed);
  if (
    command[1] === "upgrade" &&
    command.length === 6 &&
    command[2] === "--config" &&
    command[4] === "--confirm"
  )
    return upgrade(command[3], command[5], reviewed);
  throw invalid();
}

async function deployment(
  configPath: string | undefined,
  confirmedSnapshot: (sha256: string) => boolean,
): Promise<{ config: ProductConfiguration; loaded: LoadedCapabilityDeployment }> {
  if (!configPath || !path.isAbsolute(configPath)) throw invalid();
  const config = await new JsonFileConfigurationPort(configPath).load();
  if (!config.capabilityDeployment || !confirmedSnapshot(config.capabilityDeployment.sha256))
    throw invalid();
  const loaded = await loadCapabilityDeploymentSnapshot(config.capabilityDeployment);
  if (loaded.manifests.some((manifest) => manifest.reviewedBy !== config.ownerId)) throw invalid();
  return { config, loaded };
}

async function withActiveDeployment<T>(
  config: ProductConfiguration,
  work: (repo: SqliteProductStateRepository) => Promise<T>,
): Promise<T> {
  const repo = await SqliteProductStateRepository.open({
    stateRoot: config.stateRoot,
    databasePath: path.join(config.stateRoot, "data", "product.sqlite"),
  });
  try {
    const record = await repo.deploymentAuthorityPort().read(config.deploymentId);
    if (
      !record ||
      record.status !== "active" ||
      record.ownerId !== config.ownerId ||
      record.agentId !== config.agentId
    )
      throw invalid();
    return await work(repo);
  } finally {
    await repo.close();
  }
}

async function register(configPath: string | undefined, confirmation: string | undefined) {
  const { config, loaded } = await deployment(configPath, (sha256) => confirmation === sha256);
  return withActiveDeployment(config, async (repo) => {
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
  });
}

async function upgrade(
  configPath: string | undefined,
  confirmation: string | undefined,
  reviewed: boolean,
) {
  const { config, loaded } = await deployment(configPath, () => true);
  return withActiveDeployment(config, async (repo) => {
    const store = repo.capabilityStore(config.ownerId, config.agentId);
    const plan = planCapabilityRunnerUpgrade({
      ownerId: config.ownerId,
      agentId: config.agentId,
      deploymentId: config.deploymentId,
      candidates: await Promise.all(
        loaded.snapshot.capabilities.map(async (entry) => ({
          prior: await store.get(entry.manifest.ref),
          manifest: entry.manifest,
          qualification: entry.qualification,
          runtimeRoot: entry.binding.kind === "sandbox" ? entry.binding.value.runtimeRoot : null,
        })),
      ),
      reviewed,
    });
    if (plan.decisions.some((decision) => decision.kind === "not_registered"))
      throw new Error("ADMIN_CAPABILITY_NOT_REGISTERED");
    if (plan.decisions.some((decision) => decision.kind === "review_required"))
      throw new Error("ADMIN_CAPABILITY_REVIEW_REQUIRED");
    const current = plan.decisions.flatMap((decision) =>
      decision.kind === "current" ? [decision.ref] : [],
    );
    if (confirmation === undefined)
      return planOutput(loaded.snapshotDigest, plan, current, reviewed);
    if (confirmation !== plan.planDigest) throw new Error("ADMIN_CAPABILITY_PLAN_MISMATCH");
    const upgradedAt = new Date().toISOString();
    const registrations: CapabilityRegistryRegistration[] = plan.decisions.flatMap((decision) => {
      if (decision.kind !== "register") return [];
      const record = loaded.records.find((candidate) => candidate?.ref === decision.ref);
      if (!record) throw new Error("ADMIN_CAPABILITY_REVIEW_REQUIRED");
      return [
        {
          record,
          audit: {
            id: `installation-capability:${randomUUID()}`,
            ownerId: config.ownerId,
            agentId: config.agentId,
            action: "owner.capability.register",
            targetRef: decision.ref,
            outcome: "completed",
            occurredAt: upgradedAt,
          },
        },
      ];
    });
    const upgrades: CapabilityRegistryUpgrade[] = plan.decisions.flatMap((decision) =>
      decision.kind === "upgrade"
        ? [
            {
              record: upgradedCapabilityRecord(decision.upgrade, upgradedAt),
              expectedRevision: decision.upgrade.prior.revision,
              audit: {
                id: `installation-capability:${randomUUID()}`,
                ownerId: config.ownerId,
                agentId: config.agentId,
                action: decision.upgrade.scopeChanges
                  ? "owner.capability.scope_upgrade"
                  : "owner.capability.upgrade",
                targetRef: decision.ref,
                outcome: "completed",
                occurredAt: upgradedAt,
              },
            },
          ]
        : [],
    );
    if (upgrades.length > 0 || registrations.length > 0) {
      if (!store.applyCapabilityUpgrades) throw new Error("ADMIN_CAPABILITY_UPGRADE_UNAVAILABLE");
      await store.applyCapabilityUpgrades(upgrades, upgradedAt, registrations);
    }
    return {
      snapshotDigest: loaded.snapshotDigest,
      planDigest: plan.planDigest,
      upgraded: upgrades.map((entry) => entry.record.ref),
      ...(reviewed ? { registered: registrations.map((entry) => entry.record.ref) } : {}),
      current,
    };
  });
}

function planOutput(
  snapshotDigest: string,
  plan: CapabilityRunnerUpgradePlan,
  current: readonly string[],
  reviewed: boolean,
) {
  return {
    snapshotDigest,
    planDigest: plan.planDigest,
    upgrades: plan.decisions.flatMap((decision) =>
      decision.kind === "upgrade"
        ? [
            {
              ref: decision.ref,
              version: decision.upgrade.manifest.version,
              fromIntegrity: decision.upgrade.prior.declaration.integrity,
              toIntegrity: decision.upgrade.manifest.integrity,
              fromRuntimeRoot: decision.upgrade.fromRuntimeRoot,
              toRuntimeRoot: decision.upgrade.toRuntimeRoot,
              ...(decision.upgrade.scopeChanges
                ? { scopeChanges: decision.upgrade.scopeChanges }
                : {}),
            },
          ]
        : [],
    ),
    ...(reviewed
      ? {
          registrations: plan.decisions.flatMap((decision) =>
            decision.kind === "register"
              ? [
                  {
                    ref: decision.ref,
                    version: decision.registration.manifest.version,
                    integrity: decision.registration.manifest.integrity,
                    operations: decision.registration.manifest.operations,
                    network: decision.registration.manifest.scopes.network,
                    secrets: decision.registration.manifest.scopes.secrets,
                  },
                ]
              : [],
          ),
        }
      : {}),
    current,
  };
}
