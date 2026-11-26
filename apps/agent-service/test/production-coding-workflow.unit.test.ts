import { createHash } from "node:crypto";
import {
  type GovernedActionIntent,
  HOST_READ_ONLY_ERROR_CODES,
  HostReadOnlyError,
  type PermissionDecision,
  type RuntimeToolInvocation,
  type ThreadArtifact,
  type ThreadArtifactStorePort,
  validateGovernedActionIntent,
} from "@himawari-agent/application";
import { describe, expect, it, vi } from "vitest";
import { executeProductionCodingRequest } from "../src/production-coding-workflow.js";
import type {
  FileReadBinding,
  FileReadExecutionContext,
  ProductionFileReadServices,
} from "../src/production-file-read-workflow.js";
import { ProductionThreadArtifacts } from "../src/production-thread-artifacts.js";
import { WebToolMemory } from "../src/web-tool-memory.js";
import { invocation, now, runtimeToolFixture } from "./runtime-tools.fixture.js";

function fixture() {
  const base = runtimeToolFixture();
  const authority = base.options.authority();
  const call: RuntimeToolInvocation = {
    ...invocation,
    capabilityRef: "coding.write",
    capabilityHandleRef: null,
    arguments: { path: "note.txt", content: "hello" },
    executionDeadlineAt: "2026-09-06T00:01:00.000Z",
    context: {
      threadId: "thread:test" as NonNullable<RuntimeToolInvocation["context"]>["threadId"],
      modelRef: "model:test",
      executionLease: {
        ...authority.product,
        authorityLeaseId: authority.lease.leaseId,
        authorityFencingToken: 1,
        executionLeaseId: "execution:test" as NonNullable<
          RuntimeToolInvocation["context"]
        >["executionLease"]["executionLeaseId"],
        expectedLeaseRevision: 1,
        consumerId: "consumer:test",
      },
    },
  };
  const binding: FileReadBinding = {
    workerInstanceId: base.options.peer().workerInstanceId,
    revision: 1,
    hostId: "host:test",
    capabilityRef: "coding",
    capabilityVersion: "1.0.0",
    maximumBytes: 4096,
    threadId: "thread:test",
    modelRef: "model:test",
    modelIdentity: "model:openrouter:test",
    grant: {
      id: "directory:test",
      revision: 1,
      hostId: "host:test",
      canonicalRootId: "1:2",
      displayPath: "/workspace",
      operations: ["read", "create", "update"],
      dataClassification: "private",
      disclosure: "model",
      pathPolicy: "same_filesystem_no_links",
      mountPolicy: "fixed_device",
      authorizationRef: "owner:test",
      revokedAt: null,
      expiresAt: "2026-09-06T01:00:00.000Z",
    },
  };
  const values = new Map<string, unknown>();
  const ctx: FileReadExecutionContext = {
    ownerId: base.options.ownerId,
    agentId: base.options.agentId,
    now: () => now,
    authorityFence: () => 1,
    workerInstanceId: () => binding.workerInstanceId,
    assertActive: async () => {},
    load: async (key) => values.get(key),
    save: async (key, value) => {
      if (!values.has(key)) values.set(key, structuredClone(value));
      return { ref: `payload:${key}`, value: values.get(key) };
    },
    phase: vi.fn(async () => ({
      outcome: "succeeded" as const,
      resultRef: "result:tool",
      errorCode: null,
      externalActionId: null,
      modelContent: "actual tool result",
    })),
  };
  const authorize = vi.fn(
    async (
      _intent: import("@himawari-agent/application").GovernedActionIntent,
      _signal?: AbortSignal,
    ): Promise<PermissionDecision> => ({
      decision: "DENY",
      reasonCode: "test-denied",
      alternativesAllowed: false,
    }),
  );
  const services: ProductionFileReadServices = {
    binding: async () => binding,
    authorize,
    issue: vi.fn(async () => {
      throw new Error("must not issue before permission");
    }),
  };
  return { base, values, call, binding, ctx, services, authorize };
}
function allowRead(): ProductionFileReadServices["authorize"] {
  return vi.fn<ProductionFileReadServices["authorize"]>(async () => ({
    decision: "ALLOW",
    basis: { type: "grant", ref: "grant:test" },
    executionScope: {
      capabilityRef: "coding",
      operations: ["read"],
      exactResourceRef: null,
      resourcePrefixes: [],
      maxDataClassification: "private",
      sideEffects: ["none"],
      maxCostMicrosPerUse: 0,
      maxFrequency: { count: 1, intervalMs: null },
    },
  }));
}
describe("governed coding requests", () => {
  it("binds the exact tool input and recipient to approval before issuing a handle", async () => {
    const f = fixture();
    await executeProductionCodingRequest(f.call, "write", f.services, f.ctx);
    expect(f.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityRef: "coding",
        operation: "write",
        recipients: [f.binding.modelIdentity],
        disclosure: "named_recipients",
        sideEffect: "reversible",
      }),
      undefined,
    );
    expect(JSON.stringify(f.authorize.mock.calls)).not.toContain('"content":"hello"');
    expect(f.services.issue).not.toHaveBeenCalled();
    expect(f.ctx.phase).not.toHaveBeenCalled();
  });
  it.each(["../outside", "/outside", "a/../note.txt"])(
    "rejects an out-of-scope target %s",
    async (path) => {
      const f = fixture();
      expect(
        await executeProductionCodingRequest(
          { ...f.call, arguments: { path, content: "hello" } },
          "write",
          f.services,
          f.ctx,
        ),
      ).toMatchObject({ errorCode: "CODING_PATH_OUTSIDE_SCOPE", dispatchState: "not_sent" });
      expect(f.authorize).not.toHaveBeenCalled();
      expect(f.ctx.phase).not.toHaveBeenCalled();
    },
  );
  it.each([".", "./", "/workspace", "/workspace/", "/workspace//"])(
    "[R2-T1] reports a directory target as a directory instead of outside scope: %s",
    async (path) => {
      const f = fixture();
      const result = await executeProductionCodingRequest(
        { ...f.call, capabilityRef: "coding.read", arguments: { path } },
        "read",
        f.services,
        f.ctx,
      );
      expect(result).toMatchObject({
        errorCode: "CODING_PATH_IS_DIRECTORY",
        dispatchState: "not_sent",
        outcome: "failed",
      });
      expect(result.modelContent).toContain("目录");
      expect(result.modelContent).toContain("ls");
      expect(f.authorize).not.toHaveBeenCalled();
      expect(f.ctx.phase).not.toHaveBeenCalled();
    },
  );
  it.each(["/var/lib/himawari/state", "../outside", "/workspace/../outside", "/outside"])(
    "[R2-T1] still rejects an out-of-scope read target as outside scope: %s",
    async (path) => {
      const f = fixture();
      expect(
        await executeProductionCodingRequest(
          { ...f.call, capabilityRef: "coding.read", arguments: { path } },
          "read",
          f.services,
          f.ctx,
        ),
      ).toMatchObject({ errorCode: "CODING_PATH_OUTSIDE_SCOPE", dispatchState: "not_sent" });
      expect(f.authorize).not.toHaveBeenCalled();
      expect(f.ctx.phase).not.toHaveBeenCalled();
    },
  );
  it("[R2-T1] keeps the granted directory as a valid ls, find and grep query", async () => {
    for (const tool of ["ls", "find", "grep"] as const) {
      const f = fixture();
      await executeProductionCodingRequest(
        { ...f.call, capabilityRef: `coding.${tool}`, arguments: {} },
        tool,
        f.services,
        f.ctx,
      );
      expect(f.authorize).toHaveBeenCalledWith(
        expect.objectContaining({ operation: tool }),
        undefined,
      );
      expect(f.ctx.phase).not.toHaveBeenCalled();
    }
  });
  it("rates workspace risk by what the operation does rather than marking every call high", async () => {
    const cases = [
      ["read", { path: "notes.txt" }, "LOW"],
      ["ls", {}, "LOW"],
      ["find", {}, "LOW"],
      ["grep", {}, "LOW"],
      ["write", undefined, "MEDIUM"],
      ["edit", undefined, "MEDIUM"],
      ["bash", { command: "ls" }, "HIGH"],
      ["web_search", { query: "public weather" }, "MEDIUM"],
    ] as const;
    for (const [tool, args, risk] of cases) {
      const f = fixture();
      if (tool === "web_search") f.services.binding = async () => ({ ...f.binding, grant: null });
      await executeProductionCodingRequest(
        { ...f.call, capabilityRef: `coding.${tool}`, arguments: args ?? f.call.arguments },
        tool,
        f.services,
        f.ctx,
      );
      const intent = f.authorize.mock.calls[0]?.[0] as GovernedActionIntent;
      expect(intent, tool).toMatchObject({ finalRisk: risk });
      expect(() => validateGovernedActionIntent(intent), tool).not.toThrow();
    }
  });
  it("[R2-T1] reports the grant root as a directory for write and edit", async () => {
    for (const tool of ["write", "edit"] as const) {
      const f = fixture();
      expect(
        await executeProductionCodingRequest(
          {
            ...f.call,
            capabilityRef: `coding.${tool}`,
            arguments: { path: "/workspace", content: "x" },
          },
          tool,
          f.services,
          f.ctx,
        ),
      ).toMatchObject({ errorCode: "CODING_PATH_IS_DIRECTORY", dispatchState: "not_sent" });
      expect(f.authorize).not.toHaveBeenCalled();
      expect(f.ctx.phase).not.toHaveBeenCalled();
    }
  });
  it("accepts the grant root for directory queries but does not execute without approval", async () => {
    const f = fixture();
    await executeProductionCodingRequest(
      { ...f.call, capabilityRef: "coding.ls", arguments: {} },
      "ls",
      f.services,
      f.ctx,
    );
    expect(f.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "ls" }),
      undefined,
    );
    expect(f.ctx.phase).not.toHaveBeenCalled();
  });
  it("does not substitute changed arguments when a request is resumed", async () => {
    const f = fixture();
    await executeProductionCodingRequest(f.call, "write", f.services, f.ctx);
    expect(
      await executeProductionCodingRequest(
        { ...f.call, arguments: { path: "note.txt", content: "changed" } },
        "write",
        f.services,
        f.ctx,
      ),
    ).toMatchObject({ errorCode: "CODING_CONTEXT_CHANGED" });
    expect(f.authorize).toHaveBeenCalledTimes(1);
  });
  it("rejects missing grant disclosure and invalid deadlines before asking permission", async () => {
    const f = fixture();
    expect(
      await executeProductionCodingRequest(
        { ...f.call, executionDeadlineAt: "invalid" },
        "write",
        f.services,
        f.ctx,
      ),
    ).toMatchObject({ errorCode: "CODING_REQUEST_EXPIRED" });
    f.services.binding = async () => ({
      ...f.binding,
      grant: { ...f.binding.grant, disclosure: "none" },
    });
    expect(await executeProductionCodingRequest(f.call, "write", f.services, f.ctx)).toMatchObject({
      errorCode: "CODING_DIRECTORY_UNAVAILABLE",
    });
    expect(f.authorize).not.toHaveBeenCalled();
  });
});

