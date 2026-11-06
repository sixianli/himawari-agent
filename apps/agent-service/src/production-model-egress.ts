import { createHmac } from "node:crypto";
import {
  type ProductConfiguration,
  SensitiveInterceptionRecorder,
  type SensitiveInterceptionRunInput,
  type SensitiveInterceptionScope,
  type SensitiveInterceptionStorePort,
} from "@himawari-agent/application";
import { ModelEgress } from "@himawari-agent/application/runtime-port";
import {
  type HostSecretMaterialSource,
  stableErrorCode,
  writeServiceDiagnostic,
} from "@himawari-agent/platform-node";

const PLACEHOLDER_KEY_LABEL = "himawari.model-egress.placeholder.v1";

const recorders = new WeakMap<object, SensitiveInterceptionRecorder>();

export function productionSensitiveInterceptionRecorder(repository: {
  sensitiveInterceptions(): SensitiveInterceptionStorePort;
}): SensitiveInterceptionRecorder {
  let recorder = recorders.get(repository);
  if (recorder === undefined) {
    recorder = new SensitiveInterceptionRecorder({
      store: repository.sensitiveInterceptions(),
      now: () => new Date().toISOString(),
      onWriteFailed: (error) =>
        writeServiceDiagnostic(process.stderr, {
          component: "agent-service",
          event: "sensitive-interception.record_failed",
          code: stableErrorCode(error),
        }),
      onDropped: (count) =>
        writeServiceDiagnostic(process.stderr, {
          component: "agent-service",
          event: "sensitive-interception.dropped",
          count,
        }),
    });
    recorders.set(repository, recorder);
  }
  return recorder;
}

export function productionEgressThreadOf(
  repository: { sensitiveInterceptions(): SensitiveInterceptionStorePort },
  scope: SensitiveInterceptionScope,
): (
  runId: SensitiveInterceptionRunInput["runId"],
) => ReturnType<SensitiveInterceptionStorePort["threadOfRun"]> {
  return (runId) =>
    repository.sensitiveInterceptions().threadOfRun({
      ownerId: scope.ownerId,
      agentId: scope.agentId,
      runId,
    });
}

export async function flushSensitiveInterceptions(repository: object): Promise<void> {
  await recorders.get(repository)?.flush();
}

export function createProductionModelEgress(
  configuration: ProductConfiguration,
  sources: { readonly keys: HostSecretMaterialSource },
  recorder?: SensitiveInterceptionRecorder,
): ModelEgress {
  const payloadKeys = configuration.secretReferences.filter(
    ({ purpose }) => purpose === "payload-encryption",
  );
  const payloadKey = payloadKeys[0];
  if (payloadKeys.length !== 1 || payloadKey === undefined)
    throw new Error("MODEL_EGRESS_KEY_REFERENCE_INVALID");
  let derived: Promise<Uint8Array> | undefined;
  return new ModelEgress({
    key: () => {
      derived ??= sources.keys
        .resolve(payloadKey.ref, payloadKey.version)
        .then(
          (material) =>
            new Uint8Array(createHmac("sha256", material).update(PLACEHOLDER_KEY_LABEL).digest()),
        );
      return derived;
    },
    sign: (key, message) => new Uint8Array(createHmac("sha256", key).update(message).digest()),
    ...(recorder === undefined ? {} : { report: recorder.reportEgress }),
  });
}
