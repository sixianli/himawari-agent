import { createHash } from "node:crypto";
import type { ProductConfiguration } from "@himawari-agent/application";

/** The same identity is used for file and generic tool disclosure approvals. */
export function configuredModelDisclosureIdentity(
  model: ProductConfiguration["modelDescriptors"][number],
): string {
  return `model:${model.provider}:${model.model}:${createHash("sha256").update(JSON.stringify(model)).digest("hex")}`;
}

/**
 * Disclosure and routing identity for the automatic reviewer. It binds the
 * configured model plus the frozen review configuration version, so a model or
 * configuration change invalidates earlier delegations instead of silently
 * reusing them.
 */
export function configuredReviewDisclosureIdentity(
  model: ProductConfiguration["modelDescriptors"][number],
  configurationVersion: string,
): string {
  return `automatic-review:${configuredModelDisclosureIdentity(model)}:${createHash("sha256")
    .update(configurationVersion)
    .digest("hex")}`;
}