it("binds public search disclosure to the provider and query without issuing before approval", async () => {
  const f = fixture();
  const call = {
    ...f.call,
    capabilityRef: "coding.web_search",
    arguments: { query: "Tokyo forecast", limit: 3 },
  };
  await executeProductionCodingRequest(call, "web_search", f.services, f.ctx);
  expect(f.authorize).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: "web_search",
      recipients: [f.binding.modelIdentity, "https://mcp.exa.ai"],
      targets: expect.arrayContaining([{ type: "network-domain", ref: "mcp.exa.ai:443" }]),
      sideEffect: "none",
    }),
    undefined,
  );
  expect(f.services.issue).not.toHaveBeenCalled();
});
it("rejects invalid public search queries before disclosure approval", async () => {
  const f = fixture();
  const result = await executeProductionCodingRequest(
    { ...f.call, capabilityRef: "coding.web_search", arguments: { query: "x", limit: 100 } },
    "web_search",
    f.services,
    f.ctx,
  );
  expect(result.errorCode).toBe("WEB_SEARCH_INPUT_INVALID");
  expect(f.authorize).not.toHaveBeenCalled();
});

it("discloses a configured provider chain to every provider and freezes it into the program input", async () => {
  const f = fixture();
  f.services.binding = async () => ({
    ...f.binding,
    grant: null,
    providers: ["exa-public", "deepseek"],
  });
  const issue = vi.fn(async () => ({ ref: "handle:search" }));
  const services = { ...f.services, authorize: allowRead(), issue } as unknown as typeof f.services;
  await executeProductionCodingRequest(
    { ...f.call, capabilityRef: "coding.web_search", arguments: { query: "Tokyo forecast" } },
    "web_search",
    services,
    f.ctx,
  );
  expect(services.authorize).toHaveBeenCalledWith(
    expect.objectContaining({
      recipients: [f.binding.modelIdentity, "https://mcp.exa.ai", "https://api.deepseek.com"],
      targets: expect.arrayContaining([
        { type: "network-domain", ref: "api.deepseek.com:443" },
        { type: "network-domain", ref: "mcp.exa.ai:443" },
      ]),
    }),
    undefined,
  );
  expect(f.values.get("input")).toEqual({
    query: "Tokyo forecast",
    providers: ["exa-public", "deepseek"],
  });
});
it("grants only the configured provider secret by name and keeps its value out of the program input", async () => {
  const f = fixture();
  f.services.binding = async () => ({
    ...f.binding,
    grant: null,
    providers: ["deepseek", "exa-public"],
    providerSecrets: [
      {
        provider: "deepseek",
        secretRef: "deepseek-web",
        secretVersion: "v1",
        purpose: "web-provider",
      },
    ],
  });
  const issue = vi.fn(async (_input: { secretRefs: unknown }) => ({ ref: "handle:search" }));
  const services = { ...f.services, authorize: allowRead(), issue } as unknown as typeof f.services;
  await executeProductionCodingRequest(
    { ...f.call, capabilityRef: "coding.web_search", arguments: { query: "Tokyo forecast" } },
    "web_search",
    services,
    f.ctx,
  );
  expect(issue.mock.calls[0]?.[0].secretRefs).toEqual([
    { secretRef: "deepseek-web", secretVersion: "v1", purpose: "web-provider" },
  ]);
  expect(f.values.get("input")).toEqual({
    query: "Tokyo forecast",
    providers: ["deepseek", "exa-public"],
    secretRefs: { deepseek: "deepseek-web" },
  });
});
it("fetches a public page through the provider with the configured size and no model-chosen fields", async () => {
  const f = fixture();
  f.services.binding = async () => ({ ...f.binding, grant: null });
  const issue = vi.fn(async () => ({ ref: "handle:fetch" }));
  const services = { ...f.services, authorize: allowRead(), issue } as unknown as typeof f.services;
  await executeProductionCodingRequest(
    { ...f.call, capabilityRef: "coding.web_fetch", arguments: { url: "https://example.org/a" } },
    "web_fetch",
    services,
    f.ctx,
  );
  expect(services.authorize).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: "web_fetch",
      recipients: [f.binding.modelIdentity, "https://mcp.exa.ai"],
      targets: expect.arrayContaining([{ type: "network-domain", ref: "mcp.exa.ai:443" }]),
      sideEffect: "none",
    }),
    undefined,
  );
  expect(f.values.get("input")).toEqual({
    url: "https://example.org/a",
    maximumBytes: f.binding.maximumBytes,
  });
});
it("[NL-11] passes the model's continuation offset to the fetch program", async () => {
  const f = fixture();
  f.services.binding = async () => ({ ...f.binding, grant: null });
  const issue = vi.fn(async () => ({ ref: "handle:fetch" }));
  const services = { ...f.services, authorize: allowRead(), issue } as unknown as typeof f.services;
  await executeProductionCodingRequest(
    {
      ...f.call,
      capabilityRef: "coding.web_fetch",
      arguments: { url: "https://example.org/a", offset: 102400 },
    },
    "web_fetch",
    services,
    f.ctx,
  );
  expect(f.values.get("input")).toEqual({
    url: "https://example.org/a",
    offset: 102400,
    maximumBytes: f.binding.maximumBytes,
  });
});
it("answers a repeated approved search from host memory without a second provider request", async () => {
  const memory = new WebToolMemory();
  const run = async (toolCallId: string) => {
    const f = fixture();
    f.services.binding = async () => ({ ...f.binding, grant: null });
    const issue = vi.fn(async () => ({ ref: `handle:${toolCallId}` }));
    const services = {
      ...f.services,
      authorize: allowRead(),
      issue,
      webMemory: memory,
    } as unknown as typeof f.services;
    const result = await executeProductionCodingRequest(
      {
        ...f.call,
        toolCallId,
        capabilityRef: "coding.web_search",
        arguments: { query: "Tokyo  Forecast" },
      },
      "web_search",
      services,
      f.ctx,
    );
    return { f, issue, services, result };
  };
  const first = await run("call-a");
  expect(first.f.ctx.phase).toHaveBeenCalledTimes(1);
  const second = await run("call-b");
  expect(second.services.authorize).toHaveBeenCalledTimes(1);
  expect(second.issue).not.toHaveBeenCalled();
  expect(second.f.ctx.phase).not.toHaveBeenCalled();
  expect(second.result).toMatchObject({
    outcome: "succeeded",
    dispatchState: "not_sent",
    modelContent: "actual tool result",
  });
  expect(second.f.values.get("host-result")).toEqual(second.result);
});
it.each([
  { url: "http://localhost:8080/admin" },
  { url: "http://192.168.1.10/" },
  { url: "file:///etc/passwd" },
  { url: "https://example.org/", maximumBytes: 1 },
  { url: "https://example.org/", offset: -1 },
  { url: "https://example.org/", offset: 1.5 },
  { url: "https://example.org/", offset: "100" },
  { url: "https://example.org/", offset: 10_000_001 },
])("rejects a private or widened fetch request %j before disclosure", async (args) => {
  const f = fixture();
  f.services.binding = async () => ({ ...f.binding, grant: null });
  const result = await executeProductionCodingRequest(
    { ...f.call, capabilityRef: "coding.web_fetch", arguments: args },
    "web_fetch",
    f.services,
    f.ctx,
  );
  expect(result.errorCode).toBe("WEB_FETCH_INPUT_INVALID");
  expect(f.authorize).not.toHaveBeenCalled();
});

