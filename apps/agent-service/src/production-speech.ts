import type {
  ConfiguredCompletionsGenerationModelDescriptor,
  ProductConfiguration,
} from "@himawari-agent/application";
import { MagpieDashScopeSpeech, type SpeechSynthesisPort } from "@himawari-agent/platform-node";
import { resolveConfiguredSecretRequirement } from "./production-model-composition.js";

export function createProductionSpeech(
  configuration: ProductConfiguration,
  resolveSecret: (secretRef: string, secretVersion: string) => Promise<string>,
  fetchImplementation?: typeof fetch,
): SpeechSynthesisPort | undefined {
  const speech = configuration.speech;
  if (!speech) return undefined;
  const magpie = configuration.modelDescriptors.find(
    (descriptor): descriptor is ConfiguredCompletionsGenerationModelDescriptor =>
      descriptor.ref === speech.magpieModelRef &&
      descriptor.role === "primary" &&
      descriptor.provider === "magpie",
  );
  if (!magpie?.baseUrl) throw new Error("SPEECH_MAGPIE_MODEL_MISSING");
  const secret = resolveConfiguredSecretRequirement(configuration, magpie.secretRef);
  if (secret === null) throw new Error("SPEECH_MAGPIE_SECRET_MISSING");
  return new MagpieDashScopeSpeech({
    configuration: speech,
    magpieBaseUrl: magpie.baseUrl,
    gatewayKey: async () => (await resolveSecret(secret.secretRef, secret.secretVersion)).trim(),
    ...(fetchImplementation ? { fetch: fetchImplementation } : {}),
  });
}
