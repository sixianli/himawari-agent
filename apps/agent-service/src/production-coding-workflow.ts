import { createHash } from "node:crypto";
import {
  type GovernedActionIntent,
  type GovernedCapabilityExecutionHandle,
  type RuntimeToolExecutionResult,
  type RuntimeToolInvocation,
  resolveHostFileReadPath,
  scanMachineSecrets,
  runtimeToolAuthorizationResult,
} from "@himawari-agent/application";
import type {
  FileReadExecutionContext,
  ProductionFileReadServices,
} from "./production-file-read-workflow.js";

type Tool = "read" | "write" | "edit" | "bash" | "find" | "grep" | "ls" | "web_search";
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
function stableCall(call: RuntimeToolInvocation) {
  if (!call.context) return call;
  const { executionLease, continuationRef: _continuation, ...context } = call.context;
  return {
    ...call,
    context: {
      ...context,
      authority: {
        deploymentId: executionLease.deploymentId,
        authorityEpoch: executionLease.authorityEpoch,
        fencingToken: executionLease.fencingToken,
      },
    },
  };
}
const failed = (code: string): RuntimeToolExecutionResult => ({
  outcome: "failed",
  resultRef: null,
  errorCode: code,
  externalActionId: null,
  modelContent: `工具未执行：${code}`,
});

/** Freeze model parameters, obtain an actual action/disclosure grant, issue one
 * private handle, then use the existing Worker path. Model arguments never grant access. */
export async function executeProductionCodingRequest(
  call: RuntimeToolInvocation,
  tool: Tool,
  services: ProductionFileReadServices,
  ctx: FileReadExecutionContext,
): Promise<RuntimeToolExecutionResult> {
  await ctx.assertActive();
  const binding = await services.binding(call);
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
  const grant = binding.grant;
  const write = ["write", "edit", "bash"].includes(tool);
  const required =
    tool === "write"
      ? ["read", "create", "update"]
      : tool === "edit"
        ? ["read", "update"]
        : ["read"];
  if (
    grant.hostId !== binding.hostId ||
    grant.revokedAt !== null ||
    required.some((op) => !grant.operations.some((allowed) => allowed === op)) ||
    grant.pathPolicy !== "same_filesystem_no_links" ||
    grant.mountPolicy !== "fixed_device" ||
    !Number.isSafeInteger(grant.revision) ||
    grant.revision < 1 ||
    !Number.isFinite(Date.parse(grant.expiresAt)) ||
    !["model", "external_approved"].includes(grant.disclosure) ||
    grant.dataClassification !== "private" ||
    call.dataClassification !== "private"
  )
    return failed("CODING_DIRECTORY_UNAVAILABLE");
  const args = call.arguments;
  if (Buffer.byteLength(JSON.stringify(args)) > 49152) return failed("CODING_INPUT_TOO_LARGE");
  if (
    tool === "web_search" &&
    (typeof args["query"] !== "string" ||
      !args["query"].trim() ||
      Buffer.byteLength(args["query"]) > 4096 ||
      scanMachineSecrets(args["query"]).length ||
      Object.keys(args).some((key) => !["query", "limit"].includes(key)) ||
      (args["limit"] !== undefined &&
        (!Number.isInteger(args["limit"]) ||
          Number(args["limit"]) < 1 ||
          Number(args["limit"]) > 10)))
  )
    return failed("WEB_SEARCH_INPUT_INVALID");
  if (tool !== "bash" && tool !== "web_search") {
    const target =
      args["path"] ?? (tool === "ls" || tool === "find" || tool === "grep" ? "." : undefined);
    if (typeof target !== "string") return failed("CODING_PATH_REQUIRED");
    try {
      const rootQuery =
        ["ls", "find", "grep"].includes(tool) && (target === "." || target === grant.displayPath);
      if (!rootQuery) resolveHostFileReadPath(grant, target);
    } catch {
      return failed("CODING_PATH_OUTSIDE_SCOPE");
    }
  }
  const now = ctx.now();
  if (!Number.isFinite(Date.parse(call.executionDeadlineAt)))
    return failed("CODING_REQUEST_EXPIRED");
  const expiresAt = new Date(
    Math.min(Date.parse(grant.expiresAt), Date.parse(call.executionDeadlineAt)),
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
  if (
    hash({ ...proposed, requestedAt: frozen.requestedAt, expiresAt: frozen.expiresAt }) !==
    hash(frozen)
  )
    return failed("CODING_CONTEXT_CHANGED");
  const active = async () => {
    await ctx.assertActive();
    if (
      ctx.now() >= frozen.expiresAt ||
      ctx.authorityFence() !== frozen.authorityFence ||
      hash(await services.binding(call)) !== hash(binding)
    )
      throw new Error("CODING_CONTEXT_CHANGED");
  };
  const resourceRef = `coding:${hash([call.runId, call.toolCallId, tool, args, binding])}`;
  const actionKind =
    tool === "bash" ? "INSTALL_OR_EXECUTE_CODE" : write ? "CREATE_OR_UPDATE" : "READ";
  const intent: GovernedActionIntent = {
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
      { type: "directory-grant", ref: grant.id },
      { type: "directory-path", ref: grant.displayPath },
      { type: "tool", ref: tool },
      { type: "input-digest", ref: hash(args) },
      { type: "model", ref: binding.modelIdentity },
      ...(tool === "web_search" ? [{ type: "network-domain", ref: "mcp.exa.ai:443" }] : []),
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
    recipients: [binding.modelIdentity, ...(tool === "web_search" ? ["https://mcp.exa.ai"] : [])],
    credentialOrAccessChange: false,
    modelClassification: {
      actionKind,
      suggestedRisk: "HIGH",
      reasonCode: "product_governed_coding",
    },
    deterministicFacts: [
      { code: "external_model_disclosure", minimumRisk: "HIGH", source: "product" },
    ],
    finalRisk: "HIGH",
  };
  await active();
  const permission = await services.authorize(intent);
  if (permission.decision !== "ALLOW") return runtimeToolAuthorizationResult(permission);
  await active();
  let saved = (await ctx.load("handle")) as
    | { handle: GovernedCapabilityExecutionHandle; inputRef: string }
    | undefined;
  if (!saved) {
    const input = await ctx.save("input", args);
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
      secretRefs: [],
      maxUses: 1,
      maxTotalCostMicros: 0,
      expiresAt: frozen.expiresAt,
    });
    saved = (await ctx.save("handle", { handle, inputRef: input.ref })).value as typeof saved;
  }
  if (!saved) throw new Error("CODING_HANDLE_UNAVAILABLE");
  await active();
  return ctx.phase(saved.handle, tool, saved.inputRef);
}
