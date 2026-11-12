import {
  ApplicationPortError,
  CapabilityLifecycleService,
  type CapabilityReactivationVerifierPort,
  type ClockPort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
} from "@himawari-agent/application";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";

const VERSION_CHECKS_UNAVAILABLE = "capability_version_checks_not_available_in_production";

export function createProductionCapabilityLifecycle(options: {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly repository: SqliteProductStateRepository;
  readonly clock: ClockPort;
  readonly reactivation?: CapabilityReactivationVerifierPort;
}): CapabilityLifecycleService {
  const { configuration, repository, clock } = options;
  return new CapabilityLifecycleService({
    store: repository.capabilityStore(configuration.ownerId, configuration.agentId),
    clock,
    ...(options.reactivation ? { reactivation: options.reactivation } : {}),
    artifacts: {
      verify: async (manifest) => ({
        verificationVersion: "capability-artifact-verification.v1",
        artifactDigest: manifest.integrity,
        signatureStatus: manifest.artifact.signatureStatus,
        signerRef: manifest.artifact.signerRef,
        verified: false,
        reasonCodes: [VERSION_CHECKS_UNAVAILABLE],
        verifiedAt: clock.now(),
      }),
    },
    runtime: {
      qualify: async (manifest) => {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          "Capability runtime qualification is not available on this gateway",
          { capabilityRef: manifest.ref, reasons: VERSION_CHECKS_UNAVAILABLE },
        );
      },
    },
  });
}
