import type {
  OwnerPreferencesStorePort,
  ProductConfiguration,
} from "@himawari-agent/application";
import type {
  DeviceChatModel,
  DeviceChatModelPort,
  DeviceChatModels,
} from "@himawari-agent/platform-node";

export interface DeviceChatCatalogEntry {
  readonly ref: string;
  readonly name: string;
  readonly provider: string;
  readonly thinkingLevels: readonly string[];
  readonly automatic?: boolean;
  readonly price?: { readonly input: number; readonly output: number };
  readonly priceTier?: "low" | "mid" | "high";
}

export function defaultThinkingLevel(levels: readonly string[]): string | undefined {
  return (
    ["medium", "low"].find((level) => levels.includes(level)) ??
    levels.find((level) => level !== "off") ??
    levels[0]
  );
}

export function deviceChatModels(input: {
  readonly catalog: readonly DeviceChatCatalogEntry[] | undefined;
  readonly configuration: Pick<ProductConfiguration, "modelDescriptors" | "ownerId" | "agentId">;
  readonly preferences: OwnerPreferencesStorePort;
}): DeviceChatModelPort | undefined {
  const { configuration } = input;
  const primary = configuration.modelDescriptors.find(({ role }) => role === "primary");
  if (!primary) return undefined;
  const options: DeviceChatModel[] = (input.catalog ?? [])
    .filter((entry) =>
      configuration.modelDescriptors.some(
        (descriptor) => descriptor.ref === entry.ref && descriptor.role !== "embedding",
      ),
    )
    .map((entry) => ({
      ref: entry.ref,
      name: entry.name,
      provider: entry.provider,
      thinkingLevels: [...entry.thinkingLevels],
      ...(entry.automatic ? { automatic: true } : {}),
      ...(entry.price ? { price: { input: entry.price.input, output: entry.price.output } } : {}),
      ...(entry.priceTier ? { priceTier: entry.priceTier } : {}),
    }));
  if (options.length === 0) return undefined;
  const list: DeviceChatModels = Object.freeze({
    defaultRef: options.some((option) => option.ref === primary.ref)
      ? primary.ref
      : (options[0] as DeviceChatModel).ref,
    options: Object.freeze(options),
  });
  return {
    list: () => list,
    ownerChoice: async (scope) => {
      if (scope.ownerId !== configuration.ownerId || scope.agentId !== configuration.agentId)
        return null;
      const saved = await input.preferences.read({
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
      });
      const model = list.options.find((option) => option.ref === saved.modelRef);
      if (!model) return null;
      const thinkingLevel =
        saved.thinkingLevel && model.thinkingLevels.includes(saved.thinkingLevel)
          ? saved.thinkingLevel
          : defaultThinkingLevel(model.thinkingLevels);
      return thinkingLevel ? { modelRef: model.ref, thinkingLevel } : null;
    },
  };
}
