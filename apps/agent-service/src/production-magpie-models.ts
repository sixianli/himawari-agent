import type {
  ConfiguredCompletionsGenerationModelDescriptor,
  ConfiguredModelDescriptor,
  ProductConfiguration,
} from "@himawari-agent/application";
import { modelRefString } from "@himawari-agent/gateway-contracts";
import { resolveConfiguredSecretRequirement } from "./production-model-composition.js";

export type PriceTier = "low" | "mid" | "high";

export interface ModelListPrice {
  readonly input: number;
  readonly output: number;
}

export interface MagpieModelEntry {
  readonly id: string;
  readonly label: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoningLevels: readonly string[];
  readonly acceptsImages: boolean;
  readonly toolCall: boolean;
  readonly acceptsText: boolean;
  readonly price?: ModelListPrice & { readonly cacheRead: number; readonly cacheWrite: number };
}

export interface MagpieModelExpansion {
  readonly configuration: ProductConfiguration;
  readonly prices: ReadonlyMap<string, ModelListPrice>;
  readonly automaticRefs: ReadonlySet<string>;
}

export interface MagpieModelDiscoveryOptions {
  readonly resolveSecret: (secretRef: string, secretVersion: string) => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly onDiagnostic?: (event: Record<string, string | number>) => void;
}

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const DEFAULT_TIMEOUT_MS = 5000;

