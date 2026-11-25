import {
  type ClockPort,
  type PayloadProtectorPort,
  type PayloadStorePort,
  type RuntimeRequest,
  ThreadCommandService,
  type ThreadRepositoryPort,
  type ThreadUpdateInput,
} from "@himawari-agent/application";
import { THREAD_TITLE, TRUSTED_PROMPT_TEXTS } from "@himawari-agent/prompt-catalog";
import {
  type EgressPlaceholderKind,
  placeholderTable,
  restorePlaceholders,
} from "@himawari-agent/sensitive-capture";

export class ProductionThreadTitles {
  readonly #pending = new Map<string, { work: Promise<void>; admitted: Promise<void> }>();
  #stopping = false;
  private readonly options: {
    threads: ThreadRepositoryPort;
    payloads: PayloadStorePort;
    protector: PayloadProtectorPort;
    clock: ClockPort;
    authority: () => ThreadUpdateInput["authority"];
    assertActive: () => Promise<void>;
    externalTag: () => Promise<(kind: EgressPlaceholderKind, value: string) => string>;
    generate: (request: RuntimeRequest, prompt: string, onAdmitted: () => void) => Promise<string>;
    onFailure: (error: unknown) => void;
  };
  constructor(options: ProductionThreadTitles["options"]) {
    this.options = options;
  }

  start(request: RuntimeRequest): Promise<void> {
    if (!request.threadId || this.#stopping) return Promise.resolve();
    const id = request.threadId;
    const pending = this.#pending.get(id);
    if (pending) return pending.admitted;
    let onAdmitted = () => {};
    const admitted = new Promise<void>((resolve) => {
      onAdmitted = resolve;
    });
    const work = this.#generate(request, onAdmitted)
      .catch(this.options.onFailure)
      .finally(() => {
        onAdmitted();
        this.#pending.delete(id);
      });
    this.#pending.set(id, { work, admitted });
    return admitted;
  }
  async stop(): Promise<void> {
    this.#stopping = true;
    await Promise.allSettled([...this.#pending.values()].map(({ work }) => work));
  }
  async #generate(request: RuntimeRequest, onAdmitted: () => void): Promise<void> {
    const { threadId, ownerId, agentId } = request;
    if (!threadId) return;
    const thread = await this.options.threads.read(ownerId, agentId, threadId);
    if (
      !thread ||
      thread.origin === "think" ||
      thread.status !== "active" ||
      thread.titleRef ||
      thread.titleSource === "owner" ||
      (await this.options.threads.readMain(ownerId, agentId)) === threadId
    )
      return;
    const messages = await this.options.threads.listMessages(ownerId, agentId, threadId, 0, 20);
    const first = messages.find(
      (message) => message.role === "owner" && message.status === "committed",
    );
    if (!first) return;
    const source = await this.options.payloads.get(first.contentRef);
    if (
      !source ||
      source.contentType !== "text/plain" ||
      source.dataClassification !== first.dataClassification
    )
      return;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      await this.options.protector.unprotect({ ownerId, agentId, payload: source }),
    );
    if (!text.trim()) return;
    await this.options.assertActive();
    const prompt = `${THREAD_TITLE.text}\n${JSON.stringify({ userMessage: text.slice(0, 4096) })}`;
    let title: string;
    try {
      const generated = await this.options.generate(
        { ...request, dataClassification: first.dataClassification },
        prompt,
        onAdmitted,
      );
      const tag = await this.options.externalTag();
      const restored = restorePlaceholders(
        generated,
        placeholderTable(prompt, tag, { trusted: TRUSTED_PROMPT_TEXTS, jsonEmbedded: true }),
      );
      title = restored
        .trim()
        .replace(/^["“「]|["”」]$/gu, "")
        .trim();
      if (!title || title.length > 120 || /[\r\n]/u.test(title))
        throw new Error("THREAD_TITLE_RESPONSE_INVALID");
    } catch (error) {
      this.options.onFailure(error);
      title = openingWords(text);
    }
    await this.options.assertActive();
    const current = await this.options.threads.read(ownerId, agentId, threadId);
    if (
      !current ||
      current.status !== "active" ||
      current.titleRef ||
      current.titleSource === "owner"
    )
      return;
    const ref = `thread-title:${request.runId}`;
    await this.options.payloads.put(
      await this.options.protector.protect({
        ownerId,
        agentId,
        ref,
        contentType: "text/plain",
        dataClassification: first.dataClassification,
        plaintext: new TextEncoder().encode(title),
        createdAt: this.options.clock.now(),
      }),
    );
    const commands = new ThreadCommandService({
      repository: this.options.threads,
      clock: this.options.clock,
      authority: this.options.authority,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = await this.options.threads.read(ownerId, agentId, threadId);
      if (
        !latest ||
        latest.status !== "active" ||
        latest.titleRef ||
        latest.titleSource === "owner"
      )
        return;
      try {
        await commands.rename({
          ownerId,
          agentId,
          threadId,
          expectedRevision: latest.revision,
          titleRef: ref,
          source: "automatic",
          idempotencyKey: `automatic-title:${request.runId}`,
          resultRef: ref,
        });
        return;
      } catch (error) {
        const changed = await this.options.threads.read(ownerId, agentId, threadId);
        if (attempt === 2 || changed?.revision === latest.revision) throw error;
      }
    }
  }
}

const FALLBACK_TITLE_LENGTH = 24;

function openingWords(text: string): string {
  const characters = Array.from(text.trim().replace(/\s+/gu, " "));
  const opening = characters.slice(0, FALLBACK_TITLE_LENGTH).join("").trim();
  return characters.length > FALLBACK_TITLE_LENGTH ? `${opening}…` : opening;
}
