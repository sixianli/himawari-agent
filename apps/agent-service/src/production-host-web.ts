import {
  type RunPolicyConfiguration,
  type WebProviderId,
  webProviderEgress,
} from "@himawari-agent/application";
import {
  createPublicWebDispatcher,
  type WebProviderDispatcher,
  type WebProviderSecrets,
} from "@himawari-agent/platform-node";
import { isPublicEgressAddress } from "@himawari-agent/runtime-sandbox/public-address";
import type { WebProviderSecretBinding } from "./production-file-read-workflow.js";
import {
  runWebFetch,
  runWebSearch,
  type WebToolOutcome,
  webProviderFactory,
} from "./web-tool-run.js";

export interface ProductionHostWebInput {
  readonly tool: "web_search" | "web_fetch";
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly providers: readonly WebProviderId[];
  readonly secrets: readonly WebProviderSecretBinding[];
  readonly maximumBytes: number;
  readonly signal?: AbortSignal;
}

export interface ProductionHostWeb {
  execute(input: ProductionHostWebInput): Promise<WebToolOutcome>;
}

export interface WebProviderSecretReader {
  resolve(secretRef: string, secretVersion: string): Promise<string>;
}

async function resolveSecrets(
  reader: WebProviderSecretReader,
  bindings: readonly WebProviderSecretBinding[],
): Promise<WebProviderSecrets> {
  const deepseek = bindings.find(({ provider }) => provider === "deepseek");
  if (!deepseek) return {};
  try {
    return { deepseek: await reader.resolve(deepseek.secretRef, deepseek.secretVersion) };
  } catch {
    return {};
  }
}

export function createProductionHostWeb(options: {
  readonly secrets: WebProviderSecretReader;
  readonly dispatcher: WebProviderDispatcher;
}): ProductionHostWeb {
  return {
    async execute(input) {
      const secrets = await resolveSecrets(options.secrets, input.secrets);
      const common = {
        providers: input.providers,
        create: webProviderFactory(secrets, options.dispatcher),
        ...(input.signal ? { signal: input.signal } : {}),
      };
      return input.tool === "web_search"
        ? runWebSearch({
            ...common,
            query: String(input.arguments["query"]),
            limit: (input.arguments["limit"] as number | undefined) ?? 5,
          })
        : runWebFetch({
            ...common,
            url: String(input.arguments["url"]),
            offset: (input.arguments["offset"] as number | undefined) ?? 0,
            maximumBytes: input.maximumBytes,
          });
    },
  };
}

export function createConfiguredHostWeb(input: {
  readonly runPolicy: RunPolicyConfiguration | undefined;
  readonly secrets: WebProviderSecretReader;
}): ProductionHostWeb | undefined {
  const routes = [input.runPolicy?.publicSearch, input.runPolicy?.publicFetch].filter(
    (route) => route !== undefined,
  );
  if (!routes.length) return undefined;
  return createProductionHostWeb({
    secrets: input.secrets,
    dispatcher: createPublicWebDispatcher({
      allowedTargets: [...new Set(routes.flatMap((route) => webProviderEgress(route.providers)))],
      isPublicAddress: isPublicEgressAddress,
    }),
  });
}