const sendableRef = (id: string): boolean => {
  try {
    modelRefString.parse(`magpie:${id}`);
    return true;
  } catch {
    return false;
  }
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

const perMillion = (value: unknown): number | undefined => {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : undefined;
};

export function parseMagpieModelList(body: unknown): readonly MagpieModelEntry[] {
  const data = record(body)?.["data"];
  if (!Array.isArray(data)) return [];
  const entries: MagpieModelEntry[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    const entry = record(item);
    const id = entry?.["id"];
    const contextWindow = positiveInteger(entry?.["context_window"]);
    const maxOutputTokens = positiveInteger(entry?.["max_output_tokens"]);
    if (!entry || typeof id !== "string" || !contextWindow || !maxOutputTokens || seen.has(id))
      continue;
    seen.add(id);
    const input = record(entry["modalities"])?.["input"];
    const inputs = Array.isArray(input) ? input : [];
    const levels = Array.isArray(entry["reasoning_levels"]) ? entry["reasoning_levels"] : [];
    const pricing = record(entry["pricing"]);
    const prompt = perMillion(pricing?.["prompt"]);
    const completion = perMillion(pricing?.["completion"]);
    const label = entry["magpie_label"] ?? entry["display_name"];
    entries.push({
      id,
      label: typeof label === "string" && label.trim().length > 0 ? label.trim() : id,
      contextWindow,
      maxOutputTokens,
      reasoningLevels:
        entry["reasoning"] === true
          ? THINKING_LEVELS.filter((level) => levels.includes(level))
          : [],
      acceptsImages: inputs.includes("image"),
      acceptsText: inputs.includes("text"),
      toolCall: entry["tool_call"] === true,
      ...(prompt === undefined || completion === undefined
        ? {}
        : {
            price: {
              input: prompt,
              output: completion,
              cacheRead: perMillion(pricing?.["input_cache_read"]) ?? 0,
              cacheWrite: perMillion(pricing?.["input_cache_write"]) ?? 0,
            },
          }),
    });
  }
  return entries;
}

const inputsOf = (entry: MagpieModelEntry): readonly ("text" | "image")[] =>
  Object.freeze(entry.acceptsImages ? ["text", "image"] : ["text"]);

function descriptorFor(
  primary: ConfiguredCompletionsGenerationModelDescriptor,
  entry: MagpieModelEntry,
  index: number,
): ConfiguredCompletionsGenerationModelDescriptor {
  const reasoning = entry.reasoningLevels.length > 0;
  return Object.freeze({
    ...primary,
    ref: `magpie:${entry.id}`,
    model: entry.id,
    name: entry.label,
    priority: primary.priority + 1 + index,
    reasoning,
    ...(reasoning ? { thinkingLevels: Object.freeze([...entry.reasoningLevels]) } : {}),
    input: inputsOf(entry),
    contextWindow: entry.contextWindow,
    maxTokens: Math.min(entry.maxOutputTokens, primary.maxTokens),
    cost: Object.freeze(
      entry.price
        ? {
            input: entry.price.input,
            output: entry.price.output,
            cacheRead: entry.price.cacheRead,
            cacheWrite: entry.price.cacheWrite,
          }
        : { ...primary.cost },
    ),
  });
}

export function priceTiers(
  prices: ReadonlyMap<string, ModelListPrice>,
): ReadonlyMap<string, PriceTier> {
  const totals = [...prices.values()]
    .map(({ input, output }) => input + output)
    .sort((a, b) => a - b);
  if (new Set(totals).size < 3) return new Map();
  const lowCut = totals[Math.ceil(totals.length / 3) - 1] ?? 0;
  const highCut = totals[Math.ceil((totals.length * 2) / 3) - 1] ?? 0;
  return new Map(
    [...prices].map(([ref, { input, output }]) => {
      const total = input + output;
      return [ref, total <= lowCut ? "low" : total > highCut ? "high" : "mid"] as const;
    }),
  );
}

export async function expandConfigurationWithMagpieModels(
  configuration: ProductConfiguration,
  options: MagpieModelDiscoveryOptions,
): Promise<MagpieModelExpansion> {
  const unchanged: MagpieModelExpansion = {
    configuration,
    prices: new Map(),
    automaticRefs: new Set(),
  };
  const primary = configuration.modelDescriptors.find(
    (descriptor): descriptor is ConfiguredCompletionsGenerationModelDescriptor =>
      descriptor.role === "primary" && descriptor.api === "openai-completions",
  );
  if (!primary || primary.provider !== "magpie" || primary.baseUrl === undefined) return unchanged;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let entries: readonly MagpieModelEntry[];
  try {
    const secret = resolveConfiguredSecretRequirement(configuration, primary.secretRef);
    if (secret === null) return unchanged;
    const deadline = AbortSignal.timeout(timeoutMs);
    const timedOut = new Promise<never>((_, reject) => {
      deadline.addEventListener("abort", () => reject(new Error("MAGPIE_MODEL_LIST_TIMEOUT")), {
        once: true,
      });
    });
    entries = await Promise.race([
      (async () => {
        const key = (await options.resolveSecret(secret.secretRef, secret.secretVersion)).trim();
        if (key === "") throw new Error("MAGPIE_MODEL_LIST_EMPTY_KEY");
        const response = await (options.fetch ?? fetch)(
          `${primary.baseUrl?.replace(/\/$/u, "")}/models`,
          { headers: { authorization: `Bearer ${key}` }, signal: deadline, redirect: "error" },
        );
        if (!response.ok) throw new Error(`MAGPIE_MODEL_LIST_HTTP_${response.status}`);
        const parsed = parseMagpieModelList(await response.json());
        if (parsed.length === 0) throw new Error("MAGPIE_MODEL_LIST_EMPTY");
        return parsed;
      })(),
      timedOut,
    ]);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    options.onDiagnostic?.({
      event: "magpie-models.discovery_failed",
      code: /^[A-Z0-9_]{1,80}$/u.test(code) ? code : "unknown",
    });
    return unchanged;
  }
  const own = entries.find(({ id }) => id === primary.model);
  if (!own) {
    options.onDiagnostic?.({
      event: "magpie-models.primary_missing_from_list",
      model: /^[\w./-]{1,80}$/u.test(primary.model) ? primary.model : "unknown",
    });
  }
  const known = new Set(
    configuration.modelDescriptors.flatMap((descriptor) =>
      descriptor.role === "primary" ? [descriptor.model] : [],
    ),
  );
  const unsendable = entries.filter(({ id }) => !sendableRef(id));
  if (unsendable.length > 0)
    options.onDiagnostic?.({
      event: "magpie-models.ref_rejected_by_contract",
      count: unsendable.length,
      sample: (unsendable[0]?.id ?? "").replace(/[^\w./:-]/gu, "?").slice(0, 80),
    });
  const added = entries
    .filter(
      (entry) =>
        sendableRef(entry.id) &&
        !entry.id.startsWith("auto/") &&
        !entry.id.startsWith("group/") &&
        !known.has(entry.id) &&
        entry.toolCall &&
        entry.acceptsText,
    )
    .map((entry, index) => descriptorFor(primary, entry, index));
  const adjusted: ConfiguredModelDescriptor[] = configuration.modelDescriptors.map((descriptor) =>
    descriptor === primary && own
      ? Object.freeze({
          ...primary,
          input: inputsOf(own),
          ...(own.reasoningLevels.length > 0
            ? { reasoning: true, thinkingLevels: Object.freeze([...own.reasoningLevels]) }
            : {}),
        })
      : descriptor,
  );
  const prices = new Map<string, ModelListPrice>();
  for (const entry of entries)
    if (entry.price && added.some(({ model }) => model === entry.id))
      prices.set(`magpie:${entry.id}`, { input: entry.price.input, output: entry.price.output });
  options.onDiagnostic?.({
    event: "magpie-models.discovered",
    listed: entries.length,
    added: added.length,
  });
  return {
    configuration: Object.freeze({
      ...configuration,
      modelDescriptors: Object.freeze([...adjusted, ...added]),
    }),
    prices,
    automaticRefs: new Set(
      configuration.modelDescriptors.flatMap((descriptor) =>
        descriptor.role === "primary" && descriptor.model.startsWith("group/")
          ? [descriptor.ref]
          : [],
      ),
    ),
  };
}
