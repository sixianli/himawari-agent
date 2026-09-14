import { describe, expect, it, vi } from "vitest";
import { GatewayClient, loadRuntimeConfiguration, safeBrowserLog } from "../src/gateway-client.js";

const configuration = {
  ownerId: "owner",
  agentId: "agent",
  deploymentId: "deployment",
  actorId: "owner",
  csrfToken: "csrf",
  authorityEpoch: 1,
  fencingToken: 1,
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function fixture(body: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response(body));
  return { fetch, client: new GatewayClient({ fetch, csrfToken: () => "csrf" }) };
}

describe("runtime configuration trust boundary", () => {
  it.each([null, [], "configuration", 1])("rejects non-object configuration %j", async (body) => {
    await expect(loadRuntimeConfiguration(fixture(body).fetch)).rejects.toThrow(
      "CONTROL_CENTER_CONFIGURATION_INVALID",
    );
  });
  it.each(["ownerId", "agentId", "deploymentId", "actorId", "csrfToken"])(
    "requires nonempty %s",
    async (key) => {
      for (const value of [undefined, "", 7]) {
        await expect(
          loadRuntimeConfiguration(fixture({ ...configuration, [key]: value }).fetch),
        ).rejects.toThrow("CONTROL_CENTER_CONFIGURATION_INVALID");
      }
    },
  );
  it.each(["authorityEpoch", "fencingToken"])("requires a positive integer %s", async (key) => {
    for (const value of [undefined, 0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        loadRuntimeConfiguration(fixture({ ...configuration, [key]: value }).fetch),
      ).rejects.toThrow("CONTROL_CENTER_CONFIGURATION_INVALID");
    }
  });
  it.each(["", 123, "s".repeat(129)])(
    "rejects malformed session identity %j",
    async (sessionId) => {
      await expect(
        loadRuntimeConfiguration(fixture({ ...configuration, sessionId }).fetch),
      ).rejects.toThrow("CONTROL_CENTER_CONFIGURATION_INVALID");
    },
  );
  it.each([false, {}, [1]])(
    "rejects malformed operation advertisement %j",
    async (installedGatewayV2Operations) => {
      await expect(
        loadRuntimeConfiguration(fixture({ ...configuration, installedGatewayV2Operations }).fetch),
      ).rejects.toThrow("CONTROL_CENTER_CONFIGURATION_INVALID");
    },
  );
  const validModel = {
    ref: "ref",
    model: "model",
    name: "name",
    provider: "provider",
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  };
  it.each([
    false,
    {},
    [null],
    [1],
    ...["ref", "model", "name", "provider"].map((key) => [{ ...validModel, [key]: "" }]),
    ...[null, [], ["unsupported"]].map((thinkingLevels) => [{ ...validModel, thinkingLevels }]),
  ])("rejects invalid model advertisement %j", async (availableModels) => {
    await expect(
      loadRuntimeConfiguration(fixture({ ...configuration, availableModels }).fetch),
    ).rejects.toThrow("CONTROL_CENTER_CONFIGURATION_INVALID");
  });
  it.each([
    null,
    [],
    "model",
    { provider: 1, model: "model", version: "1" },
    { provider: "p", model: 1, version: "1" },
    { provider: "p", model: "m", version: 1 },
  ])("does not present an invalid primary model %j", async (primaryModel) => {
    expect(
      (await loadRuntimeConfiguration(fixture({ ...configuration, primaryModel }).fetch))
        .primaryModel,
    ).toBeNull();
  });
  it("normalizes optional capabilities without broadening disclosed classifications", async () => {
    const config = await loadRuntimeConfiguration(
      fixture({
        ...configuration,
        primaryModel: { provider: "p", model: "m", version: "1" },
        availableModels: [validModel],
        repositoryAllowlistRefs: ["repo", null, 3],
        disclosedDataClassifications: [
          "public",
          "private",
          "sensitive",
          "restricted",
          "invented",
          null,
        ],
        primaryModelRef: "",
        authorizationRef: 1,
        recentAuthenticationRef: "recent",
      }).fetch,
    );
    expect(config).toMatchObject({
      primaryModel: { provider: "p", model: "m", version: "1" },
      availableModels: [validModel],
      repositoryAllowlistRefs: ["repo"],
      disclosedDataClassifications: ["public", "private", "sensitive", "restricted"],
      primaryModelRef: null,
      authorizationRef: null,
      recentAuthenticationRef: "recent",
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.primaryModel)).toBe(true);
  });
});

