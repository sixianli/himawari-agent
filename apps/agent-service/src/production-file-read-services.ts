import {
  ActionPolicyService,
  type AutomaticActionReviewPort,
  CapabilityHandleService,
  type CapabilityInvocationAuthority,
  type CapabilityManifest,
  type ClockPort,
  type HostDirectoryGrant,
  hostDirectoryGrantStateKey,
  type IdGeneratorPort,
  type ProductConfiguration,
} from "@himawari-agent/application";
import { sandboxWorkspaceCopySchema } from "@himawari-agent/execution-contracts";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import type { ProductionFileReadServices } from "./production-file-read-workflow.js";

import { configuredModelDisclosureIdentity } from "./production-model-disclosure.js";
import { PublicSearchAuthorization } from "./public-search-authorization.js";

/** Production composition: routing never creates grants or capability qualification. */
export function createProductionFileReadServices(options: {
  readonly configuration: ProductConfiguration;
  readonly repository: Pick<
    SqliteProductStateRepository,
    | "readScopedState"
    | "commitStateAndEvents"
    | "auditLedger"
    | "runExecutionSource"
    | "runDispatch"
    | "authorizationStore"
    | "capabilityStore"
  >;
  readonly authority: () => CapabilityInvocationAuthority;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  /** Opt-in host coordinator; absent until review configuration and delegation are approved. */
  readonly automaticReview?: AutomaticActionReviewPort;
}): ProductionFileReadServices {
  const { configuration, repository, clock, ids } = options;
  const capabilities = repository.capabilityStore(configuration.ownerId, configuration.agentId);
  const policy = new ActionPolicyService({
    store: repository.authorizationStore(),
    capabilities: {
      inspect: async (ref) => {
        const record = await capabilities.get(ref);
        const manifest = record?.declaration as CapabilityManifest | undefined;
        return record && manifest?.manifestVersion === "capability.v2"
          ? { lifecycle: record.lifecycle, manifest }
          : undefined;
      },
    },
    policy: { version: "file-read.v1", rules: [] },
    clock,
    ids,
    ...(options.automaticReview ? { automaticReview: options.automaticReview } : {}),
  });
  const searchAuthorization = new PublicSearchAuthorization({
    configuration,
    repository,
    clock,
    ids,
  });
  const handles = new CapabilityHandleService({ store: capabilities, clock, ids });
  return {
    binding: async (call) => {
      const coding = configuration.runPolicy?.coding;
      const route = coding?.enabledTools.some(
        (tool) => `${coding.capabilityRef}.${tool}` === call.capabilityRef,
      )
        ? coding
        : call.capabilityRef ===
            `${configuration.runPolicy?.publicSearch?.capabilityRef}.web_search`
          ? configuration.runPolicy?.publicSearch
          : configuration.runPolicy?.fileRead;
      const context = call.context;
      if (!route || !context?.threadId) return undefined;
      const authority = options.authority();
      const claim = context.executionLease;
      if (
        claim.deploymentId !== authority.product.deploymentId ||
        claim.authorityEpoch !== authority.product.authorityEpoch ||
        claim.fencingToken !== authority.product.fencingToken ||
        claim.authorityLeaseId !== authority.lease.leaseId ||
        claim.authorityFencingToken !== authority.lease.fencingToken ||
        route.workerInstanceId !== authority.workerInstanceId
      )
        return undefined;
      await repository
        .runDispatch(
          configuration.ownerId,
          configuration.agentId,
          authority.product,
          authority.lease,
          claim.consumerId,
        )
        .assertHeld({
          runId: call.runId,
          executionLeaseId: claim.executionLeaseId,
          expectedLeaseRevision: claim.expectedLeaseRevision,
          at: clock.now(),
        });
      const source = await repository
        .runExecutionSource(configuration.ownerId, configuration.agentId)
        .read(call.runId);
      if (
        !source ||
        source.runId !== call.runId ||
        source.ownerId !== configuration.ownerId ||
        source.agentId !== configuration.agentId ||
        source.threadId !== context.threadId
      )
        return undefined;
      const model = configuration.modelDescriptors.find(
        ({ ref, role }) => ref === context.modelRef && role !== "embedding",
      );
      if (!model || !model.allowedDataClassifications.includes(call.dataClassification))
        return undefined;
      // Freeze the configured provider/model/routing identity, including fallback changes.
      const common = {
        hostId: route.hostId,
        workerInstanceId: route.workerInstanceId,
        capabilityRef: route.capabilityRef,
        capabilityVersion: route.capabilityVersion,
        maximumBytes: route.maximumBytes,
        threadId: context.threadId,
        modelRef: context.modelRef,
        modelIdentity: configuredModelDisclosureIdentity(model),
      };
      if ("scopeSource" in route && route.scopeSource === "private_temp") {
        if (call.capabilityRef !== `${route.capabilityRef}.web_search`) return undefined;
        return { ...common, revision: 1, grant: null };
      }
      if (!("grantId" in route)) return undefined;
      const stored = await repository.readScopedState(
        configuration.ownerId,
        configuration.agentId,
        hostDirectoryGrantStateKey(route.grantId),
      );
      const grant = stored?.value as unknown as HostDirectoryGrant | undefined;
      if (!stored || !grant || grant.id !== route.grantId || grant.hostId !== route.hostId)
        return undefined;
      if (
        coding &&
        route === coding &&
        call.capabilityRef === `${coding.capabilityRef}.save_copy`
      ) {
        const args = call.arguments;
        if (
          typeof args["operationId"] !== "string" ||
          typeof args["expectedHash"] !== "string" ||
          Object.keys(args).some((key) => !["operationId", "expectedHash"].includes(key))
        )
          return undefined;
        const operation = (
          await repository.readScopedState(
            configuration.ownerId,
            configuration.agentId,
            `host-workspace:file-operation:${args["operationId"]}`,
          )
        )?.value as unknown as
          | import("@himawari-agent/application").PreparedFileOperation
          | undefined;
        if (
          !operation ||
          operation.canonicalHash !== args["expectedHash"] ||
          operation.grantId !== grant.id ||
          !["create", "update", "move", "trash"].includes(operation.operation) ||
          operation.copyAuthority?.grantRevision !== grant.revision ||
          operation.copyAuthority.canonicalRootId !== grant.canonicalRootId
        )
          return undefined;
        return {
          ...common,
          revision: stored.revision,
          grant,
          copySaveOperation: {
            id: operation.id,
            operation: operation.operation as "create" | "update" | "move" | "trash",
            canonicalHash: operation.canonicalHash,
          },
        };
      }
      const selection = await repository.readScopedState(
        configuration.ownerId,
        configuration.agentId,
        `workspace-copy-selection:${context.threadId}`,
      );
      if (
        selection?.value["workspaceRef"] !== undefined &&
        selection.value["workspaceRef"] !== null
      ) {
        const selected = selection.value;
        if (
          route !== coding ||
          call.capabilityRef !== `${coding.capabilityRef}.bash` ||
          selected["grantId"] !== grant.id ||
          selected["grantRevision"] !== grant.revision ||
          selected["hostId"] !== grant.hostId
        )
          return undefined;
        return {
          ...common,
          revision: stored.revision,
          grant,
          workspaceCopy: sandboxWorkspaceCopySchema.parse(selected["root"]),
        };
      }
      return { ...common, revision: stored.revision, grant };
    },
    authorize: async (intent, signal) => {
      signal?.throwIfAborted();
      await searchAuthorization.authorize(intent);
      return policy.evaluate(intent, {
        uiAvailable: true,
        approvalExpiresAt: intent.expiresAt,
        ...(signal ? { signal } : {}),
      });
    },
    issue: (input) => handles.issue(input),
  };
}
