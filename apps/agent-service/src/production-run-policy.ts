import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
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
import { CHAT_ANSWER_LANGUAGE, CHAT_IDENTITY } from "@himawari-agent/prompt-catalog";
import type { SandboxCommandInventory } from "./sandbox-command-inventory.js";

export function createProductionRunPolicy(options: {
  readonly configuration: ProductConfiguration;
  readonly artifacts: RunPayloadArtifactPort;
  readonly protector: PayloadProtectorPort;
  readonly handles: Pick<CapabilityExecutionHandleStorePort, "listRunExecutionHandles">;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly workspaceRoot?: () => Promise<string | null>;
  readonly sandboxCommands?: () => Promise<SandboxCommandInventory>;
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
      documentSkillDirectory: DOCUMENT_SKILL_DIRECTORY,
      ...(policy.coding && options.sandboxCommands
        ? { sandboxCommands: await options.sandboxCommands() }
        : {}),
    });
    const identity = {
      runId: source.runId,
      purpose: "context" as const,
      operationKey: `run-system-instruction:v6:${createHash("sha256")
        .update(JSON.stringify([HIMAWARI_IDENTITY, policy.systemInstruction, capabilities]))
        .digest("hex")}`,
    };
    let instruction = await options.artifacts.lookup(identity);
    if (!instruction) {
      const payload = await options.protector.protect({
        ownerId: source.ownerId,
        agentId: source.agentId,
        ref: options.ids.next("run-system-instruction"),
        plaintext: new TextEncoder().encode(
          `${HIMAWARI_IDENTITY}\n\n${policy.systemInstruction}\n\n${ANSWER_LANGUAGE_RULE}\n\n${capabilities}`,
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

export const HIMAWARI_IDENTITY = CHAT_IDENTITY.text;

export const ANSWER_LANGUAGE_RULE = CHAT_ANSWER_LANGUAGE.text;

export const DOCUMENT_SKILL_DIRECTORY = fileURLToPath(
  new URL("./document-skill/", import.meta.url),
);

export function runCapabilityNotice(input: {
  readonly publicSearch: boolean;
  readonly coding: boolean;
  readonly workspaceRoot: string | null;
  readonly documentSkillDirectory?: string;
  readonly sandboxCommands?: SandboxCommandInventory;
}): string {
  const lines = ["本轮能力边界："];
  if (input.coding) {
    lines.push(
      "- 文件和命令工具在隔离沙箱里执行。沙箱没有外网，curl、wget、pip、npm install、git clone 等联网操作一定失败，不要尝试。",
    );
    if (input.sandboxCommands)
      lines.push(
        `- 沙箱里能直接用的常用命令：${input.sandboxCommands.available.join("、")}。沙箱里没有：${input.sandboxCommands.unavailable.join("、")}。用到没有的命令会得到“command not found”（退出码 127），不要重试，直接换别的办法；上面没列到的命令，用之前在一条命令里用 command -v 一次问清，不要一个个试。`,
      );
    if (input.workspaceRoot)
      lines.push(
        `- 工作目录是 ${input.workspaceRoot}。读写文件用相对路径或这个目录下的路径，目录之外的路径会被拒绝。`,
        "- 命令可以在工作目录里新建、修改和删除文件。每条命令前后系统会对比工作目录，把改了哪些文件附在命令结果末尾并留档。临时文件放到 $TMPDIR，不要放进工作目录。.git、.env、.himawari-recovery 等受保护的文件和文件夹不能读也不能写。",
        "- 你在工作目录里写出或改动的文件，界面会自动在回答下方显示文件卡片，用户点开就能预览和下载。回答里提到这些文件时只写文件名，不要写服务器上的完整路径，也不要让用户自己去服务器上找。",
      );
    if (input.documentSkillDirectory)
      lines.push(
        `- 做 Word、Excel、PDF 文档或读 PDF 时，先用 bash 运行 cat ${input.documentSkillDirectory}SKILL.md 读完并照做（read 工具只能读工作目录）：需要的库和中日文字体都已装好，不要探测或安装，也不要手写文件格式。`,
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
