import {
  type CapabilityArtifactVerification,
  CapabilityLifecycleService,
  type CapabilityManifest,
  type CapabilityRuntimeQualification,
  type ClockPort,
  type ProductConfiguration,
} from "@himawari-agent/application";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import {
  type CapabilityDeploymentEntry,
  CapabilityDeploymentSnapshotLoader,
  type LoadedCapabilityDeployment,
  revalidateCapabilityDeploymentSnapshot,
} from "@himawari-agent/platform-node";

const NOT_IN_DEPLOYMENT = "capability_not_in_deployment_snapshot";

export function createProductionCapabilityLifecycle(options: {
  readonly configuration: Pick<
    ProductConfiguration,
    "ownerId" | "agentId" | "capabilityDeployment"
  >;
  readonly repository: SqliteProductStateRepository;
  readonly clock: ClockPort;
}): CapabilityLifecycleService {
  const { configuration, repository, clock } = options;
  const deployment = configuration.capabilityDeployment;
  const admitted: Promise<LoadedCapabilityDeployment | undefined> = deployment
    ? new CapabilityDeploymentSnapshotLoader({ ...deployment, now: () => clock.now() })
        .load()
        .catch(() => undefined)
    : Promise.resolve(undefined);
  const entryFor = async (
    manifest: CapabilityManifest,
  ): Promise<CapabilityDeploymentEntry | undefined> => {
    const loaded = await admitted;
    if (!loaded) return undefined;
    const current = await revalidateCapabilityDeploymentSnapshot(loaded);
    return current.snapshot.capabilities.find(
      ({ manifest: candidate }) =>
        candidate.ref === manifest.ref &&
        candidate.version === manifest.version &&
        candidate.integrity === manifest.integrity,
    );
  };
  return new CapabilityLifecycleService({
    store: repository.capabilityStore(configuration.ownerId, configuration.agentId),
    clock,
    artifacts: {
      verify: async (manifest): Promise<CapabilityArtifactVerification> => {
        const entry = await entryFor(manifest).catch(() => undefined);
        return {
          verificationVersion: "capability-artifact-verification.v1",
          artifactDigest: entry ? entry.manifest.integrity : manifest.integrity,
          signatureStatus: manifest.artifact.signatureStatus,
          signerRef: manifest.artifact.signerRef,
          verified: entry !== undefined,
          reasonCodes: entry ? [] : [NOT_IN_DEPLOYMENT],
          verifiedAt: clock.now(),
        };
      },
    },
    runtime: {
      qualify: async (manifest): Promise<CapabilityRuntimeQualification> => {
        const entry = await entryFor(manifest);
        if (!entry) throw new Error(NOT_IN_DEPLOYMENT);
        return entry.qualification;
      },
    },
  });
}
