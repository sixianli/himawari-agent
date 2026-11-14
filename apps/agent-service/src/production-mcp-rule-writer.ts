import {
  ApplicationPortError,
  type ClockPort,
  type PayloadProtectorPort,
  type PayloadStorePort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
} from "@himawari-agent/application";
import type { ProductionOwnerRuleWriter, RulePreview } from "./production-owner-rules.js";

export const EXTERNAL_RULE_KEY_PREFIX = "mcp:";
export const EXTERNAL_RULE_MEMORY_PREFIX = "memory:rule:mcp:";
export const EXTERNAL_RULE_DECISION_PREFIX = "rule-decision:mcp:";
export const EXTERNAL_RULE_SOURCE_PREFIX = "mcp:";
export const EXTERNAL_RULE_REASON_MAXIMUM = 200;
export const EXTERNAL_RULE_TYPES = ["mail_must_notify", "mail_read_whole_thread"] as const;

export type ExternalRuleType = (typeof EXTERNAL_RULE_TYPES)[number];

export interface ExternalRuleProposal {
  readonly proposalId: string;
  readonly type: ExternalRuleType;
  readonly params: unknown;
  readonly summary: string;
  readonly reason: string;
  readonly client: string;
}

export interface ProductionMcpRuleWriterOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly rules: Pick<ProductionOwnerRuleWriter, "preview" | "create" | "confirm" | "storedFor">;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly onFailure: (error: unknown) => void;
}

export function externalRuleQuote(client: string, reason: string): string {
  return `外部 agent「${client}」提议：${reason}`;
}

export class ProductionMcpRuleWriter {
  readonly #options: ProductionMcpRuleWriterOptions;

  constructor(options: ProductionMcpRuleWriterOptions) {
    this.#options = options;
  }

  #scope() {
    const { ownerId, agentId } = this.#options.configuration;
    return { ownerId, agentId };
  }

  preview(input: {
    readonly type: string;
    readonly params: unknown;
    readonly summary: string;
  }): Promise<RulePreview> {
    return this.#options.rules.preview(input);
  }

  async decided(proposalId: string): Promise<boolean> {
    return (
      (await this.#options.payloads.get(`${EXTERNAL_RULE_DECISION_PREFIX}${proposalId}`)) !==
        undefined ||
      (await this.#options.rules.storedFor(`${EXTERNAL_RULE_KEY_PREFIX}${proposalId}`))
    );
  }

  async accept(proposal: ExternalRuleProposal): Promise<string> {
    const receipt = await this.#options.rules.create({
      key: `${EXTERNAL_RULE_KEY_PREFIX}${proposal.proposalId}`,
      quote: externalRuleQuote(proposal.client, proposal.reason),
      inferred: true,
      type: proposal.type,
      params: proposal.params,
      summary: proposal.summary,
      threadId: null,
      source: `${EXTERNAL_RULE_SOURCE_PREFIX}${proposal.client}`,
      listed: false,
    });
    if (receipt.status !== "proposed" || receipt.proposalId === null)
      throw new Error("MCP_RULE_PROPOSAL_NOT_STORED");
    const active = await this.#options.rules.confirm(receipt.proposalId);
    if (active.ruleId === null) throw new Error("MCP_RULE_NOT_ACTIVE");
    try {
      await this.#options.payloads.put(
        await this.#options.protector.protect({
          ...this.#scope(),
          ref: `${EXTERNAL_RULE_DECISION_PREFIX}${proposal.proposalId}`,
          contentType: "text/plain",
          dataClassification: "private",
          plaintext: new TextEncoder().encode(active.ruleId),
          createdAt: this.#options.clock.now(),
        }),
      );
    } catch (error) {
      if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.DUPLICATE)
        this.#options.onFailure(error);
    }
    return active.ruleId;
  }
}
