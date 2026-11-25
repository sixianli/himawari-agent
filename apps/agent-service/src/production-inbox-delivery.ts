import { createHash } from "node:crypto";
import type {
  CancelCoordinatedRunInput,
  ClockPort,
  DecisionLedgerPort,
  PayloadProtectorPort,
  PayloadStorePort,
  RunLifecyclePort,
  ThreadCommandService,
  ThreadRepositoryPort,
} from "@himawari-agent/application";
import { threadCommandFingerprint } from "@himawari-agent/application";
import {
  INBOX_EVENT_ENTRY,
  INBOX_EVENTS_PREFACE,
  renderPrompt,
} from "@himawari-agent/prompt-catalog";
import { classificationWithIdentifiers } from "@himawari-agent/sensitive-capture";
import {
  type ContextExternalContent,
  INBOX_EVENT_MESSAGE_PREFIX,
  inboxEventOrigin,
} from "./context-external-content.js";
import type {
  InboxDelivery,
  InboxDeliveryEvent,
  InboxDeliveryResult,
} from "./production-inbox-worker.js";
import type { ProductionMainThread } from "./production-main-thread.js";
import type { ProductionSubthreads } from "./production-subthreads.js";

type Admission = Parameters<ThreadCommandService["admitOwnerMessage"]>[0];
type OwnerId = Admission["ownerId"];
type AgentId = Admission["agentId"];
type ThreadId = Admission["threadId"];
type RunId = NonNullable<Admission["runId"]>;

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const POLL_MS = 1_000;
const ADMIT_ATTEMPTS = 3;
const DAY_MS = 86_400_000;

export interface InboxRunEvent {
  readonly entryId: string;
  readonly sourceKind: string;
  readonly sourceRef: string;
  readonly sourceVersion: string;
  readonly createdAt: string;
}

export interface InboxRun {
  readonly threadId: string;
  readonly runId: string;
  readonly events: readonly InboxRunEvent[];
}

export class InboxRunRegistry {
  readonly #runs = new Map<string, InboxRun>();

  open(run: InboxRun): void {
    this.#runs.set(run.runId, Object.freeze({ ...run, events: Object.freeze([...run.events]) }));
  }

  close(runId: string): void {
    this.#runs.delete(runId);
  }

  get(runId: string): InboxRun | undefined {
    return this.#runs.get(runId);
  }
}

export function spokenDecisionId(entryId: string): string {
  return `inbox:${entryId}`.slice(0, 128);
}

export function decisionDurationMs(from: string, to: string): number {
  const elapsed = Date.parse(to) - Date.parse(from);
  return Number.isFinite(elapsed) ? Math.min(Math.max(0, elapsed), DAY_MS) : 0;
}

function neutralized(text: string): string {
  return text.replaceAll("</outside-events>", "‹/outside-events›");
}

function batchKey(events: readonly InboxDeliveryEvent[]): string {
  return createHash("sha256")
    .update(JSON.stringify(events.map(({ entry }) => [entry.id, entry.attempts])))
    .digest("hex")
    .slice(0, 32);
}

export function inboxEventsMessage(events: readonly InboxDeliveryEvent[]): string {
  return [
    INBOX_EVENTS_PREFACE.text,
    ...events.map((event) =>
      renderPrompt(INBOX_EVENT_ENTRY, {
        eventId: event.entry.id,
        source: neutralized(event.source.describe),
        summary: neutralized(event.summary),
      }),
    ),
  ].join("\n\n");
}

export interface InboxDeliveryOptions {
  readonly ownerId: string;
  readonly agentId: string;
  readonly mainThread: Pick<ProductionMainThread, "ensure">;
  readonly threads: Pick<ThreadRepositoryPort, "read" | "listRuns" | "readRunThought">;
  readonly commands: Pick<ThreadCommandService, "admitOwnerMessage">;
  readonly runs: Pick<RunLifecyclePort, "readRun">;
  readonly ledger: Pick<DecisionLedgerPort, "recordSpoken">;
  readonly externalContent: Pick<ContextExternalContent, "mark">;
  readonly registry: InboxRunRegistry;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly cancelRun?: (
    input: Pick<CancelCoordinatedRunInput, "runId" | "command">,
  ) => Promise<void>;
  readonly subthreads?: Pick<ProductionSubthreads, "open" | "subthreadMessage">;
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

export class ProductionInboxDelivery implements InboxDelivery {
  readonly #options: InboxDeliveryOptions;

  constructor(options: InboxDeliveryOptions) {
    this.#options = options;
  }

