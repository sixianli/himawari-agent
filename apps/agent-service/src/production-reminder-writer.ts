import { createHash } from "node:crypto";
import type {
  ClockPort,
  DataClassification,
  DurableMemoryService,
  MemoryBookStorePort,
  MemoryReminder,
  MemoryReminderStorePort,
  PayloadProtectorPort,
  PayloadStorePort,
  ProductConfiguration,
  ProductMemoryRecord,
  ProductMemoryStatePort,
  RuntimeToolDescriptor,
  RuntimeToolInvocation,
} from "@himawari-agent/application";
import { classificationRank } from "@himawari-agent/application";
import { MACHINE_STRING_MAX_LENGTH } from "@himawari-agent/gateway-contracts";
import {
  TOOL_REMINDER_CANCEL,
  TOOL_REMINDER_LIST,
  TOOL_REMINDER_SET,
  TOOL_RESULT_REMINDER_SET,
} from "@himawari-agent/prompt-catalog";
import { externalContentSourceRefs } from "./context-external-content.js";
import { reminderSchedule } from "./production-memory-capture.js";

export const REMINDER_SET_CAPABILITY_REF = "reminder.set";
export const REMINDER_LIST_CAPABILITY_REF = "reminder.list";
export const REMINDER_CANCEL_CAPABILITY_REF = "reminder.cancel";
export const REMINDER_CAPABILITY_REFS: readonly string[] = [
  REMINDER_SET_CAPABILITY_REF,
  REMINDER_LIST_CAPABILITY_REF,
  REMINDER_CANCEL_CAPABILITY_REF,
];

const REMINDER_POLICY_VERSION = "memory-reminder:v1";
const REMINDER_IMPORTANCE = 500;
const MAXIMUM_TEXT = 500;
const LISTED = 20;
const CEILING_SCAN_LIMIT = 200;
const MEMORY_ID_PREFIX = "memory:reminder:";
const REMINDER_ID_PREFIX = `reminder:${MEMORY_ID_PREFIX}`;

const SHORTENED_KEY = /\.[0-9a-f]{64}$/u;

function reminderKey(key: string): string {
  if (
    REMINDER_ID_PREFIX.length + key.length <= MACHINE_STRING_MAX_LENGTH &&
    !SHORTENED_KEY.test(key)
  )
    return key;
  const digest = createHash("sha256").update(key, "utf8").digest("hex");
  const kept = MACHINE_STRING_MAX_LENGTH - REMINDER_ID_PREFIX.length - digest.length - 1;
  return `${key.slice(0, kept)}.${digest}`;
}

const LIST_WINDOW_MS = 2 * 366 * 24 * 3_600_000;
const SET_ARGUMENTS = ["text", "due", "repeat"];
const CANCEL_ARGUMENTS = ["reminderId"];
const DUE_FORMAT = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?$/u;

type MemoryId = ProductMemoryRecord["id"];
type GenerationId = Parameters<DurableMemoryService["delete"]>[1];

export type ReminderInputErrorCode =
  | "REMINDER_INPUT_INVALID"
  | "REMINDER_TIME_INVALID"
  | "REMINDER_TEXT_REFUSED"
  | "REMINDER_NOT_FOUND"
  | "REMINDER_MEMORY_NOT_READY"
  | "REMINDER_UNAVAILABLE";

export class ReminderInputError extends Error {
  readonly code: ReminderInputErrorCode;
  constructor(code: ReminderInputErrorCode) {
    super(code);
    this.code = code;
  }
}

export function reminderToolDescriptors(): readonly RuntimeToolDescriptor[] {
  return [
    {
      name: "reminder_set",
      capabilityRef: REMINDER_SET_CAPABILITY_REF,
      capabilityHandleRef: null,
      description: TOOL_REMINDER_SET.text,
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, maxLength: MAXIMUM_TEXT },
          due: { type: "string", minLength: 10, maxLength: 16 },
          repeat: { type: "string", enum: ["none", "yearly"] },
        },
        required: ["text", "due"],
        additionalProperties: false,
      },
    },
    {
      name: "reminder_list",
      capabilityRef: REMINDER_LIST_CAPABILITY_REF,
      capabilityHandleRef: null,
      description: TOOL_REMINDER_LIST.text,
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "reminder_cancel",
      capabilityRef: REMINDER_CANCEL_CAPABILITY_REF,
      capabilityHandleRef: null,
      description: TOOL_REMINDER_CANCEL.text,
      parameters: {
        type: "object",
        properties: { reminderId: { type: "string", minLength: 1, maxLength: 256 } },
        required: ["reminderId"],
        additionalProperties: false,
      },
    },
  ];
}

