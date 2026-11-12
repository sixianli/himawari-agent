import {
  ApplicationPortError,
  type ClockPort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
} from "@himawari-agent/application";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
import { type ProductionProposalBox, ProposalError } from "./production-proposals.js";

export const PRODUCTION_PROPOSAL_OPERATIONS = Object.freeze([
  "proposals.read",
  "proposal.respond",
] as const);

const EVIDENCE_SHOWN = 20;
const SOURCES_SHOWN = 10;
const FIGURES_SHOWN = 10;

function shown(text: string, maximum: number): string {
  return Array.from(
    text
      .replace(/\p{Bidi_Control}/gu, "")
      .replace(/\p{Cc}/gu, " ")
      .trim(),
  )
    .slice(0, maximum)
    .join("");
}

export interface ProductionProposalControlOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly box: Pick<ProductionProposalBox, "list" | "adopt" | "reject">;
  readonly clock: ClockPort;
}

export class ProductionProposalControl {
  readonly #options: ProductionProposalControlOptions;

  constructor(options: ProductionProposalControlOptions) {
    this.#options = options;
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type !== "proposals.read")
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "PROPOSAL_OPERATION_NOT_INSTALLED",
      );
    const listed = await this.#options.box.list();
    return {
      ...query,
      kind: "snapshot",
      type: "proposals.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        proposals: listed.proposals.map((proposal) => ({
          proposalId: proposal.proposalId,
          version: proposal.version,
          fingerprint: proposal.fingerprint,
          type: shown(proposal.type, 64),
          summary: shown(proposal.summary, 200),
          effect: shown(proposal.effect, 200),
          origin: proposal.origin,
          adoptable: proposal.adoptable,
          evidence: proposal.evidence.slice(0, EVIDENCE_SHOWN).map((item) => ({
            kind: shown(item.kind, 64),
            text: item.text === null ? null : shown(item.text, 500) || null,
            sources: item.sources
              .slice(0, SOURCES_SHOWN)
              .map((source) => ({ kind: shown(source.kind, 64), ref: shown(source.ref, 256) }))
              .filter((source) => source.kind.length > 0 && source.ref.length > 0),
            figures: item.figures
              .slice(0, FIGURES_SHOWN)
              .map((figure) => ({
                name: shown(figure.name, 64),
                value: figure.value,
                definition: shown(figure.definition, 200),
              }))
              .filter((figure) => figure.name.length > 0 && figure.definition.length > 0),
          })),
          proposedAt: proposal.proposedAt,
          expiresAt: proposal.expiresAt,
          refusedBefore: proposal.refusedBefore,
        })),
        pendingCount: listed.pendingCount,
        limit: listed.limit,
        expiresAfterDays: listed.expiresAfterDays,
        generatedAt: this.#options.clock.now(),
      },
    };
  }

  async execute(command: GatewayV2Command): Promise<{ resultRef: string; replayed: boolean }> {
    const { ownerId, agentId } = this.#options.configuration;
    if (
      command.actor.actorType !== "owner" ||
      command.scope.ownerId !== ownerId ||
      command.scope.agentId !== agentId
    )
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "PROPOSAL_OWNER_REQUIRED");
    if (command.type !== "proposal.respond")
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "PROPOSAL_OPERATION_NOT_INSTALLED",
      );
    const { proposalId, action, expectedVersion, fingerprint } = command.payload;
    const expected = { version: expectedVersion, fingerprint };
    try {
      if (action === "adopt")
        return {
          resultRef: (await this.#options.box.adopt(proposalId, expected)).resultRef,
          replayed: false,
        };
      if (action === "reject")
        return {
          resultRef: proposalId,
          replayed: (await this.#options.box.reject(proposalId, expected)).replayed,
        };
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "PROPOSAL_ACTION_UNKNOWN");
    } catch (error) {
      if (error instanceof ProposalError)
        throw new ApplicationPortError(
          error.code === "PROPOSAL_NOT_FOUND"
            ? PORT_ERROR_CODES.NOT_FOUND
            : PORT_ERROR_CODES.INVALID_OPERATION,
          error.code,
        );
      throw error;
    }
  }
}