it("passes cancellation to coding authorization before a handle or file effect exists", async () => {
  const f = fixture();
  const controller = new AbortController();
  const authorize = vi.fn<ProductionFileReadServices["authorize"]>(async (_intent, signal) => {
    controller.abort();
    expect(signal?.aborted).toBe(true);
    return { decision: "DENY", reasonCode: "action_cancelled", alternativesAllowed: false };
  });
  expect(
    await executeProductionCodingRequest(
      f.call,
      "write",
      { ...f.services, authorize },
      {
        ...f.ctx,
        signal: controller.signal,
      },
    ),
  ).toMatchObject({ outcome: "failed", errorCode: "action_cancelled" });
  expect(authorize).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ operation: "write" }),
    controller.signal,
  );
  expect(f.services.issue).not.toHaveBeenCalled();
  expect(f.ctx.phase).not.toHaveBeenCalled();
});

it("authorizes private-only search without a directory and rejects using that binding for files", async () => {
  const f = fixture();
  f.services.binding = async () => ({ ...f.binding, grant: null });
  const call = {
    ...f.call,
    capabilityRef: "coding.web_search",
    arguments: { query: "public weather" },
  };
  await executeProductionCodingRequest(call, "web_search", f.services, f.ctx);
  expect(f.authorize).toHaveBeenCalledWith(
    expect.objectContaining({
      expiresAt: call.executionDeadlineAt,
      targets: expect.not.arrayContaining([expect.objectContaining({ type: "directory-grant" })]),
    }),
    undefined,
  );
  expect(JSON.stringify(f.authorize.mock.calls)).not.toContain("/workspace");
  f.authorize.mockClear();
  expect(await executeProductionCodingRequest(f.call, "write", f.services, f.ctx)).toMatchObject({
    errorCode: "CODING_DIRECTORY_UNAVAILABLE",
  });
  expect(f.authorize).not.toHaveBeenCalled();
});

it("associates new content with the verified conflict and asks the original policy again", async () => {
  const f = fixture();
  const previous = { ...f.call, toolCallId: "previous" };
  f.ctx.fileConflict = async (id) =>
    id === previous.toolCallId ? { call: previous, binding: f.binding, depth: 0 } : undefined;
  const result = await executeProductionCodingRequest(
    {
      ...f.call,
      fileConflictOf: previous.toolCallId,
      arguments: { path: "note.txt", content: "preserve their change and add mine" },
    },
    "write",
    f.services,
    f.ctx,
  );
  expect(result.outcome).toBe("failed");
  expect(f.authorize).toHaveBeenCalledOnce();
  const lineage = f.values.get("conflict-lineage") as Record<string, unknown>;
  expect(lineage).toMatchObject({ previousToolCallId: "previous", depth: 1 });
  expect(lineage["intentId"]).not.toBe(lineage["previousIntentId"]);
  expect(f.authorize.mock.calls[0]?.[0]).toMatchObject({ id: lineage["intentId"] });
  expect(f.services.issue).not.toHaveBeenCalled();
  expect(f.ctx.phase).not.toHaveBeenCalled();
});

it.each(["unverified", "different-target", "different-binding", "same-call", "limit"])(
  "blocks invalid conflict regeneration before asking permission: %s",
  async (mode) => {
    const f = fixture();
    const previous = {
      ...f.call,
      toolCallId: mode === "same-call" ? f.call.toolCallId : "previous",
      arguments:
        mode === "different-target" ? { path: "other.txt", content: "x" } : f.call.arguments,
    };
    f.ctx.fileConflict = async (id) =>
      mode === "unverified" || id === f.call.toolCallId
        ? undefined
        : {
            call: previous,
            binding:
              mode === "different-binding" ? { ...f.binding, hostId: "other-host" } : f.binding,
            depth: mode === "limit" ? 3 : 0,
          };
    expect(
      await executeProductionCodingRequest(
        { ...f.call, fileConflictOf: previous.toolCallId },
        "write",
        f.services,
        f.ctx,
      ),
    ).toMatchObject({ errorCode: "CODING_CONFLICT_REGENERATION_BLOCKED" });
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.services.issue).not.toHaveBeenCalled();
  },
);