  async deliver(input: {
    readonly threadId: string | null;
    readonly fromOwner: boolean;
    readonly events: readonly InboxDeliveryEvent[];
    readonly signal: AbortSignal;
  }): Promise<InboxDeliveryResult> {
    const { events, signal } = input;
    const first = events[0];
    if (!first)
      return { status: "handled", outcome: "empty", reasonCode: "no_events", runId: null };
    if (input.fromOwner)
      return {
        status: "handled",
        outcome: "unsupported",
        reasonCode: "owner_events_unsupported",
        runId: null,
      };
    const ownerId = this.#options.ownerId as OwnerId;
    const agentId = this.#options.agentId as AgentId;
    const main = await this.#options.mainThread.ensure();
    if (input.threadId !== null && input.threadId !== main)
      return this.#deliverToSubthread(input.threadId as ThreadId, events, signal);
    const busy = await this.#options.threads.listRuns(ownerId, agentId, main);
    if (busy.some((run) => !TERMINAL.has(run.status))) return { status: "yield" };
    const key = batchKey(events);
    const runId = `run:inbox:${key}` as RunId;
    const contentRef = `inbox-message:${key}`;
    const run: InboxRun = {
      threadId: main,
      runId,
      events: events.map(({ entry }) => ({
        entryId: entry.id,
        sourceKind: entry.sourceKind,
        sourceRef: entry.sourceRef,
        sourceVersion: entry.sourceVersion,
        createdAt: entry.createdAt,
      })),
    };
    this.#options.registry.open(run);
    try {
      const classification = await this.#writeMessage(contentRef, inboxEventsMessage(events));
      await this.#admit(main, key, events, runId, contentRef, classification, true);
      await this.#markOutside(runId, events);
      const status = await this.#await(main, runId, contentRef, signal, true);
      if (status === "yielded") return { status: "yield" };
      if (status !== "completed") return { status: "retry", reasonCode: `run_${status}` };
      const told = await this.#recordSilence(run);
      return {
        status: "handled",
        outcome: told ? "told" : "silent",
        reasonCode: told ? "told_owner" : "kept_silent",
        runId,
      };
    } finally {
      this.#options.registry.close(runId);
    }
  }

