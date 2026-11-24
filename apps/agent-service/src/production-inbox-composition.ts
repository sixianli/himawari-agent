import {
  INBOX_LOOP_DEFAULTS,
  type PayloadProtectorPort,
  type PayloadStorePort,
  type ProductConfiguration,
} from "@himawari-agent/application";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { type InboxScope, ProductionInbox } from "./production-inbox.js";
import type { ProductionInboxSettings } from "./production-inbox-settings.js";
import { type InboxDelivery, InboxLoop, ProductionInboxWorker } from "./production-inbox-worker.js";

export function productionInbox(options: {
  readonly configuration: ProductConfiguration;
  readonly repository: Pick<SqliteProductStateRepository, "inbox">;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: () => string;
  readonly delivery?: InboxDelivery;
  readonly settings?: Pick<ProductionInboxSettings, "overrides">;
  readonly onDiagnostic?: (event: Record<string, string>) => void;
}) {
  const settings = options.settings;
  const overrides = settings ? () => settings.overrides() : undefined;
  const { configuration, payloads, protector } = options;
  const policy = configuration.runPolicy?.inbox ?? {};
  const clock = { now: options.clock };
  const scope = {
    ownerId: configuration.ownerId,
    agentId: configuration.agentId,
  } as InboxScope;
  const store = options.repository.inbox();
  const { idleSeconds, runTimeoutMinutes, eventsPerRun, ...limits } = policy;
  const inbox = new ProductionInbox({
    scope,
    store,
    payloads,
    protector,
    clock,
    limits,
    ...(overrides ? { overrides } : {}),
  });
  const diagnostic = options.onDiagnostic ?? (() => undefined);
  if (!options.delivery) return { inbox, worker: undefined, loop: undefined };
  const worker = new ProductionInboxWorker({
    scope,
    inbox,
    store,
    payloads,
    protector,
    clock,
    delivery: options.delivery,
    runTimeoutMs: (runTimeoutMinutes ?? INBOX_LOOP_DEFAULTS.runTimeoutMinutes) * 60_000,
    ...(eventsPerRun === undefined ? {} : { eventsPerRun }),
    ...(limits.maxAttempts === undefined ? {} : { maxAttempts: limits.maxAttempts }),
    ...(overrides ? { overrides } : {}),
    onFailure: (entryId, error) =>
      diagnostic({
        event: "inbox.failed",
        entryId,
        error: error instanceof Error ? error.name : "unknown",
      }),
  });
  const loop = new InboxLoop({
    worker,
    intervalMs: async () => {
      const value = (await overrides?.().catch(() => undefined))?.["idleSeconds"];
      return (value ?? idleSeconds ?? INBOX_LOOP_DEFAULTS.idleSeconds) * 1000;
    },
    onFailure: (error) =>
      diagnostic({
        event: "inbox.loop_failed",
        error: error instanceof Error ? error.name : "unknown",
      }),
  });
  inbox.onQueued(() => loop.wake());
  return { inbox, worker, loop };
}
