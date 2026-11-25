import type {
  ClockPort,
  PayloadProtectorPort,
  PayloadStorePort,
  ThreadCommandService,
  ThreadRepositoryPort,
} from "@himawari-agent/application";

type MainThreadInput = Parameters<ThreadRepositoryPort["claimMain"]>[0];
type ThreadId = MainThreadInput["threadId"];

const MAIN_THREAD_KEY = "main-thread";
const MAIN_THREAD_RECEIPT_REF = "main-thread:created";

export interface MainThreadOptions {
  readonly ownerId: MainThreadInput["ownerId"];
  readonly agentId: MainThreadInput["agentId"];
  readonly threads: Pick<ThreadRepositoryPort, "readMain" | "claimMain">;
  readonly commands: Pick<ThreadCommandService, "create">;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
}

export class ProductionMainThread {
  readonly #options: MainThreadOptions;
  #ensuring: Promise<ThreadId> | undefined;

  constructor(options: MainThreadOptions) {
    this.#options = options;
  }

  async read(): Promise<ThreadId | undefined> {
    return this.#options.threads.readMain(this.#options.ownerId, this.#options.agentId);
  }

  ensure(): Promise<ThreadId> {
    this.#ensuring ??= this.#ensure().finally(() => {
      this.#ensuring = undefined;
    });
    return this.#ensuring;
  }

  async #ensure(): Promise<ThreadId> {
    const { ownerId, agentId, threads, commands, payloads, protector, clock } = this.#options;
    const existing = await threads.readMain(ownerId, agentId);
    if (existing) return existing;
    const now = clock.now();
    if (!(await payloads.get(MAIN_THREAD_RECEIPT_REF as never)))
      await payloads.put(
        await protector.protect({
          ownerId,
          agentId,
          ref: MAIN_THREAD_RECEIPT_REF,
          contentType: "text/plain",
          dataClassification: "private",
          plaintext: new TextEncoder().encode(MAIN_THREAD_KEY),
          createdAt: now,
        }),
      );
    const created = await commands.create({
      ownerId,
      agentId,
      idempotencyKey: MAIN_THREAD_KEY,
      resultRef: MAIN_THREAD_RECEIPT_REF,
    });
    return threads.claimMain({ ownerId, agentId, threadId: created.thread.id, claimedAt: now });
  }
}
