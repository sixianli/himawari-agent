import {
  applyDeliveryTimingOverrides,
  type DeliveryTimingConfiguration,
  DeliveryTimingJudge,
  type DeliveryTimingJudgement,
  type DeliveryTimingModel,
  ownerStateFacts,
  type PerceptionRecord,
  type PerceptionRecordType,
  type PerceptionScope,
  type PerceptionStorePort,
  type ProductConfiguration,
  type PushClass,
} from "@himawari-agent/application";
import {
  DeliveryTimingDecision,
  type HostProviderSecretSource,
} from "@himawari-agent/platform-node";
import { resolveConfiguredSecretRequirement } from "./production-model-composition.js";
import type { DeliveryTimingSource } from "./production-web-push.js";

export class DeliveryTimingHolder {
  readonly base: DeliveryTimingConfiguration;
  #current: DeliveryTimingConfiguration;

  constructor(base: DeliveryTimingConfiguration, overrides: Readonly<Record<string, number>>) {
    this.base = base;
    this.#current = applyDeliveryTimingOverrides(base, overrides);
  }

  readonly current = (): DeliveryTimingConfiguration => this.#current;

  readonly apply = (overrides: Readonly<Record<string, number>>): void => {
    this.#current = applyDeliveryTimingOverrides(this.base, overrides);
  };
}

const READ_LIMIT = 500;
const READ_PAGES = 20;

export function productionDeliveryTiming(
  configuration: ProductConfiguration,
  secretSource: HostProviderSecretSource,
  options: { readonly fetch?: typeof globalThis.fetch; readonly baseUrl?: string } = {},
): DeliveryTimingDecision | undefined {
  const route = configuration.runPolicy?.deliveryTiming;
  if (!route) return undefined;
  const secret = resolveConfiguredSecretRequirement(configuration, route.secretRef);
  if (!secret) throw new Error("DELIVERY_TIMING_SECRET_REQUIRED");
  if (!secretSource.productionSuitable) throw new TypeError("DELIVERY_TIMING_UNSAFE_SECRET_SOURCE");
  let apiKey: Promise<string> | undefined;
  return new DeliveryTimingDecision({
    model: route.model,
    inputMicrosPerMillionTokens: route.inputMicrosPerMillionTokens,
    apiKey: () => {
      apiKey ??= secretSource.resolve(secret.secretRef, secret.secretVersion).then(
        (value) => {
          if (value.trim().length === 0) throw new Error("DELIVERY_TIMING_SECRET_EMPTY");
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

export function createDeliveryTimingSource(options: {
  readonly model: DeliveryTimingModel;
  readonly configuration: () => DeliveryTimingConfiguration;
  readonly store: Pick<PerceptionStorePort, "listRecordsBetween">;
  readonly scope: PerceptionScope;
  readonly reserve: (micros: number) => Promise<boolean>;
  readonly now?: () => number;
}): DeliveryTimingSource {
  const judge = new DeliveryTimingJudge({
    model: options.model,
    configuration: options.configuration,
    reserve: options.reserve,
    now: options.now ?? (() => Date.now()),
  });
  return {
    configuration: options.configuration,
    async judge(pushClass: PushClass, nowMs: number): Promise<DeliveryTimingJudgement> {
      const configuration = options.configuration();
      const windows: readonly (readonly [PerceptionRecordType, number])[] = [
        ["speech.utterance", configuration.speechFreshSeconds],
        ["motion.activity", configuration.motionFreshSeconds],
        ["health.sample", configuration.sleepFreshSeconds],
        ["context.focus", configuration.focusFreshSeconds],
        ["context.connectivity", configuration.connectivityFreshSeconds],
      ];
      const read = await Promise.all(
        windows.map(async ([type, seconds]) => {
          const collected: PerceptionRecord[] = [];
          let after: { readonly atMs: number; readonly id: string } | null = null;
          for (let page = 0; page < READ_PAGES; page += 1) {
            const { records } = await options.store.listRecordsBetween({
              ...options.scope,
              fromMs: Math.max(0, nowMs - seconds * 1000),
              toMs: nowMs,
              types: [type],
              after,
              limit: READ_LIMIT,
            });
            collected.push(...records);
            const last = records[records.length - 1];
            if (records.length < READ_LIMIT || !last) return collected;
            after = { atMs: last.occurredAtMs, id: last.id };
          }
          throw new Error("DELIVERY_TIMING_WINDOW_TOO_LARGE");
        }),
      );
      const records: readonly PerceptionRecord[] = read.flat();
      return judge.decide({ pushClass, facts: ownerStateFacts(records, nowMs, configuration) });
    },
  };
}
