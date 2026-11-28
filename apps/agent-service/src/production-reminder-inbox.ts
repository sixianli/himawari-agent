import { createHash } from "node:crypto";
import type {
  ClockPort,
  DataClassification,
  DecisionLedgerPort,
  MemoryReminder,
  MemoryReminderStorePort,
  PayloadProtectorPort,
  PayloadStorePort,
  ThreadCommandService,
  WebPushStorePort,
} from "@himawari-agent/application";
import { herWordsPushKey } from "@himawari-agent/application";
import { REMINDER_DUE_EVENT, renderPrompt } from "@himawari-agent/prompt-catalog";
import type { InboxSourceRegistry, ProductionInbox } from "./production-inbox.js";
import { decisionDurationMs, spokenDecisionId } from "./production-inbox-delivery.js";

type Post = Parameters<ThreadCommandService["postAgentMessage"]>[0];

export const REMINDER_EVENT_KIND = "reminder";
const REMINDER_PRIORITY = 1;
const DEFAULT_INTERVAL_MS = 10_000;
const DUE_WINDOW_MS = 24 * 3_600_000;
const PUSH_WINDOW_MS = 24 * 3_600_000;
const BATCH = 50;

export interface ReminderEvent {
  readonly entryId: string;
  readonly sourceKind: string;
  readonly sourceRef: string;
  readonly sourceVersion: string;
  readonly createdAt: string;
}

function occurrenceKey(reminderId: string, remindAt: string): string {
  return createHash("sha256")
    .update(JSON.stringify([reminderId, remindAt]))
    .digest("hex")
    .slice(0, 32);
}

export function reminderMessageId(reminderId: string, remindAt: string): string {
  return `message:reminder:${occurrenceKey(reminderId, remindAt)}`;
}

export function isReminderEvent(event: Pick<ReminderEvent, "sourceKind">): boolean {
  return event.sourceKind === REMINDER_EVENT_KIND;
}

export interface ProductionReminderInboxOptions {
  readonly ownerId: string;
  readonly agentId: string;
  readonly reminders: Pick<MemoryReminderStorePort, "listDue" | "read">;
  readonly reminderText: (reminder: MemoryReminder) => Promise<string | undefined>;
  readonly formatDue?: (dueAt: string) => string;
  readonly messageExists: (threadId: string, messageId: string) => Promise<boolean>;
  readonly commands: Pick<ThreadCommandService, "postAgentMessage">;
  readonly ledger: Pick<DecisionLedgerPort, "recordSpoken">;
  readonly push: Pick<WebPushStorePort, "enqueue">;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly intervalMs?: number;
  readonly onFailure?: (error: unknown) => void;
}

export class ProductionReminderInbox {
  readonly #options: ProductionReminderInboxOptions;
  #inbox: Pick<ProductionInbox, "submit"> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<unknown> | undefined;
  #stopped = true;

  constructor(options: ProductionReminderInboxOptions) {
    this.#options = options;
  }

  registerSource(registry: InboxSourceRegistry): void {
    registry.register({
      kind: REMINDER_EVENT_KIND,
      describe: "到点的提醒",
      externalContent: false,
      fromOwner: false,
      priority: REMINDER_PRIORITY,
      verbatim: true,
    });
  }

  attach(inbox: Pick<ProductionInbox, "submit">): void {
    this.#inbox = inbox;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#schedule(0);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running?.catch(() => undefined);
  }

