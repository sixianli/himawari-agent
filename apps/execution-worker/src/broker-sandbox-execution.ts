import type {
  CapabilityInvocationAuthority,
  CapabilityInvocationRequest,
  SandboxExecutionPlan,
  SandboxHostSession,
} from "@himawari-agent/application";
import { SandboxJobLifecycleService } from "@himawari-agent/application";
import type { ProductionPayloadBrokerClient } from "./production-payload-broker-client.js";
import { ProductionSandboxExecution } from "./production-sandbox-execution.js";

/** Production Worker uses the authenticated broker, never a local database or
 * an admit-capable journal. Agent Service supplies authority for every append. */
export function createBrokerSandboxExecution(options: {
  readonly payloads: Pick<ProductionPayloadBrokerClient, "readSandboxJob" | "appendSandboxJob">;
  readonly authority: (plan: SandboxExecutionPlan) => CapabilityInvocationAuthority;
  readonly now: () => string;
  readonly verify: (plan: SandboxExecutionPlan) => Promise<void>;
  readonly prepareHost: (
    plan: SandboxExecutionPlan,
    invocation: CapabilityInvocationRequest,
  ) => Promise<SandboxHostSession>;
}): ProductionSandboxExecution {
  return new ProductionSandboxExecution({
    now: options.now,
    bind: async (request) => {
      const identity = request.payload.sandboxJob;
      if (!identity || !request.scope.ownerId || !request.scope.agentId || !request.scope.runId)
        throw new Error("SANDBOX_JOB_REQUIRED");
      const invocation: CapabilityInvocationRequest = {
        invocationId: request.messageId,
        ownerId: request.scope.ownerId as CapabilityInvocationRequest["ownerId"],
        agentId: request.scope.agentId as CapabilityInvocationRequest["agentId"],
        runId: request.scope.runId as CapabilityInvocationRequest["runId"],
        capabilityRef: request.payload.capabilityId,
        capabilityHandleRef: request.payload.capabilityHandleRef,
        operation: request.payload.operation,
        inputRef: request.payload.inputRef,
        delegatedContextRefs: request.payload.delegatedContextRefs,
        secretHandleRefs: request.payload.secretRefs.map((secret) => secret.secretRef),
        dataClassification: request.dataClassification,
        resourceCeiling: request.payload.resourceCeiling,
      };
      const { record } = await options.payloads.readSandboxJob(invocation, identity);
      const lifecycle = new SandboxJobLifecycleService({
        journal: {
          read: async (job) => (await options.payloads.readSandboxJob(invocation, job)).record,
          // Worker-provided authority and time are deliberately not serialized.
          append: (input) => options.payloads.appendSandboxJob(invocation, input.observation),
        },
        authority: () => options.authority(record.plan),
        now: options.now,
        verify: options.verify,
        prepareHost: (plan) => options.prepareHost(plan, invocation),
      });
      return { plan: record.plan, lifecycle };
    },
  });
}
