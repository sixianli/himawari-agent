import { createHash } from "node:crypto";
import type { ProductConfiguration } from "@himawari-agent/application";

/** The same identity is used for file and generic tool disclosure approvals. */
export function configuredModelDisclosureIdentity(
  model: ProductConfiguration["modelDescriptors"][number],
): string {
  return `model:${model.provider}:${model.model}:${createHash("sha256").update(JSON.stringify(model)).digest("hex")}`;
}
