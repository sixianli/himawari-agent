import type {
  AuditLedgerPort,
  AuthorityFence,
  ClockPort,
  PayloadProtectorPort,
  PayloadStorePort,
  ProductConfiguration,
  RunExecutionSource,
  ThreadRepositoryPort,
} from "@himawari-agent/application";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { type HostProviderSecretSource, OwnerIntentDecision } from "@himawari-agent/platform-node";
import { OwnerIntentGate } from "./owner-intent-gate.js";
import { deterministicallySensitive } from "./production-memory-classification.js";
import { resolveConfiguredSecretRequirement } from "./production-model-composition.js";

const RECENT_OWNER_MESSAGES = 6;
const MAXIMUM_WORDS_CHARACTERS = 2000;
const WINDOW_MESSAGES = 30;

export interface ProductionOwnerIntentOptions {
  readonly configuration: ProductConfiguration;
  readonly secretSource: HostProviderSecretSource;
  readonly state: Pick<SqliteProductStateRepository, "readScopedState" | "commitStateAndEvents">;
  readonly audit: AuditLedgerPort;
  readonly authority: () => AuthorityFence;
  readonly clock: ClockPort;
  readonly threads: Pick<ThreadRepositoryPort, "listMessages" | "readCommittedMessagesByIds">;
  readonly payloads: Pick<PayloadStorePort, "get">;
  readonly protector: PayloadProtectorPort;
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
}

export interface OwnerWordsDependencies {
  readonly ownerId: ProductConfiguration["ownerId"];
  readonly agentId: ProductConfiguration["agentId"];
  readonly threads: Pick<ThreadRepositoryPort, "listMessages" | "readCommittedMessagesByIds">;
  readonly readText: (ref: string) => Promise<string | undefined>;
}

const sendable = (classification: string) =>
  classification === "public" || classification === "private";

export async function collectOwnerWords(
  dependencies: OwnerWordsDependencies,
  source: RunExecutionSource,
): Promise<readonly string[]> {
  const { ownerId, agentId, threads, readText } = dependencies;
  if (source.sourceType !== "user_message" || !source.threadId) return [];
  const [current] = await threads.readCommittedMessagesByIds({
    ownerId,
    agentId,
    threadId: source.threadId,
    messageIds: [source.sourceId as never],
  });
  if (!current || current.role !== "owner" || current.contentRef !== source.payloadRef) return [];
  const window = await threads.listMessages(
    ownerId,
    agentId,
    source.threadId,
    Math.max(0, current.sequence - WINDOW_MESSAGES),
    WINDOW_MESSAGES + 1,
  );
  const messages = window
    .filter(
      (message) =>
        message.role === "owner" &&
        message.status === "committed" &&
        message.sequence <= current.sequence &&
        sendable(message.dataClassification),
    )
    .toSorted((left, right) => left.sequence - right.sequence)
    .slice(-RECENT_OWNER_MESSAGES);
  const words: string[] = [];
  for (const message of messages) {
    const text = (await readText(message.contentRef).catch(() => undefined))?.trim();
    if (!text || deterministicallySensitive(text)) continue;
    words.push(text.slice(0, MAXIMUM_WORDS_CHARACTERS));
  }
  return words;
}

export function productionOwnerIntentGate(
  options: ProductionOwnerIntentOptions,
): OwnerIntentGate | undefined {
  const { configuration } = options;
  const settings = configuration.runPolicy?.ownerIntentCheck;
  if (!settings?.enabled) return undefined;
  const secret = resolveConfiguredSecretRequirement(configuration, settings.secretRef);
  if (!secret) throw new Error("OWNER_INTENT_SECRET_REQUIRED");
  if (!options.secretSource.productionSuitable)
    throw new TypeError("OWNER_INTENT_UNSAFE_SECRET_SOURCE");
  let apiKey: Promise<string> | undefined;
  const { ownerId, agentId } = configuration;
  const ownerWords = (source: RunExecutionSource) =>
    collectOwnerWords(
      {
        ownerId,
        agentId,
        threads: options.threads,
        readText: async (ref) => {
          const payload = await options.payloads.get(ref);
          if (!payload || payload.contentType !== "text/plain") return undefined;
          return new TextDecoder("utf-8", { fatal: true }).decode(
            await options.protector.unprotect({ ownerId, agentId, payload }),
          );
        },
      },
      source,
    );
  return new OwnerIntentGate({
    configuration,
    settings,
    check: new OwnerIntentDecision({
      model: settings.model,
      apiKey: () => {
        apiKey ??= options.secretSource.resolve(secret.secretRef, secret.secretVersion).then(
          (value) => {
            if (value.trim().length === 0) throw new Error("OWNER_INTENT_SECRET_EMPTY");
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
    }),
    ownerWords,
    state: options.state,
    audit: options.audit,
    authority: options.authority,
    clock: options.clock,
  });
}
