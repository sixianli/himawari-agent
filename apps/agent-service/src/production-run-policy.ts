import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ApplicationPortError,
  type CapabilityExecutionHandleStorePort,
  type ClockPort,
  type DataClassification,
  type HostDirectoryGrant,
  hostDirectoryGrantStateKey,
  type IdGeneratorPort,
  isModelVisible,
  type PayloadProtectorPort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
  type RunExecutionPolicy,
  type RunExecutionSource,
  type RunPayloadArtifactPort,
  type WebProviderId,
  webProviderChain,
} from "@himawari-agent/application";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import {
  CHAT_ANSWER_LANGUAGE,
  CHAT_CAPABILITIES_DOCUMENT_SKILL,
  CHAT_CAPABILITIES_HEADER,
  CHAT_CAPABILITIES_RUNTIME_ENVIRONMENT,
  CHAT_CAPABILITIES_SANDBOX_COMMANDS,
  CHAT_CAPABILITIES_SANDBOX_OFFLINE,
  CHAT_CAPABILITIES_SEARCH,
  CHAT_CAPABILITIES_WORKSPACE,
  CHAT_CAPABILITIES_WORKSPACE_COMMANDS,
  CHAT_CAPABILITIES_WORKSPACE_FILE_CARDS,
  CHAT_IDENTITY,
  CHAT_RUNTIME_ENVIRONMENT_DOCUMENT_SKILL,
  CHAT_RUNTIME_ENVIRONMENT_FETCH,
  CHAT_RUNTIME_ENVIRONMENT_FOOTER,
  CHAT_RUNTIME_ENVIRONMENT_HEADER,
  CHAT_RUNTIME_ENVIRONMENT_NO_CODING,
  CHAT_RUNTIME_ENVIRONMENT_NO_FETCH,
  CHAT_RUNTIME_ENVIRONMENT_NO_SEARCH,
  CHAT_RUNTIME_ENVIRONMENT_NO_WORKSPACE,
  CHAT_RUNTIME_ENVIRONMENT_SANDBOX_COMMANDS,
  CHAT_RUNTIME_ENVIRONMENT_SEARCH,
  CHAT_RUNTIME_ENVIRONMENT_WORKSPACE,
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
  readonly statusBoard?: (input: {
    readonly threadId: string;
    readonly dataClassification: DataClassification;
  }) => Promise<string | undefined>;
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
    if (!selected || !isModelVisible(source.dataClassification))
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "RUN_POLICY_MODEL_DISCLOSURE_DENIED",
      );
    const capabilities = runCapabilityNotice({ coding: policy.coding !== undefined });
    const board =
      source.threadId && options.statusBoard
        ? await options.statusBoard({
            threadId: source.threadId,
            dataClassification: source.dataClassification,
          })
        : undefined;
    const notice = runtimeEnvironmentNotice({
      coding: policy.coding !== undefined,
      workspaceRoot: policy.coding && options.workspaceRoot ? await options.workspaceRoot() : null,
      documentSkillDirectory: DOCUMENT_SKILL_DIRECTORY,
      ...(policy.coding && options.sandboxCommands
        ? { sandboxCommands: await options.sandboxCommands() }
        : {}),
      ...(policy.publicSearch
        ? { publicSearch: { providers: policy.publicSearch.providers } }
        : {}),
      ...(policy.publicFetch
        ? {
            publicFetch: {
              providers: policy.publicFetch.providers,
              maximumBytes: policy.publicFetch.maximumBytes,
            },
          }
        : {}),
    });
    const environment = board ? `${notice}\n\n${board}` : notice;
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
    const environmentIdentity = {
      runId: source.runId,
      purpose: "context" as const,
      operationKey: `run-runtime-environment:v1:${createHash("sha256")
        .update(environment)
        .digest("hex")}`,
    };
    let environmentArtifact = await options.artifacts.lookup(environmentIdentity);
    if (!environmentArtifact) {
      const payload = await options.protector.protect({
        ownerId: source.ownerId,
        agentId: source.agentId,
        ref: options.ids.next("run-runtime-environment"),
        plaintext: new TextEncoder().encode(environment),
        dataClassification: source.dataClassification,
        contentType: "text/plain",
        createdAt: options.clock.now(),
      });
      environmentArtifact = (await options.artifacts.commit({ ...environmentIdentity, payload }))
        .artifact;
    }
    const handles = await listHandles(source.runId, options.clock.now());
    return Object.freeze({
      modelRef: selected.ref,
      ...(source.modelSelection ? { thinkingLevel: source.modelSelection.thinkingLevel } : {}),
      systemInstructionRef: instruction.payloadRef,
      policyVersion: policy.version,
      policies: [],
      capabilities: [],
      runtimeEnvironmentRef: environmentArtifact.payloadRef,
      capabilityHandleRefs: handles.map(({ ref }) => ref),
      memoryLimit: policy.memoryLimit,
    });
  };
}

