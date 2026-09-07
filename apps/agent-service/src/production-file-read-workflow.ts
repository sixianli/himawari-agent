import { createHash } from "node:crypto";
import {
  resolveHostFileReadPath,
  runtimeToolAuthorizationResult,
} from "@himawari-agent/application";
import type {
  GovernedActionIntent,
  GovernedCapabilityExecutionHandle,
  HostDirectoryGrant,
  PermissionDecision,
  ResolvedHostFileReadTarget,
  RuntimeToolExecutionResult,
  RuntimeToolInvocation,
  RuntimeRequest,
  CapabilityHandleService,
} from "@himawari-agent/application";

export interface FileReadBinding {
  readonly workerInstanceId: string;
  readonly revision: number;
  readonly hostId: string;
  readonly grant: HostDirectoryGrant;
  readonly capabilityRef: string;
  readonly capabilityVersion: string;
  readonly maximumBytes: number;
  readonly threadId: string;
  readonly modelRef: string;
  readonly modelIdentity: string;
}
export interface ProductionFileReadServices {
  binding(call: RuntimeToolInvocation): Promise<FileReadBinding | undefined>;
  authorize(intent: GovernedActionIntent): Promise<PermissionDecision>;
  issue(
    input: Parameters<CapabilityHandleService["issue"]>[0],
  ): ReturnType<CapabilityHandleService["issue"]>;
}
export interface FileReadExecutionContext {
  readonly ownerId: RuntimeRequest["ownerId"];
  readonly agentId: RuntimeRequest["agentId"];
  readonly now: () => string;
  readonly authorityFence: () => number;
  readonly workerInstanceId: () => string;
  assertActive(): Promise<void>;
  load(key: string): Promise<unknown | undefined>;
  save(key: string, value: unknown): Promise<{ readonly ref: string; readonly value: unknown }>;
  phase(
    handle: GovernedCapabilityExecutionHandle,
    phase: "inspect" | "read",
    inputRef: string,
  ): Promise<RuntimeToolExecutionResult>;
}
function resumeIdentity(call: RuntimeToolInvocation) {
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
function hash(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        item !== null && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest("hex");
}
function failure(code: string): RuntimeToolExecutionResult {
  return {
    outcome: "failed",
    resultRef: null,
    errorCode: code,
    externalActionId: null,
    modelContent: `文件读取未完成：${code}`,
  };
}
const decisionFailure = runtimeToolAuthorizationResult;

/** One model call, two separately authorized Worker operations. Never reads local files. */
export class ProductionFileReadWorkflow {
  readonly services: ProductionFileReadServices;
  constructor(services: ProductionFileReadServices) {
    this.services = services;
  }

  async execute(
    call: RuntimeToolInvocation,
    ctx: FileReadExecutionContext,
  ): Promise<RuntimeToolExecutionResult> {
    await ctx.assertActive();
    if (
      call.capabilityHandleRef !== null ||
      call.capabilityRef !== "host.file.read" ||
      typeof call.arguments["path"] !== "string" ||
      !call.arguments["path"] ||
      Object.keys(call.arguments).some((key) => !["path", "offset", "limit"].includes(key)) ||
      [call.arguments["offset"], call.arguments["limit"]].some(
        (value) =>
          value !== undefined &&
          (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1),
      )
    )
      return failure("FILE_READ_REQUEST_INVALID");
    const binding = await this.services.binding(call);
    if (!binding) return failure("FILE_READ_BINDING_UNAVAILABLE");
    const now = ctx.now();
    const ranks = ["public", "private", "sensitive", "restricted"];
    if (
      !call.context ||
      call.context.threadId !== binding.threadId ||
      call.context.modelRef !== binding.modelRef ||
      ctx.workerInstanceId() !== binding.workerInstanceId ||
      ranks.indexOf(binding.grant.dataClassification) < 0 ||
      ranks.indexOf(binding.grant.dataClassification) > ranks.indexOf(call.dataClassification)
    )
      return failure("FILE_READ_SCOPE_INVALID");
    let relativePath: string;
    try {
      relativePath = resolveHostFileReadPath(binding.grant, call.arguments["path"]);
    } catch {
      return failure("FILE_READ_PATH_OUTSIDE_SCOPE");
    }
    if (
      !Number.isSafeInteger(binding.maximumBytes) ||
      binding.maximumBytes < 1 ||
      binding.hostId !== binding.grant.hostId ||
      binding.grant.revokedAt !== null ||
      !Number.isSafeInteger(binding.grant.revision) ||
      binding.grant.revision < 1 ||
      binding.grant.pathPolicy !== "same_filesystem_no_links" ||
      binding.grant.mountPolicy !== "fixed_device" ||
      !binding.grant.operations.includes("read") ||
      !Number.isFinite(Date.parse(binding.grant.expiresAt)) ||
      Date.parse(binding.grant.expiresAt) <= Date.parse(now)
    )
      return failure("FILE_READ_DIRECTORY_UNAVAILABLE");
    const expiresAt = call.executionDeadlineAt;
    if (
      !expiresAt ||
      !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= Date.parse(now)
    )
      return failure("FILE_READ_DEADLINE_REQUIRED");
    const snapshot = {
      call,
      binding,
      authorityFence: ctx.authorityFence(),
      requestedAt: now,
      expiresAt: new Date(
        Math.min(Date.parse(expiresAt), Date.parse(binding.grant.expiresAt)),
      ).toISOString(),
    };
    const stored = (await ctx.save("context", snapshot)).value as typeof snapshot;
    if (
      (call.context.continuationRef
        ? hash(resumeIdentity(stored.call)) !== hash(resumeIdentity(call))
        : hash(stored.call) !== hash(call)) ||
      hash(stored.binding) !== hash(binding) ||
      stored.authorityFence !== ctx.authorityFence()
    )
      return failure("FILE_READ_CONTEXT_CHANGED");
    const active = async () => {
      await ctx.assertActive();
      if (
        Date.parse(ctx.now()) >= Date.parse(stored.expiresAt) ||
        ctx.authorityFence() !== stored.authorityFence ||
        ctx.workerInstanceId() !== binding.workerInstanceId ||
        hash((await this.services.binding(call)) ?? null) !== hash(binding)
      )
        throw new Error("FILE_READ_CONTEXT_CHANGED");
    };
    const resource = `host-file:${encodeURIComponent(binding.hostId)}:${encodeURIComponent(binding.grant.id)}:${hash(relativePath)}`;
    const intent = (
      operation: string,
      target: unknown,
      disclose = false,
    ): GovernedActionIntent => ({
      contractVersion: "authorization.v2",
      id: `file-read:${hash([call.runId, call.toolCallId, operation])}`,
      ownerId: ctx.ownerId,
      agentId: ctx.agentId,
      threadId: binding.threadId,
      runId: call.runId,
      capabilityRef: binding.capabilityRef,
      capabilityVersion: binding.capabilityVersion,
      operation,
      resourceRef: `${resource}:${hash({ target, arguments: call.arguments, model: disclose ? binding.modelIdentity : null })}`,
      resourceRefs: [
        `${resource}:${hash({ target, arguments: call.arguments, model: disclose ? binding.modelIdentity : null })}`,
      ],
      targets: [
        { type: "host", ref: binding.hostId },
        { type: "directory-grant", ref: binding.grant.id },
        { type: "directory-path", ref: binding.grant.displayPath },
        { type: "file-path", ref: call.arguments["path"] as string },
        { type: "file-identity", ref: hash(target) },
        ...(disclose ? [{ type: "model", ref: binding.modelIdentity }] : []),
      ],
      dataClassification: call.dataClassification,
      sideEffect: "none",
      estimatedCostMicros: 0,
      frequency: { count: 1, intervalMs: null },
      idempotencyKey:
        `file-read:${hash([call.runId, call.toolCallId, operation])}` as GovernedActionIntent["idempotencyKey"],
      reversible: true,
      requestedAt: stored.requestedAt,
      expiresAt: stored.expiresAt,
      actionKind: "READ",
      disclosure: disclose ? "named_recipients" : "none",
      recipients: disclose ? [binding.modelIdentity] : [],
      credentialOrAccessChange: false,
      modelClassification: {
        actionKind: "READ",
        suggestedRisk: "LOW",
        reasonCode: "product_file_read",
      },
      deterministicFacts: disclose
        ? [{ code: "external_model_disclosure", minimumRisk: "HIGH", source: "product" }]
        : [],
      finalRisk: disclose ? "HIGH" : "LOW",
    });
    const runPhase = async (
      phase: "inspect" | "read",
      payload: unknown,
      action: GovernedActionIntent,
    ) => {
      await active();
      const permission = await this.services.authorize(action);
      if (permission.decision !== "ALLOW") return decisionFailure(permission);
      await active();
      let saved = (await ctx.load(`${phase}:handle`)) as
        | { handle: GovernedCapabilityExecutionHandle; inputRef: string }
        | undefined;
      if (!saved) {
        const input = await ctx.save(`${phase}:input`, payload);
        const handle = await this.services.issue({
          ownerId: ctx.ownerId,
          agentId: ctx.agentId,
          runId: call.runId,
          authorityFence: ctx.authorityFence(),
          capabilityRef: binding.capabilityRef,
          capabilityVersion: binding.capabilityVersion,
          operation: phase,
          permission,
          inputRefs: [input.ref],
          delegatedContextRefs: [],
          secretRefs: [],
          maxUses: 1,
          maxTotalCostMicros: 0,
          expiresAt: stored.expiresAt,
        });
        saved = (await ctx.save(`${phase}:handle`, { handle, inputRef: input.ref }))
          .value as typeof saved;
      }
      if (!saved) throw new Error("FILE_READ_HANDLE_MISSING");
      await active();
      return ctx.phase(saved.handle, phase, saved.inputRef);
    };
    const inspectInput = {
      version: "host-file.v1",
      phase: "inspect",
      hostId: binding.hostId,
      workerInstanceId: binding.workerInstanceId,
      grant: binding.grant,
      path: call.arguments["path"],
      maximumBytes: binding.maximumBytes,
    };
    const inspection = await runPhase("inspect", inspectInput, intent("inspect", inspectInput));
    if (inspection.outcome !== "succeeded") return inspection;
    let target: ResolvedHostFileReadTarget;
    try {
      target = JSON.parse(inspection.modelContent) as ResolvedHostFileReadTarget;
    } catch {
      return failure("FILE_READ_TARGET_INVALID");
    }
    if (
      !target ||
      target.hostId !== binding.hostId ||
      target.grantId !== binding.grant.id ||
      target.grantRevision !== binding.grant.revision ||
      target.canonicalRootId !== binding.grant.canonicalRootId ||
      target.authorizationRef !== binding.grant.authorizationRef ||
      target.requestedPath !== call.arguments["path"] ||
      target.maximumBytes !== binding.maximumBytes ||
      !target.identity ||
      target.relativePath !== relativePath ||
      Object.keys(target).sort().join(",") !==
        [
          "hostId",
          "grantId",
          "grantRevision",
          "canonicalRootId",
          "authorizationRef",
          "requestedPath",
          "relativePath",
          "identity",
          "maximumBytes",
          "observedAt",
        ]
          .sort()
          .join(",") ||
      Object.keys(target.identity).sort().join(",") !==
        ["canonicalPath", "device", "inode", "mode", "linkCount", "sizeBytes", "modifiedAtMillis"]
          .sort()
          .join(",") ||
      typeof target.identity.canonicalPath !== "string" ||
      !target.identity.canonicalPath.startsWith("/") ||
      !target.identity.canonicalPath.endsWith(`/${relativePath}`) ||
      !Number.isFinite(Date.parse(target.observedAt)) ||
      Date.parse(target.observedAt) < Date.parse(stored.requestedAt) ||
      Date.parse(target.observedAt) > Date.parse(ctx.now()) ||
      !Number.isFinite(target.identity.modifiedAtMillis) ||
      !Number.isSafeInteger(target.identity.mode) ||
      target.identity.mode < 0 ||
      target.identity.linkCount !== 1 ||
      typeof target.identity.device !== "string" ||
      typeof target.identity.inode !== "string" ||
      !/^\d+$/.test(target.identity.inode) ||
      !/^\d+$/.test(target.identity.device) ||
      !binding.grant.canonicalRootId.startsWith(`${target.identity.device}:`) ||
      !Number.isSafeInteger(target.identity.sizeBytes) ||
      target.identity.sizeBytes < 0 ||
      target.identity.sizeBytes > binding.maximumBytes ||
      (target.identity.mode & 0o170000) !== 0o100000
    )
      return failure("FILE_READ_TARGET_INVALID");
    await active();
    if (!["model", "external_approved"].includes(binding.grant.disclosure))
      return failure("FILE_READ_DIRECTORY_DISCLOSURE_DENIED");
    const readIntent = intent("read", target);
    const readPermission = await this.services.authorize(readIntent);
    if (readPermission.decision !== "ALLOW") return decisionFailure(readPermission);
    const disclosureIntent = intent("disclose", target, true);
    const disclosure = await this.services.authorize(disclosureIntent);
    if (disclosure.decision !== "ALLOW") return decisionFailure(disclosure);
    const result = await runPhase(
      "read",
      {
        version: "host-file.v1",
        phase: "read",
        hostId: binding.hostId,
        workerInstanceId: binding.workerInstanceId,
        target,
        grant: binding.grant,
        arguments: call.arguments,
      },
      readIntent,
    );
    if (result.outcome !== "succeeded") return result;
    await active();
    if (result.outcome === "succeeded") {
      const renewed = await this.services.authorize(disclosureIntent);
      if (renewed.decision !== "ALLOW") return decisionFailure(renewed);
    }
    return result;
  }
}
