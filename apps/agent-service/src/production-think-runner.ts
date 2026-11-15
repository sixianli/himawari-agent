import { createHash } from "node:crypto";
import {
  type CancelCoordinatedRunInput,
  type ClockPort,
  type PayloadProtectorPort,
  type PayloadStorePort,
  parseThinkRunAnswer,
  type RunExecutionSource,
  type StoredThinkEntry,
  type ThinkRunAnswer,
  type ThreadCommandService,
  type ThreadRepositoryPort,
  threadCommandFingerprint,
} from "@himawari-agent/application";
import {
  renderPrompt,
  THINK_RUN_EXTERNAL_NOTE,
  THINK_RUN_TASK,
} from "@himawari-agent/prompt-catalog";
import { classificationWithIdentifiers } from "@himawari-agent/sensitive-capture";
import type { ThinkRunner, ThinkRunResult } from "./production-think-worker.js";

type Admission = Parameters<ThreadCommandService["admitOwnerMessage"]>[0];
type OwnerId = Admission["ownerId"];
type AgentId = Admission["agentId"];
type ThreadId = Admission["threadId"];
type MessageId = NonNullable<Admission["messageId"]>;
type TurnId = NonNullable<Admission["turnId"]>;
type RunId = NonNullable<Admission["runId"]>;
type SessionId = Admission["sessionId"];

type RunAnswer = { readonly status: string; readonly text?: string | undefined };

export const THINK_MESSAGE_PREFIX = "message:think:";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const POLL_MS = 2_000;
const SNAPSHOT_LIMIT = 50;
const ARCHIVE_ATTEMPTS = 3;

export function isThinkRunSource(
  source: Pick<RunExecutionSource, "sourceType" | "sourceId"> | undefined,
) {
  return (
    source?.sourceType === "external_event" && source.sourceId.startsWith(THINK_MESSAGE_PREFIX)
  );
}

export interface ThinkActionContext {
  readonly entry: StoredThinkEntry;
  readonly reason: string;
  readonly threadId: string;
}

export interface ThinkAction {
  readonly type: string;
  readonly describe: string;
  propose(
    fields: Readonly<Record<string, unknown>>,
    context: ThinkActionContext,
  ): Promise<{ readonly proposalId: string } | { readonly refused: string }>;
}

export class ThinkActionRegistry {
  readonly #actions = new Map<string, ThinkAction>();