export const HIMAWARI_IDENTITY = CHAT_IDENTITY.text;

export const ANSWER_LANGUAGE_RULE = CHAT_ANSWER_LANGUAGE.text;

export const DOCUMENT_SKILL_DIRECTORY = fileURLToPath(
  new URL("./document-skill/", import.meta.url),
);

export function runCapabilityNotice(input: { readonly coding: boolean }): string {
  return [
    CHAT_CAPABILITIES_HEADER.text,
    CHAT_CAPABILITIES_RUNTIME_ENVIRONMENT.text,
    ...(input.coding
      ? [
          CHAT_CAPABILITIES_SANDBOX_OFFLINE.text,
          CHAT_CAPABILITIES_SANDBOX_COMMANDS.text,
          CHAT_CAPABILITIES_WORKSPACE.text,
          CHAT_CAPABILITIES_WORKSPACE_COMMANDS.text,
          CHAT_CAPABILITIES_WORKSPACE_FILE_CARDS.text,
          CHAT_CAPABILITIES_DOCUMENT_SKILL.text,
        ]
      : []),
    CHAT_CAPABILITIES_SEARCH.text,
  ].join("\n");
}

export function webProviderNames(providers: readonly WebProviderId[] | undefined): string {
  const [first, ...rest] = webProviderChain(providers).map((provider) => provider.displayName);
  return rest.length ? `${first}（失败时依次改用 ${rest.join("、")}）` : `${first}`;
}

export function runtimeEnvironmentNotice(input: {
  readonly coding: boolean;
  readonly workspaceRoot: string | null;
  readonly documentSkillDirectory?: string;
  readonly sandboxCommands?: SandboxCommandInventory;
  readonly publicSearch?: { readonly providers?: readonly WebProviderId[] | undefined };
  readonly publicFetch?: {
    readonly providers?: readonly WebProviderId[] | undefined;
    readonly maximumBytes: number;
  };
}): string {
  const lines = [CHAT_RUNTIME_ENVIRONMENT_HEADER.text];
  if (input.coding) {
    if (input.sandboxCommands)
      lines.push(
        renderPrompt(CHAT_RUNTIME_ENVIRONMENT_SANDBOX_COMMANDS, {
          available: input.sandboxCommands.available.join("、"),
          unavailable: input.sandboxCommands.unavailable.join("、"),
        }),
      );
    lines.push(
      input.workspaceRoot
        ? renderPrompt(CHAT_RUNTIME_ENVIRONMENT_WORKSPACE, { workspaceRoot: input.workspaceRoot })
        : CHAT_RUNTIME_ENVIRONMENT_NO_WORKSPACE.text,
    );
    if (input.documentSkillDirectory)
      lines.push(
        renderPrompt(CHAT_RUNTIME_ENVIRONMENT_DOCUMENT_SKILL, {
          documentSkillDirectory: input.documentSkillDirectory,
        }),
      );
  } else lines.push(CHAT_RUNTIME_ENVIRONMENT_NO_CODING.text);
  lines.push(
    input.publicSearch
      ? renderPrompt(CHAT_RUNTIME_ENVIRONMENT_SEARCH, {
          providers: webProviderNames(input.publicSearch.providers),
        })
      : CHAT_RUNTIME_ENVIRONMENT_NO_SEARCH.text,
    input.publicFetch
      ? renderPrompt(CHAT_RUNTIME_ENVIRONMENT_FETCH, {
          providers: webProviderNames(input.publicFetch.providers),
          maximumKib: String(Math.floor(input.publicFetch.maximumBytes / 1024)),
        })
      : CHAT_RUNTIME_ENVIRONMENT_NO_FETCH.text,
    CHAT_RUNTIME_ENVIRONMENT_FOOTER.text,
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
