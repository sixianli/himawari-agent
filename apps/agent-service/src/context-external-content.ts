import { createHash } from "node:crypto";
import type {
  AuthorityFence,
  ClockPort,
  IdempotentAgentCommand,
  ProductConfiguration,
  RunExecutionSource,
  RunExecutionSourcePort,
} from "@himawari-agent/application";

type RunId = RunExecutionSource["runId"];
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const CONTEXT_EXTERNAL_CONTENT_KEY_PREFIX = "context-external-content:";
const WRITE_ATTEMPTS = 5;

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

export class ContextExternalContent {
  readonly #configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly #state: Pick<SqliteProductStateRepository, "readScopedState" | "commitStateAndEvents">;
  readonly #source: RunExecutionSourcePort;
  readonly #authority: () => AuthorityFence;
  readonly #clock: ClockPort;

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

  async mark(runId: RunId, origin: string): Promise<void> {
    const [scope] = await this.#scopes(runId);
    if (!scope) return;
    const { ownerId, agentId } = this.#configuration;
    const key = externalContentKey(scope);
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
        lastError = error;
      }
    }
    throw lastError;
  }
}
