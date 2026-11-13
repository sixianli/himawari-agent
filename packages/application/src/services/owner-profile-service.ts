import type { AgentId, MemoryId, OwnerId } from "@himawari-agent/domain";
import {
  OWNER_AGENDA_ENDING,
  OWNER_AGENDA_OMITTED,
  OWNER_AGENDA_UNREMINDED,
  renderPrompt,
} from "@himawari-agent/prompt-catalog";
import type {
  DataClassification,
  MemoryBookStorePort,
  MemoryCategory,
  MemoryReminderStorePort,
  PayloadRef,
  ProductMemoryRecord,
  ProductMemoryStatePort,
} from "../ports/index.js";
import { memoryDateNote, memoryDatesOf, memoryLocalDate } from "../ports/memory-dates.js";
import { highestClassification, modelVisibleCeiling } from "./model-visibility.js";

export const OWNER_PROFILE_CHARACTER_BUDGET = 2000;
export const OWNER_AGENDA_CHARACTER_BUDGET = 2400;
const AGENDA_HORIZON_MS = 7 * 24 * 3_600_000;
const AGENDA_REMINDER_LIMIT = 100;
const PROFILE_MINIMUM_IMPORTANCE = 600;
const CLASSIFICATION_RANK: Record<DataClassification, number> = {
  public: 0,
  private: 1,
  sensitive: 2,
  restricted: 3,
};
const PROFILE_SECTIONS: readonly (readonly [MemoryCategory, string])[] = [
  ["identity", "身份"],
  ["preference", "偏好"],
  ["relationship", "人际关系"],
  ["goal", "长期目标"],
  ["project", "进行中的事"],
];

export interface OwnerProfileBlock {
  readonly kind: "owner-rules" | "owner-profile" | "owner-agenda";
  readonly ref: string;
  readonly payloadRef: PayloadRef;
  readonly dataClassification: DataClassification;
  readonly memoryIds: readonly MemoryId[];
}

export interface OwnerProfile {
  readonly blocks: readonly OwnerProfileBlock[];
  readonly memoryIds: readonly MemoryId[];
  readonly usage?: OwnerProfileUsage;
}

export interface OwnerProfileLine {
  readonly memoryId: MemoryId;
  readonly text: string;
  readonly updatedAt: string;
}

export interface OwnerProfileUsage {
  readonly used: number;
  readonly limit: number;
  readonly pinned: number;
  readonly queued: readonly MemoryId[];
}

interface ProfileLine {
  readonly memory: ProductMemoryRecord;
  readonly text: string;
  readonly dateNote: string;
  readonly length: number;
}

export interface OwnerProfileOutline {
  readonly usage: OwnerProfileUsage;
  readonly rules: readonly OwnerProfileLine[];
  readonly sections: readonly {
    readonly category: MemoryCategory;
    readonly title: string;
    readonly lines: readonly OwnerProfileLine[];
  }[];
}

export interface OwnerProfilePort {
  compose(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly maxClassification: DataClassification;
    readonly now: string;
  }): Promise<OwnerProfile>;
}

export interface OwnerProfileServiceOptions {
  readonly state: Pick<ProductMemoryStatePort, "listActive">;
  readonly readText: (memory: ProductMemoryRecord) => Promise<string | undefined>;
  readonly storeText: (input: {
    readonly ref: PayloadRef;
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly text: string;
    readonly dataClassification: DataClassification;
  }) => Promise<void>;
  readonly digest: (text: string) => string;
  readonly characterBudget?: number;
  readonly agendaCharacterBudget?: number;
  readonly reminders?: Pick<MemoryReminderStorePort, "listUpcoming">;
  readonly pins?: Pick<MemoryBookStorePort, "listProfilePins">;
  readonly timeZone?: string;
  readonly ownerName?: (input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
  }) => Promise<string | null>;
}

function currentlyValid(memory: ProductMemoryRecord, now: string): boolean {
  const attributes = memory.attributes;
  if (!attributes) return false;
  if (attributes.supersededBy !== null || attributes.tentative === true) return false;
  return attributes.validTo === null || attributes.validTo > now;
}

