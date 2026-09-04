import type {
  ExecutionAdmissionPeerBinding,
  ResourceCeiling,
} from "@himawari-agent/execution-contracts";
import { describe, expect, it } from "vitest";
import type { ProductionExecutionAdmissionParentBinding } from "../src/production-execution-admission-handler.js";
import {
  createProductionWorkerParentBindingRegistry,
  PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_ERROR_CODES,
} from "../src/production-worker-parent-binding-registry.js";

type ParentScope = ProductionExecutionAdmissionParentBinding["scope"];

const peer: ExecutionAdmissionPeerBinding = {
  agentServiceInstanceId: "agent-service:parent-registry",
  agentServiceBootId: "agent-boot:parent-registry",
  workerInstanceId: "worker:parent-registry",
  workerBootId: "worker-boot:parent-registry",
  deploymentId: "deployment:parent-registry",
  authorityEpoch: 3,
  fencingToken: 7,
};

const scope: ParentScope = {
  deploymentId: peer.deploymentId,
  authorityEpoch: peer.authorityEpoch,
  fencingToken: peer.fencingToken,
  ownerId: "owner:parent-registry",
  agentId: "agent:parent-registry",
  runId: "run:parent-registry",
  workerRunId: "worker-run:parent-registry",
};

const resourceCeiling: ResourceCeiling = {
  maxWallTimeMs: 30_000,
  maxCpuTimeMs: 10_000,
  maxMemoryBytes: 268_435_456,
  maxOutputBytes: 1_048_576,
  maxProgressEvents: 100,
};

function createBinding(
  overrides: {
    readonly parentMessageId?: string;
    readonly parentCorrelationId?: string;
    readonly bindingRevision?: number;
    readonly bindingDigest?: string;
    readonly scope?: Partial<ParentScope>;
    readonly authority?: Partial<ExecutionAdmissionPeerBinding>;
    readonly dataClassification?: ProductionExecutionAdmissionParentBinding["dataClassification"];
    readonly resourceCeiling?: Partial<ResourceCeiling>;
    readonly deadlineAt?: string;
    readonly capabilityHandleRefs?: readonly string[];
    readonly delegatedContextRefs?: readonly string[];
  } = {},
): ProductionExecutionAdmissionParentBinding {
  return {
    parentMessageId: overrides.parentMessageId ?? "parent:parent-registry",
    parentCorrelationId: overrides.parentCorrelationId ?? "correlation:parent-registry",
    bindingRevision: overrides.bindingRevision ?? 1,
    bindingDigest: overrides.bindingDigest ?? "digest:parent-registry:v1",
    scope: {
      ...scope,
      ...overrides.scope,
    },
    authority: {
      ...peer,
      ...overrides.authority,
    },
    dataClassification: overrides.dataClassification ?? "private",
    resourceCeiling: {
      ...resourceCeiling,
      ...overrides.resourceCeiling,
    },
    deadlineAt: overrides.deadlineAt ?? "2026-09-05T01:00:00.000Z",
    capabilityHandleRefs: [...(overrides.capabilityHandleRefs ?? ["handle:parent-registry"])],
    delegatedContextRefs: [...(overrides.delegatedContextRefs ?? ["context:parent-registry"])],
  };
}

function registryFixture() {
  let currentPeer = peer;
  const registry = createProductionWorkerParentBindingRegistry({
    trustedPeerBinding: () => currentPeer,
  });
  return {
    registry,
    setPeer(nextPeer: ExecutionAdmissionPeerBinding) {
      currentPeer = nextPeer;
    },
  };
}