  register(action: ThinkAction): void {
    if (action.type === "none" || this.#actions.has(action.type))
      throw new RangeError("Think action type is invalid or already registered");
    this.#actions.set(action.type, action);
  }

  get(type: string): ThinkAction | undefined {
    return this.#actions.get(type);
  }

  list(): readonly ThinkAction[] {
    return [...this.#actions.values()].sort((a, b) => (a.type < b.type ? -1 : 1));
  }
}

function neutralized(text: string): string {
  return text.replaceAll("<<<", "‹‹‹").replaceAll(">>>", "›››");
}

export function thinkRunMessage(input: {
  readonly sourceDescription: string;
  readonly summary: string;
  readonly externalContent: boolean;
  readonly actions: readonly Pick<ThinkAction, "describe">[];
}): string {
  return renderPrompt(THINK_RUN_TASK, {
    source: neutralized(input.sourceDescription),
    externalNote: input.externalContent ? THINK_RUN_EXTERNAL_NOTE.text : "",
    summary: neutralized(input.summary),
    actions: input.actions.map(({ describe }) => `- ${describe}`).join("\n"),
  });
}

export interface ThreadThinkRunnerOptions {
  readonly configuration: { readonly ownerId: string; readonly agentId: string };
  readonly commands: Pick<ThreadCommandService, "create" | "admitOwnerMessage" | "setLifecycle">;
  readonly threads: Pick<ThreadRepositoryPort, "readDetailSnapshot">;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly actions: ThinkActionRegistry;
  readonly describeSource: (kind: string) => string | undefined;
  readonly cancelRun?: (
    input: Pick<CancelCoordinatedRunInput, "runId" | "command">,
  ) => Promise<void>;
  readonly onFailure?: (event: string, entryId: string, error: unknown) => void;
  readonly pollMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

export class ThreadThinkRunner implements ThinkRunner {
  readonly #options: ThreadThinkRunnerOptions;

  constructor(options: ThreadThinkRunnerOptions) {
    this.#options = options;
  }

  #ids(entry: StoredThinkEntry) {
    const key = createHash("sha256").update(entry.id).digest("hex").slice(0, 32);
    return {
      key,
      threadId: `thread:think:${key}` as ThreadId,
      messageId: `${THINK_MESSAGE_PREFIX}${key}` as MessageId,
      turnId: `turn:think:${key}` as TurnId,
      runId: `run:think:${key}` as RunId,
      sessionId: `session:think:${key}` as SessionId,
      contentRef: `think-task:${key}`,
    };
  }

  async think(input: {
    readonly entry: StoredThinkEntry;
    readonly summary: string;
    readonly signal: AbortSignal;
  }): Promise<ThinkRunResult> {
    const { entry, summary, signal } = input;
    const { configuration, commands, payloads, protector, clock } = this.#options;
    const ownerId = configuration.ownerId as OwnerId;
    const agentId = configuration.agentId as AgentId;
    const id = this.#ids(entry);
    const earlier = await this.#options.threads.readDetailSnapshot({
      ownerId,
      agentId,
      threadId: id.threadId,
      afterSequence: 0,
      limit: 1,
    });
    if (earlier && earlier.thread.status !== "active")
      return { outcome: "skipped", reasonCode: "run_already_finished" };
    const now = clock.now();
    const sourceDescription = this.#options.describeSource(entry.sourceKind) ?? entry.sourceKind;
    const message = thinkRunMessage({
      sourceDescription,
      summary,
      externalContent: entry.externalContent,
      actions: this.#options.actions.list(),
    });
    const classification = classificationWithIdentifiers(message, "private");
    if (!(await payloads.get(id.contentRef as never)))
      await payloads.put(
        await protector.protect({
          ownerId,
          agentId,
          ref: id.contentRef,
          contentType: "text/plain",
          dataClassification: classification,
          plaintext: new TextEncoder().encode(message),
          createdAt: now,
        }),
      );
    const created = await commands.create({
      ownerId,
      agentId,
      threadId: id.threadId,
      idempotencyKey: `think-thread:${entry.id}`,
      resultRef: id.contentRef as never,
    });
    await commands.admitOwnerMessage({
      triggerSource: "external_event",
      ownerId,
      agentId,
      threadId: id.threadId,
      expectedThreadRevision: created.thread.revision,
      sessionId: id.sessionId,
      idempotencyKey: `think-run:${entry.id}`,
      contentRef: id.contentRef as never,
      sourceProofRef: `think:${entry.id}`,
      dataClassification: classification,
      resultRef: id.contentRef as never,
      messageId: id.messageId,
      turnId: id.turnId,
      runId: id.runId,
      occurredAt: now,
    });
    try {
      let answer: RunAnswer;
      try {
        answer = await this.#await(ownerId, agentId, id.threadId, id.runId, signal);
      } catch (error) {
        if (signal.aborted)
          await this.#cancel(id.runId, id.contentRef).catch((cancelError: unknown) =>
            this.#report("think.cancel_failed", entry.id, cancelError),
          );
        throw error;
      }
      if (answer.status !== "completed")
        return { outcome: "skipped", reasonCode: `run_${answer.status}` };
      const parsed = answer.text === undefined ? undefined : parseThinkRunAnswer(answer.text);
      if (!parsed) return { outcome: "skipped", reasonCode: "answer_invalid" };
      return await this.#propose(parsed, entry, id.threadId);
    } finally {
      await this.#archive(ownerId, agentId, id.threadId, id.key, id.contentRef).catch(
        (archiveError: unknown) => this.#report("think.archive_failed", entry.id, archiveError),
      );
    }
  }

  #report(event: string, entryId: string, error: unknown) {
    try {
      this.#options.onFailure?.(event, entryId, error);
    } catch {}
  }

  async #cancel(runId: RunId, contentRef: string) {
    const cancelRun = this.#options.cancelRun;
    if (!cancelRun) throw new Error("THINK_RUN_CANCEL_UNAVAILABLE");
    await cancelRun({
      runId,
      command: {
        idempotencyKey: `think-cancel:${runId}` as never,
        commandFingerprint: threadCommandFingerprint({ type: "think.cancel", runId }),
        payloadRef: contentRef as never,
      },
    });
  }

  async #propose(
    parsed: ThinkRunAnswer,
    entry: StoredThinkEntry,
    threadId: string,
  ): Promise<ThinkRunResult> {
    if (parsed.action === "none") return { outcome: "skipped", reasonCode: "nothing_to_propose" };
    const action = this.#options.actions.get(parsed.action);
    if (!action) return { outcome: "skipped", reasonCode: "action_unknown" };
    const result = await action.propose(parsed.fields, { entry, reason: parsed.reason, threadId });
    if ("refused" in result)
      return {
        outcome: "skipped",
        reasonCode: `refused_${result.refused}`.toLowerCase().slice(0, 64),
      };
    return { outcome: "proposed", reasonCode: "proposal_written" };
  }

  async #await(
    ownerId: OwnerId,
    agentId: AgentId,
    threadId: ThreadId,
    runId: RunId,
    signal: AbortSignal,
  ): Promise<RunAnswer> {
    const sleep = this.#options.sleep ?? defaultSleep;
    for (;;) {
      const snapshot = await this.#options.threads.readDetailSnapshot({
        ownerId,
        agentId,
        threadId,
        afterSequence: 0,
        limit: SNAPSHOT_LIMIT,
      });
      const run = snapshot?.runs.find((candidate) => candidate.runId === runId);
      if (run && TERMINAL.has(run.status)) {
        if (run.status !== "completed") return { status: run.status };
        const last = [...(snapshot?.messages ?? [])]
          .reverse()
          .find(
            (item) => item.role === "agent" && item.runId === runId && item.status === "committed",
          );
        return {
          status: "completed",
          ...(last ? { text: await this.#text(ownerId, agentId, last.contentRef) } : {}),
        };
      }
      await sleep(this.#options.pollMs ?? POLL_MS, signal);
    }
  }

  async #text(ownerId: OwnerId, agentId: AgentId, ref: string): Promise<string | undefined> {
    const payload = await this.#options.payloads.get(ref as never);
    if (!payload || payload.contentType !== "text/plain") return undefined;
    return new TextDecoder("utf-8", { fatal: false }).decode(
      await this.#options.protector.unprotect({ ownerId, agentId, payload }),
    );
  }

  async #archive(
    ownerId: OwnerId,
    agentId: AgentId,
    threadId: ThreadId,
    key: string,
    contentRef: string,
  ) {
    for (let attempt = 1; ; attempt += 1) {
      const snapshot = await this.#options.threads.readDetailSnapshot({
        ownerId,
        agentId,
        threadId,
        afterSequence: 0,
        limit: 1,
      });
      if (!snapshot || snapshot.thread.status !== "active") return;
      try {
        await this.#options.commands.setLifecycle({
          ownerId,
          agentId,
          threadId,
          expectedRevision: snapshot.thread.revision,
          status: "archived",
          reasonCode: "think_finished",
          idempotencyKey: `think-archive:${key}:${snapshot.thread.revision}`,
          resultRef: contentRef as never,
        });
        return;
      } catch (error) {
        if (attempt >= ARCHIVE_ATTEMPTS) throw error;
      }
    }
  }
}
