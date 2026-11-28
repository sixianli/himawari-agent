import { createHash } from "node:crypto";
import type {
  CancelCoordinatedRunInput,
  ClockPort,
  DataClassification,
  DecisionLedgerPort,
  PayloadProtectorPort,
  PayloadStorePort,
  RunCheckpointStore,
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
import {
  type ContextExternalContent,
  INBOX_EVENT_MESSAGE_PREFIX,
  inboxEventOrigin,
} from "./context-external-content.js";
import { isApprovalAnswerEvent } from "./production-approval-answers.js";
import type {
  InboxDelivery,
  InboxDeliveryEvent,
  InboxDeliveryResult,
} from "./production-inbox-worker.js";
import type { ProductionMainThread } from "./production-main-thread.js";
import { isReminderEvent, type ProductionReminderInbox } from "./production-reminder-inbox.js";
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
const REMINDER_GRACE_MS = 90_000;

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
  readonly subthreads?: Pick<
    ProductionSubthreads,
    | "open"
    | "subthreadMessage"
    | "overBudget"
    | "afterRun"
    | "awaitingApproval"
    | "listAwaitingApproval"
    | "approvalSettled"
  >;
  readonly checkpoints?: Pick<RunCheckpointStore, "read">;
  readonly reminders?: Pick<ProductionReminderInbox, "ensureTold">;
  readonly reminderGraceMs?: number;
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
    if (input.fromOwner && events.every(({ entry }) => isApprovalAnswerEvent(entry.sourceKind)))
      return this.#approvalAnswers(input.threadId, events, signal);
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
      let status: string;
      try {
        status = await this.#await(main, runId, contentRef, signal, true, false, () =>
          this.#remind(run),
        );
      } catch (error) {
        await this.#remind(run).catch(() => undefined);
        throw error;
      }
      if (status === "yielded") return { status: "yield" };
      const reminded = await this.#remind(run);
      if (status !== "completed") {
        if (reminded && run.events.every(isReminderEvent))
          return {
            status: "handled",
            outcome: "reminder_fallback",
            reasonCode: `run_${status}`,
            runId,
          };
        return { status: "retry", reasonCode: `run_${status}` };
      }
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

  async #remind(run: InboxRun): Promise<boolean> {
    const reminders = this.#options.reminders;
    if (!reminders) return false;
    for (const event of run.events.filter(isReminderEvent))
      await reminders.ensureTold({ threadId: run.threadId, runId: run.runId, event });
    return true;
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
    if (await subthreads.overBudget(threadId))
      return {
        status: "handled",
        outcome: "over_budget",
        reasonCode: "subthread_over_budget",
        runId: null,
      };
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
    const status = await this.#await(threadId, runId, contentRef, signal, false, true);
    if (status === "awaiting_approval") {
      await subthreads.awaitingApproval({ threadId, runId });
      return {
        status: "handled",
        outcome: "awaiting_approval",
        reasonCode: "subthread_awaiting_approval",
        runId,
      };
    }
    const cutOff = status === "failed" && (await this.#cutOff(runId));
    if (status !== "completed" && !cutOff) return { status: "retry", reasonCode: `run_${status}` };
    const ending = await subthreads.afterRun({ threadId, runId, cutOff });
    return {
      status: "handled",
      outcome: ending === "settled" ? "delivered" : ending,
      reasonCode: cutOff ? "subthread_cut_off" : "subthread_ran",
      runId,
    };
  }

  async #approvalAnswers(
    threadId: string | null,
    events: readonly InboxDeliveryEvent[],
    signal: AbortSignal,
  ): Promise<InboxDeliveryResult> {
    const sleep = this.#options.sleep ?? defaultSleep;
    const runIds = [...new Set(events.map(({ entry }) => entry.sourceRef))] as RunId[];
    const subthreads = this.#options.subthreads;
    const subthread = threadId !== null && subthreads ? await subthreads.open(threadId) : undefined;
    let last: RunId | null = null;
    for (const runId of runIds) {
      last = runId;
      let resumed = false;
      for (;;) {
        const stored = await this.#options.runs.readRun(runId);
        const status = stored?.run.status;
        if (status === undefined || TERMINAL.has(status)) break;
        if (status !== "awaiting_approval") resumed = true;
        else if (resumed) break;
        if (resumed && !subthread) break;
        await sleep(this.#options.pollMs ?? POLL_MS, signal);
      }
      if (!subthread || !subthreads) continue;
      const stored = await this.#options.runs.readRun(runId);
      const status = stored?.run.status;
      if (status === "awaiting_approval") {
        await subthreads.awaitingApproval({ threadId: subthread.threadId, runId });
        continue;
      }
      await subthreads.approvalSettled(subthread.threadId);
      const cutOff = status === "failed" && (await this.#cutOff(runId));
      if (status === "completed" || cutOff)
        await subthreads.afterRun({ threadId: subthread.threadId, runId, cutOff });
    }
    return {
      status: "handled",
      outcome: "resumed",
      reasonCode: "approval_answered",
      runId: last,
    };
  }

  async sweep(): Promise<void> {
    const subthreads = this.#options.subthreads;
    if (!subthreads) return;
    for (const subthread of await subthreads.listAwaitingApproval()) {
      const runId = subthread.approvalRunId;
      if (runId === null) continue;
      const stored = await this.#options.runs.readRun(runId as RunId);
      if (stored && !TERMINAL.has(stored.run.status)) continue;
      await subthreads.approvalSettled(subthread.threadId);
      const status = stored?.run.status;
      const cutOff = status === "failed" && (await this.#cutOff(runId as RunId));
      if (status === "completed" || cutOff)
        await subthreads.afterRun({ threadId: subthread.threadId, runId, cutOff });
    }
  }

  async #cutOff(runId: RunId): Promise<boolean> {
    const stored = await this.#options.checkpoints?.read(runId);
    return stored?.checkpoint.diagnosticCode === "RUN_EXECUTION_DEADLINE_EXCEEDED";
  }

  async #markOutside(runId: RunId, events: readonly InboxDeliveryEvent[]): Promise<void> {
    for (const kind of new Set(
      events.filter(({ entry }) => entry.externalContent).map(({ entry }) => entry.sourceKind),
    ))
      await this.#options.externalContent.mark(runId, inboxEventOrigin(kind));
  }

  async #writeMessage(ref: string, message: string) {
    const { payloads, protector, clock } = this.#options;
    const classification: DataClassification = "private";
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
    parkOnApproval = false,
    whenSlow?: () => Promise<unknown>,
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
    const slowAt = Date.now() + (this.#options.reminderGraceMs ?? REMINDER_GRACE_MS);
    let slow = whenSlow;
    try {
      for (;;) {
        if (slow && Date.now() >= slowAt) {
          const late = slow;
          slow = undefined;
          await late().catch(() => undefined);
        }
        const stored = await this.#options.runs.readRun(runId);
        if (stored && TERMINAL.has(stored.run.status)) return stored.run.status;
        if (parkOnApproval && stored?.run.status === "awaiting_approval") return stored.run.status;
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
