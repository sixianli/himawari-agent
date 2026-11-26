import { createHash } from "node:crypto";
import type {
  ClockPort,
  DecisionLedgerPort,
  InboxStorePort,
  PayloadProtectorPort,
  PayloadStorePort,
  RuntimeToolDescriptor,
  RuntimeToolInvocation,
  ThreadCommandService,
  WebPushStorePort,
} from "@himawari-agent/application";
import { herWordsPushKey, isMessageUrgency, MESSAGE_URGENCIES } from "@himawari-agent/application";
import { TOOL_TELL_OWNER } from "@himawari-agent/prompt-catalog";
import { classificationWithIdentifiers } from "@himawari-agent/sensitive-capture";
import {
  decisionDurationMs,
  type InboxRunRegistry,
  spokenDecisionId,
} from "./production-inbox-delivery.js";
import { isReminderEvent, reminderMessageId } from "./production-reminder-inbox.js";

type Post = Parameters<ThreadCommandService["postAgentMessage"]>[0];

export const TELL_OWNER_CAPABILITY_REF = "owner.tell";
const TEXT_LIMIT = 4000;
const REASON_LIMIT = 1000;
const ARGUMENTS = ["text", "push", "urgency", "about", "reason"];
const PUSH_WINDOW_MS = 24 * 3_600_000;

export class TellOwnerInputError extends Error {
  readonly code: "TELL_OWNER_INPUT_INVALID" | "TELL_OWNER_NOT_AVAILABLE";

  constructor(code: TellOwnerInputError["code"]) {
    super(code);
    this.name = "TellOwnerInputError";
    this.code = code;
  }
}

export function tellOwnerDescriptor(): RuntimeToolDescriptor {
  return {
    name: "tell_owner",
    capabilityRef: TELL_OWNER_CAPABILITY_REF,
    capabilityHandleRef: null,
    description: TOOL_TELL_OWNER.text,
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: TEXT_LIMIT },
        push: { type: "boolean" },
        urgency: { type: "string", enum: [...MESSAGE_URGENCIES] },
        about: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 128 },
          uniqueItems: true,
        },
        reason: { type: "string", minLength: 1, maxLength: REASON_LIMIT },
      },
      required: ["text", "push", "urgency", "reason"],
      additionalProperties: false,
    },
  };
}

export interface ProductionTellOwnerOptions {
  readonly ownerId: string;
  readonly agentId: string;
  readonly registry: InboxRunRegistry;
  readonly commands: Pick<ThreadCommandService, "postAgentMessage">;
  readonly ledger: Pick<DecisionLedgerPort, "recordSpoken">;
  readonly push: Pick<WebPushStorePort, "enqueue">;
  readonly urgency: Pick<InboxStorePort, "recordUrgency">;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly messageExists?: (threadId: string, messageId: string) => Promise<boolean>;
}

export class ProductionTellOwner {
  readonly #options: ProductionTellOwnerOptions;

  constructor(options: ProductionTellOwnerOptions) {
    this.#options = options;
  }

  async run(invocation: RuntimeToolInvocation): Promise<unknown> {
    const args = invocation.arguments;
    const text = args["text"];
    const push = args["push"];
    const reason = args["reason"];
    const about = args["about"];
    const urgency = args["urgency"];
    if (
      !isMessageUrgency(urgency) ||
      typeof text !== "string" ||
      text.trim().length === 0 ||
      [...text].length > TEXT_LIMIT ||
      typeof push !== "boolean" ||
      typeof reason !== "string" ||
      reason.trim().length === 0 ||
      [...reason].length > REASON_LIMIT ||
      (about !== undefined &&
        (!Array.isArray(about) ||
          about.length === 0 ||
          !about.every((id) => typeof id === "string") ||
          new Set(about).size !== about.length)) ||
      Object.keys(args).some((name) => !ARGUMENTS.includes(name))
    )
      throw new TellOwnerInputError("TELL_OWNER_INPUT_INVALID");
    const run = this.#options.registry.get(invocation.runId);
    if (!run) throw new TellOwnerInputError("TELL_OWNER_NOT_AVAILABLE");
    const named = about as readonly string[] | undefined;
    const targets = named
      ? run.events.filter((event) => named.includes(event.entryId))
      : run.events;
    if (named && targets.length !== named.length)
      throw new TellOwnerInputError("TELL_OWNER_INPUT_INVALID");
    const reminder = targets.find(isReminderEvent);
    if (reminder && targets.length !== 1) throw new TellOwnerInputError("TELL_OWNER_INPUT_INVALID");
    const { ownerId, agentId, clock, commands, ledger } = this.#options;
    const key = createHash("sha256")
      .update(JSON.stringify([invocation.runId, invocation.toolCallId]))
      .digest("hex")
      .slice(0, 32);
    const messageId = reminder
      ? reminderMessageId(reminder.sourceRef, reminder.sourceVersion)
      : `message:said:${key}`;
    if (reminder && (await this.#options.messageExists?.(run.threadId, messageId)))
      return { said: false, messageId, pushed: false, alreadyTold: true };
    const contentRef = `said:${key}`;
    const dataClassification = await this.#write(contentRef, text.trim());
    await commands.postAgentMessage({
      ownerId: ownerId as Post["ownerId"],
      agentId: agentId as Post["agentId"],
      threadId: run.threadId as Post["threadId"],
      runId: invocation.runId as Post["runId"],
      messageId: messageId as Post["messageId"],
      idempotencyKey: `tell-owner:${key}`,
      contentRef: contentRef as Post["contentRef"],
      dataClassification,
      resultRef: contentRef as Post["resultRef"],
    });
    const now = clock.now();
    await this.#options.urgency.recordUrgency({
      ownerId: ownerId as Post["ownerId"],
      agentId: agentId as Post["agentId"],
      messageId,
      urgency,
      now,
    });
    const only = targets.length === 1 ? targets[0] : undefined;
    const pushSourceKey = push
      ? await herWordsPushKey({
          messageId,
          ...(only
            ? { source: { kind: only.sourceKind, id: only.sourceRef, version: only.sourceVersion } }
            : {}),
        })
      : null;
    if (pushSourceKey)
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
            threadId: run.threadId,
            createdAt: now,
            expiresAt: new Date(Date.parse(now) + PUSH_WINDOW_MS).toISOString(),
          },
        ],
        cursor: null,
        now,
      });
    const reasonRef = `decision-reason:${key}`;
    await this.#write(reasonRef, reason.trim());
    for (const event of targets)
      await ledger.recordSpoken({
        id: spokenDecisionId(event.entryId),
        ownerId: ownerId as Post["ownerId"],
        agentId: agentId as Post["agentId"],
        scenario: event.sourceKind,
        decidedAt: now,
        verdict: push ? "pushed" : "silent",
        reasonCode: push ? "told_pushed" : "told_in_app",
        subjectRef: event.entryId,
        runId: invocation.runId,
        messageId,
        reasonRef,
        pushSourceKey,
        sourceIds: [event.sourceRef],
        durationMs: decisionDurationMs(event.createdAt, now),
      });
    return { said: true, messageId, pushed: push, urgency };
  }

  async #write(ref: string, text: string) {
    const { payloads, protector, clock } = this.#options;
    const dataClassification = classificationWithIdentifiers(text, "private");
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