describe("gateway response contracts", () => {
  const health = {
    id: "health",
    live: true,
    ready: true,
    status: "healthy",
    dependencies: [{ name: "worker", required: true, status: "healthy", reasonCode: null }],
  };
  it.each([
    null,
    [],
    1,
    ...["id", "live", "ready", "status", "dependencies"].map((key) => ({ ...health, [key]: 3 })),
    ...[
      null,
      [],
      false,
      {},
      { name: "worker" },
      { name: "worker", required: true, status: "invented", reasonCode: null },
      { name: "worker", required: true, status: "healthy", reasonCode: 3 },
    ].map((value) => ({ ...health, dependencies: [value] })),
  ])("rejects invalid dependency status %j", async (body) => {
    await expect(fixture(body).client.healthDependencies()).rejects.toThrow(
      "CONTROL_CENTER_RESPONSE_INVALID",
    );
  });
  it("preserves unhealthy dependency explanations", async () => {
    const body = {
      ...health,
      ready: false,
      status: "not_ready",
      dependencies: [
        { name: "worker", required: true, status: "unavailable", reasonCode: "WORKER_NOT_READY" },
      ],
    };
    expect(await fixture(body).client.healthDependencies()).toEqual(body);
  });
  it.each([null, [], 1, {}, { payloadRef: 1 }])(
    "rejects malformed protected write acknowledgement %j",
    async (body) => {
      await expect(fixture(body).client.protectText("private text")).rejects.toThrow(
        "CONTROL_CENTER_RESPONSE_INVALID",
      );
    },
  );
  it.each([0, 65537])("rejects text size %s before network", async (size) => {
    const content = "x".repeat(size);
    const f = fixture({ payloadRef: "p" });
    await expect(f.client.protectText(content)).rejects.toThrow("CONTROL_CENTER_PAYLOAD_INVALID");
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each([
    null,
    [],
    1,
    {},
    { content: 1, dataClassification: "private", contentType: "text/plain" },
    { content: "text", dataClassification: "unknown", contentType: "text/plain" },
    { content: "text", dataClassification: "private", contentType: "text/html" },
  ])("rejects malformed protected read %j", async (body) => {
    await expect(fixture(body).client.readText("p")).rejects.toThrow(
      "CONTROL_CENTER_RESPONSE_INVALID",
    );
  });
  it.each(["public", "private", "sensitive", "restricted"])(
    "reads %s text without exposing content-type internals",
    async (dataClassification) => {
      const result = await fixture({
        content: "text",
        dataClassification,
        contentType: "text/plain",
      }).client.readText("p");
      expect(result).toEqual({ content: "text", dataClassification });
      expect(Object.isFrozen(result)).toBe(true);
    },
  );
  it.each([
    null,
    [],
    1,
    {},
    { queryRef: 1, tokenRefs: ["t"], projectionVersion: "v" },
    { queryRef: "q", tokenRefs: "t", projectionVersion: "v" },
    { queryRef: "q", tokenRefs: [], projectionVersion: "v" },
    { queryRef: "q", tokenRefs: [1], projectionVersion: "v" },
    { queryRef: "q", tokenRefs: ["t"], projectionVersion: 1 },
  ])("rejects malformed protected search %j", async (body) => {
    await expect(fixture(body).client.prepareThreadSearch("q")).rejects.toThrow(
      "CONTROL_CENTER_RESPONSE_INVALID",
    );
  });
  it.each([null, [], {}, { error: {} }, { error: { code: 1 } }])(
    "does not mistake an unstructured HTTP failure for success %j",
    async (body) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => response(body, 503));
      await expect(
        new GatewayClient({ fetch, csrfToken: () => "csrf" }).readText("p"),
      ).rejects.toMatchObject({ message: "CONTROL_CENTER_REQUEST_REJECTED", status: 503 });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
  it.each(["", "old"])("does not loop when CSRF refresh yields %j", async (token) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      response({ error: { code: "HTTP_GATEWAY_CSRF_REJECTED" } }, 403),
    );
    const refreshCsrfToken = vi.fn(async () => token);
    const client = new GatewayClient({ fetch, csrfToken: () => "old", refreshCsrfToken });
    await expect(client.protectText("text")).rejects.toThrow(
      token ? "HTTP_GATEWAY_CSRF_REJECTED" : "CONTROL_CENTER_CONFIGURATION_INVALID",
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(refreshCsrfToken).toHaveBeenCalledOnce();
  });
  it.each([
    undefined,
    { type: 1, messageId: 2, payload: [] },
    { type: "t", messageId: "id", payload: { cursor: 1, secret: "not-for-log" } },
  ])("limits logs to typed routing fields %j", (message) => {
    const result = safeBrowserLog("failed", message);
    expect(result).toEqual({
      code: "failed",
      messageType: typeof message?.type === "string" ? message.type : null,
      messageId: typeof message?.messageId === "string" ? message.messageId : null,
      cursor: null,
    });
    expect(JSON.stringify(result)).not.toContain("not-for-log");
  });
});