describe("ProductionWorkerParentBindingRegistry", () => {
  it("exposes a read-only reader and has no binding before registration", async () => {
    const fixture = registryFixture();

    expect(await fixture.registry.reader.lookup("parent:missing")).toBeUndefined();
    expect("register" in fixture.registry.reader).toBe(false);
  });

  it("deep-freezes a complete binding before it becomes readable", async () => {
    const fixture = registryFixture();
    const binding = {
      ...createBinding(),
      scope: { ...scope },
      authority: { ...peer },
      resourceCeiling: { ...resourceCeiling },
      capabilityHandleRefs: ["handle:parent-registry"],
      delegatedContextRefs: ["context:parent-registry"],
    };

    fixture.registry.writer.register(binding);
    binding.scope.runId = "run:mutated";
    binding.authority.workerBootId = "worker-boot:mutated";
    binding.resourceCeiling.maxOutputBytes = 1;
    binding.capabilityHandleRefs.push("handle:mutated");
    binding.delegatedContextRefs[0] = "context:mutated";

    const stored = await fixture.registry.reader.lookup(binding.parentMessageId);
    expect(stored).toEqual(createBinding());
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored?.scope)).toBe(true);
    expect(Object.isFrozen(stored?.authority)).toBe(true);
    expect(Object.isFrozen(stored?.resourceCeiling)).toBe(true);
    expect(Object.isFrozen(stored?.capabilityHandleRefs)).toBe(true);
    expect(Object.isFrozen(stored?.delegatedContextRefs)).toBe(true);
  });

  it("allows only an exact same-identity registration replay", async () => {
    const fixture = registryFixture();
    const binding = createBinding();

    fixture.registry.writer.register(binding);
    fixture.registry.writer.register(createBinding());
    expect(await fixture.registry.reader.lookup(binding.parentMessageId)).toEqual(binding);

    for (const conflicting of [
      createBinding({ parentCorrelationId: "correlation:changed" }),
      createBinding({ bindingRevision: 2 }),
      createBinding({ bindingDigest: "digest:parent-registry:v2" }),
      createBinding({ scope: { workerRunId: "worker-run:changed" } }),
      createBinding({ resourceCeiling: { maxOutputBytes: 2_097_152 } }),
      createBinding({ delegatedContextRefs: ["context:changed"] }),
    ]) {
      expect(() => fixture.registry.writer.register(conflicting)).toThrowError(
        PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_ERROR_CODES.IDENTITY_CONFLICT,
      );
    }
    expect(() =>
      fixture.registry.writer.register(
        createBinding({ scope: { fencingToken: 8 }, authority: { fencingToken: 8 } }),
      ),
    ).toThrowError(PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_ERROR_CODES.BINDING_PEER_MISMATCH);
    expect(await fixture.registry.reader.lookup(binding.parentMessageId)).toEqual(binding);
  });

  it("invalidates all bindings when the trusted boot or authority changes", async () => {
    const fixture = registryFixture();
    const binding = createBinding();
    fixture.registry.writer.register(binding);

    fixture.setPeer({ ...peer, workerBootId: "worker-boot:next" });
    expect(await fixture.registry.reader.lookup(binding.parentMessageId)).toBeUndefined();
    expect(() => fixture.registry.writer.register(binding)).toThrowError(
      PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_ERROR_CODES.PEER_SCOPE_CHANGED,
    );

    fixture.setPeer(peer);
    expect(await fixture.registry.reader.lookup(binding.parentMessageId)).toBeUndefined();
    expect(() => fixture.registry.writer.register(binding)).toThrowError(
      PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_ERROR_CODES.PEER_SCOPE_CHANGED,
    );

    const second = registryFixture();
    second.registry.writer.register(binding);
    second.setPeer({ ...peer, authorityEpoch: peer.authorityEpoch + 1 });
    expect(await second.registry.reader.lookup(binding.parentMessageId)).toBeUndefined();
  });

  it("rejects a binding that is not aligned with the trusted peer", () => {
    const fixture = registryFixture();

    expect(() =>
      fixture.registry.writer.register(
        createBinding({ authority: { agentServiceBootId: "agent-boot:other" } }),
      ),
    ).toThrowError(PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_ERROR_CODES.BINDING_PEER_MISMATCH);
  });

  it("rejects incomplete bindings without changing the registry", async () => {
    const fixture = registryFixture();
    const binding = createBinding({ resourceCeiling: { maxOutputBytes: 0 } });

    expect(() => fixture.registry.writer.register(binding)).toThrowError(
      PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_ERROR_CODES.BINDING_INVALID,
    );
    expect(await fixture.registry.reader.lookup(binding.parentMessageId)).toBeUndefined();
  });
});
