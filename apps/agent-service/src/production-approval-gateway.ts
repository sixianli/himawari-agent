import { randomUUID } from "node:crypto";
import {
  AgentGatewayV2Service,
  ApprovalService,
  ApplicationPortError,
  GovernanceGatewayV2ControlPlane,
  GovernanceGatewayV2ReadModel,
  GrantService,
  PORT_ERROR_CODES,
  type ClockPort,
  type ThreadCreateInput,
  type GatewayV2AccessPolicyPort,
  type ProductConfiguration,
  type RecentAuthenticationGuardPort,
} from "@himawari-agent/application";
type ProductAuthorityFence = ThreadCreateInput["authority"];
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";

/** Only the installed approval surface is exposed; other governance mutations stay unavailable. */
export function createProductionApprovalGateway(options: {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
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
    delegate: { query: unsupported, async *subscribe() {} },
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
    delegate: { execute: unsupported },
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
    reads,
    controlPlane,
    access: {
      authorize: async (input) => {
        if (!["approval.list", "approval.detail", "approval.respond"].includes(input.message.type))
          return { allowed: false, reasonCode: "GATEWAY_OPERATION_NOT_INSTALLED" };
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
