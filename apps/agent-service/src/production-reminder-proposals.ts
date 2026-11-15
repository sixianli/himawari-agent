import { createHash } from "node:crypto";
import { ApplicationPortError, type ClockPort } from "@himawari-agent/application";
import {
  localTimeText,
  type ProductionReminderWriter,
  ReminderInputError,
} from "./production-reminder-writer.js";
import {
  type ProductionProposalBox,
  type ProposalActionHandler,
  ProposalError,
  type ProposalEvidence,
  type ProposalPremises,
  type ProposalSource,
} from "./production-proposals.js";

export const REMINDER_RESCHEDULE_PROPOSAL_TYPE = "reminder.reschedule";
export const REMINDER_CREATE_PROPOSAL_TYPE = "reminder.create";

const SHOWN_TEXT_LENGTH = 60;
const FULL_READ_TEXT_LENGTH = 120;

type Writer = Pick<
  ProductionReminderWriter,
  "create" | "describe" | "schedulePreview" | "moveSchedule" | "withdraw"
>;

interface RescheduleData {
  readonly reminderId: string;
  readonly expectedUpdatedAt: string;
  readonly dueAt: string;
  readonly remindAt: string;
}

interface CreateData {
  readonly text: string;
  readonly due: string;
  readonly repeat: "none" | "yearly";
  readonly dueAt: string;
  readonly threadId: string | null;
  readonly externalOrigins: readonly string[];
}

interface RescheduleOriginal {
  readonly dueAt: string;
  readonly remindAt: string;
  readonly updatedAt: string;
}

interface CreateOriginal {
  readonly reminderId: string;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function rescheduleData(value: unknown): RescheduleData | undefined {
  const record = (value ?? {}) as Record<string, unknown>;
  const { reminderId, expectedUpdatedAt, dueAt, remindAt } = record;
  return isText(reminderId) && isText(expectedUpdatedAt) && isText(dueAt) && isText(remindAt)
    ? { reminderId, expectedUpdatedAt, dueAt, remindAt }
    : undefined;
}

function createData(value: unknown): CreateData | undefined {
  const record = (value ?? {}) as Record<string, unknown>;
  const { text, due, repeat, dueAt, threadId, externalOrigins } = record;
  if (!isText(text) || !isText(due) || !isText(dueAt)) return undefined;
  if (repeat !== "none" && repeat !== "yearly") return undefined;
  if (threadId !== null && !isText(threadId)) return undefined;
  if (!Array.isArray(externalOrigins) || !externalOrigins.every(isText)) return undefined;
  return { text, due, repeat, dueAt, threadId, externalOrigins };
}

function rescheduleOriginal(value: unknown): RescheduleOriginal | undefined {
  const record = (value ?? {}) as Record<string, unknown>;
  const { dueAt, remindAt, updatedAt } = record;
  return isText(dueAt) && isText(remindAt) && isText(updatedAt)
    ? { dueAt, remindAt, updatedAt }
    : undefined;
}

function createOriginal(value: unknown): CreateOriginal | undefined {
  const reminderId = ((value ?? {}) as Record<string, unknown>)["reminderId"];
  return isText(reminderId) ? { reminderId } : undefined;
}

function refused(reason: string): ProposalPremises {
  return { ok: false, reason };
}

async function unlessInputError<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ReminderInputError)
      throw new ProposalError("PROPOSAL_NOT_UNDOABLE", error.code);
    throw error;
  }
}

