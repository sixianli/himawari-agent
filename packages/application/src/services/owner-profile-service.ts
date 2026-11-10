import type { AgentId, MemoryId, OwnerId } from "@himawari-agent/domain";
import type {
  DataClassification,
  MemoryBookStorePort,
  MemoryCategory,
  MemoryReminderStorePort,
  PayloadRef,
  ProductMemoryRecord,
  ProductMemoryStatePort,
} from "../ports/index.js";
import { memoryDateNote, memoryDatesOf } from "../ports/memory-dates.js";
import { highestClassification, modelVisibleCeiling } from "./model-visibility.js";

export const OWNER_PROFILE_CHARACTER_BUDGET = 2000;
const AGENDA_CHARACTER_BUDGET = 800;
const AGENDA_HORIZON_MS = 7 * 24 * 3_600_000;
const AGENDA_LIMIT = 10;
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
}

export interface OwnerProfileLine {
  readonly memoryId: MemoryId;
  readonly text: string;
  readonly updatedAt: string;
}

export interface OwnerProfileUsage {
  readonly used: number;
  readonly limit: number;
  readonly queued: readonly MemoryId[];
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
    const line = ({ memory, text }: { memory: ProductMemoryRecord; text: string }) =>
      Object.freeze({ memoryId: memory.id, text, updatedAt: memory.updatedAt });
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
    const valid = (await this.#options.state.listActive(input.ownerId, input.agentId)).filter(
      (memory) =>
        memory.status === "active" &&
        CLASSIFICATION_RANK[memory.dataClassification] <= ceiling &&
        currentlyValid(memory, input.now),
    );
    const eligible = valid.filter((memory) => choices.get(memory.id) !== false);
    const limit = this.#options.characterBudget ?? OWNER_PROFILE_CHARACTER_BUDGET;
    let remaining = limit;
    const queued: MemoryId[] = [];
    const take = async (memories: readonly ProductMemoryRecord[], dated: boolean) => {
      const lines: { memory: ProductMemoryRecord; text: string; dateNote: string }[] = [];
      for (const memory of [...memories].sort(ownerFirst(pinned))) {
        const text = (await this.#options.readText(memory))?.replace(/\s+/gu, " ").trim();
        if (!text) continue;
        const dateNote = dated
          ? memoryDateNote(memoryDatesOf(memory), this.#options.timeZone ?? "UTC")
          : "";
        const length = text.length + dateNote.length + 3;
        if (length > remaining) {
          queued.push(memory.id);
          continue;
        }
        remaining -= length;
        lines.push({ memory, text, dateNote });
      }
      return lines;
    };
    const rules = await take(
      eligible.filter((memory) => memory.attributes?.category === "rule"),
      false,
    );
    const sections: {
      category: MemoryCategory;
      title: string;
      lines: { memory: ProductMemoryRecord; text: string; dateNote: string }[];
    }[] = [];
    const profileCandidates = eligible.filter(
      (memory) =>
        pinned.has(memory.id) ||
        (memory.attributes?.importancePermille ?? 0) >= PROFILE_MINIMUM_IMPORTANCE,
    );
    const chosen = await take(
      profileCandidates.filter((memory) =>
        PROFILE_SECTIONS.some(([category]) => memory.attributes?.category === category),
      ),
      true,
    );
    for (const [category, title] of PROFILE_SECTIONS) {
      const lines = chosen
        .filter(({ memory }) => memory.attributes?.category === category)
        .sort((left, right) => ownerFirst(pinned)(left.memory, right.memory));
      if (lines.length > 0) sections.push({ category, title, lines });
    }
    const usage = Object.freeze({
      used: limit - remaining,
      limit,
      queued: Object.freeze(queued),
    });
    return { rules, sections, eligible: valid, usage };
  }

  async #agenda(
    input: { readonly ownerId: OwnerId; readonly agentId: AgentId; readonly now: string },
    eligible: readonly ProductMemoryRecord[],
  ) {
    const reminders = this.#options.reminders;
    if (!reminders) return [];
    const memories = new Map(eligible.map((memory) => [memory.id, memory]));
    const upcoming = await reminders.listUpcoming({
      ownerId: input.ownerId,
      agentId: input.agentId,
      from: input.now,
      to: new Date(Date.parse(input.now) + AGENDA_HORIZON_MS).toISOString(),
      limit: AGENDA_LIMIT,
    });
    const format = new Intl.DateTimeFormat("zh-CN", {
      timeZone: this.#options.timeZone ?? "UTC",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    let remaining = AGENDA_CHARACTER_BUDGET;
    const lines: { memory: ProductMemoryRecord; text: string }[] = [];
    for (const reminder of upcoming) {
      const memory = memories.get(reminder.memoryId);
      if (!memory) continue;
      const text = (await this.#options.readText(memory))?.replace(/\s+/gu, " ").trim();
      if (!text) continue;
      const line = `${format.format(new Date(reminder.dueAt))}：${text}`;
      if (line.length + 3 > remaining) continue;
      remaining -= line.length + 3;
      lines.push({ memory, text: line });
    }
    return lines;
  }

  async compose(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly maxClassification: DataClassification;
    readonly now: string;
  }): Promise<OwnerProfile> {
    const { rules, sections, eligible } = await this.#select(input);
    const agenda = await this.#agenda(input, eligible);
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
    if (agenda.length > 0)
      blocks.push(
        await this.#block(
          input,
          "owner-agenda",
          [
            `主人接下来 7 天的安排（时间为主人当地时间，${this.#options.timeZone ?? "UTC"}）：`,
            ...agenda.map(({ text }) => `- ${text}`),
          ].join("\n"),
          agenda.map(({ memory }) => memory),
        ),
      );
    return Object.freeze({
      blocks: Object.freeze(blocks),
      memoryIds: Object.freeze(blocks.flatMap(({ memoryIds }) => memoryIds)),
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
