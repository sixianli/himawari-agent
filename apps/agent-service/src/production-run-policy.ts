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
import {
  CHAT_ANSWER_LANGUAGE,
  CHAT_CAPABILITIES_DOCUMENT_SKILL,
  CHAT_CAPABILITIES_HEADER,
  CHAT_CAPABILITIES_NO_SEARCH,
  CHAT_CAPABILITIES_SANDBOX_COMMANDS,
  CHAT_CAPABILITIES_SANDBOX_OFFLINE,
  CHAT_CAPABILITIES_SEARCH,
  CHAT_CAPABILITIES_WORKSPACE,
  CHAT_CAPABILITIES_WORKSPACE_COMMANDS,
  CHAT_CAPABILITIES_WORKSPACE_FILE_CARDS,
  CHAT_IDENTITY,
  renderPrompt,
} from "@himawari-agent/prompt-catalog";
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
  const lines = [CHAT_CAPABILITIES_HEADER.text];
  if (input.coding) {
    lines.push(CHAT_CAPABILITIES_SANDBOX_OFFLINE.text);
    if (input.sandboxCommands)
      lines.push(
        renderPrompt(CHAT_CAPABILITIES_SANDBOX_COMMANDS, {
          available: input.sandboxCommands.available.join("、"),
          unavailable: input.sandboxCommands.unavailable.join("、"),
        }),
      );
    if (input.workspaceRoot)
      lines.push(
        renderPrompt(CHAT_CAPABILITIES_WORKSPACE, { workspaceRoot: input.workspaceRoot }),
        CHAT_CAPABILITIES_WORKSPACE_COMMANDS.text,
        CHAT_CAPABILITIES_WORKSPACE_FILE_CARDS.text,
      );
    if (input.documentSkillDirectory)
      lines.push(
        renderPrompt(CHAT_CAPABILITIES_DOCUMENT_SKILL, {
          documentSkillDirectory: input.documentSkillDirectory,
        }),
      );
  }
  lines.push(input.publicSearch ? CHAT_CAPABILITIES_SEARCH.text : CHAT_CAPABILITIES_NO_SEARCH.text);
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
