import { fileURLToPath } from "node:url";
import type {
  CapabilityInvocationRequest,
  CapabilityManifest,
  PayloadProtectorPort,
  PayloadRecord,
  PayloadStorePort,
} from "@himawari-agent/application";
import { createAgentId, createOwnerId, createRunId } from "@himawari-agent/domain";
import { describe, expect, it, vi } from "vitest";
import {
  NODE_CAPABILITY_RUNTIME_ERROR_CODES,
  NodeCapabilityRuntimePort,
} from "../src/capabilities/node-capability-runtime.js";
import type {
  CapabilityEndpointBinding,
  CapabilityProcessBinding,
  CapabilityRuntimeBindingPort,
  SandboxedProcessIsolationBackend,
} from "../src/capabilities/isolation.js";
import { EphemeralSecretPort } from "../src/ephemeral-secret-port.js";

const NOW = "2026-08-28T08:20:00.000Z";
const OWNER_ID = createOwnerId("owner-node-capability-runtime");
const AGENT_ID = createAgentId("agent-node-capability-runtime");
const RUN_ID = createRunId("run-node-capability-runtime");
const DIGEST = `sha256:${"a".repeat(64)}`;
const CEILING = {
  maxWallTimeMs: 3_000,
  maxCpuTimeMs: 1_000,
  maxMemoryBytes: 128 * 1024 * 1024,
  maxOutputBytes: 16_384,
  maxProgressEvents: 8,
};
const MCP_FIXTURE = fileURLToPath(new URL("./fixtures/mcp-echo-server.mjs", import.meta.url));

class FixturePayloadStore implements PayloadStorePort {
  readonly #records = new Map<string, PayloadRecord>();

  async put(payload: PayloadRecord): Promise<void> {
    this.#records.set(payload.ref, structuredClone(payload));
  }

  async get(ref: string): Promise<PayloadRecord | undefined> {
    const payload = this.#records.get(ref);
    return payload ? structuredClone(payload) : undefined;
  }

  async delete(ref: string): Promise<boolean> {
    return this.#records.delete(ref);
  }
}

const fixtureProtector: PayloadProtectorPort = {
  protect: async (input) => ({
    ref: input.ref,
    dataClassification: input.dataClassification,
    contentType: input.contentType,
    ciphertext: input.plaintext.map((byte) => byte ^ 0xa5),
    encryption: { algorithm: "fixture-xor", keyRef: "fixture-key" },
    contentDigest: `fixture:${String(input.plaintext.byteLength)}`,
    createdAt: input.createdAt,
  }),
  unprotect: async ({ payload }) => payload.ciphertext.map((byte) => byte ^ 0xa5),
  rewrap: async ({ payload }) => structuredClone(payload),
};

function manifest(
  runtime: CapabilityManifest["runtime"],
  sourceType: CapabilityManifest["source"]["type"],
  input: {
    readonly ref: string;
    readonly isolation: CapabilityManifest["isolation"];
    readonly operations?: readonly string[];
    readonly secrets?: readonly string[];
  },
): CapabilityManifest {
  return {
    manifestVersion: "capability.v2",
    ref: input.ref,
    displayName: input.ref,
    version: "1.0.0",
    source: { type: sourceType, locator: `${sourceType}:${input.ref}:1.0.0` },
    sourceIdentity: `${sourceType}:fixture`,
    integrity: DIGEST,
    artifact: {
      digest: DIGEST,
      signatureStatus: "verified",
      signerRef: "signer:fixture",
      rollbackArtifactRef: null,
    },
    operations: input.operations ?? ["execute"],
    permissionRefs: [],
    isolation: input.isolation,
    scopes: {
      dataClassifications: ["private"],
      network: [],
      filesystem: [],
      secrets: input.secrets ?? [],
    },
    cost: { currency: "USD", maxMicrosPerInvocation: 0 },
    health: { status: "healthy", checkedAt: NOW },
    reviewedBy: "owner",
    reviewedAt: NOW,
    contractCompatibility: ["capability-conformance.v1"],
    runtime,
  };
}