it("changes only authority after queue proof and still rejects changed outer tool arguments", async () => {
  const f = fixture();
  await executeProductionCodingRequest(f.call, "write", f.services, f.ctx);
  if (!f.call.context) throw new Error("context missing");
  const call = {
    ...f.call,
    context: {
      ...f.call.context,
      continuationRef: "original-batch",
      executionLease: {
        ...f.call.context.executionLease,
        fencingToken: 2,
        authorityFencingToken: 2,
      },
    },
  };
  const proof = vi.fn(async () => false);
  const context = { ...f.ctx, authorityFence: () => 2, canResumeAuthority: proof };
  expect(await executeProductionCodingRequest(call, "write", f.services, context)).toMatchObject({
    errorCode: "CODING_CONTEXT_CHANGED",
  });
  proof.mockResolvedValue(true);
  expect(await executeProductionCodingRequest(call, "write", f.services, context)).toMatchObject({
    errorCode: "test-denied",
  });
  const calls = f.authorize.mock.calls.length;
  expect(
    await executeProductionCodingRequest(
      { ...call, arguments: { ...call.arguments, content: "changed" } },
      "write",
      f.services,
      context,
    ),
  ).toMatchObject({ errorCode: "CODING_CONTEXT_CHANGED" });
  expect(f.authorize).toHaveBeenCalledTimes(calls);
  expect(proof).toHaveBeenCalledWith({
    deploymentId: f.call.context.executionLease.deploymentId,
    authorityEpoch: 1,
    fencingToken: 1,
  });
});

it("replays a verified Worker conflict as accepted without dispatching or renewing approval", async () => {
  const f = fixture();
  f.ctx.fileConflict = async () => ({
    call: f.call,
    binding: f.binding,
    depth: 0,
    dispatchState: "accepted",
  });
  expect(await executeProductionCodingRequest(f.call, "write", f.services, f.ctx)).toMatchObject({
    dispatchState: "accepted",
    outcome: "failed",
    errorCode: "FILE_VERSION_CONFLICT",
  });
  expect(f.authorize).not.toHaveBeenCalled();
  expect(f.services.issue).not.toHaveBeenCalled();
  expect(f.ctx.phase).not.toHaveBeenCalled();
});
it("freezes both directory move paths under the original move permission", async () => {
  const f = fixture();
  f.services.binding = async () => ({
    ...f.binding,
    grant: { ...f.binding.grant, operations: ["read", "move"] },
  });
  const call = {
    ...f.call,
    capabilityRef: "coding.move_directory",
    arguments: { path: "reports", destination: "archive" },
  };
  await executeProductionCodingRequest(call, "move_directory", f.services, f.ctx);
  expect(f.authorize).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: "move_directory",
      targets: expect.arrayContaining([
        { type: "file-path", ref: "reports" },
        { type: "destination-path", ref: "archive" },
      ]),
    }),
    undefined,
  );
  f.authorize.mockClear();
  expect(
    await executeProductionCodingRequest(
      { ...call, arguments: { path: "reports", destination: "../outside" } },
      "move_directory",
      f.services,
      f.ctx,
    ),
  ).toMatchObject({ outcome: "failed" });
  expect(f.authorize).not.toHaveBeenCalled();
});

it.each(["create", "update", "move", "trash"] as const)(
  "authorizes the actual prepared copy %s effect",
  async (operation) => {
    const f = fixture();
    f.services.binding = async () => ({
      ...f.binding,
      grant: { ...f.binding.grant, operations: ["read", operation] },
      copySaveOperation: { id: "prepared:copy", operation, canonicalHash: "sha256:copy" },
    });
    const call = {
      ...f.call,
      capabilityRef: "coding.save_copy",
      arguments: { operationId: "prepared:copy", expectedHash: "sha256:copy" },
    };
    await executeProductionCodingRequest(call, "save_copy", f.services, f.ctx);
    expect(f.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        actionKind: operation === "trash" ? "DELETE" : "CREATE_OR_UPDATE",
        targets: expect.arrayContaining([
          { type: "prepared-file-operation", ref: "prepared:copy" },
        ]),
      }),
      undefined,
    );
    f.authorize.mockClear();
    expect(
      await executeProductionCodingRequest(
        { ...call, arguments: { ...call.arguments, expectedHash: "changed" } },
        "save_copy",
        f.services,
        f.ctx,
      ),
    ).toMatchObject({ outcome: "failed" });
    expect(f.authorize).not.toHaveBeenCalled();
  },
);

