import {
  ApplicationPortError,
  type ClockPort,
  type GatewayAuthenticationContext,
  PORT_ERROR_CODES,
  type ProductConfiguration,
  type RecentAuthenticationGuardPort,
} from "@himawari-agent/application";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
import { type ProductionProposalBox, ProposalError, shownText } from "./production-proposals.js";

export const PRODUCTION_PROPOSAL_OPERATIONS = Object.freeze([
  "proposals.read",
  "proposal.respond",
] as const);

const EVIDENCE_SHOWN = 20;
const SOURCES_SHOWN = 10;
const FIGURES_SHOWN = 10;

export interface ProductionProposalControlOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly box: Pick<ProductionProposalBox, "list" | "adopt" | "reject" | "undo" | "openFull">;
  readonly recentAuthentication?: RecentAuthenticationGuardPort;
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
    const { open } = query.payload;
    const opened = open ? await this.#open(open) : null;
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
          type: shownText(proposal.type, 64),
          summary: shownText(proposal.summary, 200),
          effect: shownText(proposal.effect, 200),
          origin: proposal.origin,
          adoptable: proposal.adoptable,
          requiresFullRead: proposal.requiresFullRead,
          requiresPresence: proposal.requiresPresence,
          evidence: proposal.evidence
            .filter((item) => shownText(item.kind, 64).length > 0)
            .slice(0, EVIDENCE_SHOWN)
            .map((item) => ({
              kind: shownText(item.kind, 64),
              text: item.text === null ? null : shownText(item.text, 500) || null,
              sources: item.sources
                .slice(0, SOURCES_SHOWN)
                .map((source) => ({
                  kind: shownText(source.kind, 64),
                  ref: shownText(source.ref, 256),
                }))
                .filter((source) => source.kind.length > 0 && source.ref.length > 0),
              figures: item.figures
                .slice(0, FIGURES_SHOWN)
                .map((figure) => ({
                  name: shownText(figure.name, 64),
                  value: figure.value,
                  definition: shownText(figure.definition, 200),
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
        opened,
        generatedAt: this.#options.clock.now(),
      },
    };
  }

  async #open(open: {
    readonly proposalId: string;
    readonly expectedVersion: number;
    readonly fingerprint: string;
  }) {
    try {
      const opened = await this.#options.box.openFull(open.proposalId, {
        version: open.expectedVersion,
        fingerprint: open.fingerprint,
      });
      return { proposalId: open.proposalId, ...opened };
    } catch (error) {
      throw this.#failure(error);
    }
  }

  #failure(error: unknown): unknown {
    if (error instanceof ProposalError)
      return new ApplicationPortError(
        error.code === "PROPOSAL_NOT_FOUND"
          ? PORT_ERROR_CODES.NOT_FOUND
          : PORT_ERROR_CODES.INVALID_OPERATION,
        error.code,
      );
    return error;
  }

  async execute(
    authentication: GatewayAuthenticationContext,
    command: GatewayV2Command,
  ): Promise<{ resultRef: string; replayed: boolean }> {
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
    const {
      proposalId,
      action,
      expectedVersion,
      fingerprint,
      recentAuthenticationRef,
      fullReadToken,
    } = command.payload;
    const expected = { version: expectedVersion, fingerprint };
    const guard = this.#options.recentAuthentication;
    try {
      if (action === "adopt")
        return {
          resultRef: (
            await this.#options.box.adopt(proposalId, expected, {
              fullReadToken,
              ...(guard
                ? {
                    assertPresence: async () => {
                      await guard.assertRecentAuthentication({
                        authentication,
                        expectedAuthenticationRef: recentAuthenticationRef,
                      });
                    },
                  }
                : {}),
            })
          ).resultRef,
          replayed: false,
        };
      if (action === "undo")
        return {
          resultRef: proposalId,
          replayed: (await this.#options.box.undo(proposalId, expected)).replayed,
        };
      if (action === "reject")
        return {
          resultRef: proposalId,
          replayed: (await this.#options.box.reject(proposalId, expected)).replayed,
        };
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "PROPOSAL_ACTION_UNKNOWN");
    } catch (error) {
      throw this.#failure(error);
    }
  }
}
