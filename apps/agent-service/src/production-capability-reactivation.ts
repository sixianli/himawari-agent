import type {
  CapabilityReactivationVerifierPort,
  ProductConfiguration,
} from "@himawari-agent/application";
import {
  checkSealedCapabilityMembership,
  readWorkerQualifiedDeployment,
  type StateRootLayout,
} from "@himawari-agent/platform-node";

export const CAPABILITY_REACTIVATION_REASONS = Object.freeze({
  WORKER_NOT_QUALIFIED: "execution_worker_qualification_not_published",
  WORKER_BOOT_MISMATCH: "execution_worker_boot_mismatch",
  WORKER_SNAPSHOT_MISMATCH: "execution_worker_admitted_other_snapshot",
} as const);

export function createProductionCapabilityReactivationVerifier(options: {
  readonly configuration: Pick<ProductConfiguration, "capabilityDeployment" | "deploymentId">;
  readonly layout: StateRootLayout;
  readonly trustedPeerBinding: () => {
    readonly workerInstanceId: string;
    readonly workerBootId: string;
  };
}): CapabilityReactivationVerifierPort | undefined {
  const deployment = options.configuration.capabilityDeployment;
  if (!deployment) return undefined;
  const refuse = (reason: string) => ({ verified: false, reasonCodes: [reason] });
  return {
    verify: async (manifest) => {
      const membership = await checkSealedCapabilityMembership({
        snapshotPath: deployment.snapshotPath,
        sha256: deployment.sha256,
        ref: manifest.ref,
        version: manifest.version,
        integrity: manifest.integrity,
      });
      if (membership !== "member") return refuse(membership);
      const published = await readWorkerQualifiedDeployment(options.layout).catch(() => undefined);
      if (!published) return refuse(CAPABILITY_REACTIVATION_REASONS.WORKER_NOT_QUALIFIED);
      const peer = options.trustedPeerBinding();
      if (
        published.workerBootId !== peer.workerBootId ||
        published.workerInstanceId !== peer.workerInstanceId ||
        published.deploymentId !== options.configuration.deploymentId
      )
        return refuse(CAPABILITY_REACTIVATION_REASONS.WORKER_BOOT_MISMATCH);
      if (published.snapshotDigest !== deployment.sha256)
        return refuse(CAPABILITY_REACTIVATION_REASONS.WORKER_SNAPSHOT_MISMATCH);
      return { verified: true, reasonCodes: [] };
    },
  };
}