export function registerReminderProposalHandlers(options: {
  readonly box: Pick<ProductionProposalBox, "register">;
  readonly writer: Writer;
  readonly clock: ClockPort;
}): void {
  const { box, writer, clock } = options;
  const reschedule: ProposalActionHandler = {
    kind: "action",
    async verify({ data }) {
      const parsed = rescheduleData(data);
      if (!parsed) return refused("提议内容不完整");
      const found = await writer.describe(parsed.reminderId);
      if (!found) return refused("这条提醒已经不在了");
      if (found.reminder.status !== "scheduled") return refused("这条提醒已经不再生效");
      if (found.reminder.updatedAt !== parsed.expectedUpdatedAt)
        return refused("这条提醒在提议之后被改过");
      const dueAt = Date.parse(parsed.dueAt);
      const remindAt = Date.parse(parsed.remindAt);
      if (
        !Number.isFinite(dueAt) ||
        !Number.isFinite(remindAt) ||
        remindAt > dueAt ||
        new Date(dueAt).toISOString() !== parsed.dueAt ||
        new Date(remindAt).toISOString() !== parsed.remindAt
      )
        return refused("提议里的时间不对");
      if (dueAt <= Date.parse(clock.now())) return refused("新的时间已经过了");
      return { ok: true };
    },
    async execute({ data }) {
      const parsed = rescheduleData(data);
      if (!parsed) throw new ReminderInputError("REMINDER_INPUT_INVALID");
      const found = await writer.describe(parsed.reminderId);
      if (!found) throw new ReminderInputError("REMINDER_NOT_FOUND");
      const remindAt =
        Date.parse(parsed.remindAt) > Date.parse(clock.now())
          ? parsed.remindAt
          : new Date(clock.now()).toISOString();
      const moved = await writer.moveSchedule({
        reminderId: parsed.reminderId,
        expectedUpdatedAt: parsed.expectedUpdatedAt,
        dueAt: parsed.dueAt,
        remindAt,
      });
      return {
        original: {
          dueAt: found.reminder.dueAt,
          remindAt: found.reminder.remindAt,
          updatedAt: moved.updatedAt,
        },
      };
    },
    async readBack({ data }) {
      const parsed = rescheduleData(data);
      if (!parsed) return "differs";
      const found = await writer.describe(parsed.reminderId);
      return found?.reminder.status === "scheduled" && found.reminder.dueAt === parsed.dueAt
        ? "matches"
        : "differs";
    },
    async undo({ data, original }) {
      await unlessInputError(async () => {
        const parsed = rescheduleData(data);
        const before = rescheduleOriginal(original);
        if (!parsed || !before) throw new ReminderInputError("REMINDER_INPUT_INVALID");
        const current = await writer.describe(parsed.reminderId);
        if (
          current?.reminder.status === "scheduled" &&
          current.reminder.dueAt === before.dueAt &&
          current.reminder.remindAt === before.remindAt
        )
          return;
        await writer.moveSchedule({
          reminderId: parsed.reminderId,
          expectedUpdatedAt: before.updatedAt,
          dueAt: before.dueAt,
          remindAt: before.remindAt,
        });
      });
    },
  };
  const create: ProposalActionHandler = {
    kind: "action",
    async verify({ data }) {
      const parsed = createData(data);
      if (!parsed) return refused("提议内容不完整");
      const schedule = writer.schedulePreview(parsed.due, parsed.repeat);
      if (!schedule) return refused("提醒的时间已经过了");
      if (schedule.dueAt !== parsed.dueAt)
        return refused("提醒的时间已经变了，和提议时看到的不一样");
      return { ok: true };
    },
    async execute({ proposalId, data }) {
      const parsed = createData(data);
      if (!parsed) throw new ReminderInputError("REMINDER_INPUT_INVALID");
      const request = {
        key: `proposal:${proposalId}`,
        text: parsed.text,
        due: parsed.due,
        repeat: parsed.repeat,
        expectedDueAt: parsed.dueAt,
        externalOrigins: parsed.externalOrigins,
      } as const;
      let created: Awaited<ReturnType<Writer["create"]>>;
      try {
        created = await writer.create({ ...request, sourceThreadId: parsed.threadId });
      } catch (error) {
        if (
          parsed.threadId === null ||
          !(error instanceof ApplicationPortError) ||
          error.code !== "PORT_NOT_FOUND"
        )
          throw error;
        created = await writer.create({ ...request, sourceThreadId: null });
      }
      return { original: { reminderId: created.reminderId }, detail: created.reminderId };
    },
    async readBack({ original }) {
      const made = createOriginal(original);
      if (!made) return "differs";
      const found = await writer.describe(made.reminderId);
      return found?.reminder.status === "scheduled" ? "matches" : "differs";
    },
    async undo({ original }) {
      await unlessInputError(async () => {
        const made = createOriginal(original);
        if (!made) throw new ReminderInputError("REMINDER_INPUT_INVALID");
        await writer.withdraw(made.reminderId);
      });
    },
  };
  box.register(REMINDER_RESCHEDULE_PROPOSAL_TYPE, reschedule);
  box.register(REMINDER_CREATE_PROPOSAL_TYPE, create);
}

function proposalId(prefix: string, parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
  return `${prefix}:${digest}`;
}

function clip(text: string, maximum: number): string {
  const characters = [...text.replace(/\s+/gu, " ").trim()];
  return characters.length <= maximum
    ? characters.join("")
    : `${characters.slice(0, maximum).join("")}…`;
}

