import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import {
  AgentGatewayV2Service,
  ApplicationPortError,
  ApprovalService,
  type AuthorityFence,
  type CapabilityReactivationVerifierPort,
  type ClockPort,
  type GatewayV2AccessPolicyPort,
  type GatewayV2ControlPlanePort,
  GovernanceGatewayV2ControlPlane,
  GovernanceGatewayV2ReadModel,
  GrantService,
  PORT_ERROR_CODES,
  type ProductConfiguration,
  type RecentAuthenticationGuardPort,
  type ThreadCreateInput,
} from "@himawari-agent/application";

type ProductAuthorityFence = ThreadCreateInput["authority"];

import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { PRODUCTION_HOME_OPERATIONS, type ProductionHomeControl } from "./production-home.js";
import { PRODUCTION_SEARCH_OPERATIONS, type ProductionSearchControl } from "./production-search.js";
import {
  PRODUCTION_DEVICE_OPERATIONS,
  type ProductionDeviceControl,
} from "./production-device-control.js";
import {
  PRODUCTION_MEMORY_OPERATIONS,
  type ProductionMemoryControl,
} from "./production-memory-control.js";
import {
  PRODUCTION_PERCEPTION_OPERATIONS,
  type ProductionPerceptionControl,
} from "./production-perception-control.js";
import {
  PRODUCTION_MUSE_OPERATIONS,
  type ProductionMuseControl,
} from "./production-muse-intake-control.js";
import {
  PRODUCTION_OBSERVATION_OPERATIONS,
  type ProductionObservation,
} from "./production-observation.js";
import {
  PRODUCTION_OWNER_PREFERENCE_OPERATIONS,
  type ProductionOwnerPreferencesControl,
} from "./production-owner-preferences-control.js";
import {
  PRODUCTION_PROPOSAL_OPERATIONS,
  type ProductionProposalControl,
} from "./production-proposal-control.js";
import {
  PRODUCTION_PROACTIVE_OPERATIONS,
  type ProductionProactive,
} from "./production-proactive.js";
import {
  PRODUCTION_SENSITIVE_INTERCEPTION_OPERATIONS,
  type ProductionSensitiveInterceptionsControl,
} from "./production-sensitive-interceptions-control.js";
import {
  PRODUCTION_DATA_EXPORT_OPERATIONS,
  type ProductionDataExportControl,
} from "./production-data-export.js";
import {
  PRODUCTION_FILES_OPERATIONS,
  type ProductionFilesControl,
} from "./production-files-control.js";
import {
  PRODUCTION_LOGIN_DEVICE_OPERATIONS,
  type ProductionLoginDevicesControl,
} from "./production-login-devices-control.js";
import {
  PRODUCTION_SERVER_STATUS_OPERATIONS,
  type ProductionServerStatusControl,
} from "./production-server-status-control.js";
import {
  PRODUCTION_WEB_PUSH_OPERATIONS,
  type ProductionWebPushControl,
} from "./production-web-push-control.js";
import { createProductionCapabilityLifecycle } from "./production-capability-lifecycle.js";
import { PRODUCTION_COPY_OPERATIONS } from "./production-workspace-copies.js";
import { PublicSearchAuthorization } from "./public-search-authorization.js";

export const PRODUCTION_APPROVAL_OPERATIONS = Object.freeze([
  "approval.list",
  "approval.detail",
  "approval.respond",
  "search.authorization.read",
  "search.authorization.set",
] as const);

export const PRODUCTION_CAPABILITY_OPERATIONS = Object.freeze([
  "capability.list",
  "capability.detail",
  "capability.disable",
] as const);

export const PRODUCTION_CAPABILITY_REACTIVATION_OPERATIONS = Object.freeze([
  "capability.reactivate",
] as const);