export interface ProductionReminderWriterOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly memory: Pick<DurableMemoryService, "applyProposal"> &
    Partial<Pick<DurableMemoryService, "delete">>;
  readonly state: Pick<ProductMemoryStatePort, "read">;
  readonly book: Pick<MemoryBookStorePort, "latestGeneration">;
  readonly reminders: Pick<
    MemoryReminderStorePort,
    "schedule" | "read" | "update" | "listUpcoming"
  >;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly timeZone?: string;
}

export interface CreatedReminder {
  readonly reminderId: string;
  readonly memoryId: string;
  readonly dueAt: string;
  readonly remindAt: string;
  readonly repeat: "none" | "yearly";
  readonly replayed: boolean;
}

export interface ListedReminder {
  readonly reminderId: string;
  readonly memoryId: string;
  readonly text: string;
  readonly dueAt: string;
  readonly remindAt: string;
  readonly repeat: "none" | "yearly";
}

export class ProductionReminderWriter {
  readonly #options: ProductionReminderWriterOptions;

  constructor(options: ProductionReminderWriterOptions) {
    this.#options = options;
  }

  #scope() {
    const { ownerId, agentId } = this.#options.configuration;
    return { ownerId, agentId };
  }

  async #readText(ref: string): Promise<string | undefined> {
    const payload = await this.#options.payloads.get(ref);
    if (!payload || payload.contentType !== "text/plain") return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await this.#options.protector.unprotect({ ...this.#scope(), payload }),
    );
  }

  async create(input: {
    readonly key: string;
    readonly text?: string;
    readonly contentRef?: string;
    readonly due: string;
    readonly repeat: "none" | "yearly";
    readonly sourceThreadId?: string | null;
    readonly externalOrigins?: readonly string[];
    readonly expectedDueAt?: string;
  }): Promise<CreatedReminder> {
    const key = reminderKey(input.key);
    const memoryId = `${MEMORY_ID_PREFIX}${key}` as MemoryId;
    const reminderId = `reminder:${memoryId}`;
    const existing = await this.#options.reminders.read(reminderId);
    if (
      existing &&
      (existing.ownerId !== this.#scope().ownerId || existing.agentId !== this.#scope().agentId)
    )
      throw new ReminderInputError("REMINDER_NOT_FOUND");
    if (existing)
      return {
        reminderId,
        memoryId,
        dueAt: existing.dueAt,
        remindAt: existing.remindAt,
        repeat: existing.repeat,
        replayed: true,
      };
    const now = this.#options.clock.now();
    const due = input.due.trim();
    if (!DUE_FORMAT.test(due)) throw new ReminderInputError("REMINDER_TIME_INVALID");
    const schedule = reminderSchedule(due, input.repeat, now, this.#options.timeZone);
    if (!schedule) throw new ReminderInputError("REMINDER_TIME_INVALID");
    if (input.expectedDueAt !== undefined && schedule.dueAt !== input.expectedDueAt)
      throw new ReminderInputError("REMINDER_TIME_INVALID");
    let contentRef = input.contentRef;
    let text = contentRef ? await this.#readText(contentRef) : undefined;
    if (contentRef === undefined) {
      text = (input.text ?? "").trim();
      contentRef = `memory-content:reminder:${key}`;
    }
    if (text === undefined || text.trim().length === 0 || text.length > MAXIMUM_TEXT)
      throw new ReminderInputError(
        text === undefined || text.trim().length === 0
          ? "REMINDER_INPUT_INVALID"
          : "REMINDER_TEXT_REFUSED",
      );
    const generation: GenerationId | undefined = await this.#options.book.latestGeneration(
      this.#scope(),
    );
    if (!generation) throw new ReminderInputError("REMINDER_MEMORY_NOT_READY");
    if (input.contentRef === undefined && !(await this.#options.payloads.get(contentRef)))
      await this.#options.payloads.put(
        await this.#options.protector.protect({
          ...this.#scope(),
          ref: contentRef,
          contentType: "text/plain",
          dataClassification: "private",
          plaintext: new TextEncoder().encode(text),
          createdAt: now,
        }),
      );
    const payload = await this.#options.payloads.get(contentRef);
    if (!payload || payload.dataClassification === "restricted")
      throw new ReminderInputError("REMINDER_TEXT_REFUSED");
    await this.#options.memory.applyProposal(
      {
        decision: "create",
        memory: {
          id: memoryId,
          ...this.#scope(),
          contentRef,
          dataClassification: payload.dataClassification,
          sourceThreadId: (input.sourceThreadId ?? null) as ProductMemoryRecord["sourceThreadId"],
          sourceRefs: [
            contentRef,
            ...externalContentSourceRefs(memoryId, input.externalOrigins ?? []),
          ],
          inference: false,
          confidencePermille: 1000,
          policyVersion: REMINDER_POLICY_VERSION,
          attributes: {
            category: "event",
            importancePermille: REMINDER_IMPORTANCE,
            entities: [],
            validFrom: null,
            validTo: null,
            supersededBy: null,
            evidenceVerified: false,
          },
        },
      },
      generation,
    );
    await this.#options.reminders.schedule({
      ...schedule,
      id: reminderId,
      ...this.#scope(),
      memoryId,
      status: "scheduled",
      dismissedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    return {
      reminderId,
      memoryId,
      dueAt: schedule.dueAt,
      remindAt: schedule.remindAt,
      repeat: schedule.repeat,
      replayed: false,
    };
  }

  async list(
    windowMs: number = LIST_WINDOW_MS,
    ceiling?: DataClassification,
  ): Promise<{ readonly reminders: readonly ListedReminder[]; readonly more: boolean }> {
    const now = this.#options.clock.now();
    const upcoming = await this.#options.reminders.listUpcoming({
      ...this.#scope(),
      from: now,
      to: new Date(Date.parse(now) + windowMs).toISOString(),
      limit: ceiling === undefined ? LISTED + 1 : CEILING_SCAN_LIMIT,
    });
    const listed: ListedReminder[] = [];
    let eligibleAfterListed = false;
    for (const reminder of ceiling === undefined ? upcoming.slice(0, LISTED) : upcoming) {
      const text = await this.#textOf(reminder, ceiling);
      if (text === undefined) continue;
      if (listed.length >= LISTED) {
        eligibleAfterListed = true;
        break;
      }
      listed.push({
        reminderId: reminder.id,
        memoryId: reminder.memoryId,
        text,
        dueAt: reminder.dueAt,
        remindAt: reminder.remindAt,
        repeat: reminder.repeat,
      });
    }
    return {
      reminders: listed,
      more:
        ceiling === undefined
          ? upcoming.length > LISTED
          : eligibleAfterListed || upcoming.length >= CEILING_SCAN_LIMIT,
    };
  }

  async #textOf(
    reminder: MemoryReminder,
    ceiling?: DataClassification,
  ): Promise<string | undefined> {
    const memory = await this.#options.state.read(reminder.memoryId);
    return memory &&
      memory.status === "active" &&
      memory.dataClassification !== "restricted" &&
      (ceiling === undefined ||
        classificationRank(memory.dataClassification) <= classificationRank(ceiling))
      ? this.#readText(memory.contentRef)
      : undefined;
  }

  async describe(
    reminderId: string,
  ): Promise<{ readonly reminder: MemoryReminder; readonly text: string } | undefined> {
    const reminder = await this.#options.reminders.read(reminderId);
    const { ownerId, agentId } = this.#options.configuration;
    if (!reminder || reminder.ownerId !== ownerId || reminder.agentId !== agentId) return undefined;
    const text = await this.#textOf(reminder);
    return text === undefined ? undefined : { reminder, text };
  }

  schedulePreview(due: string, repeat: "none" | "yearly") {
    return reminderSchedule(due, repeat, this.#options.clock.now(), this.#options.timeZone);
  }

  async moveSchedule(input: {
    readonly reminderId: string;
    readonly expectedUpdatedAt: string;
    readonly dueAt: string;
    readonly remindAt: string;
  }): Promise<{ readonly updatedAt: string; readonly dueAt: string; readonly remindAt: string }> {
    const reminder = await this.#options.reminders.read(input.reminderId);
    const { ownerId, agentId } = this.#options.configuration;
    if (!reminder || reminder.ownerId !== ownerId || reminder.agentId !== agentId)
      throw new ReminderInputError("REMINDER_NOT_FOUND");
    if (reminder.status !== "scheduled" || reminder.updatedAt !== input.expectedUpdatedAt)
      throw new ReminderInputError("REMINDER_UNAVAILABLE");
    const now = this.#options.clock.now();
    const updatedAt =
      Date.parse(now) > Date.parse(reminder.updatedAt)
        ? now
        : new Date(Date.parse(reminder.updatedAt) + 1).toISOString();
    const updated = await this.#options.reminders.update({
      id: reminder.id,
      expectedUpdatedAt: input.expectedUpdatedAt,
      status: "scheduled",
      dueAt: input.dueAt,
      remindAt: input.remindAt,
      dismissedAt: null,
      updatedAt,
    });
    if (!updated) throw new ReminderInputError("REMINDER_UNAVAILABLE");
    return { updatedAt, dueAt: input.dueAt, remindAt: input.remindAt };
  }

  async withdraw(reminderId: string): Promise<void> {
    const remove = this.#options.memory.delete;
    if (remove === undefined) throw new ReminderInputError("REMINDER_MEMORY_NOT_READY");
    const reminder = await this.cancel(reminderId);
    const generation = await this.#options.book.latestGeneration(this.#scope());
    if (!generation) throw new ReminderInputError("REMINDER_MEMORY_NOT_READY");
    const memory = await this.#options.state.read(reminder.memoryId);
    if (
      memory === undefined ||
      memory.status === "deletion_pending" ||
      memory.status === "deleted_verified"
    )
      return;
    await remove.call(this.#options.memory, reminder.memoryId, generation);
  }

  async cancel(reminderId: string): Promise<MemoryReminder> {
    const reminder = await this.#options.reminders.read(reminderId);
    const { ownerId, agentId } = this.#options.configuration;
    if (!reminder || reminder.ownerId !== ownerId || reminder.agentId !== agentId)
      throw new ReminderInputError("REMINDER_NOT_FOUND");
    if (reminder.status === "cancelled") return reminder;
    const now = this.#options.clock.now();
    const updated = await this.#options.reminders.update({
      id: reminder.id,
      expectedUpdatedAt: reminder.updatedAt,
      status: "cancelled",
      dueAt: reminder.dueAt,
      remindAt: reminder.remindAt,
      dismissedAt: now,
      updatedAt: now === reminder.updatedAt ? new Date(Date.parse(now) + 1).toISOString() : now,
    });
    if (!updated) throw new ReminderInputError("REMINDER_UNAVAILABLE");
    return reminder;
  }
}

