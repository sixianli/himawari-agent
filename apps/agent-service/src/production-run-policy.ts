import { createHash } from "node:crypto";
import {
  ApplicationPortError,
  type CapabilityExecutionHandleStorePort,
  type ClockPort,
  type HostDirectoryGrant,
  hostDirectoryGrantStateKey,
  type IdGeneratorPort,
  type PayloadProtectorPort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
  type RunExecutionPolicy,
  type RunExecutionSource,
  type RunPayloadArtifactPort,
} from "@himawari-agent/application";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";

export function createProductionRunPolicy(options: {
  readonly configuration: ProductConfiguration;
  readonly artifacts: RunPayloadArtifactPort;
  readonly protector: PayloadProtectorPort;
  readonly handles: Pick<CapabilityExecutionHandleStorePort, "listRunExecutionHandles">;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly workspaceRoot?: () => Promise<string | null>;
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
    const capabilities = runCapabilityNotice({
      publicSearch: policy.publicSearch !== undefined,
      coding: policy.coding !== undefined,
      workspaceRoot: policy.coding && options.workspaceRoot ? await options.workspaceRoot() : null,
    });
    const identity = {
      runId: source.runId,
      purpose: "context" as const,
      operationKey: `run-system-instruction:v3:${createHash("sha256")
        .update(JSON.stringify([policy.systemInstruction, policy.timeZone ?? "UTC", capabilities]))
        .digest("hex")}`,
    };
    let instruction = await options.artifacts.lookup(identity);
    if (!instruction) {
      const payload = await options.protector.protect({
        ownerId: source.ownerId,
        agentId: source.agentId,
        ref: options.ids.next("run-system-instruction"),
        plaintext: new TextEncoder().encode(
          `${policy.systemInstruction}\n\n本轮请求时间（UTC）：${source.occurredAt}。配置时区 ${policy.timeZone ?? "UTC"} 的当地时间：${new Intl.DateTimeFormat("sv-SE", { timeZone: policy.timeZone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset" }).format(new Date(source.occurredAt))}。涉及“今天”或最新信息时，必须按查询地点的时区换算日期，不能直接截取 UTC 日期。\n\n${capabilities}`,
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

export function runCapabilityNotice(input: {
  readonly publicSearch: boolean;
  readonly coding: boolean;
  readonly workspaceRoot: string | null;
}): string {
  const lines = ["本轮能力边界："];
  if (input.coding) {
    lines.push(
      "- 文件和命令工具在隔离沙箱里执行。沙箱没有外网，curl、wget、pip、npm install、git clone 等联网操作一定失败，不要尝试。",
    );
    if (input.workspaceRoot)
      lines.push(
        `- 工作目录是 ${input.workspaceRoot}。读写文件用相对路径或这个目录下的路径，目录之外的路径会被拒绝。`,
      );
  }
  lines.push(
    input.publicSearch
      ? "- 需要联网信息时用 web_search 工具，它返回来源网址和摘录，不是完整网页。首次使用可能要等用户在页面打开联网搜索。使用真实查询，并核对来源日期。"
      : "- 本轮没有联网搜索工具。用户要实时信息（天气、新闻、价格等）时，直接说明现在查不到，不要用沙箱命令联网，也不要让用户去配置网络或代理。",
  );
  return lines.join("\n");
}

export function configuredWorkspaceRoot(
  configuration: ProductConfiguration,
  repository: Pick<SqliteProductStateRepository, "readScopedState">,
  clock: ClockPort,
): () => Promise<string | null> {
  return async () => {
    const route = configuration.runPolicy?.coding;
    if (!route) return null;
    const stored = await repository.readScopedState(
      configuration.ownerId,
      configuration.agentId,
      hostDirectoryGrantStateKey(route.grantId),
    );
    const grant = stored?.value as unknown as HostDirectoryGrant | undefined;
    if (
      !grant ||
      grant.id !== route.grantId ||
      grant.hostId !== route.hostId ||
      grant.revokedAt ||
      grant.expiresAt <= clock.now() ||
      typeof grant.displayPath !== "string"
    )
      return null;
    return grant.displayPath;
  };
}
