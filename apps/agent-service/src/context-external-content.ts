import { createHash } from "node:crypto";
import type {
  AuthorityFence,
  ClockPort,
  IdempotentAgentCommand,
  ProductConfiguration,
  ProductMemoryRecord,
  ProductMemoryStatePort,
  RunExecutionSource,
  RunExecutionSourcePort,
} from "@himawari-agent/application";
import { PORT_ERROR_CODES } from "@himawari-agent/application";

type RunId = RunExecutionSource["runId"];

import { EXTERNAL_CONTENT_SOURCE_REF_PREFIX } from "@himawari-agent/gateway-contracts";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const CONTEXT_EXTERNAL_CONTENT_KEY_PREFIX = "context-external-content:";
const WRITE_ATTEMPTS = 5;
const SOURCE_REF_LIMIT = 512;
const ORIGIN_IN_REF_LIMIT = 256;
export const RECALLED_EXTERNAL_RECORD_ORIGIN = "recalled_external_record";
export const RECALLED_EXTERNAL_CONVERSATION_ORIGIN = "recalled_external_conversation";

export class ExternalContentMarkNotWrittenError extends Error {
  constructor(cause: unknown) {
    super("EXTERNAL_CONTENT_MARK_NOT_WRITTEN", { cause });
    this.name = "ExternalContentMarkNotWrittenError";
  }
}

export function externalContentSourceRefs(
  recordId: string,
  origins: readonly string[],
): readonly string[] {
  return [
    ...new Set(
      origins.map((origin) =>
        origin.length <= ORIGIN_IN_REF_LIMIT
          ? origin
          : `${origin.slice(0, ORIGIN_IN_REF_LIMIT - 17)}~${digest(origin).slice(0, 16)}`,
      ),
    ),
  ]
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((origin) => {
      const room = SOURCE_REF_LIMIT - EXTERNAL_CONTENT_SOURCE_REF_PREFIX.length - 1 - origin.length;
      const record =
        recordId.length <= room
          ? recordId
          : `${recordId.slice(0, room - 17)}~${digest(recordId).slice(0, 16)}`;
      return `${EXTERNAL_CONTENT_SOURCE_REF_PREFIX}${record}|${origin}`;
    });
}

export function runExternalOrigins(content: Pick<ContextExternalContent, "read"> | undefined) {
  return async (runId: RunId): Promise<readonly string[]> => originsOf(await content?.read(runId));
}

export function threadExternalOrigins(
  content: Pick<ContextExternalContent, "readThread"> | undefined,
) {
  return async (threadId: string): Promise<readonly string[]> =>
    originsOf(await content?.readThread(threadId));
}

export function isConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === PORT_ERROR_CODES.CONFLICT
  );
}

export function originsOf(
  sources: readonly ExternalContentSource[] | undefined,
): readonly string[] {
  return [...new Set((sources ?? []).map(({ origin }) => origin))];
}

export const EXTERNAL_EVENT_ORIGIN_PREFIX = "external_event:";
export const INBOX_EVENT_MESSAGE_PREFIX = "message:inbox:";

export function inboxEventOrigin(sourceKind: string): string {
  return `${EXTERNAL_EVENT_ORIGIN_PREFIX}${sourceKind}`;
}

export function externalEventOrigin(
  source: Pick<RunExecutionSource, "sourceType" | "sourceId"> | undefined,
): string | null {
  if (source?.sourceType !== "external_event") return null;
  if (source.sourceId.startsWith(INBOX_EVENT_MESSAGE_PREFIX)) {
    const kind = source.sourceId.slice(INBOX_EVENT_MESSAGE_PREFIX.length).split(":", 1)[0];
    if (kind) return inboxEventOrigin(kind);
  }
  return `${EXTERNAL_EVENT_ORIGIN_PREFIX}${source.sourceId}`;
}

export function isExternalContentSourceRef(ref: string): boolean {
  return ref.startsWith(EXTERNAL_CONTENT_SOURCE_REF_PREFIX);
}

export function carriesExternalContent(sourceRefs: readonly string[]): boolean {
  return sourceRefs.some(isExternalContentSourceRef);
}

export interface ExternalContentSource {
  readonly origin: string;
  readonly firstRunId: string;
  readonly firstSeenAt: string;
}

export interface ExternalContentScope {
  readonly threadId: string | null;
  readonly runId: string;
}

export function externalContentKey(scope: ExternalContentScope): string {
  return scope.threadId
    ? `${CONTEXT_EXTERNAL_CONTENT_KEY_PREFIX}thread:${scope.threadId}`
    : `${CONTEXT_EXTERNAL_CONTENT_KEY_PREFIX}run:${scope.runId}`;
}

function sourcesOf(value: Readonly<Record<string, unknown>> | undefined) {
  const sources = value?.["sources"];
  if (!Array.isArray(sources)) return [];
  return sources.filter(
    (source): source is ExternalContentSource =>
      source !== null &&
      typeof source === "object" &&
      typeof (source as ExternalContentSource).origin === "string" &&
      typeof (source as ExternalContentSource).firstRunId === "string" &&
      typeof (source as ExternalContentSource).firstSeenAt === "string",
  );
}

