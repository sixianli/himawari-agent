import { createHash } from "node:crypto";
import type {
  CapabilityInvocationAuthority,
  ClockPort,
  ProductConfiguration,
  SandboxExecutionPlan,
} from "@himawari-agent/application";
import type { ExecutionAdmissionPeerBinding } from "@himawari-agent/execution-contracts";
import {
  CapabilityDeploymentSnapshotLoader,
  verifySandboxHost,
} from "@himawari-agent/platform-node";
import { prepareJobPolicy } from "@himawari-agent/runtime-sandbox";
import { createBrokerSandboxExecution } from "./broker-sandbox-execution.js";
import { createProductSandboxHostSession } from "./product-job-host.js";
import type { ProductionPayloadBrokerClient } from "./production-payload-broker-client.js";

/** Resolves only authenticated Agent scope and pinned host inventory. It never
 * reads SQLite or derives execution permissions from model arguments. */
export function createProductionSandboxWorker(options: {
  readonly configuration: Pick<ProductConfiguration, "deploymentId" | "capabilityDeployment">;
  readonly peer: ExecutionAdmissionPeerBinding;
  readonly payloads: ProductionPayloadBrokerClient;
  readonly clock: ClockPort;
}) {
  const { configuration, peer, payloads, clock } = options;
  const deployment = configuration.capabilityDeployment;
  if (!deployment) throw new Error("SANDBOX_DEPLOYMENT_UNAVAILABLE");
  const loader = new CapabilityDeploymentSnapshotLoader({ ...deployment, now: () => clock.now() });
  const hostFor = async (plan: SandboxExecutionPlan) => {
    const loaded = await loader.load();
    const entry = loaded.snapshot.capabilities.find(
      (entry) =>
        entry.manifest.ref === plan.capabilityRef &&
        entry.manifest.version === plan.capabilityVersion,
    );
    if (!entry || entry.binding.kind !== "sandbox" || !entry.qualification.sandbox)
      throw new Error("SANDBOX_HOST_UNAVAILABLE");
    await verifySandboxHost({
      binding: entry.binding.value,
      qualification: entry.qualification.sandbox,
      hostId: plan.identity.hostId,
      plan,
    });
    return entry.binding.value;
  };
  return createBrokerSandboxExecution({
    payloads,
    now: () => clock.now(),
    authority: (plan) => ({
      product: {
        deploymentId: configuration.deploymentId,
        authorityEpoch: peer.authorityEpoch,
        fencingToken: peer.fencingToken,
      },
      lease: {
        leaseId: plan.executionLease
          .authorityLeaseId as CapabilityInvocationAuthority["lease"]["leaseId"],
        fencingToken: plan.executionLease.authorityFencingToken,
      },
      agentServiceInstanceId: peer.agentServiceInstanceId,
      agentServiceBootId: peer.agentServiceBootId,
      workerInstanceId: peer.workerInstanceId,
      workerBootId: peer.workerBootId,
    }),
    verify: async (plan) => {
      await hostFor(plan);
    },
    prepareHost: async (plan, invocation) => {
      const binding = await hostFor(plan);
      const resolved = await payloads.readSandboxScope(invocation, plan.identity);
      const scope = resolved.scope;
      if (
        scope.operation !== plan.operation ||
        scope.authorizationRef !== plan.authorizationRef ||
        scope.modelRef !== plan.modelRef ||
        scope.profileRef !== binding.profileRef ||
        resolved.allowedDomains.some((domain) => !binding.allowedDomains.includes(domain)) ||
        (scope.networkAuthorizationRef === null && resolved.allowedDomains.length > 0)
      )
        throw new Error("SANDBOX_SCOPE_CHANGED");
      const root = binding.roots.find(
        (root) => root.canonicalRootId === scope.directoryGrant.canonicalRootId,
      );
      if (!root) throw new Error("SANDBOX_ROOT_UNAVAILABLE");
      const { policy, compiled } = await prepareJobPolicy({
        workspace: root.canonicalPath,
        writable: scope.directoryGrant.operations.some((operation) => operation !== "read"),
        jobId: plan.identity.jobId,
        privateRoot: binding.privateRoot,
        readOnlyToolchainPaths: [binding.runtimeRoot, ...binding.readOnlyToolchainPaths],
        protectedPaths: binding.protectedPaths,
        allowedDomains: resolved.allowedDomains,
      });
      const input = await payloads.readInput(invocation);
      if (input.byteLength > 49152) throw new Error("SANDBOX_INPUT_TOO_LARGE");
      return createProductSandboxHostSession(
        plan,
        {
          policy,
          policyDigest: compiled.policyDigest,
          executable: binding.executable.path,
          args: [binding.runner.path, binding.hostId, peer.workerInstanceId],
          stdinBase64: Buffer.from(input).toString("base64"),
          cleanupTimeoutMs: 5000,
        },
        async (result) => {
          // Preserve the registered program's existing stdout Payload contract.
          // Resource samples travel in the job observation, not a second output envelope.
          const bytes = result.stdout;
          const outputRef = await payloads.writeOutput(
            invocation,
            bytes,
            "application/octet-stream",
          );
          return { outputRef, outputDigest: createHash("sha256").update(bytes).digest("hex") };
        },
      );
    },
  });
}
