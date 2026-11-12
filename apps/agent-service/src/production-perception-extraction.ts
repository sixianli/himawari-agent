import { createHash } from "node:crypto";
import {
  type ClockPort,
  type DeviceConfiguration,
  type DurableMemoryService,
  type EgressPlaceholderTag,
  type MemoryBookStorePort,
  type PayloadProtectorPort,
  type PayloadRef,
  type PayloadStorePort,
  type PerceptionConfiguration,
  type PerceptionExtractionModel,
  type PerceptionExtractionReport,
  PerceptionExtractionService,
  type PerceptionProposalPort,
  type PerceptionScope,
  type PerceptionStorePort,
  type ProductMemoryStatePort,
} from "@himawari-agent/application";
import { localTimeText, type ProductionReminderWriter } from "./production-reminder-writer.js";

export const PERCEPTION_EXTRACT_SIZE_LIMIT_KEY = "perception.extract.max_chars";

export interface ProductionPerceptionExtractionOptions {
  readonly scope: PerceptionScope;
  readonly store: PerceptionStorePort;
  readonly model: PerceptionExtractionModel;
  readonly memory: Pick<DurableMemoryService, "applyProposal">;
  readonly memories: Pick<ProductMemoryStatePort, "read">;
  readonly book: Pick<MemoryBookStorePort, "latestGeneration">;
  readonly reminders: Pick<ProductionReminderWriter, "list">;
  readonly proposals?: PerceptionProposalPort;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly tag: () => Promise<EgressPlaceholderTag>;
  readonly configuration: () => PerceptionConfiguration;
  readonly deviceConfiguration: () => DeviceConfiguration;
  readonly timeZone: string;
  readonly clock: ClockPort;
  readonly onReport?: (report: PerceptionExtractionReport) => void;
  readonly onFailure?: (error: unknown) => void;
}

export function createPerceptionExtractionService(
  options: ProductionPerceptionExtractionOptions,
): PerceptionExtractionService {
  const { scope, payloads, protector } = options;
  const readText = async (contentRef: string) => {
    const payload = await payloads.get(contentRef as PayloadRef);
    if (!payload || payload.contentType !== "text/plain") return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await protector.unprotect({ ...scope, payload }),
    );
  };
  return new PerceptionExtractionService({
    scope,
    store: options.store,
    model: options.model,
    readText,
    tag: options.tag,
    memory: options.memory,
    memories: options.memories,
    generation: () => options.book.latestGeneration(scope),
    storeText: async ({ key, text, dataClassification, createdAt }) => {
      const ref = `memory-content:${key}` as PayloadRef;
      if (!(await payloads.get(ref)))
        await payloads.put(
          await protector.protect({
            ...scope,
            ref,
            contentType: "text/plain",
            dataClassification,
            plaintext: new TextEncoder().encode(text),
            createdAt,
          }),
        );
      return ref;
    },
    openTodos: async () =>
      (await options.reminders.list()).reminders.map((reminder) => ({
        id: reminder.reminderId,
        text: reminder.text,
        due: localTimeText(reminder.dueAt, options.timeZone),
      })),
    ...(options.proposals ? { proposals: options.proposals } : {}),
    configuration: options.configuration,
    maximumCharacters: () =>
      options.deviceConfiguration().limits[PERCEPTION_EXTRACT_SIZE_LIMIT_KEY],
    timeZone: () => options.timeZone,
    now: () => options.clock.now(),
    invocationId: (key) =>
      `perception-extract:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`,
  });
}

export class ProductionPerceptionExtraction {
  readonly #service: PerceptionExtractionService;
  readonly #options: ProductionPerceptionExtractionOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;

  constructor(options: ProductionPerceptionExtractionOptions) {
    this.#options = options;
    this.#service = createPerceptionExtractionService(options);
  }

  runOnce(): Promise<PerceptionExtractionReport> {
    return this.#service.runOnce();
  }

  #tick(): void {
    if (this.#running) return;
    this.#running = this.#service
      .runOnce()
      .then((report) => {
        if (report.episodes > 0) this.#options.onReport?.(report);
      })
      .catch((error: unknown) => {
        this.#options.onFailure?.(error);
      })
      .finally(() => {
        this.#running = undefined;
      });
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(
      () => this.#tick(),
      this.#options.configuration().extractIntervalSeconds * 1000,
    );
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }
}