function evidenceOf(
  text: string,
  sources: readonly { readonly kind: string; readonly ref: string }[],
): readonly ProposalEvidence[] {
  return [{ kind: "detail", text, sources, figures: [] }];
}

export interface ReminderProposalContext {
  readonly box: Pick<ProductionProposalBox, "propose">;
  readonly writer: Writer;
  readonly timeZone: string;
  readonly origin: "owner_said" | "inferred" | "external_agent" | "external_content";
  readonly threadId: string | null;
  readonly externalContentSeen?: boolean;
  readonly externalOrigins?: readonly string[];
  readonly source?: ProposalSource;
  readonly reason?: string;
}

export async function proposeReminderReschedule(
  context: ReminderProposalContext,
  input: { readonly reminderId: string; readonly due: string },
): Promise<{ readonly proposalId: string } | { readonly refused: string }> {
  const found = await context.writer.describe(input.reminderId);
  if (!found) return { refused: "REMINDER_NOT_FOUND" };
  if (found.reminder.status !== "scheduled") return { refused: "REMINDER_NOT_SCHEDULED" };
  const schedule = context.writer.schedulePreview(input.due, found.reminder.repeat);
  if (!schedule) return { refused: "REMINDER_TIME_INVALID" };
  if (schedule.dueAt === found.reminder.dueAt) return { refused: "REMINDER_TIME_UNCHANGED" };
  const id = proposalId("reminder-reschedule", [
    input.reminderId,
    found.reminder.updatedAt,
    schedule.dueAt,
  ]);
  const before = localTimeText(found.reminder.dueAt, context.timeZone);
  const after = localTimeText(schedule.dueAt, context.timeZone);
  const text = clip(found.text, SHOWN_TEXT_LENGTH);
  await context.box.propose({
    proposalId: id,
    type: REMINDER_RESCHEDULE_PROPOSAL_TYPE,
    summary: `提醒“${text}”：${before} 改到 ${after}`,
    effect: `这条提醒的时间从 ${before} 改成 ${after}（${context.timeZone}），可以撤销`,
    origin: context.origin,
    threadId: context.threadId,
    evidence: evidenceOf(context.reason ?? `提醒原文：${found.text}`, [
      { kind: "reminder", ref: input.reminderId },
    ]),
    data: {
      reminderId: input.reminderId,
      expectedUpdatedAt: found.reminder.updatedAt,
      dueAt: schedule.dueAt,
      remindAt: schedule.remindAt,
    },
    source: context.source ?? { ref: input.reminderId, version: found.reminder.updatedAt },
    ...(context.externalContentSeen === true ? { externalContentSeen: true } : {}),
  });
  return { proposalId: id };
}

export async function proposeReminderCreate(
  context: ReminderProposalContext,
  input: { readonly text: string; readonly due: string; readonly repeat?: "none" | "yearly" },
): Promise<{ readonly proposalId: string } | { readonly refused: string }> {
  const repeat = input.repeat ?? "none";
  const text = input.text.trim();
  if (text.length === 0 || text.length > 500) return { refused: "REMINDER_INPUT_INVALID" };
  const schedule = context.writer.schedulePreview(input.due, repeat);
  if (!schedule) return { refused: "REMINDER_TIME_INVALID" };
  const id = proposalId("reminder-create", [text, input.due.trim(), repeat, schedule.dueAt]);
  const when = localTimeText(schedule.dueAt, context.timeZone);
  await context.box.propose({
    proposalId: id,
    type: REMINDER_CREATE_PROPOSAL_TYPE,
    summary: `新建提醒“${clip(text, SHOWN_TEXT_LENGTH)}”：${when}`,
    effect: `新建一条提醒，${when}（${context.timeZone}）提醒你${repeat === "yearly" ? "，每年一次" : ""}，可以撤销`,
    origin: context.origin,
    threadId: context.threadId,
    evidence: evidenceOf(context.reason ?? `提醒原文：${text}`, []),
    data: {
      text,
      due: input.due.trim(),
      repeat,
      dueAt: schedule.dueAt,
      threadId: context.threadId,
      externalOrigins: context.externalOrigins ?? [],
    },
    requiresFullRead: [...text].length > FULL_READ_TEXT_LENGTH,
    ...(context.source ? { source: context.source } : {}),
    ...(context.externalContentSeen === true ? { externalContentSeen: true } : {}),
  });
  return { proposalId: id };
}
