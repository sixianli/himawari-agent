import { createHash } from "node:crypto";
import {
  ACTION_KIND_RISK_BASELINE,
  computeActionRisk,
  DEFAULT_WEB_PROVIDERS,
  type GovernedActionIntent,
  type GovernedCapabilityExecutionHandle,
  type HostDirectoryGrant,
  isModelVisible,
  type RuntimeToolExecutionResult,
  type RuntimeToolInvocation,
  type RuntimeToolSettledResult,
  resolveHostFileReadPath,
  runtimeToolAuthorizationResult,
  type ThreadArtifactSource,
  WEB_FETCH_MAXIMUM_OFFSET,
  webProviderEgress,
  webProviderRecipients,
} from "@himawari-agent/application";
import { validatePublicFetchUrl } from "@himawari-agent/platform-node";
import { redactForExternalText, redactForExternalUrl } from "@himawari-agent/sensitive-capture";
import { isComputerTool } from "./production-computer-tools.js";
import type {
  FileReadExecutionContext,
  ProductionFileReadServices,
  WorkflowAuthority,
} from "./production-file-read-workflow.js";
import { stageTiming } from "./production-stage-timing.js";
import type { ThreadArtifactCandidate } from "./production-thread-artifacts.js";
import type {
  WorkspaceLedgerBaseline,
  WorkspaceLedgerChange,
} from "./production-workspace-ledger.js";

type Tool =
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "find"
  | "grep"
  | "ls"
  | "move_directory"
  | "save_copy"
  | "web_search"
  | "web_fetch";
const webTool = (tool: Tool) => tool === "web_search" || tool === "web_fetch";
const hash = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, entry: unknown) =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry)
          ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
          : entry,
      ),
    )
    .digest("hex");
function stableCall(call: RuntimeToolInvocation, authority?: WorkflowAuthority) {
  if (!call.context) throw new Error("CODING_CONTEXT_UNAVAILABLE");
  const { executionLease, continuationRef: _continuation, ...context } = call.context;
  return {
    ...call,
    context: {
      ...context,
      authority: authority ?? {
        deploymentId: executionLease.deploymentId,
        authorityEpoch: executionLease.authorityEpoch,
        fencingToken: executionLease.fencingToken,
      },
    },
  };
}
const failed = (code: string): RuntimeToolExecutionResult => ({
  dispatchState: "not_sent",
  outcome: "failed",
  resultRef: null,
  errorCode: code,
  externalActionId: null,
  modelContent: `工具未执行：${code}`,
});

function targetsGrantRoot(grant: HostDirectoryGrant, target: string): boolean {
  const root = grant.displayPath.replace(/\/+$/, "") || "/";
  const candidate = target.replace(/\/+$/, "");
  return candidate === "." || (candidate.length > 0 && candidate === root);
}

const directoryTargetResult = (): RuntimeToolExecutionResult => ({
  dispatchState: "not_sent",
  outcome: "failed",
  resultRef: null,
  errorCode: "CODING_PATH_IS_DIRECTORY",
  externalActionId: null,
  modelContent:
    "工具未执行：CODING_PATH_IS_DIRECTORY。这个路径是目录（可能是授权工作目录本身），不是文件。查看目录内容请用 ls；请在 ls 的结果里找到具体文件后，再对那个文件路径调用 read。",
});

export const fileVersionConflictResult = (
  dispatchState: "not_sent" | "accepted" = "not_sent",
): RuntimeToolSettledResult => ({
  dispatchState,
  outcome: "failed",
  resultRef: null,
  errorCode: "FILE_VERSION_CONFLICT",
  externalActionId: null,
  modelContent:
    "目标文件已变化，已确认本次候选未发布。已准备的候选仍保留；请重新读取最新内容，理解并保留他人修改后，用新的工具调用提出修改。新内容仍须经过原权限检查；无法确定意图时暂停说明。",
});

