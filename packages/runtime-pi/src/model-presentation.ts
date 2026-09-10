import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { PiModelBinding } from "./pi-runtime-adapter.js";
export function getPiModelPresentation(binding: PiModelBinding) {
  if (!binding.descriptor) throw new Error("MODEL_DESCRIPTOR_REQUIRED");
  return {
    ref: binding.descriptor.ref,
    model: binding.model.id,
    name: binding.model.name,
    provider: binding.model.provider,
    thinkingLevels: getSupportedThinkingLevels(binding.model),
  };
}