function request(capabilityRef: string, operation = "execute"): CapabilityInvocationRequest {
  return {
    invocationId: `invocation:${capabilityRef}`,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    capabilityRef,
    capabilityHandleRef: `handle:${capabilityRef}`,
    operation,
    inputRef: `payload:input:${capabilityRef}`,
    delegatedContextRefs: [],
    secretHandleRefs: [],
    dataClassification: "private",
    resourceCeiling: CEILING,
  };
}

async function runtimeFixture(
  active: readonly CapabilityManifest[],
  bindings: CapabilityRuntimeBindingPort,
  isolation: SandboxedProcessIsolationBackend,
  fetch?: typeof globalThis.fetch,
  listActive?: () => Promise<readonly CapabilityManifest[]>,
) {
  const clock = { now: () => NOW };
  const payloadStore = new FixturePayloadStore();
  const secretHandles = new EphemeralSecretPort({
    clock,
    ids: { next: (namespace) => `${namespace}:fixture` },
  });
  const port = new NodeCapabilityRuntimePort({
    manifests: { listActive: listActive ?? (async () => active) },
    bindings,
    isolation,
    payloads: {
      store: () => payloadStore,
      protector: fixtureProtector,
      nextResultRef: (input) => `payload:result:${input.invocationId}`,
    },
    secretHandles,
    secretSource: { resolve: async () => "fixture-secret" },
    clock,
    ...(fetch ? { fetch } : {}),
  });
  const putInput = async (input: CapabilityInvocationRequest, value: unknown) => {
    await payloadStore.put(
      await fixtureProtector.protect({
        ownerId: input.ownerId,
        agentId: input.agentId,
        ref: input.inputRef,
        dataClassification: input.dataClassification,
        contentType: "application/json",
        plaintext: new TextEncoder().encode(JSON.stringify(value)),
        createdAt: NOW,
      }),
    );
  };
  return { payloadStore, port, protector: fixtureProtector, putInput, secretHandles };
}

async function collect(port: NodeCapabilityRuntimePort, input: CapabilityInvocationRequest) {
  const events = [];
  for await (const event of port.invoke(input)) events.push(event);
  return events;
}

