import type { AgentId, MemoryId, OwnerId } from "@himawari-agent/domain";
import type {
  DataClassification,
  MemoryCategory,
  PayloadRef,
  ProductMemoryRecord,
  ProductMemoryStatePort,
} from "../ports/index.js";

export const OWNER_PROFILE_CHARACTER_BUDGET = 2000;
const PROFILE_MINIMUM_IMPORTANCE = 600;
const PROFILE_CLASSIFICATIONS = new Set<DataClassification>(["public", "private"]);
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
  readonly kind: "owner-rules" | "owner-profile";
  readonly ref: string;
  readonly payloadRef: PayloadRef;
  readonly dataClassification: DataClassification;
  readonly memoryIds: readonly MemoryId[];
}

export interface OwnerProfile {
  readonly blocks: readonly OwnerProfileBlock[];
  readonly memoryIds: readonly MemoryId[];
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
}

function currentlyValid(memory: ProductMemoryRecord, now: string): boolean {
  const attributes = memory.attributes;
  if (!attributes) return false;
  if (attributes.supersededBy !== null) return false;
  return attributes.validTo === null || attributes.validTo > now;
}

function byImportance(left: ProductMemoryRecord, right: ProductMemoryRecord): number {
  return (
    (right.attributes?.importancePermille ?? 0) - (left.attributes?.importancePermille ?? 0) ||
    left.id.localeCompare(right.id)
  );
}

export class OwnerProfileService implements OwnerProfilePort {
  readonly #options: OwnerProfileServiceOptions;

  constructor(options: OwnerProfileServiceOptions) {
    this.#options = options;
  }

  async compose(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly maxClassification: DataClassification;
    readonly now: string;
  }): Promise<OwnerProfile> {
    const ceiling = Math.min(
      CLASSIFICATION_RANK[input.maxClassification],
      CLASSIFICATION_RANK.private,
    );
    const eligible = (await this.#options.state.listActive(input.ownerId, input.agentId)).filter(
      (memory) =>
        memory.status === "active" &&
        PROFILE_CLASSIFICATIONS.has(memory.dataClassification) &&
        CLASSIFICATION_RANK[memory.dataClassification] <= ceiling &&
        currentlyValid(memory, input.now),
    );
    let remaining = this.#options.characterBudget ?? OWNER_PROFILE_CHARACTER_BUDGET;
    const take = async (memories: readonly ProductMemoryRecord[]) => {
      const lines: { memory: ProductMemoryRecord; text: string }[] = [];
      for (const memory of [...memories].sort(byImportance)) {
        const text = (await this.#options.readText(memory))?.replace(/\s+/gu, " ").trim();
        if (!text || text.length + 3 > remaining) continue;
        remaining -= text.length + 3;
        lines.push({ memory, text });
      }
      return lines;
    };
    const rules = await take(eligible.filter((memory) => memory.attributes?.category === "rule"));
    const sections: { title: string; lines: { memory: ProductMemoryRecord; text: string }[] }[] =
      [];
    const profileCandidates = eligible.filter(
      (memory) => (memory.attributes?.importancePermille ?? 0) >= PROFILE_MINIMUM_IMPORTANCE,
    );
    const chosen = await take(
      profileCandidates.filter((memory) =>
        PROFILE_SECTIONS.some(([category]) => memory.attributes?.category === category),
      ),
    );
    for (const [category, title] of PROFILE_SECTIONS) {
      const lines = chosen
        .filter(({ memory }) => memory.attributes?.category === category)
        .sort((left, right) => byImportance(left.memory, right.memory));
      if (lines.length > 0) sections.push({ title, lines });
    }
    const blocks: OwnerProfileBlock[] = [];
    if (rules.length > 0)
      blocks.push(
        await this.#block(
          input,
          "owner-rules",
          [
            "主人对 Himawari 的要求（主人亲口说过的，回答时遵守）：",
            ...rules.map(({ text }) => `- ${text}`),
          ].join("\n"),
          rules.map(({ memory }) => memory),
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
              ...lines.map(({ text }) => `- ${text}`),
            ]),
          ].join("\n"),
          sections.flatMap(({ lines }) => lines.map(({ memory }) => memory)),
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
  ): Promise<OwnerProfileBlock> {
    const dataClassification = memories.some(
      ({ dataClassification }) => dataClassification === "private",
    )
      ? "private"
      : "public";
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