export async function markRecalledExternalRecords(input: {
  readonly marker: Pick<ContextExternalContent, "mark">;
  readonly state: Pick<ProductMemoryStatePort, "readMany">;
  readonly runId: RunId;
  readonly ownerId: ProductMemoryRecord["ownerId"];
  readonly agentId: ProductMemoryRecord["agentId"];
  readonly memoryIds: readonly string[];
}): Promise<boolean> {
  if (input.memoryIds.length === 0) return false;
  const records = await input.state.readMany({
    ownerId: input.ownerId,
    agentId: input.agentId,
    memoryIds: input.memoryIds as readonly ProductMemoryRecord["id"][],
  });
  if (!records.some(({ sourceRefs }) => carriesExternalContent(sourceRefs))) return false;
  await input.marker.mark(input.runId, RECALLED_EXTERNAL_RECORD_ORIGIN);
  return true;
}

export class ContextExternalContent {
  readonly #configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly #state: Pick<SqliteProductStateRepository, "readScopedState" | "commitStateAndEvents">;
  readonly #source: RunExecutionSourcePort;
  readonly #authority: () => AuthorityFence;
  readonly #clock: ClockPort;
  readonly #pending = new Map<string, Promise<void>>();

  constructor(options: {
    readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
    readonly state: Pick<SqliteProductStateRepository, "readScopedState" | "commitStateAndEvents">;
    readonly source: RunExecutionSourcePort;
    readonly authority: () => AuthorityFence;
    readonly clock: ClockPort;
  }) {
    this.#configuration = options.configuration;
    this.#state = options.state;
    this.#source = options.source;
    this.#authority = options.authority;
    this.#clock = options.clock;
  }

  async #scopes(runId: RunId): Promise<readonly ExternalContentScope[]> {
    const threadId = (await this.#source.read(runId))?.threadId ?? null;
    return threadId
      ? [
          { threadId, runId },
          { threadId: null, runId },
        ]
      : [{ threadId: null, runId }];
  }

  async readThread(threadId: string): Promise<readonly ExternalContentSource[]> {
    const record = await this.#state.readScopedState(
      this.#configuration.ownerId,
      this.#configuration.agentId,
      externalContentKey({ threadId, runId: "" }),
    );
    return sourcesOf(record?.value);
  }

  async read(runId: RunId): Promise<readonly ExternalContentSource[]> {
    const found: ExternalContentSource[] = [];
    for (const scope of await this.#scopes(runId)) {
      const record = await this.#state.readScopedState(
        this.#configuration.ownerId,
        this.#configuration.agentId,
        externalContentKey(scope),
      );
      found.push(...sourcesOf(record?.value));
    }
    return found;
  }

  async markRunSource(runId: RunId): Promise<readonly string[]> {
    const origin = externalEventOrigin(await this.#source.read(runId));
    if (origin !== null) await this.mark(runId, origin);
    return origin === null ? [] : [origin];
  }

  async mark(runId: RunId, origin: string): Promise<void> {
    const [scope] = await this.#scopes(runId);
    if (!scope) return;
    await this.#enqueue(externalContentKey(scope), runId, origin);
  }

  async markThread(threadId: string, runId: RunId, origin: string): Promise<void> {
    await this.#enqueue(externalContentKey({ threadId, runId }), runId, origin);
  }

  async #enqueue(key: string, runId: RunId, origin: string): Promise<void> {
    const previous = this.#pending.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.#write(key, runId, origin));
    this.#pending.set(key, current);
    try {
      await current;
    } finally {
      if (this.#pending.get(key) === current) this.#pending.delete(key);
    }
  }

  async #write(key: string, runId: RunId, origin: string): Promise<void> {
    const { ownerId, agentId } = this.#configuration;
    let lastError: unknown;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      const record = await this.#state.readScopedState(ownerId, agentId, key);
      const sources = sourcesOf(record?.value);
      if (sources.some((source) => source.origin === origin)) return;
      const value = {
        sources: [...sources, { origin, firstRunId: runId, firstSeenAt: this.#clock.now() }]
          .sort((left, right) => left.origin.localeCompare(right.origin, "en"))
          .map((source) => ({ ...source })),
      };
      try {
        await this.#state.commitStateAndEvents({
          command: {
            ownerId,
            agentId,
            commandType: "context.external_content.mark",
            idempotencyKey:
              `${key}:${record?.revision ?? 0}:${digest(origin)}` as IdempotentAgentCommand["idempotencyKey"],
            commandFingerprint: digest([record?.revision ?? 0, origin]),
            authority: this.#authority(),
          },
          state: { key, expectedRevision: record?.revision ?? null, value },
          events: [],
          resultRef: key,
          committedAt: this.#clock.now(),
        });
        return;
      } catch (error) {
        if (!isConflict(error)) throw new ExternalContentMarkNotWrittenError(error);
        lastError = error;
      }
    }
    throw new ExternalContentMarkNotWrittenError(lastError);
  }
}