export function localTimeText(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .formatToParts(new Date(instant))
    .reduce<Record<string, string>>((all, { type, value }) => {
      all[type] = value;
      return all;
    }, {});
  return `${parts["year"]}-${parts["month"]}-${parts["day"]} ${parts["hour"]}:${parts["minute"]}`;
}

export interface ProductionReminderToolsOptions {
  readonly writer: Pick<ProductionReminderWriter, "create" | "list" | "cancel">;
  readonly timeZone?: string;
}

export class ProductionReminderTools {
  readonly #writer: ProductionReminderToolsOptions["writer"];
  readonly #timeZone: string;

  constructor(options: ProductionReminderToolsOptions) {
    this.#writer = options.writer;
    this.#timeZone = options.timeZone ?? "UTC";
  }

  #local(instant: string) {
    return `${localTimeText(instant, this.#timeZone)}（${this.#timeZone}）`;
  }

  async run(
    invocation: RuntimeToolInvocation,
    provenance: { readonly externalOrigins?: readonly string[] } = {},
  ): Promise<unknown> {
    const args = invocation.arguments;
    const names = Object.keys(args);
    if (invocation.capabilityRef === REMINDER_LIST_CAPABILITY_REF) {
      if (names.length > 0) throw new ReminderInputError("REMINDER_INPUT_INVALID");
      const listed = await this.#writer.list();
      return {
        reminders: listed.reminders.map((reminder) => ({
          reminderId: reminder.reminderId,
          text: reminder.text,
          due: this.#local(reminder.dueAt),
          repeat: reminder.repeat,
        })),
        ...(listed.more ? { more: true } : {}),
      };
    }
    if (invocation.capabilityRef === REMINDER_CANCEL_CAPABILITY_REF) {
      const reminderId = args["reminderId"];
      if (
        typeof reminderId !== "string" ||
        reminderId.length === 0 ||
        reminderId.length > 256 ||
        names.some((name) => !CANCEL_ARGUMENTS.includes(name))
      )
        throw new ReminderInputError("REMINDER_INPUT_INVALID");
      const cancelled = await this.#writer.cancel(reminderId);
      return { cancelled: true, reminderId, due: this.#local(cancelled.dueAt) };
    }
    const text = args["text"];
    const due = args["due"];
    const repeat = args["repeat"] ?? "none";
    if (
      typeof text !== "string" ||
      typeof due !== "string" ||
      (repeat !== "none" && repeat !== "yearly") ||
      names.some((name) => !SET_ARGUMENTS.includes(name))
    )
      throw new ReminderInputError("REMINDER_INPUT_INVALID");
    const created = await this.#writer.create({
      key: `${invocation.runId}:${invocation.toolCallId}`.replace(/[^A-Za-z0-9:._-]/gu, "_"),
      text,
      due,
      repeat,
      sourceThreadId: invocation.context?.threadId ?? null,
      ...(provenance.externalOrigins?.length
        ? { externalOrigins: provenance.externalOrigins }
        : {}),
    });
    return {
      created: true,
      reminderId: created.reminderId,
      due: this.#local(created.dueAt),
      remindAt: this.#local(created.remindAt),
      repeat: created.repeat,
      note: TOOL_RESULT_REMINDER_SET.text,
    };
  }
}
