import type { ProductConfiguration } from "@himawari-agent/application";
import {
  type HostProviderSecretSource,
  VoiceAddresseeDecision,
} from "@himawari-agent/platform-node";
import { resolveConfiguredSecretRequirement } from "./production-model-composition.js";

export function productionVoiceAddressee(
  configuration: ProductConfiguration,
  secretSource: HostProviderSecretSource,
  options: { readonly fetch?: typeof globalThis.fetch; readonly baseUrl?: string } = {},
): VoiceAddresseeDecision | undefined {
  const route = configuration.runPolicy?.voiceAddressee;
  if (!route) return undefined;
  const secret = resolveConfiguredSecretRequirement(configuration, route.secretRef);
  if (!secret) throw new Error("VOICE_ADDRESSEE_SECRET_REQUIRED");
  if (!secretSource.productionSuitable) throw new TypeError("VOICE_ADDRESSEE_UNSAFE_SECRET_SOURCE");
  let apiKey: Promise<string> | undefined;
  return new VoiceAddresseeDecision({
    model: route.model,
    inputMicrosPerMillionTokens: route.inputMicrosPerMillionTokens,
    apiKey: () => {
      apiKey ??= secretSource.resolve(secret.secretRef, secret.secretVersion).then(
        (value) => {
          if (value.trim().length === 0) throw new Error("VOICE_ADDRESSEE_SECRET_EMPTY");
          return value;
        },
        (error: unknown) => {
          apiKey = undefined;
          throw error;
        },
      );
      return apiKey;
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  });
}
