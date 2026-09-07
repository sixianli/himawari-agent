import { createHash } from "node:crypto";
import {
  ActionPolicyService,
  CapabilityHandleService,
  hostDirectoryGrantStateKey,
  type CapabilityInvocationAuthority,
  type CapabilityManifest,
  type ClockPort,
  type HostDirectoryGrant,
  type IdGeneratorPort,
  type ProductConfiguration,
} from "@himawari-agent/application";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import type { ProductionFileReadServices } from "./production-file-read-workflow.js";

/** Production composition: routing never creates grants or capability qualification. */
export function createProductionFileReadServices(options: {
  readonly configuration: ProductConfiguration;
  readonly repository: Pick<
    SqliteProductStateRepository,
    | "readScopedState"
    | "runExecutionSource"
    | "runDispatch"
    | "authorizationStore"
    | "capabilityStore"
  >;
  readonly authority: () => CapabilityInvocationAuthority;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
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
  });
  const handles = new CapabilityHandleService({ store: capabilities, clock, ids });
  return {
    binding: async (call) => {
      const route = configuration.runPolicy?.fileRead;
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
      const stored = await repository.readScopedState(
        configuration.ownerId,
        configuration.agentId,
        hostDirectoryGrantStateKey(route.grantId),
      );
      const grant = stored?.value as unknown as HostDirectoryGrant | undefined;
      if (!stored || !grant || grant.id !== route.grantId || grant.hostId !== route.hostId)
        return undefined;
      // Freeze the configured provider/model/routing identity, including fallback changes.
      const identity = createHash("sha256").update(JSON.stringify(model)).digest("hex");
      return {
        revision: stored.revision,
        hostId: route.hostId,
        workerInstanceId: route.workerInstanceId,
        grant,
        capabilityRef: route.capabilityRef,
        capabilityVersion: route.capabilityVersion,
        maximumBytes: route.maximumBytes,
        threadId: context.threadId,
        modelRef: context.modelRef,
        modelIdentity: `model:${model.provider}:${model.model}:${identity}`,
      };
    },
    authorize: (intent) =>
      policy.evaluate(intent, { uiAvailable: true, approvalExpiresAt: intent.expiresAt }),
    issue: (input) => handles.issue(input),
  };
}
