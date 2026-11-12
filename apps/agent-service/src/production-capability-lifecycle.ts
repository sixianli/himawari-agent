import {
  ApplicationPortError,
  type CapabilityArtifactVerification,
  CapabilityLifecycleService,
  type CapabilityManifest,
  type CapabilityRuntimeQualification,
  type ClockPort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
} from "@himawari-agent/application";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import {
  type CapabilityDeploymentEntry,
  CapabilityDeploymentSnapshotLoader,
} from "@himawari-agent/platform-node";

const NOT_IN_DEPLOYMENT = "capability_not_in_deployment_snapshot";
const SNAPSHOT_UNREADABLE = "capability_deployment_snapshot_unreadable";
const NO_DEPLOYMENT = "capability_deployment_not_configured";

type EntryLookup =
  | { readonly entry: CapabilityDeploymentEntry; readonly reason?: undefined }
  | { readonly entry?: undefined; readonly reason: string };

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
  const loader = deployment
    ? new CapabilityDeploymentSnapshotLoader({ ...deployment, now: () => clock.now() })
    : undefined;
  const entryFor = async (manifest: CapabilityManifest): Promise<EntryLookup> => {
    if (!loader) return { reason: NO_DEPLOYMENT };
    let loaded: Awaited<ReturnType<typeof loader.load>>;
    try {
      loaded = await loader.load();
    } catch {
      return { reason: SNAPSHOT_UNREADABLE };
    }
    const entry = loaded.snapshot.capabilities.find(
      ({ manifest: candidate }) =>
        candidate.ref === manifest.ref &&
        candidate.version === manifest.version &&
        candidate.integrity === manifest.integrity,
    );
    return entry ? { entry } : { reason: NOT_IN_DEPLOYMENT };
  };
  return new CapabilityLifecycleService({
    store: repository.capabilityStore(configuration.ownerId, configuration.agentId),
    clock,
    artifacts: {
      verify: async (manifest): Promise<CapabilityArtifactVerification> => {
        const { entry, reason } = await entryFor(manifest);
        return {
          verificationVersion: "capability-artifact-verification.v1",
          artifactDigest: entry ? entry.manifest.integrity : manifest.integrity,
          signatureStatus: manifest.artifact.signatureStatus,
          signerRef: manifest.artifact.signerRef,
          verified: entry !== undefined,
          reasonCodes: entry ? [] : [reason],
          verifiedAt: clock.now(),
        };
      },
    },
    runtime: {
      qualify: async (manifest): Promise<CapabilityRuntimeQualification> => {
        const { entry, reason } = await entryFor(manifest);
        if (!entry)
          throw new ApplicationPortError(
            PORT_ERROR_CODES.NOT_AUTHORITATIVE,
            "Capability runtime qualification failed",
            {
              capabilityRef: manifest.ref,
              reasons: reason,
            },
          );
        return entry.qualification;
      },
    },
  });
}