describe("NodeCapabilityRuntimePort", () => {
  it("keeps cancellation while manifest admission is pending and never dispatches afterwards", async () => {
    let release = () => {};
    let started = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admitted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const capability = manifest(
      { kind: "adapter", endpointIdentity: "adapter:cancel", protectedReferenceOnly: true },
      "adapter",
      { ref: "cancelled-admission", isolation: "remote" },
    );
    const resolveEndpoint = vi.fn(async () => undefined);
    const f = await runtimeFixture(
      [capability],
      { resolveEndpoint, resolveProcess: async () => undefined },
      {
        qualify: async () => {
          throw new Error("not reached");
        },
        createLaunch: async () => {
          throw new Error("not reached");
        },
      },
      undefined,
      async () => {
        started();
        await pending;
        return [capability];
      },
    );
    const invocation = request(capability.ref);
    await f.putInput(invocation, {});
    const running = collect(f.port, invocation);
    await admitted;
    await f.port.cancel(invocation.invocationId, "owner_cancelled");
    release();
    expect(await running).toMatchObject([{ type: "capability.cancelled" }]);
    expect(resolveEndpoint).not.toHaveBeenCalled();
  });

  it("uses the official MCP v2 stdio SDK, enforces exact server/tool identity, and protects output", async () => {
    const capability = manifest(
      {
        kind: "mcp",
        serverIdentity: "himawari-qualified-echo@1.0.0",
        transport: "stdio:mcp-2026-07-28",
        mappedResources: ["tool:echo"],
      },
      "mcp",
      { ref: "qualified-mcp", isolation: "sandbox", operations: ["echo"] },
    );
    const binding: CapabilityProcessBinding = {
      capabilityRef: capability.ref,
      capabilityVersion: capability.version,
      artifactDigest: capability.integrity,
      runtimeRoot: "/fixture/not-used-by-sdk-test",
      command: process.execPath,
      workdirRef: "fixture",
      sandboxWorkdir: "/",
      environment: {},
      availableExecutables: [process.execPath],
      filesystem: [],
      maximumResourceCeiling: CEILING,
      mcpServerIdentity: "himawari-qualified-echo@1.0.0",
      mcpServerName: "himawari-qualified-echo",
      mcpServerVersion: "1.0.0",
      mcpOperationMap: { echo: "echo" },
    };
    const bindings: CapabilityRuntimeBindingPort = {
      resolveProcess: async () => binding,
      resolveEndpoint: async () => undefined,
    };
    const isolation: SandboxedProcessIsolationBackend = {
      qualify: async () => ({
        qualificationVersion: "capability-runtime-qualification.v1",
        platform: "darwin",
        runtimeIdentity: "test-only-direct-process",
        productionSuitable: false,
        artifactDigest: DIGEST,
        enforcement: {
          filesystem: false,
          network: false,
          processes: false,
          secrets: false,
          resourceCeilings: false,
          termination: true,
        },
        reasonCodes: ["TEST_ONLY_NO_PRODUCTION_ISOLATION"],
        checkedAt: NOW,
      }),
      createLaunch: async (_manifest, ceiling) => ({
        command: process.execPath,
        args: [MCP_FIXTURE],
        cwd: "/",
        environment: {},
        ceiling,
      }),
    };
    const fixture = await runtimeFixture([capability], bindings, isolation);
    const invocation = request(capability.ref, "echo");
    await fixture.putInput(invocation, { value: "hello from qualified MCP" });
    const events = await collect(fixture.port, invocation);
    expect(events).toEqual([
      {
        type: "capability.completed",
        invocationId: invocation.invocationId,
        resultRef: `payload:result:${invocation.invocationId}`,
        occurredAt: NOW,
      },
    ]);
    const output = await fixture.payloadStore.get(`payload:result:${invocation.invocationId}`);
    expect(output).toBeDefined();
    if (!output) throw new Error("protected MCP output is missing");
    expect(JSON.stringify(output)).not.toContain("hello from qualified MCP");
    const decoded = JSON.parse(
      new TextDecoder().decode(
        await fixture.protector.unprotect({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          payload: output,
        }),
      ),
    );
    expect(decoded).toMatchObject({
      content: [{ type: "text", text: "hello from qualified MCP" }],
    });
  });

  it("binds a remote adapter to one same-origin endpoint and reports uncertain side effects", async () => {
    const capability = manifest(
      { kind: "adapter", endpointIdentity: "adapter:fixture", protectedReferenceOnly: true },
      "adapter",
      { ref: "qualified-adapter", isolation: "remote", operations: ["publish"] },
    );
    const endpoint: CapabilityEndpointBinding = {
      endpointIdentity: "adapter:fixture",
      artifactDigest: capability.integrity,
      url: "https://api.example.test/v1/",
      allowedMethods: ["POST"],
      operations: { publish: { method: "POST", path: "/v1/publish", secretHeaders: {} } },
      productionSuitable: true,
      allowLoopbackQualification: false,
    };
    const bindings: CapabilityRuntimeBindingPort = {
      resolveProcess: async () => undefined,
      resolveEndpoint: async () => endpoint,
    };
    const isolation = {
      qualify: async () => {
        throw new Error("endpoint runtime must not use process isolation");
      },
      createLaunch: async () => {
        throw new Error("endpoint runtime must not launch a process");
      },
    } satisfies SandboxedProcessIsolationBackend;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce(new Response("upstream failed", { status: 500 }));
    const fixture = await runtimeFixture([capability], bindings, isolation, fetch);
    const invocation = request(capability.ref, "publish");
    await fixture.putInput(invocation, { message: "publish once" });
    await expect(collect(fixture.port, invocation)).resolves.toEqual([
      {
        type: "capability.result_unknown",
        invocationId: invocation.invocationId,
        externalActionId: `external:${invocation.invocationId}`,
        occurredAt: NOW,
      },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://api.example.test/v1/publish"),
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
    await expect(collect(fixture.port, invocation)).resolves.toEqual([
      {
        type: "capability.result_unknown",
        invocationId: invocation.invocationId,
        externalActionId: `external:${invocation.invocationId}`,
        occurredAt: NOW,
      },
    ]);
  });

  it("injects secret material only through the declared endpoint header and stores protected output", async () => {
    const capability = manifest(
      { kind: "remote_api", endpointIdentity: "api:fixture", protectedReferenceOnly: true },
      "remote_api",
      {
        ref: "qualified-api",
        isolation: "remote",
        operations: ["read"],
        secrets: ["provider-token"],
      },
    );
    const endpoint: CapabilityEndpointBinding = {
      endpointIdentity: "api:fixture",
      artifactDigest: capability.integrity,
      url: "https://api.example.test/v1/",
      allowedMethods: ["GET"],
      operations: {
        read: {
          method: "GET",
          path: "/v1/value",
          secretHeaders: { "provider-token": "x-provider-token" },
        },
      },
      productionSuitable: true,
      allowLoopbackQualification: false,
    };
    const bindings: CapabilityRuntimeBindingPort = {
      resolveProcess: async () => undefined,
      resolveEndpoint: async () => endpoint,
    };
    const isolation = {
      qualify: async () => {
        throw new Error("not called");
      },
      createLaunch: async () => {
        throw new Error("not called");
      },
    } satisfies SandboxedProcessIsolationBackend;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const fixture = await runtimeFixture([capability], bindings, isolation, fetch);
    const baseRequest = request(capability.ref, "read");
    const secretHandle = await fixture.secretHandles.issueHandle({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      secretRef: "provider-token",
      secretVersion: "version-1",
      purpose: "read",
      scopeRef: baseRequest.invocationId,
      expiresAt: "2026-08-28T09:20:00.000Z",
    });
    const invocation = { ...baseRequest, secretHandleRefs: [secretHandle.ref] };
    await fixture.putInput(invocation, {});
    await expect(collect(fixture.port, invocation)).resolves.toMatchObject([
      { type: "capability.completed", resultRef: `payload:result:${invocation.invocationId}` },
    ]);
    const call = fetch.mock.calls[0];
    expect(call).toBeDefined();
    const headers = call?.[1]?.headers;
    expect(new Headers(headers).get("x-provider-token")).toBe("fixture-secret");
    const output = await fixture.payloadStore.get(`payload:result:${invocation.invocationId}`);
    expect(output).toBeDefined();
    expect(JSON.stringify(output)).not.toContain('"status":"ok"');
  });

  it("fails before any runtime call when the resource ceiling is missing", async () => {
    const capability = manifest(
      { kind: "adapter", endpointIdentity: "adapter:fixture", protectedReferenceOnly: true },
      "adapter",
      { ref: "ceiling-required", isolation: "remote" },
    );
    const bindings: CapabilityRuntimeBindingPort = {
      resolveProcess: async () => undefined,
      resolveEndpoint: async () => undefined,
    };
    const isolation = {
      qualify: async () => {
        throw new Error("not called");
      },
      createLaunch: async () => {
        throw new Error("not called");
      },
    } satisfies SandboxedProcessIsolationBackend;
    const fixture = await runtimeFixture([capability], bindings, isolation);
    await expect(
      collect(fixture.port, { ...request(capability.ref), resourceCeiling: null }),
    ).resolves.toEqual([
      {
        type: "capability.failed",
        invocationId: `invocation:${capability.ref}`,
        errorCode: NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_RESOURCE_CEILING_MISSING,
        occurredAt: NOW,
      },
    ]);
  });
});
