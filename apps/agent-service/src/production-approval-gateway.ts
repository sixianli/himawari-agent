import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import {
  AgentGatewayV2Service,
  ApprovalService,
  ApplicationPortError,
  GovernanceGatewayV2ControlPlane,
  GovernanceGatewayV2ReadModel,
  GrantService,
  PORT_ERROR_CODES,
  type ClockPort,
  type AuthorityFence,
  type ThreadCreateInput,
  type GatewayV2AccessPolicyPort,
  type ProductConfiguration,
  type RecentAuthenticationGuardPort,
} from "@himawari-agent/application";
type ProductAuthorityFence = ThreadCreateInput["authority"];
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";

import { PublicSearchAuthorization } from "./public-search-authorization.js";

export const PRODUCTION_APPROVAL_OPERATIONS = Object.freeze([
  "approval.list",
  "approval.detail",
  "approval.respond",
  "search.authorization.read",
  "search.authorization.set",
] as const);

/** Only the installed approval surface is exposed; other governance mutations stay unavailable. */
export function createProductionApprovalGateway(options: {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId"> &
    Partial<Pick<ProductConfiguration, "modelDescriptors" | "runPolicy">>;
  readonly executionAuthority?: () => AuthorityFence;
  readonly repository: SqliteProductStateRepository;
  readonly access: GatewayV2AccessPolicyPort;
  readonly recentAuthentication: RecentAuthenticationGuardPort;
  readonly clock: ClockPort;
  readonly authority: () => ProductAuthorityFence;
}) {
  const { ownerId, agentId } = options.configuration;
  const { repository, clock } = options;
  const authorization = repository.authorizationStore();
  const capabilities = repository.capabilityStore(ownerId, agentId);
  const searchAuthorization = new PublicSearchAuthorization({
    configuration: options.configuration,
    repository,
    clock,
    ids: { next: (scope) => `${scope}:${randomUUID()}` },
  });
  const unsupported = async (): Promise<never> => {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "Gateway operation is not installed",
    );
  };
  const reads = new GovernanceGatewayV2ReadModel({
    ownerId,
    agentId,
    authorization,
    capabilities,
    clock,
    delegate: {
      query: (query) => searchAuthorization.query(query),
      async *subscribe({ authentication, signal }) {
        let previous: string | undefined;
        while (!signal?.aborted) {
          const authority = options.authority();
          const decision = await options.access.authorize({
            authentication,
            message: {
              schemaVersion: "gateway.v2",
              kind: "query",
              type: "approval.list",
              messageId: "approval-subscription",
              correlationId: "approval-subscription",
              causationId: null,
              dataClassification: "private",
              risk: "low",
              authorizationRef: null,
              scope: { ownerId, agentId },
              authority,
              actor: { actorType: "owner", actorId: authentication.subjectId },
              payload: { status: null, afterCursor: null, limit: 100 },
            },
          });
          if (authentication.ownerId !== ownerId || !decision.allowed) {
            throw new ApplicationPortError(
              PORT_ERROR_CODES.NOT_AUTHORITATIVE,
              "Approval subscription is no longer authorized",
            );
          }
          const approvals = await authorization.listApprovals(ownerId, agentId);
          const now = clock.now();
          const version = JSON.stringify([
            authority,
            await searchAuthorization.revision(),
            approvals.map((approval) => [
              approval.id,
              approval.revision,
              approval.status === "pending" && now >= approval.expiresAt
                ? "expired"
                : approval.status,
            ]),
          ]);
          if (signal?.aborted) return;
          if (version !== previous) {
            previous = version;
            // This installation has authoritative snapshots, not a durable v2
            // event journal. Reconnects always re-read; never invent a cursor.
            yield {
              kind: "snapshot_required",
              scope: { ownerId, agentId },
              reason: "state_changed",
            };
          }
          try {
            await wait(1000, undefined, { ...(signal ? { signal } : {}), ref: false });
          } catch (error) {
            if (signal?.aborted) return;
            throw error;
          }
        }
      },
    },
    dependencies: {
      listTaskRefsByCapability: unsupported,
      listTaskRefsByGrant: unsupported,
      trueResultRefForApproval: async (id) => {
        const approval = await authorization.getApproval(id);
        if (!approval || approval.ownerId !== ownerId || approval.agentId !== agentId) return null;
        const checkpoint = await repository
          .runCheckpointStore(ownerId, agentId, options.authority())
          .read(approval.runId);
        return checkpoint?.checkpoint.output?.kind === "assistant-answer"
          ? checkpoint.checkpoint.output.contentRef
          : null;
      },
    },
  });
  const controlPlane = new GovernanceGatewayV2ControlPlane({
    ownerId,
    agentId,
    authorization,
    capabilities,
    clock,
    delegate: {
      execute: async ({ authentication, command }) => {
        if (
          !options.executionAuthority ||
          authentication.ownerId !== ownerId ||
          authentication.subjectId !== command.actor.actorId
        )
          return unsupported();
        return searchAuthorization.set(command, options.executionAuthority());
      },
    },
    receipts: repository.governanceMutationReceiptStore(),
    approvalService: new ApprovalService({ store: authorization, clock }),
    grantService: new GrantService({
      store: authorization,
      clock,
      ids: { next: (scope) => `${scope}:${randomUUID()}` },
    }),
    audit: repository.auditLedger(),
    recentAuthentication: options.recentAuthentication,
  });
  return new AgentGatewayV2Service({
    installedOperations: PRODUCTION_APPROVAL_OPERATIONS,
    reads,
    controlPlane,
    access: {
      authorize: async (input) => {
        const fence = options.authority();
        if (
          input.message.authority.deploymentId !== fence.deploymentId ||
          input.message.authority.authorityEpoch !== fence.authorityEpoch ||
          input.message.authority.fencingToken !== fence.fencingToken
        )
          return { allowed: false, reasonCode: "GATEWAY_AUTHORITY_CHANGED" };
        return options.access.authorize(input);
      },
    },
  });
}