it("[R2-P1] executes read-only tools in the host process and reuses the saved result", async () => {
  const f = fixture();
  const execute = vi.fn(async () => ({
    modelContent: "pi-result.v1",
    isError: false,
    errorCode: null,
  }));
  const services = { ...f.services, authorize: allowRead(), hostReadOnly: { execute } };
  const call = { ...f.call, capabilityRef: "coding.read", arguments: { path: "notes.txt" } };
  const first = await executeProductionCodingRequest(call, "read", services, f.ctx);
  expect(first).toMatchObject({
    outcome: "succeeded",
    dispatchState: "accepted",
    modelContent: "pi-result.v1",
    executionTiming: expect.any(Object),
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(f.ctx.phase).not.toHaveBeenCalled();
  expect(f.services.issue).not.toHaveBeenCalled();
  const second = await executeProductionCodingRequest(call, "read", services, f.ctx);
  expect(second).toMatchObject({
    outcome: "succeeded",
    dispatchState: "accepted",
    modelContent: "pi-result.v1",
  });
  expect(execute).toHaveBeenCalledTimes(1);
});

it("[R2-P1] marks a host read that ran and failed as dispatched, not as not sent", async () => {
  const f = fixture();
  const execute = vi.fn(async () => ({
    modelContent: "ENOENT: no such file or directory, open 'missing.txt'",
    isError: true,
    errorCode: "ENOENT",
  }));
  const services = { ...f.services, authorize: allowRead(), hostReadOnly: { execute } };
  const call = { ...f.call, capabilityRef: "coding.read", arguments: { path: "missing.txt" } };
  const result = await executeProductionCodingRequest(call, "read", services, f.ctx);
  expect(result).toMatchObject({
    outcome: "failed",
    dispatchState: "accepted",
    errorCode: "ENOENT",
    executionTiming: expect.any(Object),
  });
  expect(execute).toHaveBeenCalledTimes(1);
});

it("[R2-P1] keeps a read rejected before execution as not sent", async () => {
  const f = fixture();
  const execute = vi.fn(async () => ({
    modelContent: "unreachable",
    isError: false,
    errorCode: null,
  }));
  const services = { ...f.services, authorize: allowRead(), hostReadOnly: { execute } };
  const call = { ...f.call, capabilityRef: "coding.read", arguments: { path: "../outside" } };
  expect(await executeProductionCodingRequest(call, "read", services, f.ctx)).toMatchObject({
    outcome: "failed",
    dispatchState: "not_sent",
    errorCode: "CODING_PATH_OUTSIDE_SCOPE",
  });
  expect(execute).not.toHaveBeenCalled();
});

describe("工具在主人自己的电脑里跑", () => {
  it("授权之后交给电脑执行，路径换成工作目录里的相对路径，结果只执行一次", async () => {
    const f = fixture();
    const execute = vi.fn<NonNullable<ProductionFileReadServices["computer"]>["execute"]>(
      async () => ({ modelContent: "pi-result.v1", isError: false, errorCode: null }),
    );
    const services = { ...f.services, authorize: allowRead(), computer: { execute } };
    const call = {
      ...f.call,
      capabilityRef: "coding.read",
      arguments: { path: "/workspace/docs/plan.md" },
    };
    const first = await executeProductionCodingRequest(call, "read", services, f.ctx);
    expect(first).toMatchObject({
      outcome: "succeeded",
      dispatchState: "accepted",
      modelContent: "pi-result.v1",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      ownerId: f.ctx.ownerId,
      tool: "read",
      relativePath: "docs/plan.md",
      grant: f.binding.grant,
      maximumOutputBytes: f.binding.maximumBytes,
    });
    expect(f.ctx.phase).not.toHaveBeenCalled();
    expect(f.services.issue).not.toHaveBeenCalled();
    expect(await executeProductionCodingRequest(call, "read", services, f.ctx)).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("bash 不带路径，交给电脑时相对路径为空", async () => {
    const f = fixture();
    const execute = vi.fn<NonNullable<ProductionFileReadServices["computer"]>["execute"]>(
      async () => ({ modelContent: "pi-result.v1", isError: false, errorCode: null }),
    );
    const services = { ...f.services, authorize: allowRead(), computer: { execute } };
    const call = { ...f.call, capabilityRef: "coding.bash", arguments: { command: "pwd" } };
    await executeProductionCodingRequest(call, "bash", services, f.ctx);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ tool: "bash", relativePath: null });
  });

  it("反向：工作目录以外的路径不交给电脑", async () => {
    const f = fixture();
    const execute = vi.fn<NonNullable<ProductionFileReadServices["computer"]>["execute"]>();
    const services = { ...f.services, authorize: allowRead(), computer: { execute } };
    const call = { ...f.call, capabilityRef: "coding.read", arguments: { path: "/etc/passwd" } };
    expect(await executeProductionCodingRequest(call, "read", services, f.ctx)).toMatchObject({
      outcome: "failed",
      dispatchState: "not_sent",
      errorCode: "CODING_PATH_OUTSIDE_SCOPE",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("发出去以后服务重启、没拿到结果时报结果未知，不重做", async () => {
    const f = fixture();
    const execute = vi.fn<NonNullable<ProductionFileReadServices["computer"]>["execute"]>();
    const services = { ...f.services, authorize: allowRead(), computer: { execute } };
    f.values.set("computer-dispatched", { at: now });
    const call = { ...f.call, capabilityRef: "coding.bash", arguments: { command: "rm -rf x" } };
    expect(await executeProductionCodingRequest(call, "bash", services, f.ctx)).toMatchObject({
      outcome: "result_unknown",
      dispatchState: "possibly_sent",
      errorCode: "COMPUTER_RESULT_UNKNOWN",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("电脑开不起来时如实报错，不退回沙箱", async () => {
    const f = fixture();
    const execute = vi.fn<NonNullable<ProductionFileReadServices["computer"]>["execute"]>(
      async () => ({
        modelContent: "工具没有在你的电脑里执行：COMPUTER_START_FAILED",
        isError: true,
        errorCode: "COMPUTER_START_FAILED",
      }),
    );
    const services = { ...f.services, authorize: allowRead(), computer: { execute } };
    const call = { ...f.call, capabilityRef: "coding.bash", arguments: { command: "ls" } };
    expect(await executeProductionCodingRequest(call, "bash", services, f.ctx)).toMatchObject({
      outcome: "failed",
      errorCode: "COMPUTER_START_FAILED",
    });
    expect(f.ctx.phase).not.toHaveBeenCalled();
  });
});

function hostWebFixture(
  execute: NonNullable<ProductionFileReadServices["hostWeb"]>["execute"],
  webMemory = new WebToolMemory(),
) {
  const f = fixture();
  const secrets = [
    {
      provider: "deepseek" as const,
      secretRef: "secret:deepseek",
      secretVersion: "v1",
      purpose: "web_provider",
    },
  ];
  f.services.binding = async () => ({
    ...f.binding,
    grant: null,
    providers: ["exa-public", "deepseek"],
    providerSecrets: secrets,
  });
  const services: ProductionFileReadServices = {
    ...f.services,
    authorize: allowRead(),
    hostWeb: { execute },
    webMemory,
  };
  return { f, services, secrets };
}

it("[NL-2] runs web search in the service process without issuing a sandbox handle", async () => {
  const execute = vi.fn<NonNullable<ProductionFileReadServices["hostWeb"]>["execute"]>(
    async () => ({ ok: true, code: null, output: '{"results":[]}' }),
  );
  const { f, services, secrets } = hostWebFixture(execute);
  const call = {
    ...f.call,
    capabilityRef: "coding.web_search",
    arguments: { query: "Tokyo forecast" },
  };
  const first = await executeProductionCodingRequest(call, "web_search", services, f.ctx);
  expect(first).toMatchObject({
    outcome: "succeeded",
    dispatchState: "accepted",
    errorCode: null,
    modelContent: '{"results":[]}',
    executionTiming: expect.any(Object),
  });
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      tool: "web_search",
      arguments: { query: "Tokyo forecast" },
      providers: ["exa-public", "deepseek"],
      secrets,
      maximumBytes: f.binding.maximumBytes,
    }),
  );
  expect(f.services.issue).not.toHaveBeenCalled();
  expect(f.ctx.phase).not.toHaveBeenCalled();
  expect(f.values.get("host-result")).toEqual(first);
  const replay = await executeProductionCodingRequest(call, "web_search", services, f.ctx);
  expect(replay).toEqual(first);
  expect(execute).toHaveBeenCalledTimes(1);
});

const externalTag = async () => (kind: string, value: string) =>
  createHash("sha256")
    .update(`${kind}\u0000${value}`)
    .digest("hex")
    .replace(/[^a-z]/gu, "")
    .padEnd(8, "z")
    .slice(0, 8);

const webPassword = (suffix: string) => ["hunter", "2", suffix].join("");
const webToken = () => ["ghp", "_", "Q".repeat(30)].join("");

it("[mask-not-block] masks secrets in a search query once at entry and sends, caches and saves that value", async () => {
  const sent: string[] = [];
  const execute = vi.fn<NonNullable<ProductionFileReadServices["hostWeb"]>["execute"]>(
    async (input) => {
      sent.push(String(input.arguments["query"]));
      return {
        ok: true,
        code: null,
        output: `{"query":${JSON.stringify(input.arguments["query"])}}`,
      };
    },
  );
  const memory = new WebToolMemory();
  const search = async (toolCallId: string, query: string) => {
    const { f, services } = hostWebFixture(execute, memory);
    const result = await executeProductionCodingRequest(
      { ...f.call, toolCallId, capabilityRef: "coding.web_search", arguments: { query } },
      "web_search",
      { ...services, externalTag },
      f.ctx,
    );
    return { result, f };
  };
  const first = await search("call-a", `login password: ${webPassword("abc")} ${webToken()}`);
  expect(first.result.outcome).toBe("succeeded");
  expect(sent[0]).toMatch(/^login password: \[密码#[a-z]{8}\] \[密钥\]$/u);
  expect(sent[0]).not.toContain(webPassword("abc"));
  expect(sent[0]).not.toContain(webToken());
  await search("call-b", `login password: ${webPassword("abc")} ${webToken()}`);
  expect(execute).toHaveBeenCalledTimes(1);
  await search("call-c", `login password: ${webPassword("xyz")} ${webToken()}`);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(sent[1]).toMatch(/^login password: \[密码#[a-z]{8}\] \[密钥\]$/u);
  expect(sent[1]).not.toBe(sent[0]);
  await search("call-d", "Tokyo forecast");
  expect(sent[2]).toBe("Tokyo forecast");
});

it("[mask-not-block] saves the masked query as the sandboxed search program input", async () => {
  const f = fixture();
  f.services.binding = async () => ({ ...f.binding, grant: null });
  const issue = vi.fn(async () => ({ ref: "handle:search" }));
  const services = {
    ...f.services,
    authorize: allowRead(),
    issue,
    externalTag,
  } as unknown as typeof f.services;
  const result = await executeProductionCodingRequest(
    {
      ...f.call,
      capabilityRef: "coding.web_search",
      arguments: { query: `deploy ${webToken()} failing` },
    },
    "web_search",
    services,
    f.ctx,
  );
  expect(result.errorCode).not.toBe("WEB_SEARCH_INPUT_INVALID");
  expect(f.values.get("input")).toEqual({ query: "deploy [密钥] failing" });
});

it.each([
  ["web_search", { query: "Tokyo forecast" }, "WEB_SEARCH_UNAVAILABLE"],
  ["web_fetch", { url: "https://example.org/a" }, "WEB_FETCH_UNAVAILABLE"],
] as const)(
  "[mask-not-block] reports %s as unavailable without disclosure when the numbering key cannot be read",
  async (tool, args, code) => {
    const f = fixture();
    f.services.binding = async () => ({ ...f.binding, grant: null });
    const issue = vi.fn(async () => ({ ref: "handle:x" }));
    const services = {
      ...f.services,
      authorize: allowRead(),
      issue,
      externalTag: async () => {
        throw new Error("key unavailable");
      },
    } as unknown as typeof f.services;
    const result = await executeProductionCodingRequest(
      { ...f.call, capabilityRef: `coding.${tool}`, arguments: args },
      tool,
      services,
      f.ctx,
    );
    expect(result).toMatchObject({ outcome: "failed", dispatchState: "not_sent", errorCode: code });
    expect(services.authorize).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  },
);

it("[mask-not-block] rejects an oversized web call before masking it", async () => {
  const f = fixture();
  f.services.binding = async () => ({ ...f.binding, grant: null });
  const externalTagCalls = vi.fn(async () => undefined);
  const result = await executeProductionCodingRequest(
    {
      ...f.call,
      capabilityRef: "coding.web_fetch",
      arguments: { url: `https://example.org/${"%5B".repeat(40_000)}` },
    },
    "web_fetch",
    { ...f.services, externalTag: externalTagCalls } as unknown as typeof f.services,
    f.ctx,
  );
  expect(result.errorCode).toBe("CODING_INPUT_TOO_LARGE");
  expect(externalTagCalls).not.toHaveBeenCalled();
});

it.each([
  ["https://user:pw@example.org/a", "https://example.org/a"],
  [
    "https://example.org/a?monkey=1&sig=abcdef123456&X-Amz-Credential=AKID%2F20261107",
    /^https:\/\/example\.org\/a\?monkey=1&sig=%5B%E5%AF%86%E7%A0%81%23[a-z]{8}%5D&X-Amz-Credential=%5B%E5%AF%86%E7%A0%81%23[a-z]{8}%5D$/u,
  ],
  ["https://example.org/a?page=2", "https://example.org/a?page=2"],
])(
  "[mask-not-block] cleans a fetch url %s once at entry and saves that value",
  async (url, saved) => {
    const f = fixture();
    f.services.binding = async () => ({ ...f.binding, grant: null });
    const issue = vi.fn(async () => ({ ref: "handle:fetch" }));
    const services = {
      ...f.services,
      authorize: allowRead(),
      issue,
      externalTag,
    } as unknown as typeof f.services;
    const result = await executeProductionCodingRequest(
      { ...f.call, capabilityRef: "coding.web_fetch", arguments: { url } },
      "web_fetch",
      services,
      f.ctx,
    );
    expect(result.errorCode).not.toBe("WEB_FETCH_INPUT_INVALID");
    const input = f.values.get("input") as { url: string };
    if (typeof saved === "string") expect(input.url).toBe(saved);
    else expect(input.url).toMatch(saved);
    expect(input.url).not.toContain("pw@");
    expect(input.url).not.toContain("abcdef123456");
  },
);

it("[NL-2] marks a host web fetch that ran and failed as dispatched and does not cache it", async () => {
  const execute = vi.fn<NonNullable<ProductionFileReadServices["hostWeb"]>["execute"]>(
    async () => ({ ok: false, code: "WEB_FETCH_FAILED", output: '{"error":"WEB_FETCH_FAILED"}' }),
  );
  const memory = new WebToolMemory();
  const run = (toolCallId: string) => {
    const { f, services } = hostWebFixture(execute, memory);
    return executeProductionCodingRequest(
      {
        ...f.call,
        toolCallId,
        capabilityRef: "coding.web_fetch",
        arguments: { url: "https://example.org/" },
      },
      "web_fetch",
      services,
      f.ctx,
    ).then((result) => ({ result, issue: f.services.issue }));
  };
  const first = await run("call-a");
  expect(first.result).toMatchObject({
    outcome: "failed",
    dispatchState: "accepted",
    errorCode: "WEB_FETCH_FAILED",
  });
  const second = await run("call-b");
  expect(execute).toHaveBeenCalledTimes(2);
  expect(first.issue).not.toHaveBeenCalled();
  expect(second.issue).not.toHaveBeenCalled();
});

it("[NL-2] answers a repeated host web search from memory without running it again", async () => {
  const execute = vi.fn<NonNullable<ProductionFileReadServices["hostWeb"]>["execute"]>(
    async () => ({ ok: true, code: null, output: '{"results":["a"]}' }),
  );
  const memory = new WebToolMemory();
  const run = (toolCallId: string) => {
    const { f, services } = hostWebFixture(execute, memory);
    return executeProductionCodingRequest(
      {
        ...f.call,
        toolCallId,
        capabilityRef: "coding.web_search",
        arguments: { query: "Tokyo  Forecast" },
      },
      "web_search",
      services,
      f.ctx,
    );
  };
  await run("call-a");
  const second = await run("call-b");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(second).toMatchObject({
    outcome: "succeeded",
    dispatchState: "not_sent",
    modelContent: '{"results":["a"]}',
  });
});

it("[NL-2] still asks for permission before a host web search and stops when it is denied", async () => {
  const execute = vi.fn<NonNullable<ProductionFileReadServices["hostWeb"]>["execute"]>(
    async () => ({ ok: true, code: null, output: "unreachable" }),
  );
  const { f, services } = hostWebFixture(execute);
  const result = await executeProductionCodingRequest(
    { ...f.call, capabilityRef: "coding.web_search", arguments: { query: "Tokyo" } },
    "web_search",
    { ...services, authorize: f.authorize },
    f.ctx,
  );
  expect(result).toMatchObject({ outcome: "failed", dispatchState: "not_sent" });
  expect(f.authorize).toHaveBeenCalledTimes(1);
  expect(execute).not.toHaveBeenCalled();
});

function ledgerFixture() {
  const f = fixture();
  const baselineValue = { snapshot: { complete: true, entries: [] }, scanMs: 3 };
  const ledger = {
    baseline: vi.fn(async () => baselineValue),
    record: vi.fn(async () => ({
      version: "workspace-changes.v1" as const,
      complete: true,
      beforeScanMs: 3,
      afterScanMs: 4,
      changes: [],
      summary: "工作目录改动：新建 out.txt",
    })),
  };
  const issue = vi.fn(async () => ({ ref: "handle:bash" }));
  const services = {
    ...f.services,
    authorize: allowRead(),
    issue,
    workspaceLedger: ledger,
  } as unknown as typeof f.services;
  const call = {
    ...f.call,
    capabilityRef: "coding.bash",
    arguments: { command: "echo hi > out.txt" },
  };
  return { f, ledger, services, call, baselineValue };
}

it("[BW-3] records workspace changes around a command and tells the model what changed", async () => {
  const { f, ledger, services, call, baselineValue } = ledgerFixture();
  const order: string[] = [];
  ledger.baseline.mockImplementation(async () => {
    order.push("before");
    return baselineValue;
  });
  vi.mocked(f.ctx.phase).mockImplementation(async () => {
    order.push("command");
    return {
      outcome: "succeeded" as const,
      resultRef: "result:tool",
      errorCode: null,
      externalActionId: null,
      modelContent: "actual tool result",
    };
  });
  ledger.record.mockImplementation(async () => {
    order.push("after");
    return {
      version: "workspace-changes.v1" as const,
      complete: true,
      beforeScanMs: 3,
      afterScanMs: 4,
      changes: [],
      summary: "工作目录改动：新建 out.txt",
    };
  });
  const result = await executeProductionCodingRequest(call, "bash", services, f.ctx);
  expect(order).toEqual(["before", "command", "after"]);
  expect(result).toMatchObject({
    outcome: "succeeded",
    modelContent: "actual tool result\n\n工作目录改动：新建 out.txt",
  });
  expect(f.values.get("workspace-changes")).toMatchObject({
    runId: call.runId,
    toolCallId: call.toolCallId,
    threadId: f.binding.threadId,
    grantId: f.binding.grant.id,
    command: "echo hi > out.txt",
    summary: "工作目录改动：新建 out.txt",
  });
});

it("[BW-3] reuses the saved baseline and change record when a command is resumed", async () => {
  const { f, ledger, services, call } = ledgerFixture();
  await executeProductionCodingRequest(call, "bash", services, f.ctx);
  const again = await executeProductionCodingRequest(call, "bash", services, f.ctx);
  expect(ledger.baseline).toHaveBeenCalledTimes(1);
  expect(ledger.record).toHaveBeenCalledTimes(1);
  expect(again.modelContent).toContain("工作目录改动：新建 out.txt");
});

it("[BW-3] does not run a command whose workspace baseline cannot be taken", async () => {
  const { f, ledger, services, call } = ledgerFixture();
  ledger.baseline.mockRejectedValue(new Error("HOST_READ_ROOT_IDENTITY_CHANGED"));
  const result = await executeProductionCodingRequest(call, "bash", services, f.ctx);
  expect(result).toMatchObject({ outcome: "failed", errorCode: "WORKSPACE_LEDGER_UNAVAILABLE" });
  expect(f.ctx.phase).not.toHaveBeenCalled();
});

it("[BW-3] keeps the command result and notes a failed change record", async () => {
  const { f, ledger, services, call } = ledgerFixture();
  ledger.record.mockRejectedValue(new Error("HOST_READ_ROOT_IDENTITY_CHANGED"));
  const result = await executeProductionCodingRequest(call, "bash", services, f.ctx);
  expect(result).toMatchObject({
    outcome: "succeeded",
    modelContent: "actual tool result\n\n工作目录改动：这次没能记录",
  });
  expect(f.values.get("workspace-changes")).toMatchObject({
    errorCode: "HOST_READ_ROOT_IDENTITY_CHANGED",
  });
});

function memoryArtifactStore() {
  const rows: ThreadArtifact[] = [];
  const latest = (threadId: string, path: string) =>
    rows
      .filter((row) => row.threadId === threadId && row.path === path)
      .sort((left, right) => right.version - left.version)[0] ?? null;
  const store: ThreadArtifactStorePort = {
    register: async ({ artifact }) => {
      const replayed = rows.find(
        (row) =>
          row.runId === artifact.runId &&
          row.toolCallId === artifact.toolCallId &&
          row.path === artifact.path,
      );
      if (replayed) return { artifact: replayed, created: false };
      const previous = latest(artifact.threadId, artifact.path);
      if (
        previous &&
        previous.deletedAt === null &&
        artifact.sha256 !== null &&
        previous.sha256 === artifact.sha256
      )
        return { artifact: previous, created: false };
      const row = { ...artifact, version: (previous?.version ?? 0) + 1, turn: 1, deletedAt: null };
      rows.push(row);
      return { artifact: row, created: true };
    },
    latest: async ({ threadId, path }) => latest(threadId, path),
    get: async ({ id }) => rows.find((row) => row.id === id) ?? null,
    versions: async ({ threadId, path }) =>
      rows.filter((row) => row.threadId === threadId && row.path === path),
    list: async () => ({ items: rows, nextCursor: null }),
    markDeleted: async ({ threadId, paths, deletedAt }) => {
      let changed = 0;
      rows.forEach((row, index) => {
        if (row.threadId === threadId && paths.includes(row.path) && row.deletedAt === null) {
          rows[index] = { ...row, deletedAt };
          changed++;
        }
      });
      return changed;
    },
  };
  return { rows, store };
}

function artifactFixture(files: Record<string, string>) {
  const { f, ledger, services, call } = ledgerFixture();
  const { rows, store } = memoryArtifactStore();
  let counter = 0;
  const readFile = vi.fn(async ({ relativePath }: { relativePath: string }) => {
    const content = files[relativePath];
    if (content === undefined) throw new HostReadOnlyError(HOST_READ_ONLY_ERROR_CODES.PROTECTED);
    return new TextEncoder().encode(content);
  });
  const threadArtifacts = new ProductionThreadArtifacts({
    store,
    files: {
      readFile,
      inspectEntry: async ({ relativePath }) => (files[relativePath] === undefined ? null : "file"),
    },
    ids: { next: (scope) => `${scope}:${++counter}` },
    now: () => now,
    warn: () => {},
  });
  const copies = new Map<string, { bytes: Uint8Array; contentType: string }>();
  f.ctx.saveCopy = async (key, bytes, contentType) => {
    copies.set(key, { bytes, contentType });
    return { ref: `copy:${key}` };
  };
  const withArtifacts = { ...services, threadArtifacts } as typeof services;
  return { f, ledger, services: withArtifacts, call, rows, copies, readFile, threadArtifacts };
}

const ledgerRecord = (changes: readonly Record<string, unknown>[]) => ({
  version: "workspace-changes.v1" as const,
  complete: true,
  beforeScanMs: 3,
  afterScanMs: 4,
  changes,
  summary: "工作目录改动：新建 game/index.html",
});

const fileChange = (path: string, change = "created", size = 5) => ({
  path,
  kind: "file",
  change,
  before: null,
  after: { size: String(size), modifiedAtNs: "1", sha256: null },
});

it("[FD-1] registers files a command created or changed and keeps an encrypted copy", async () => {
  const { f, ledger, services, call, rows, copies } = artifactFixture({
    "game/index.html": "<html>",
    "node_modules/x/a.js": "x",
  });
  ledger.record.mockResolvedValue(
    ledgerRecord([
      fileChange("game/index.html"),
      fileChange("node_modules/x/a.js"),
      fileChange("old.txt", "deleted"),
      { ...fileChange("game"), kind: "directory" },
    ]) as never,
  );
  await executeProductionCodingRequest(call, "bash", services, f.ctx);
  expect(rows).toMatchObject([
    {
      threadId: f.binding.threadId,
      runId: call.runId,
      toolCallId: call.toolCallId,
      source: "bash",
      path: "game/index.html",
      kind: "web",
      mediaType: "text/html",
      sizeBytes: 6,
      version: 1,
      overlapped: false,
    },
  ]);
  expect(rows[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect([...copies.values()]).toMatchObject([{ contentType: "text/html" }]);
  expect(rows[0]?.copyRef).toBe(`copy:${[...copies.keys()][0]}`);
});

it("[FD-1] marks an earlier registered file as deleted when a later command deletes it", async () => {
  const files: Record<string, string> = { "海里的一封信.docx": "v1" };
  const { f, ledger, services, call, rows } = artifactFixture(files);
  ledger.record.mockResolvedValue(ledgerRecord([fileChange("海里的一封信.docx")]) as never);
  await executeProductionCodingRequest(call, "bash", services, f.ctx);
  expect(rows).toMatchObject([{ path: "海里的一封信.docx", deletedAt: null }]);

  delete files["海里的一封信.docx"];
  files["海的记事.docx"] = "v2";
  ledger.record.mockResolvedValue(
    ledgerRecord([
      fileChange("海的记事.docx"),
      fileChange("海里的一封信.docx", "deleted"),
    ]) as never,
  );
  f.values.clear();
  await executeProductionCodingRequest(
    { ...call, toolCallId: "tool:second" },
    "bash",
    services,
    f.ctx,
  );
  expect(rows.map(({ path, deletedAt }) => [path, deletedAt !== null])).toEqual([
    ["海里的一封信.docx", true],
    ["海的记事.docx", false],
  ]);
});

it("[FD-1] a command that only deletes a file still marks its earlier record as deleted", async () => {
  const files: Record<string, string> = { "draft.docx": "v1" };
  const { f, ledger, services, call, rows } = artifactFixture(files);
  ledger.record.mockResolvedValue(ledgerRecord([fileChange("draft.docx")]) as never);
  await executeProductionCodingRequest(call, "bash", services, f.ctx);
  delete files["draft.docx"];
  ledger.record.mockResolvedValue(ledgerRecord([fileChange("draft.docx", "deleted")]) as never);
  f.values.clear();
  await executeProductionCodingRequest({ ...call, toolCallId: "tool:rm" }, "bash", services, f.ctx);
  expect(rows.map(({ path, deletedAt }) => [path, deletedAt !== null])).toEqual([
    ["draft.docx", true],
  ]);
});

it("[FD-1] when commands overlapped, a file that still exists is not marked deleted", async () => {
  const files: Record<string, string> = { "keep.docx": "v1", "gone.docx": "v1" };
  const { f, ledger, services, call, rows, threadArtifacts } = artifactFixture(files);
  ledger.record.mockResolvedValue(
    ledgerRecord([fileChange("keep.docx"), fileChange("gone.docx")]) as never,
  );
  await executeProductionCodingRequest(call, "bash", services, f.ctx);
  delete files["gone.docx"];
  await threadArtifacts.recordDeleted({
    ownerId: f.ctx.ownerId,
    agentId: f.ctx.agentId,
    threadId: f.binding.threadId,
    runId: call.runId,
    toolCallId: "tool:overlap",
    paths: ["keep.docx", "gone.docx"],
    grant: {} as never,
    overlapped: true,
  });
  expect(rows.map(({ path, deletedAt }) => [path, deletedAt !== null]).sort()).toEqual([
    ["gone.docx", true],
    ["keep.docx", false],
  ]);
});

it("[FD-1] records one version per command end and none when the content did not change", async () => {
  const files: Record<string, string> = { "notes.md": "one" };
  const { f, ledger, services, call, rows, copies } = artifactFixture(files);
  ledger.record.mockResolvedValue(ledgerRecord([fileChange("notes.md", "modified")]) as never);
  await executeProductionCodingRequest(call, "bash", services, f.ctx);
  const second = { ...call, toolCallId: "tool:second" };
  f.values.clear();
  await executeProductionCodingRequest(second, "bash", services, f.ctx);
  expect(rows).toHaveLength(1);
  expect(copies.size).toBe(1);
  files["notes.md"] = "two";
  const third = { ...call, toolCallId: "tool:third" };
  f.values.clear();
  await executeProductionCodingRequest(third, "bash", services, f.ctx);
  expect(rows.map(({ version, toolCallId }) => [version, toolCallId])).toEqual([
    [1, call.toolCallId],
    [2, "tool:third"],
  ]);
});

it("[FD-1] marks a version when another command ran in the same directory at the same time", async () => {
  const { f, ledger, services, call, rows, threadArtifacts } = artifactFixture({ "out.csv": "a" });
  ledger.record.mockResolvedValue(ledgerRecord([fileChange("out.csv")]) as never);
  const finishOther = threadArtifacts.begin(f.binding.grant.id);
  await executeProductionCodingRequest(call, "bash", services, f.ctx);
  expect(finishOther()).toBe(true);
  expect(rows).toMatchObject([{ path: "out.csv", kind: "data", overlapped: true }]);
});

it("[FD-1] registers a file without a copy when it is over the copy limit", async () => {
  const { f, ledger, services, call, rows, copies, readFile } = artifactFixture({});
  ledger.record.mockResolvedValue(
    ledgerRecord([
      {
        ...fileChange("video.bin", "created", 40 * 1024 * 1024),
        after: { size: String(40 * 1024 * 1024), modifiedAtNs: "1", sha256: null },
      },
    ]) as never,
  );
  await executeProductionCodingRequest(call, "bash", services, f.ctx);
  expect(readFile).not.toHaveBeenCalled();
  expect(copies.size).toBe(0);
  expect(rows).toMatchObject([
    { path: "video.bin", copyRef: null, sha256: null, sizeBytes: 40 * 1024 * 1024 },
  ]);
});

it("[FD-1] registers the file a write or edit changed under its workspace-relative path", async () => {
  const { f, call, rows, services } = artifactFixture({ "report.md": "# hi" });
  const write = {
    ...call,
    capabilityRef: "coding.write",
    arguments: { path: "/workspace/report.md", content: "# hi" },
  };
  const result = await executeProductionCodingRequest(write, "write", services, f.ctx);
  expect(result.outcome).toBe("succeeded");
  expect(rows).toMatchObject([
    { source: "write", path: "report.md", kind: "document", mediaType: "text/markdown" },
  ]);
});

it("[FD-1] does not register anything when the write failed", async () => {
  const { f, call, rows, services } = artifactFixture({ "report.md": "# hi" });
  vi.mocked(f.ctx.phase).mockResolvedValue({
    outcome: "failed",
    resultRef: null,
    errorCode: "FILE_VERSION_CONFLICT",
    externalActionId: null,
    modelContent: "failed",
  });
  await executeProductionCodingRequest(
    { ...call, capabilityRef: "coding.write", arguments: { path: "report.md", content: "x" } },
    "write",
    services,
    f.ctx,
  );
  expect(rows).toEqual([]);
});
