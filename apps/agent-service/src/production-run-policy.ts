import { createHash } from "node:crypto";
import {
  ApplicationPortError,
  type CapabilityExecutionHandleStorePort,
  type ClockPort,
  type IdGeneratorPort,
  type PayloadProtectorPort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
  type RunExecutionPolicy,
  type RunExecutionSource,
  type RunPayloadArtifactPort,
} from "@himawari-agent/application";

/** Resolve policy from trusted host configuration and durable, Run-scoped grants. */
export function createProductionRunPolicy(options: {
  readonly configuration: ProductConfiguration;
  readonly artifacts: RunPayloadArtifactPort;
  readonly protector: PayloadProtectorPort;
  readonly handles: Pick<CapabilityExecutionHandleStorePort, "listRunExecutionHandles">;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
}): (source: RunExecutionSource) => Promise<RunExecutionPolicy> {
  const { configuration } = options;
  const policy = configuration.runPolicy;
  const primary = configuration.modelDescriptors.find(({ role }) => role === "primary");
  if (!policy || !primary || !options.handles.listRunExecutionHandles)
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "RUN_POLICY_CONFIGURATION_INCOMPLETE",
    );
  const listHandles = options.handles.listRunExecutionHandles.bind(options.handles);
  return async (source) => {
    if (source.ownerId !== configuration.ownerId || source.agentId !== configuration.agentId)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "RUN_POLICY_SCOPE_MISMATCH",
      );
    const selected = source.modelSelection
      ? configuration.modelDescriptors.find(
          (model) => model.ref === source.modelSelection?.modelRef && model.role !== "embedding",
        )
      : primary;
    if (!selected || !selected.allowedDataClassifications.includes(source.dataClassification))
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "RUN_POLICY_MODEL_DISCLOSURE_DENIED",
      );
    const identity = {
      runId: source.runId,
      purpose: "context" as const,
      operationKey: `run-system-instruction:v1:${createHash("sha256").update(policy.systemInstruction).digest("hex")}`,
    };
    let instruction = await options.artifacts.lookup(identity);
    if (!instruction) {
      const payload = await options.protector.protect({
        ownerId: source.ownerId,
        agentId: source.agentId,
        ref: options.ids.next("run-system-instruction"),
        plaintext: new TextEncoder().encode(
          `${policy.systemInstruction}\n\n本轮请求时间（ISO 8601）：${source.occurredAt}。涉及“今天”或最新信息时，根据这个时间使用真实查询，并核对来源日期。`,
        ),
        dataClassification: source.dataClassification,
        contentType: "text/plain",
        createdAt: options.clock.now(),
      });
      instruction = (await options.artifacts.commit({ ...identity, payload })).artifact;
    }
    const handles = await listHandles(source.runId, options.clock.now());
    return Object.freeze({
      modelRef: selected.ref,
      ...(source.modelSelection ? { thinkingLevel: source.modelSelection.thinkingLevel } : {}),
      systemInstructionRef: instruction.payloadRef,
      policyVersion: policy.version,
      policies: [],
      capabilities: [],
      capabilityHandleRefs: handles.map(({ ref }) => ref),
      memoryLimit: policy.memoryLimit,
      maxSelectedMemories: policy.maxSelectedMemories,
      maxMemoryClassification: policy.maxMemoryClassification,
    });
  };
}