async function outboundWebArguments(
  args: RuntimeToolInvocation["arguments"],
  services: ProductionFileReadServices,
): Promise<RuntimeToolInvocation["arguments"]> {
  const query = args["query"];
  const url = args["url"];
  if (typeof query !== "string" && typeof url !== "string") return args;
  const tag = await services.externalTag?.();
  const options = tag === undefined ? {} : { tag };
  return {
    ...args,
    ...(typeof query === "string" ? { query: redactForExternalText(query, options).text } : {}),
    ...(typeof url === "string" ? { url: redactForExternalUrl(url, options).text } : {}),
  };
}

export async function executeProductionCodingRequest(
  call: RuntimeToolInvocation,
  tool: Tool,
  services: ProductionFileReadServices,
  ctx: FileReadExecutionContext,
): Promise<RuntimeToolExecutionResult> {
  const timing = stageTiming("tool.workflow.timing", {
    runId: call.runId,
    toolCallId: call.toolCallId,
    tool,
  });
  await ctx.assertActive();
  const binding = await services.binding(call);
  timing.mark("binding");
  if (
    !binding ||
    !call.context ||
    !call.executionDeadlineAt ||
    `${binding.capabilityRef}.${tool}` !== call.capabilityRef ||
    binding.threadId !== call.context.threadId ||
    binding.modelRef !== call.context.modelRef ||
    binding.workerInstanceId !== ctx.workerInstanceId()
  )
    return failed("CODING_BINDING_UNAVAILABLE");
  if (binding.workspaceCopy && tool !== "bash") return failed("CODING_COPY_REQUIRES_BASH");
  if (
    tool === "save_copy" &&
    (!binding.copySaveOperation ||
      binding.copySaveOperation.id !== call.arguments["operationId"] ||
      binding.copySaveOperation.canonicalHash !== call.arguments["expectedHash"])
  )
    return failed("COPY_SAVE_OPERATION_UNAVAILABLE");
  const grant = binding.grant;
  if (!isModelVisible(call.dataClassification) || (grant === null && !webTool(tool)))
    return failed("CODING_DIRECTORY_UNAVAILABLE");
  const write = ["write", "edit", "bash", "move_directory", "save_copy"].includes(tool);
  const required =
    tool === "save_copy" && binding.copySaveOperation
      ? ["read", binding.copySaveOperation.operation]
      : tool === "move_directory"
        ? ["move"]
        : tool === "write" || (tool === "bash" && !binding.workspaceCopy)
          ? ["read", "create", "update"]
          : tool === "edit"
            ? ["read", "update"]
            : ["read"];
  if (
    grant !== null &&
    (grant.hostId !== binding.hostId ||
      grant.revokedAt !== null ||
      required.some((op) => !grant.operations.some((allowed) => allowed === op)) ||
      grant.pathPolicy !== "same_filesystem_no_links" ||
      grant.mountPolicy !== "fixed_device" ||
      !Number.isSafeInteger(grant.revision) ||
      grant.revision < 1 ||
      !Number.isFinite(Date.parse(grant.expiresAt)) ||
      !["model", "external_approved"].includes(grant.disclosure) ||
      !isModelVisible(grant.dataClassification))
  )
    return failed("CODING_DIRECTORY_UNAVAILABLE");
  if (Buffer.byteLength(JSON.stringify(call.arguments)) > 49152)
    return failed("CODING_INPUT_TOO_LARGE");
  let args: RuntimeToolInvocation["arguments"];
  try {
    args = webTool(tool) ? await outboundWebArguments(call.arguments, services) : call.arguments;
  } catch {
    return failed(tool === "web_search" ? "WEB_SEARCH_UNAVAILABLE" : "WEB_FETCH_UNAVAILABLE");
  }
  if (Buffer.byteLength(JSON.stringify(args)) > 49152) return failed("CODING_INPUT_TOO_LARGE");
  if (
    tool === "web_search" &&
    (typeof args["query"] !== "string" ||
      !args["query"].trim() ||
      Buffer.byteLength(args["query"]) > 4096 ||
      Object.keys(args).some((key) => !["query", "limit"].includes(key)) ||
      (args["limit"] !== undefined &&
        (!Number.isInteger(args["limit"]) ||
          Number(args["limit"]) < 1 ||
          Number(args["limit"]) > 10)))
  )
    return failed("WEB_SEARCH_INPUT_INVALID");
  if (tool === "web_fetch") {
    if (
      typeof args["url"] !== "string" ||
      Object.keys(args).some((key) => !["url", "offset"].includes(key)) ||
      (args["offset"] !== undefined &&
        (!Number.isSafeInteger(args["offset"]) ||
          Number(args["offset"]) < 0 ||
          Number(args["offset"]) > WEB_FETCH_MAXIMUM_OFFSET))
    )
      return failed("WEB_FETCH_INPUT_INVALID");
    try {
      validatePublicFetchUrl(args["url"]);
    } catch {
      return failed("WEB_FETCH_INPUT_INVALID");
    }
  }
  if (tool !== "bash" && !webTool(tool) && tool !== "save_copy") {
    if (!grant) return failed("CODING_DIRECTORY_UNAVAILABLE");
    const target =
      args["path"] ?? (tool === "ls" || tool === "find" || tool === "grep" ? "." : undefined);
    if (typeof target !== "string") return failed("CODING_PATH_REQUIRED");
    if (["read", "write", "edit"].includes(tool) && targetsGrantRoot(grant, target))
      return directoryTargetResult();
    try {
      const rootQuery =
        ["ls", "find", "grep"].includes(tool) && (target === "." || target === grant.displayPath);
      if (!rootQuery) resolveHostFileReadPath(grant, target);
      if (tool === "move_directory") {
        if (
          typeof args["destination"] !== "string" ||
          Object.keys(args).some((key) => !["path", "destination"].includes(key))
        )
          return failed("CODING_PATH_REQUIRED");
        resolveHostFileReadPath(grant, args["destination"]);
      }
    } catch {
      return failed("CODING_PATH_OUTSIDE_SCOPE");
    }
  }
  const now = ctx.now();
  if (!Number.isFinite(Date.parse(call.executionDeadlineAt)))
    return failed("CODING_REQUEST_EXPIRED");
  const expiresAt = new Date(
    Math.min(grant ? Date.parse(grant.expiresAt) : Infinity, Date.parse(call.executionDeadlineAt)),
  ).toISOString();
  if (expiresAt <= now) return failed("CODING_REQUEST_EXPIRED");
  const proposed = {
    call: stableCall(call),
    binding,
    tool,
    authorityFence: ctx.authorityFence(),
    requestedAt: now,
    expiresAt,
  };
  const frozen = (await ctx.save("context", proposed)).value as typeof proposed;
  const previousAuthority = frozen.call.context.authority;
  const rebound =
    frozen.authorityFence === previousAuthority.fencingToken &&
    (await ctx.canResumeAuthority?.(previousAuthority));
  const activeFence = rebound ? ctx.authorityFence() : frozen.authorityFence;
  if (
    hash({
      ...proposed,
      ...(rebound
        ? { call: stableCall(call, previousAuthority), authorityFence: frozen.authorityFence }
        : {}),
      requestedAt: frozen.requestedAt,
      expiresAt: frozen.expiresAt,
    }) !== hash(frozen)
  )
    return failed("CODING_CONTEXT_CHANGED");
  const active = async () => {
    await ctx.assertActive();
    if (
      ctx.now() >= frozen.expiresAt ||
      ctx.authorityFence() !== activeFence ||
      hash(await services.binding(call)) !== hash(binding)
    )
      throw new Error("CODING_CONTEXT_CHANGED");
  };
  const resourceRef = `coding:${hash([call.runId, call.toolCallId, tool, args, binding])}`;
  const actionKind =
    tool === "bash"
      ? "INSTALL_OR_EXECUTE_CODE"
      : binding.copySaveOperation?.operation === "trash"
        ? "DELETE"
        : write
          ? "CREATE_OR_UPDATE"
          : "READ";
  const unrated: Omit<GovernedActionIntent, "finalRisk"> = {
    contractVersion: "authorization.v2",
    id: resourceRef,
    ownerId: ctx.ownerId,
    agentId: ctx.agentId,
    threadId: binding.threadId,
    runId: call.runId,
    capabilityRef: binding.capabilityRef,
    capabilityVersion: binding.capabilityVersion,
    operation: tool,
    resourceRef,
    resourceRefs: [resourceRef],
    targets: [
      { type: "host", ref: binding.hostId },
      ...(grant
        ? [
            { type: "directory-grant", ref: grant.id },
            { type: "directory-path", ref: grant.displayPath },
          ]
        : []),
      ...(binding.workspaceCopy
        ? [{ type: "workspace-copy", ref: binding.workspaceCopy.canonicalRootId }]
        : []),
      ...(binding.copySaveOperation
        ? [{ type: "prepared-file-operation", ref: binding.copySaveOperation.id }]
        : []),
      { type: "tool", ref: tool },
      { type: "input-digest", ref: hash(args) },
      { type: "model", ref: binding.modelIdentity },
      ...(webTool(tool)
        ? webProviderEgress(binding.providers).map((ref) => ({ type: "network-domain", ref }))
        : []),
      ...(typeof args["destination"] === "string"
        ? [{ type: "destination-path", ref: args["destination"] }]
        : []),
      ...(typeof args["path"] === "string" ? [{ type: "file-path", ref: args["path"] }] : []),
    ],
    dataClassification: "private",
    sideEffect: tool === "bash" ? "irreversible" : write ? "reversible" : "none",
    estimatedCostMicros: 0,
    frequency: { count: 1, intervalMs: null },
    idempotencyKey: resourceRef as GovernedActionIntent["idempotencyKey"],
    reversible: tool !== "bash",
    requestedAt: frozen.requestedAt,
    expiresAt: frozen.expiresAt,
    actionKind,
    disclosure: "named_recipients",
    recipients: [
      binding.modelIdentity,
      ...(webTool(tool) ? webProviderRecipients(binding.providers) : []),
    ],
    credentialOrAccessChange: false,
    modelClassification: {
      actionKind,
      suggestedRisk: ACTION_KIND_RISK_BASELINE[actionKind],
      reasonCode: "product_governed_coding",
    },
    deterministicFacts: [
      { code: "external_model_disclosure", minimumRisk: "LOW", source: "product" },
      ...(webTool(tool)
        ? [
            {
              code: "external_provider_disclosure",
              minimumRisk: "MEDIUM" as const,
              source: "product" as const,
            },
          ]
        : []),
    ],
  };
  const intent: GovernedActionIntent = {
    ...unrated,
    finalRisk: computeActionRisk({ ...unrated, finalRisk: "LOW" }),
  };
  if (["write", "edit"].includes(tool)) {
    const previous = await ctx.fileConflict?.(call.toolCallId);
    if (previous) {
      await active();
      return fileVersionConflictResult(previous.dispatchState);
    }
  }
  if (call.fileConflictOf !== undefined) {
    const previous = await ctx.fileConflict?.(call.fileConflictOf);
    if (
      !["write", "edit"].includes(tool) ||
      !grant ||
      !previous ||
      previous.call.runId !== call.runId ||
      previous.call.toolCallId === call.toolCallId ||
      hash(previous.binding) !== hash(binding) ||
      typeof previous.call.arguments["path"] !== "string" ||
      typeof args["path"] !== "string" ||
      resolveHostFileReadPath(grant, previous.call.arguments["path"]) !==
        resolveHostFileReadPath(grant, args["path"]) ||
      !Number.isSafeInteger(previous.depth) ||
      previous.depth < 0 ||
      previous.depth >= 3
    )
      return failed("CODING_CONFLICT_REGENERATION_BLOCKED");
    await ctx.save("conflict-lineage", {
      previousToolCallId: previous.call.toolCallId,
      previousIntentId: `coding:${hash([
        previous.call.runId,
        previous.call.toolCallId,
        previous.call.capabilityRef.slice(previous.binding.capabilityRef.length + 1),
        previous.call.arguments,
        previous.binding,
      ])}`,
      intentId: intent.id,
      depth: previous.depth + 1,
    });
  }
  await active();
  timing.mark("prepare");
  const display = services.approvalDisplay?.({
    threadId: binding.threadId,
    tool,
    arguments: args,
  });
  const permission = display
    ? await services.authorize(intent, ctx.signal, display)
    : await services.authorize(intent, ctx.signal);
  timing.mark("authorize");
  if (permission.decision !== "ALLOW") {
    const result = runtimeToolAuthorizationResult(permission);
    return result.outcome === "failed" ? { ...result, dispatchState: "not_sent" } : result;
  }
  await active();
  if (services.computer && grant !== null && !binding.workspaceCopy && isComputerTool(tool)) {
    const finished = (await ctx.load("computer-result")) as RuntimeToolSettledResult | undefined;
    if (finished) return finished;
    if (await ctx.load("computer-dispatched")) {
      const unknown: RuntimeToolSettledResult = {
        dispatchState: "possibly_sent",
        outcome: "result_unknown",
        resultRef: null,
        errorCode: "COMPUTER_RESULT_UNKNOWN",
        externalActionId: null,
        modelContent:
          "这次工具调用已经发到你的电脑里，但服务中途重启，没拿到结果，不知道有没有执行完。没有自动重做；需要的话先检查现状再决定。",
      };
      await ctx.save("computer-result", unknown);
      return unknown;
    }
    let relativePath: string | null = null;
    if (tool !== "bash") {
      const target = args["path"] ?? ".";
      try {
        relativePath =
          target === "." || target === grant.displayPath
            ? ""
            : resolveHostFileReadPath(grant, target as string);
      } catch {
        return failed("CODING_PATH_OUTSIDE_SCOPE");
      }
    }
    await ctx.save("computer-dispatched", { at: ctx.now() });
    const startedAt = ctx.now();
    const executed = await services.computer.execute({
      ownerId: ctx.ownerId,
      tool,
      toolCallId: call.toolCallId,
      hostId: binding.hostId,
      grant,
      parameters: args,
      relativePath,
      maximumOutputBytes: binding.maximumBytes,
      deadlineAt: frozen.expiresAt,
    });
    await active();
    const settled: RuntimeToolSettledResult = {
      dispatchState: "accepted",
      executionTiming: { startedAt, endedAt: ctx.now() },
      outcome: executed.isError ? "failed" : "succeeded",
      resultRef: null,
      errorCode: executed.errorCode,
      externalActionId: null,
      modelContent: executed.modelContent,
    };
    await ctx.save("computer-result", settled);
    return settled;
  }
  if (services.hostReadOnly && grant !== null && ["read", "ls", "find", "grep"].includes(tool)) {
    const cached = (await ctx.load("host-result")) as RuntimeToolSettledResult | undefined;
    if (cached) return cached;
    const target = args["path"] ?? ".";
    let relativePath: string;
    try {
      relativePath =
        target === "." || target === grant.displayPath
          ? ""
          : resolveHostFileReadPath(grant, target as string);
    } catch {
      return failed("CODING_PATH_OUTSIDE_SCOPE");
    }
    const startedAt = ctx.now();
    const executed = await services.hostReadOnly.execute({
      tool: tool as "read" | "ls" | "find" | "grep",
      toolCallId: call.toolCallId,
      grant,
      parameters: args,
      relativePath,
      readBytesLimit: 16 * 1024 * 1024,
      maximumOutputBytes: binding.maximumBytes,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    await active();
    const settled: RuntimeToolSettledResult = {
      dispatchState: "accepted",
      executionTiming: { startedAt, endedAt: ctx.now() },
      outcome: executed.isError ? "failed" : "succeeded",
      resultRef: null,
      errorCode: executed.errorCode,
      externalActionId: null,
      modelContent: executed.modelContent,
    };
    await ctx.save("host-result", settled);
    return settled;
  }
  const memory = webTool(tool) ? services.webMemory : undefined;
  const providers = binding.providers ?? DEFAULT_WEB_PROVIDERS;
  const memoryKey = memory?.key({
    ownerId: ctx.ownerId,
    agentId: ctx.agentId,
    tool: tool as "web_search" | "web_fetch",
    providers,
    arguments: args,
  });
  if (services.hostWeb && webTool(tool)) {
    const previous = (await ctx.load("host-result")) as RuntimeToolSettledResult | undefined;
    if (previous) return previous;
    const hit = memory && memoryKey ? memory.cached(memoryKey) : undefined;
    if (hit) {
      await active();
      await ctx.save("host-result", hit);
      return hit;
    }
    const startedAt = ctx.now();
    const executed = await services.hostWeb.execute({
      tool: tool as "web_search" | "web_fetch",
      arguments: args,
      providers: memory ? memory.order(providers) : providers,
      secrets: binding.providerSecrets ?? [],
      maximumBytes: binding.maximumBytes,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    await active();
    const settled: RuntimeToolSettledResult = {
      dispatchState: "accepted",
      executionTiming: { startedAt, endedAt: ctx.now() },
      outcome: executed.ok ? "succeeded" : "failed",
      resultRef: null,
      errorCode: executed.code,
      externalActionId: null,
      modelContent: executed.output,
    };
    if (memory && memoryKey) {
      memory.observe(providers, settled);
      memory.remember(memoryKey, tool as "web_search" | "web_fetch", settled);
    }
    await ctx.save("host-result", settled);
    return settled;
  }
  let saved = (await ctx.load("handle")) as
    | { handle: GovernedCapabilityExecutionHandle; inputRef: string }
    | undefined;
  if (!saved && memory && memoryKey) {
    const previous = (await ctx.load("host-result")) as RuntimeToolSettledResult | undefined;
    if (previous) return previous;
    const hit = memory.cached(memoryKey);
    if (hit) {
      await active();
      await ctx.save("host-result", hit);
      return hit;
    }
  }
  const providerSecrets = webTool(tool) ? (binding.providerSecrets ?? []) : [];
  const secretNames = providerSecrets.length
    ? {
        secretRefs: Object.fromEntries(
          providerSecrets.map(({ provider, secretRef }) => [provider, secretRef]),
        ),
      }
    : {};
  if (!saved) {
    const ordered = memory ? memory.order(providers) : binding.providers;
    const input = await ctx.save(
      "input",
      tool === "web_search"
        ? { ...args, ...(ordered ? { providers: ordered } : {}), ...secretNames }
        : tool === "web_fetch"
          ? {
              url: args["url"],
              ...(args["offset"] === undefined ? {} : { offset: args["offset"] }),
              maximumBytes: binding.maximumBytes,
              ...(ordered ? { providers: ordered } : {}),
              ...secretNames,
            }
          : args,
    );
    const handle = await services.issue({
      ownerId: ctx.ownerId,
      agentId: ctx.agentId,
      runId: call.runId,
      authorityFence: ctx.authorityFence(),
      capabilityRef: binding.capabilityRef,
      capabilityVersion: binding.capabilityVersion,
      operation: tool,
      permission,
      inputRefs: [input.ref],
      delegatedContextRefs: [],
      secretRefs: providerSecrets.map(({ secretRef, secretVersion, purpose }) => ({
        secretRef,
        secretVersion,
        purpose,
      })),
      maxUses: 1,
      maxTotalCostMicros: 0,
      expiresAt: frozen.expiresAt,
    });
    saved = (await ctx.save("handle", { handle, inputRef: input.ref })).value as typeof saved;
  }
  if (!saved) throw new Error("CODING_HANDLE_UNAVAILABLE");
  await active();
  timing.mark("handle");
  const ledger =
    tool === "bash" && grant !== null && !binding.workspaceCopy
      ? services.workspaceLedger
      : undefined;
  if (ledger && grant !== null) {
    let baseline = (await ctx.load("workspace-before")) as WorkspaceLedgerBaseline | undefined;
    if (!baseline) {
      try {
        baseline = await ledger.baseline(grant);
      } catch {
        return failed("WORKSPACE_LEDGER_UNAVAILABLE");
      }
      baseline = (await ctx.save("workspace-before", baseline)).value as WorkspaceLedgerBaseline;
    }
    timing.mark("ledger_before");
    const finishOverlap = services.threadArtifacts?.begin(grant.id);
    let overlapped = false;
    let executed: RuntimeToolExecutionResult;
    try {
      executed = await ctx.phase(saved.handle, tool, saved.inputRef);
    } finally {
      overlapped = finishOverlap?.() ?? false;
    }
    timing.mark("phase");
    if (executed.outcome === "awaiting_approval") return executed;
    let changes = (await ctx.load("workspace-changes")) as { readonly summary: string } | undefined;
    if (!changes) {
      const identity = {
        runId: call.runId,
        toolCallId: call.toolCallId,
        threadId: binding.threadId,
        grantId: grant.id,
        command: typeof args["command"] === "string" ? args["command"] : null,
      };
      let recorded: Record<string, unknown>;
      try {
        recorded = { ...identity, ...(await ledger.record(grant, baseline)) };
      } catch (error) {
        recorded = {
          ...identity,
          version: "workspace-changes.v1",
          errorCode: error instanceof Error ? error.message : "WORKSPACE_LEDGER_FAILED",
          summary: "工作目录改动：这次没能记录",
        };
      }
      changes = (await ctx.save("workspace-changes", recorded)).value as { summary: string };
      await recordThreadArtifacts(
        services,
        ctx,
        call,
        binding.threadId,
        grant,
        "bash",
        overlapped,
        [...ledgerCandidates(recorded)],
      );
      await services.threadArtifacts?.recordDeleted({
        ownerId: ctx.ownerId,
        agentId: ctx.agentId,
        threadId: binding.threadId,
        runId: call.runId,
        toolCallId: call.toolCallId,
        paths: ledgerDeletedPaths(recorded),
        grant,
        overlapped,
      });
    }
    timing.finish("ledger_after");
    return {
      ...executed,
      modelContent: executed.modelContent
        ? `${executed.modelContent}\n\n${changes.summary}`
        : changes.summary,
    };
  }
  const result = await ctx.phase(saved.handle, tool, saved.inputRef);
  timing.mark("phase");
  if (
    (tool === "write" || tool === "edit") &&
    grant !== null &&
    result.outcome === "succeeded" &&
    typeof args["path"] === "string"
  )
    await recordThreadArtifacts(services, ctx, call, binding.threadId, grant, tool, false, [
      {
        path: resolveHostFileReadPath(grant, args["path"]),
        ...(tool === "write" && typeof args["content"] === "string"
          ? { sizeBytes: Buffer.byteLength(args["content"]) }
          : {}),
      },
    ]);
  if (memory && memoryKey) {
    memory.observe(providers, result);
    memory.remember(memoryKey, tool as "web_search" | "web_fetch", result);
  }
  timing.finish("artifacts");
  return result;
}

function ledgerDeletedPaths(recorded: Record<string, unknown>): string[] {
  const changes = recorded["changes"];
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((change: WorkspaceLedgerChange) =>
    change.kind === "file" && change.change === "deleted" ? [change.path] : [],
  );
}

function ledgerCandidates(recorded: Record<string, unknown>): ThreadArtifactCandidate[] {
  const changes = recorded["changes"];
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((change: WorkspaceLedgerChange) =>
    change.kind === "file" && change.change !== "deleted" && change.after
      ? [
          {
            path: change.path,
            sizeBytes: Number(change.after.size),
            sha256: change.after.sha256 ?? null,
          },
        ]
      : [],
  );
}

async function recordThreadArtifacts(
  services: ProductionFileReadServices,
  ctx: FileReadExecutionContext,
  call: RuntimeToolInvocation,
  threadId: string,
  grant: HostDirectoryGrant,
  source: ThreadArtifactSource,
  overlapped: boolean,
  candidates: readonly ThreadArtifactCandidate[],
): Promise<void> {
  const saveCopy = ctx.saveCopy;
  if (!services.threadArtifacts || !saveCopy || candidates.length === 0) return;
  await services.threadArtifacts.record({
    ownerId: ctx.ownerId,
    agentId: ctx.agentId,
    threadId,
    runId: call.runId,
    toolCallId: call.toolCallId,
    source,
    grant,
    candidates,
    overlapped,
    saveCopy: (key, bytes, mediaType) => saveCopy(key, bytes, mediaType),
  });
}