export function createProductionApprovalGateway(options: {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId"> &
    Partial<Pick<ProductConfiguration, "modelDescriptors" | "runPolicy">>;
  readonly executionAuthority?: () => AuthorityFence;
  readonly repository: SqliteProductStateRepository;
  readonly access: GatewayV2AccessPolicyPort;
  readonly recentAuthentication: RecentAuthenticationGuardPort;
  readonly clock: ClockPort;
  readonly authority: () => ProductAuthorityFence;
  readonly workspaceCopies?: GatewayV2ControlPlanePort;
  readonly memoryControl?: ProductionMemoryControl;
  readonly webPushControl?: ProductionWebPushControl;
  readonly proactiveControl?: Pick<ProductionProactive, "query" | "execute">;
  readonly museControl?: Pick<ProductionMuseControl, "query" | "execute">;
  readonly observationControl?: Pick<ProductionObservation, "query" | "execute">;
  readonly ownerPreferencesControl?: ProductionOwnerPreferencesControl;
  readonly proposalControl?: Pick<ProductionProposalControl, "query" | "execute">;
  readonly sensitiveInterceptionsControl?: ProductionSensitiveInterceptionsControl;
  readonly serverStatusControl?: ProductionServerStatusControl;
  readonly capabilityReactivation?: CapabilityReactivationVerifierPort;
  readonly deviceControl?: Pick<ProductionDeviceControl, "query" | "execute">;
  readonly homeControl?: Pick<ProductionHomeControl, "query">;
  readonly searchControl?: Pick<ProductionSearchControl, "query">;
  readonly dataExportControl?: ProductionDataExportControl;
  readonly filesControl?: ProductionFilesControl;
  readonly loginDevicesControl?: ProductionLoginDevicesControl;
  readonly perceptionControl?: Pick<ProductionPerceptionControl, "query" | "execute">;
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
      query: (query, context) =>
        query.type.startsWith("login.") && options.loginDevicesControl
          ? options.loginDevicesControl.query(query, context)
          : query.type === "home.read" && options.homeControl
            ? options.homeControl.query(query)
            : query.type === "search.ask.read" && options.searchControl
              ? options.searchControl.query(query)
              : (query.type.startsWith("memory.") || query.type.startsWith("decision.chain.")) &&
                  options.memoryControl
                ? options.memoryControl.query(query)
                : query.type.startsWith("push.") && options.webPushControl
                  ? options.webPushControl.query(query)
                  : (query.type === "proactive.weekly.read" ||
                        query.type === "decision.email.read") &&
                      options.observationControl
                    ? options.observationControl.query(query)
                    : query.type.startsWith("proactive.") && options.proactiveControl
                      ? options.proactiveControl.query(query)
                      : query.type.startsWith("muse.") && options.museControl
                        ? options.museControl.query(query)
                        : query.type.startsWith("owner.preferences.") &&
                            options.ownerPreferencesControl
                          ? options.ownerPreferencesControl.query(query)
                          : query.type.startsWith("proposals.") && options.proposalControl
                            ? options.proposalControl.query(query)
                            : query.type.startsWith("sensitive.interceptions.") &&
                                options.sensitiveInterceptionsControl
                              ? options.sensitiveInterceptionsControl.query(query)
                              : query.type.startsWith("server.status.") &&
                                  options.serverStatusControl
                                ? options.serverStatusControl.query(query)
                                : query.type.startsWith("data.export.") && options.dataExportControl
                                  ? options.dataExportControl.query(query)
                                  : query.type.startsWith("files.") && options.filesControl
                                    ? options.filesControl.query(query, context)
                                    : query.type.startsWith("device.") && options.deviceControl
                                      ? options.deviceControl.query(query)
                                      : query.type.startsWith("perception.") &&
                                          options.perceptionControl
                                        ? options.perceptionControl.query(query)
                                        : searchAuthorization.query(query),
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
          const approvals = await authorization.approvalChangeMarker(ownerId, agentId);
          const now = clock.now();
          const version = JSON.stringify([
            authority,
            await searchAuthorization.revision(),
            await options.memoryControl?.revision(),
            approvals.count,
            approvals.revisionTotal,
            approvals.pending.map((approval) => [approval.id, now >= approval.expiresAt]),
          ]);
          if (signal?.aborted) return;
          if (version !== previous) {
            previous = version;
            yield {
              kind: "snapshot_required",
              scope: { ownerId, agentId },
              reason: "state_changed",
            };
          }
          try {
            await wait(1000, undefined, {
              ...(signal ? { signal } : {}),
              ref: false,
            });
          } catch (error) {
            if (signal?.aborted) return;
            throw error;
          }
        }
      },
    },
    dependencies: {
      listTaskRefsByCapability: async (capabilityRef) =>
        (await capabilities.listScheduledJobRefs?.(capabilityRef)) ?? [],
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
        if (command.type.startsWith("memory.") && options.memoryControl)
          return options.memoryControl.execute(command);
        if (command.type.startsWith("login.") && options.loginDevicesControl)
          return options.loginDevicesControl.execute({
            authentication,
            command,
          });
        if (
          (command.type.startsWith("push.") || command.type === "presence.heartbeat") &&
          options.webPushControl
        )
          return options.webPushControl.execute(command);
        if (command.type === "proactive.observation.start" && options.observationControl) {
          await options.recentAuthentication.assertRecentAuthentication({
            authentication,
            expectedAuthenticationRef: command.payload.recentAuthenticationRef,
          });
          return options.observationControl.execute(command);
        }
        if (command.type === "proactive.gapcase.mark" && options.observationControl)
          return options.observationControl.execute(command);
        if (command.type.startsWith("proactive.") && options.proactiveControl)
          return options.proactiveControl.execute(command);
        if (command.type.startsWith("muse.") && options.museControl)
          return options.museControl.execute(command);
        if (command.type.startsWith("owner.preferences.") && options.ownerPreferencesControl)
          return options.ownerPreferencesControl.execute(command);
        if (command.type.startsWith("proposal.") && options.proposalControl)
          return options.proposalControl.execute(command);
        if (command.type.startsWith("data.export.") && options.dataExportControl)
          return options.dataExportControl.execute(command);
        if (
          command.type.startsWith("sensitive.interceptions.") &&
          options.sensitiveInterceptionsControl
        )
          return options.sensitiveInterceptionsControl.execute(command);
        if (command.type.startsWith("device.") && options.deviceControl)
          return options.deviceControl.execute(authentication, command);
        if (command.type.startsWith("perception.") && options.perceptionControl)
          return options.perceptionControl.execute(command);
        if (command.type.startsWith("workspace.copy.") && options.workspaceCopies)
          return options.workspaceCopies.execute({ authentication, command });
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
    capabilityLifecycle: createProductionCapabilityLifecycle({
      configuration: options.configuration,
      repository,
      clock,
      ...(options.capabilityReactivation ? { reactivation: options.capabilityReactivation } : {}),
    }),
  });
  const capabilityReactivationAvailable = options.capabilityReactivation !== undefined;
  return new AgentGatewayV2Service({
    installedOperations: [
      ...PRODUCTION_APPROVAL_OPERATIONS,
      ...(options.workspaceCopies ? PRODUCTION_COPY_OPERATIONS : []),
      ...(options.memoryControl ? PRODUCTION_MEMORY_OPERATIONS : []),
      ...(options.webPushControl ? PRODUCTION_WEB_PUSH_OPERATIONS : []),
      ...(options.proactiveControl ? PRODUCTION_PROACTIVE_OPERATIONS : []),
      ...(options.museControl ? PRODUCTION_MUSE_OPERATIONS : []),
      ...(options.observationControl ? PRODUCTION_OBSERVATION_OPERATIONS : []),
      ...(options.ownerPreferencesControl ? PRODUCTION_OWNER_PREFERENCE_OPERATIONS : []),
      ...(options.proposalControl ? PRODUCTION_PROPOSAL_OPERATIONS : []),
      ...(options.sensitiveInterceptionsControl
        ? PRODUCTION_SENSITIVE_INTERCEPTION_OPERATIONS
        : []),
      ...(options.serverStatusControl ? PRODUCTION_SERVER_STATUS_OPERATIONS : []),
      ...PRODUCTION_CAPABILITY_OPERATIONS,
      ...(capabilityReactivationAvailable ? PRODUCTION_CAPABILITY_REACTIVATION_OPERATIONS : []),
      ...(options.deviceControl ? PRODUCTION_DEVICE_OPERATIONS : []),
      ...(options.homeControl ? PRODUCTION_HOME_OPERATIONS : []),
      ...(options.searchControl ? PRODUCTION_SEARCH_OPERATIONS : []),
      ...(options.dataExportControl ? PRODUCTION_DATA_EXPORT_OPERATIONS : []),
      ...(options.filesControl ? PRODUCTION_FILES_OPERATIONS : []),
      ...(options.loginDevicesControl ? PRODUCTION_LOGIN_DEVICE_OPERATIONS : []),
      ...(options.perceptionControl ? PRODUCTION_PERCEPTION_OPERATIONS : []),
    ],
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
