import { createHmac } from "node:crypto";
import { ModelEgress, type ModelEgressOptions } from "@himawari-agent/application/runtime-port";

export function testModelEgress(
  seed = "test-egress-key",
  report?: ModelEgressOptions["report"],
): ModelEgress {
  const key = new TextEncoder().encode(seed);
  return new ModelEgress({
    key: async () => key,
    sign: (secret, message) =>
      new Uint8Array(createHmac("sha256", secret).update(message).digest()),
    ...(report === undefined ? {} : { report }),
  });
}