  async #deliverToSubthread(
    threadId: ThreadId,
    events: readonly InboxDeliveryEvent[],
    signal: AbortSignal,
  ): Promise<InboxDeliveryResult> {
    const subthreads = this.#options.subthreads;
    if (!subthreads || !(await subthreads.open(threadId)))
      return { status: "handled", outcome: "closed", reasonCode: "subthread_closed", runId: null };
    const busy = await this.#options.threads.listRuns(
      this.#options.ownerId as OwnerId,
      this.#options.agentId as AgentId,
      threadId,
    );
    if (busy.some((run) => !TERMINAL.has(run.status))) return { status: "yield" };
    const key = batchKey(events);
    const runId = `run:inbox:${key}` as RunId;
    const contentRef = `inbox-message:${key}`;
    const classification = await this.#writeMessage(
      contentRef,
      subthreads.subthreadMessage(
        events.map(({ entry, summary }) => ({
          sourceKind: entry.sourceKind,
          sourceRef: entry.sourceRef,
          text: summary,
        })),
      ),
    );
    await this.#admit(threadId, key, events, runId, contentRef, classification, false);
    await this.#markOutside(runId, events);
    const status = await this.#await(threadId, runId, contentRef, signal, false);
    if (status !== "completed") return { status: "retry", reasonCode: `run_${status}` };
    return { status: "handled", outcome: "delivered", reasonCode: "subthread_ran", runId };
  }

  async #markOutside(runId: RunId, events: readonly InboxDeliveryEvent[]): Promise<void> {
    for (const kind of new Set(
      events.filter(({ entry }) => entry.externalContent).map(({ entry }) => entry.sourceKind),
    ))
      await this.#options.externalContent.mark(runId, inboxEventOrigin(kind));
  }

  async #writeMessage(ref: string, message: string) {
    const { payloads, protector, clock } = this.#options;
    const classification = classificationWithIdentifiers(message, "private");
    if (!(await payloads.get(ref as never)))
      await payloads.put(
        await protector.protect({
          ownerId: this.#options.ownerId as OwnerId,
          agentId: this.#options.agentId as AgentId,
          ref,
          contentType: "text/plain",
          dataClassification: classification,
          plaintext: new TextEncoder().encode(message),
          createdAt: clock.now(),
        }),
      );
    return classification;
  }

  async #admit(
    threadId: ThreadId,
    key: string,
    events: readonly InboxDeliveryEvent[],
    runId: RunId,
    contentRef: string,
    dataClassification: Admission["dataClassification"],
    internal: boolean,
  ): Promise<void> {
    const ownerId = this.#options.ownerId as OwnerId;
    const agentId = this.#options.agentId as AgentId;
    const kind = events[0]?.entry.sourceKind ?? "inbox";
    const outside = events.some(({ entry }) => entry.externalContent);
    let lastError: unknown;
    for (let attempt = 0; attempt < ADMIT_ATTEMPTS; attempt += 1) {
      const thread = await this.#options.threads.read(ownerId, agentId, threadId);
      if (!thread) throw new Error("INBOX_THREAD_MISSING");
      try {
        await this.#options.commands.admitOwnerMessage({
          triggerSource: outside ? "external_event" : "schedule",
          ...(internal ? { internal: true as const } : {}),
          ownerId,
          agentId,
          threadId,
          expectedThreadRevision: thread.revision,
          sessionId: `session:inbox:${key}` as Admission["sessionId"],
          idempotencyKey: `inbox-run:${key}`,
          contentRef: contentRef as never,
          sourceProofRef: `inbox:${key}`,
          dataClassification,
          resultRef: contentRef as never,
          messageId: `${INBOX_EVENT_MESSAGE_PREFIX}${kind}:${key}` as NonNullable<
            Admission["messageId"]
          >,
          turnId: `turn:inbox:${key}` as NonNullable<Admission["turnId"]>,
          runId,
          occurredAt: this.#options.clock.now(),
        });
        return;
      } catch (error) {
        lastError = error;
        if ((error as { readonly code?: unknown }).code !== "PORT_CONFLICT") throw error;
      }
    }
    throw lastError;
  }

  async #await(
    threadId: ThreadId,
    runId: RunId,
    contentRef: string,
    signal: AbortSignal,
    yieldToOwner: boolean,
  ): Promise<string> {
    const sleep = this.#options.sleep ?? defaultSleep;
    const cancel = () =>
      this.#options.cancelRun
        ? this.#options
            .cancelRun({
              runId,
              command: {
                idempotencyKey: `inbox-cancel:${runId}` as never,
                commandFingerprint: threadCommandFingerprint({ type: "inbox.cancel", runId }),
                payloadRef: contentRef as never,
              },
            })
            .then(
              () => true,
              () => false,
            )
        : Promise.resolve(false);
    try {
      for (;;) {
        const stored = await this.#options.runs.readRun(runId);
        if (stored && TERMINAL.has(stored.run.status)) return stored.run.status;
        if (
          yieldToOwner &&
          this.#options.cancelRun &&
          (await this.#ownerWaiting(threadId)) &&
          (await cancel())
        )
          return "yielded";
        await sleep(this.#options.pollMs ?? POLL_MS, signal);
      }
    } catch (error) {
      if (signal.aborted) await cancel();
      throw error;
    }
  }

  async #ownerWaiting(main: ThreadId): Promise<boolean> {
    const runs = await this.#options.threads.listRuns(
      this.#options.ownerId as OwnerId,
      this.#options.agentId as AgentId,
      main,
    );
    return runs.some((run) => !TERMINAL.has(run.status));
  }

  async #recordSilence(run: InboxRun): Promise<boolean> {
    const { ledger, clock } = this.#options;
    const ownerId = this.#options.ownerId as OwnerId;
    const agentId = this.#options.agentId as AgentId;
    const now = clock.now();
    const reasonRef = await this.#thoughtCopy(run);
    let told = false;
    for (const event of run.events) {
      const written = await ledger.recordSpoken({
        id: spokenDecisionId(event.entryId),
        ownerId,
        agentId,
        scenario: event.sourceKind,
        decidedAt: now,
        verdict: "silent",
        reasonCode: "kept_silent",
        subjectRef: event.entryId,
        runId: run.runId,
        messageId: null,
        reasonRef,
        pushSourceKey: null,
        sourceIds: [event.sourceRef],
        durationMs: decisionDurationMs(event.createdAt, now),
      });
      if (!written) told = true;
    }
    return told;
  }

  async #thoughtCopy(run: InboxRun): Promise<string | null> {
    const { payloads, protector, threads, clock } = this.#options;
    const ownerId = this.#options.ownerId as OwnerId;
    const agentId = this.#options.agentId as AgentId;
    const thought = await threads.readRunThought({
      ownerId,
      agentId,
      threadId: run.threadId as ThreadId,
      runId: run.runId as RunId,
    });
    if (!thought) return null;
    const ref = `decision-reason:${run.runId}`;
    if (await payloads.get(ref as never)) return ref;
    const stored = await payloads.get(thought.contentRef);
    if (!stored) return null;
    const plaintext = await protector.unprotect({ ownerId, agentId, payload: stored });
    await payloads.put(
      await protector.protect({
        ownerId,
        agentId,
        ref,
        contentType: "text/plain",
        dataClassification: stored.dataClassification,
        plaintext,
        createdAt: clock.now(),
      }),
    );
    return ref;
  }
}
