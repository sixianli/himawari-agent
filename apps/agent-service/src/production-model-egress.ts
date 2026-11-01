import { createHmac } from "node:crypto";
import type { ProductConfiguration } from "@himawari-agent/application";
import { ModelEgress } from "@himawari-agent/application/runtime-port";
import type { HostSecretMaterialSource } from "@himawari-agent/platform-node";

const PLACEHOLDER_KEY_LABEL = "himawari.model-egress.placeholder.v1";

export function createProductionModelEgress(
  configuration: ProductConfiguration,
  sources: { readonly keys: HostSecretMaterialSource },
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
  });
}
