import {
  type PayloadProtectorPort,
  type PayloadStorePort,
  type ProductConfiguration,
  THINK_LOOP_DEFAULTS,
  type ThinkWorthConfiguration,
  type ThreadCommandService,
  type ThreadRepositoryPort,
} from "@himawari-agent/application";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { type HostProviderSecretSource, ThinkWorthDecision } from "@himawari-agent/platform-node";
import { resolveConfiguredSecretRequirement } from "./production-model-composition.js";
import type { ProductionProposalBox } from "./production-proposals.js";
import type { ReminderProposalContext } from "./production-reminder-proposals.js";
import { thinkActions } from "./production-think-actions.js";
import { ProductionThinkInbox } from "./production-think-inbox.js";
import { ThreadThinkRunner } from "./production-think-runner.js";
import { ProductionThinkWorker } from "./production-think-worker.js";

export interface ThinkWorthRoute {
  readonly settings: ThinkWorthConfiguration;
  readonly port: ThinkWorthDecision;
}

export function productionThinkWorth(
  configuration: ProductConfiguration,
  secretSource: HostProviderSecretSource,
  options: { readonly fetch?: typeof globalThis.fetch; readonly baseUrl?: string } = {},
): ThinkWorthRoute | undefined {
  const settings = configuration.runPolicy?.thinkInbox?.worth;
  if (!settings) return undefined;
  const secret = resolveConfiguredSecretRequirement(configuration, settings.secretRef);
  if (!secret) throw new Error("THINK_WORTH_SECRET_REQUIRED");
  if (!secretSource.productionSuitable) throw new TypeError("THINK_WORTH_UNSAFE_SECRET_SOURCE");
  let apiKey: Promise<string> | undefined;
  return {
    settings,
    port: new ThinkWorthDecision({
      model: settings.model,
      apiKey: () => {
        apiKey ??= secretSource.resolve(secret.secretRef, secret.secretVersion).then(
          (value) => {
            if (value.trim().length === 0) throw new Error("THINK_WORTH_SECRET_EMPTY");
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
  };
}

export class ThinkLoop {
  readonly #worker: Pick<ProductionThinkWorker, "runOnce">;
  readonly #intervalMs: number;
  readonly #onFailure: (error: unknown) => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #controller: AbortController | undefined;
  #running: Promise<void> | undefined;

  constructor(options: {
    readonly worker: Pick<ProductionThinkWorker, "runOnce">;
    readonly intervalMs: number;
    readonly onFailure: (error: unknown) => void;
  }) {
    this.#worker = options.worker;
    this.#intervalMs = options.intervalMs;
    this.#onFailure = options.onFailure;
  }

  start(): void {
    if (this.#controller) return;
    this.#controller = new AbortController();
    this.#schedule(0);
  }

  #schedule(delay: number): void {
    const controller = this.#controller;
    if (!controller || controller.signal.aborted) return;
    this.#timer = setTimeout(() => {
      this.#running = this.#tick(controller.signal);
    }, delay);
    this.#timer.unref?.();
  }

  async #tick(signal: AbortSignal): Promise<void> {
    let busy = false;
    try {
      const step = await this.#worker.runOnce(signal);
      busy = step.status === "done";
    } catch (error) {
      this.#onFailure(error);
    }
    this.#schedule(busy ? 0 : this.#intervalMs);
  }

  async stop(): Promise<void> {
    this.#controller?.abort();
    this.#controller = undefined;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running?.catch(() => undefined);
  }
}

export function productionThinkLoop(options: {
  readonly configuration: ProductConfiguration;
  readonly repository: Pick<SqliteProductStateRepository, "thinkInbox">;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: () => string;
  readonly commands: Pick<ThreadCommandService, "create" | "admitOwnerMessage" | "setLifecycle">;
  readonly threads: Pick<ThreadRepositoryPort, "readDetailSnapshot">;
  readonly box: Pick<ProductionProposalBox, "propose">;
  readonly writer?: ReminderProposalContext["writer"];
  readonly worth: ThinkWorthRoute;
  readonly onDiagnostic?: (event: Record<string, string>) => void;
}) {
  const { configuration, payloads, protector } = options;
  const settings = configuration.runPolicy?.thinkInbox ?? {};
  const timeZone = configuration.runPolicy?.timeZone ?? "UTC";
  const clock = { now: options.clock };
  const scope = {
    ownerId: configuration.ownerId,
    agentId: configuration.agentId,
  } as ConstructorParameters<typeof ProductionThinkInbox>[0]["scope"];
  const store = options.repository.thinkInbox();
  const { worth: _worth, idleSeconds, runTimeoutMinutes, ...limits } = settings;
  const inbox = new ProductionThinkInbox({
    scope,
    store,
    payloads,
    protector,
    clock,
    timeZone,
    limits,
  });
  const diagnostic = options.onDiagnostic ?? (() => undefined);
  const runner = new ThreadThinkRunner({
    configuration,
    commands: options.commands,
    threads: options.threads,
    payloads,
    protector,
    clock,
    actions: thinkActions({
      box: options.box,
      ...(options.writer ? { writer: options.writer } : {}),
      timeZone,
    }),
    describeSource: (kind) => inbox.sources.get(kind)?.describe,
  });
  const worker = new ProductionThinkWorker({
    scope,
    inbox,
    store,
    payloads,
    protector,
    clock,
    worth: {
      port: options.worth.port,
      yesAtLeastPermille: options.worth.settings.yesAtLeastPermille,
      noAtMostPermille: options.worth.settings.noAtMostPermille,
      requestTimeoutMs: options.worth.settings.requestTimeoutMs,
    },
    runner,
    runTimeoutMs: (runTimeoutMinutes ?? THINK_LOOP_DEFAULTS.runTimeoutMinutes) * 60_000,
    onFailure: (entryId, error) =>
      diagnostic({
        event: "think.failed",
        entryId,
        error: error instanceof Error ? error.name : "unknown",
      }),
  });
  const loop = new ThinkLoop({
    worker,
    intervalMs: (idleSeconds ?? THINK_LOOP_DEFAULTS.idleSeconds) * 1000,
    onFailure: (error) =>
      diagnostic({
        event: "think.loop_failed",
        error: error instanceof Error ? error.name : "unknown",
      }),
  });
  return { inbox, worker, loop };
}
