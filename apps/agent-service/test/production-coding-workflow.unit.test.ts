import type { PermissionDecision, RuntimeToolInvocation } from "@himawari-agent/application";
import { describe, expect, it, vi } from "vitest";
import { executeProductionCodingRequest } from "../src/production-coding-workflow.js";
import type {
  FileReadBinding,
  FileReadExecutionContext,
  ProductionFileReadServices,
} from "../src/production-file-read-workflow.js";
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
    async (): Promise<PermissionDecision> => ({
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
  return { call, binding, ctx, services, authorize };
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
      ).toMatchObject({ errorCode: "CODING_PATH_OUTSIDE_SCOPE" });
      expect(f.authorize).not.toHaveBeenCalled();
    },
  );
  it("accepts the grant root for directory queries but does not execute without approval", async () => {
    const f = fixture();
    await executeProductionCodingRequest(
      { ...f.call, capabilityRef: "coding.ls", arguments: {} },
      "ls",
      f.services,
      f.ctx,
    );
    expect(f.authorize).toHaveBeenCalledWith(expect.objectContaining({ operation: "ls" }));
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