function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function byImportance(left: ProductMemoryRecord, right: ProductMemoryRecord): number {
  return (
    (right.attributes?.importancePermille ?? 0) - (left.attributes?.importancePermille ?? 0) ||
    left.id.localeCompare(right.id)
  );
}

function ownerFirst(pinned: ReadonlySet<MemoryId>) {
  return (left: ProductMemoryRecord, right: ProductMemoryRecord): number =>
    Number(pinned.has(right.id)) - Number(pinned.has(left.id)) || byImportance(left, right);
}

export class OwnerProfileService implements OwnerProfilePort {
  readonly #options: OwnerProfileServiceOptions;

  constructor(options: OwnerProfileServiceOptions) {
    this.#options = options;
  }

  async outline(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly maxClassification: DataClassification;
    readonly now: string;
  }): Promise<OwnerProfileOutline> {
    const { rules, sections, usage } = await this.#select(input);
    const line = ({
      memory,
      text,
      dateNote,
    }: {
      memory: ProductMemoryRecord;
      text: string;
      dateNote: string;
    }) =>
      Object.freeze({
        memoryId: memory.id,
        text: `${text}${dateNote}`,
        updatedAt: memory.updatedAt,
      });
    return Object.freeze({
      usage,
      rules: Object.freeze(rules.map(line)),
      sections: Object.freeze(
        sections.map(({ category, title, lines }) =>
          Object.freeze({ category, title, lines: Object.freeze(lines.map(line)) }),
        ),
      ),
    });
  }

  async #select(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly maxClassification: DataClassification;
    readonly now: string;
  }) {
    const ceiling = Math.min(
      CLASSIFICATION_RANK[input.maxClassification],
      CLASSIFICATION_RANK[modelVisibleCeiling()],
    );
    const choices = new Map(
      (
        (await this.#options.pins?.listProfilePins({
          ownerId: input.ownerId,
          agentId: input.agentId,
        })) ?? []
      ).map(({ memoryId, pinned }) => [memoryId, pinned]),
    );
    const pinned = new Set([...choices].flatMap(([memoryId, on]) => (on ? [memoryId] : [])));
    const declined = new Set([...choices].flatMap(([memoryId, on]) => (on ? [] : [memoryId])));
    const valid = (await this.#options.state.listActive(input.ownerId, input.agentId)).filter(
      (memory) =>
        memory.status === "active" &&
        CLASSIFICATION_RANK[memory.dataClassification] <= ceiling &&
        currentlyValid(memory, input.now),
    );
    const eligible = valid.filter((memory) => choices.get(memory.id) !== false);
    const limit = this.#options.characterBudget ?? OWNER_PROFILE_CHARACTER_BUDGET;
    const read = async (memories: readonly ProductMemoryRecord[], dated: boolean) => {
      const lines: ProfileLine[] = [];
      for (const memory of [...memories].sort(ownerFirst(pinned))) {
        const text = (await this.#options.readText(memory))?.replace(/\s+/gu, " ").trim();
        if (!text) continue;
        const dateNote = dated
          ? memoryDateNote(memoryDatesOf(memory), this.#options.timeZone ?? "UTC")
          : "";
        lines.push({ memory, text, dateNote, length: text.length + dateNote.length + 3 });
      }
      return lines;
    };
    const ruleLines = await read(
      eligible.filter((memory) => memory.attributes?.category === "rule"),
      false,
    );
    const factLines = await read(
      eligible.filter(
        (memory) =>
          (pinned.has(memory.id) ||
            (memory.attributes?.importancePermille ?? 0) >= PROFILE_MINIMUM_IMPORTANCE) &&
          PROFILE_SECTIONS.some(([category]) => memory.attributes?.category === category),
      ),
      true,
    );
    const pinnedUsed = [...ruleLines, ...factLines]
      .filter(({ memory }) => pinned.has(memory.id))
      .reduce((sum, { length }) => sum + length, 0);
    let remaining = limit - pinnedUsed;
    const queued: MemoryId[] = [];
    const fit = (lines: readonly ProfileLine[]) =>
      lines.filter(({ memory, length }) => {
        if (pinned.has(memory.id)) return true;
        if (length > remaining) {
          queued.push(memory.id);
          return false;
        }
        remaining -= length;
        return true;
      });
    const rules = fit(ruleLines);
    const chosen = fit(factLines);
    const sections: {
      category: MemoryCategory;
      title: string;
      lines: ProfileLine[];
    }[] = [];
    for (const [category, title] of PROFILE_SECTIONS) {
      const lines = chosen
        .filter(({ memory }) => memory.attributes?.category === category)
        .sort((left, right) => ownerFirst(pinned)(left.memory, right.memory));
      if (lines.length > 0) sections.push({ category, title, lines });
    }
    const usage = Object.freeze({
      used: limit - remaining,
      limit,
      pinned: pinnedUsed,
      queued: Object.freeze(queued),
    });
    return { rules, sections, eligible: valid, declined, usage };
  }

  async #agenda(
    input: { readonly ownerId: OwnerId; readonly agentId: AgentId; readonly now: string },
    eligible: readonly ProductMemoryRecord[],
    declined: ReadonlySet<MemoryId>,
  ) {
    const timeZone = this.#options.timeZone ?? "UTC";
    const now = Date.parse(input.now);
    const until = new Date(now + AGENDA_HORIZON_MS).toISOString();
    const firstDay = memoryLocalDate(input.now, timeZone);
    const lastDay = memoryLocalDate(until, timeZone);
    const memories = new Map(eligible.map((memory) => [memory.id, memory]));
    const listed = await this.#options.reminders?.listUpcoming({
      ownerId: input.ownerId,
      agentId: input.agentId,
      from: input.now,
      to: until,
      limit: AGENDA_REMINDER_LIMIT,
    });
    const upcoming = listed ?? [];
    const remindersComplete = listed !== undefined && listed.length < AGENDA_REMINDER_LIMIT;
    const timed = new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const dayOnly = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "UTC",
      month: "numeric",
      day: "numeric",
      weekday: "short",
    });
    const entries: {
      memory: ProductMemoryRecord;
      day: string;
      timed: boolean;
      instant: string;
      tie: string;
      label: string;
    }[] = [];
    const reminded = new Set<MemoryId>();
    for (const reminder of upcoming) {
      const memory = memories.get(reminder.memoryId);
      if (!memory) continue;
      reminded.add(memory.id);
      entries.push({
        memory,
        day: memoryLocalDate(reminder.dueAt, timeZone),
        timed: true,
        instant: reminder.dueAt,
        tie: reminder.id,
        label: timed.format(new Date(reminder.dueAt)),
      });
    }
    const dayInWindow = (value: string | null): string | null => {
      if (value === null) return null;
      const instant = Date.parse(value);
      if (value.includes("T") && (instant <= now || instant > now + AGENDA_HORIZON_MS)) return null;
      const day = memoryLocalDate(value, timeZone);
      return day >= firstDay && day <= lastDay ? day : null;
    };
    for (const memory of eligible) {
      if (reminded.has(memory.id) || declined.has(memory.id)) continue;
      const dates = memoryDatesOf(memory);
      for (const [value, ending] of [
        [dates.validFrom, false],
        [dates.validTo, true],
      ] as const) {
        const day = dayInWindow(value);
        if (day === null) continue;
        const shown = dayOnly.format(new Date(`${day}T12:00:00.000Z`));
        const label = ending ? renderPrompt(OWNER_AGENDA_ENDING, { day: shown }) : shown;
        entries.push({
          memory,
          day,
          timed: false,
          instant: "",
          tie: memory.id,
          label: remindersComplete ? renderPrompt(OWNER_AGENDA_UNREMINDED, { label }) : label,
        });
      }
    }
    entries.sort(
      (left, right) =>
        byCodeUnit(left.day, right.day) ||
        Number(left.timed) - Number(right.timed) ||
        byCodeUnit(left.instant, right.instant) ||
        byCodeUnit(left.tie, right.tie) ||
        byCodeUnit(left.label, right.label),
    );
    let remaining = this.#options.agendaCharacterBudget ?? OWNER_AGENDA_CHARACTER_BUDGET;
    let omitted = 0;
    const lines: { memory: ProductMemoryRecord; text: string }[] = [];
    for (const entry of entries) {
      const text = (await this.#options.readText(entry.memory))?.replace(/\s+/gu, " ").trim();
      if (!text) continue;
      const line = `${entry.label}：${text}`;
      if (line.length + 3 > remaining) {
        omitted += 1;
        continue;
      }
      remaining -= line.length + 3;
      lines.push({ memory: entry.memory, text: line });
    }
    return { lines, omitted };
  }

  async compose(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly maxClassification: DataClassification;
    readonly now: string;
  }): Promise<OwnerProfile> {
    const { rules, sections, eligible, declined, usage } = await this.#select(input);
    const agenda = await this.#agenda(input, eligible, declined);
    const blocks: OwnerProfileBlock[] = [];
    const name =
      CLASSIFICATION_RANK[input.maxClassification] >= CLASSIFICATION_RANK.private
        ? (await this.#options.ownerName?.(input))?.replace(/\s+/gu, " ").trim()
        : undefined;
    if (rules.length > 0 || name)
      blocks.push(
        await this.#block(
          input,
          "owner-rules",
          [
            name
              ? "主人对 Himawari 的要求（主人亲口说过或在设置里填写的，回答时遵守）："
              : "主人对 Himawari 的要求（主人亲口说过的，回答时遵守）：",
            ...(name
              ? [
                  `- 主人在设置里填写的称呼是「${name}」，称呼主人时用它；对话里出现过不同的称呼时，以最后出现的为准。`,
                ]
              : []),
            ...rules.map(({ text }) => `- ${text}`),
          ].join("\n"),
          rules.map(({ memory }) => memory),
          name ? "private" : undefined,
        ),
      );
    if (sections.length > 0)
      blocks.push(
        await this.#block(
          input,
          "owner-profile",
          [
            "主人档案（由已确认的长期记忆整理）：",
            ...sections.flatMap(({ title, lines }) => [
              `${title}：`,
              ...lines.map(({ text, dateNote }) => `- ${text}${dateNote}`),
            ]),
          ].join("\n"),
          sections.flatMap(({ lines }) => lines.map(({ memory }) => memory)),
        ),
      );
    if (agenda.lines.length > 0 || agenda.omitted > 0)
      blocks.push(
        await this.#block(
          input,
          "owner-agenda",
          [
            `主人接下来 7 天的安排（时间为主人当地时间，${this.#options.timeZone ?? "UTC"}）：`,
            ...agenda.lines.map(({ text }) => `- ${text}`),
            ...(agenda.omitted > 0
              ? [renderPrompt(OWNER_AGENDA_OMITTED, { count: String(agenda.omitted) })]
              : []),
          ].join("\n"),
          [...new Set(agenda.lines.map(({ memory }) => memory))],
        ),
      );
    return Object.freeze({
      blocks: Object.freeze(blocks),
      memoryIds: Object.freeze(blocks.flatMap(({ memoryIds }) => memoryIds)),
      usage,
    });
  }

  async #block(
    input: { readonly ownerId: OwnerId; readonly agentId: AgentId },
    kind: OwnerProfileBlock["kind"],
    text: string,
    memories: readonly ProductMemoryRecord[],
    floor?: DataClassification,
  ): Promise<OwnerProfileBlock> {
    const dataClassification = highestClassification(
      floor ?? "public",
      memories.map(({ dataClassification }) => dataClassification),
    );
    const digest = this.#options.digest(
      JSON.stringify([kind, input.ownerId, input.agentId, dataClassification, text]),
    );
    const payloadRef = `${kind}:${digest}`;
    await this.#options.storeText({
      ref: payloadRef,
      ownerId: input.ownerId,
      agentId: input.agentId,
      text,
      dataClassification,
    });
    return Object.freeze({
      kind,
      ref: `${kind}:${input.agentId}`,
      payloadRef,
      dataClassification,
      memoryIds: Object.freeze(memories.map(({ id }) => id)),
    });
  }
}