  #schedule(delay: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#running = this.tick()
        .catch((error: unknown) => this.#fail(error))
        .finally(() => {
          this.#running = undefined;
          this.#schedule(this.#options.intervalMs ?? DEFAULT_INTERVAL_MS);
        });
    }, delay);
    this.#timer.unref?.();
  }

  #fail(error: unknown): void {
    try {
      this.#options.onFailure?.(error);
    } catch {}
  }

  async tick(): Promise<number> {
    const inbox = this.#inbox;
    if (!inbox) return 0;
    const now = this.#options.clock.now();
    const due = await this.#options.reminders.listDue({
      ownerId: this.#options.ownerId as MemoryReminder["ownerId"],
      agentId: this.#options.agentId as MemoryReminder["agentId"],
      now,
      limit: BATCH,
    });
    let submitted = 0;
    for (const reminder of due) {
      if (Date.parse(now) - Date.parse(reminder.remindAt) > DUE_WINDOW_MS) continue;
      const text = await this.#options.reminderText(reminder);
      if (text === undefined) continue;
      const result = await inbox.submit({
        sourceKind: REMINDER_EVENT_KIND,
        sourceRef: reminder.id,
        sourceVersion: reminder.remindAt,
        summary: renderPrompt(REMINDER_DUE_EVENT, {
          text,
          due: this.#options.formatDue?.(reminder.dueAt) ?? reminder.dueAt,
        }),
        externalContent: false,
        threadId: null,
      });
      if (result.accepted) submitted += 1;
    }
    return submitted;
  }

  async told(threadId: string, event: ReminderEvent): Promise<boolean> {
    return this.#options.messageExists(
      threadId,
      reminderMessageId(event.sourceRef, event.sourceVersion),
    );
  }

  async ensureTold(input: {
    readonly threadId: string;
    readonly runId: string;
    readonly event: ReminderEvent;
  }): Promise<"told" | "fallback" | "gone"> {
    const { threadId, runId, event } = input;
    if (await this.told(threadId, event)) return "told";
    const reminder = await this.#options.reminders.read(event.sourceRef);
    if (!reminder) return "gone";
    const text = await this.#options.reminderText(reminder);
    if (text === undefined) return "gone";
    const { ownerId, agentId, clock } = this.#options;
    const key = occurrenceKey(event.sourceRef, event.sourceVersion);
    const messageId = reminderMessageId(event.sourceRef, event.sourceVersion);
    const contentRef = `reminder-said:${key}`;
    const dataClassification = await this.#write(contentRef, text);
    await this.#options.commands.postAgentMessage({
      ownerId: ownerId as Post["ownerId"],
      agentId: agentId as Post["agentId"],
      threadId: threadId as Post["threadId"],
      runId: runId as Post["runId"],
      messageId: messageId as Post["messageId"],
      idempotencyKey: `reminder-fallback:${key}`,
      contentRef: contentRef as Post["contentRef"],
      dataClassification,
      resultRef: contentRef as Post["resultRef"],
      afterRunEnded: true,
    });
    const now = clock.now();
    const pushSourceKey = await herWordsPushKey({
      messageId,
      source: { kind: event.sourceKind, id: event.sourceRef, version: event.sourceVersion },
    });
    await this.#options.push.enqueue({
      ownerId: ownerId as Post["ownerId"],
      agentId: agentId as Post["agentId"],
      items: [
        {
          ownerId: ownerId as Post["ownerId"],
          agentId: agentId as Post["agentId"],
          sourceKey: pushSourceKey,
          kind: "reminder",
          sourceRef: messageId,
          threadId,
          createdAt: now,
          expiresAt: new Date(Date.parse(now) + PUSH_WINDOW_MS).toISOString(),
        },
      ],
      cursor: null,
      now,
    });
    await this.#options.ledger.recordSpoken({
      id: spokenDecisionId(event.entryId),
      ownerId: ownerId as Post["ownerId"],
      agentId: agentId as Post["agentId"],
      scenario: event.sourceKind,
      decidedAt: now,
      verdict: "pushed",
      reasonCode: "reminder_fallback",
      subjectRef: event.entryId,
      runId,
      messageId,
      reasonRef: null,
      pushSourceKey,
      sourceIds: [event.sourceRef],
      durationMs: decisionDurationMs(event.createdAt, now),
    });
    return "fallback";
  }

  async #write(ref: string, text: string) {
    const { payloads, protector, clock } = this.#options;
    const dataClassification: DataClassification = "private";
    if (!(await payloads.get(ref as never)))
      await payloads.put(
        await protector.protect({
          ownerId: this.#options.ownerId as Post["ownerId"],
          agentId: this.#options.agentId as Post["agentId"],
          ref,
          contentType: "text/plain",
          dataClassification,
          plaintext: new TextEncoder().encode(text),
          createdAt: clock.now(),
        }),
      );
    return dataClassification;
  }
}
