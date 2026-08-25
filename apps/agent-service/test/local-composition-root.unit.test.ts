import type {
  GatewayAuthenticationContext,
  GatewayCommandExecution,
  GatewayControlPlanePort,
  SecretPort,
} from "@himawari-agent/application";
import {
  InMemoryGatewayAccessPolicy,
  InMemoryGatewayReadModel,
  createReferenceAdapterSet,
} from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";
import {
  StaticLocalGatewayAuthenticator,
  createLocalAgentServiceComposition,
} from "../src/index.js";

const authentication: GatewayAuthenticationContext = {
  subjectId: "owner-01",
  ownerId: "owner-01",
  deviceId: "device-01",
  authenticatedAt: "2026-08-25T00:00:00.000Z",
  authenticationRef: "auth-session-01",
};

const cancelCommand = {
  schemaVersion: "gateway.v1",
  kind: "command",
  type: "run.cancel",
  messageId: "message-01",
  correlationId: "correlation-01",
  causationId: null,
  dataClassification: "private",
  scope: { ownerId: "owner-01", agentId: "agent-01" },
  actor: { actorType: "owner", actorId: "owner-01" },
  idempotencyKey: "cancel-01",
  payload: { runId: "run-01", reasonCode: "owner_cancelled" },
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("local agent-service composition root", () => {
  it("composes reference adapters with a replaceable Secret Port and safe readiness", async () => {
    const adapters = createReferenceAdapterSet();
    const secret: SecretPort = {
      issueHandle: (...args) => adapters.secret.issueHandle(...args),
      inspectHandle: (...args) => adapters.secret.inspectHandle(...args),
      revokeHandle: (...args) => adapters.secret.revokeHandle(...args),
    };
    const worker = {
      adapterIdentity: "local-in-process-execution-worker",
      schemaVersion: "execution.v1" as const,
      isReady: () => true,
      async *dispatch() {},
    };
    const root = createLocalAgentServiceComposition({
      adapters,
      secret,
      worker,
      authenticator: new StaticLocalGatewayAuthenticator("local-credential", authentication),
      access: new InMemoryGatewayAccessPolicy([authentication]),
    });

    const diagnostics = await root.process.start();

    expect(root.services.secret).toBe(secret);
    expect(diagnostics).toEqual([
      {
        component: "agent-service",
        adapterIdentity: "local-foreground-composition",
        schemaVersion: "gateway.v1",
        readiness: "ready",
      },
      {
        component: "execution-worker-client",
        adapterIdentity: "local-in-process-execution-worker",
        schemaVersion: "execution.v1",
        readiness: "ready",
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("local-credential");
    expect(JSON.stringify(diagnostics)).not.toMatch(/secretRef|secretValue|credentialValue/);

    const recorded = await root.services.trace.record({
      ownerId: "owner-01" as never,
      agentId: "agent-01" as never,
      sessionId: "session-01" as never,
      threadId: "thread-01" as never,
      runId: "run-01" as never,
      turnId: null,
      parentEventId: null,
      causationId: null,
      correlationId: "correlation-01",
      actorId: "system",
      dataClassification: "sensitive",
      eventType: "secret.handle_issued",
      payload: { secretRef: "booking-provider", secretValue: "raw-secret-never-persist" },
      sensitiveLiterals: ["raw-secret-never-persist"],
    });
    const protectedPayload = await adapters.payload.get(recorded.payloadRef ?? "");
    expect(protectedPayload).toBeDefined();
    if (!protectedPayload) throw new Error("protected trace payload missing");
    const revealed = await adapters.payloadProtector.revealForTest(protectedPayload);
    expect(revealed).toEqual({ secretRef: "booking-provider", secretValue: "[REDACTED]" });
  });

  it("stops admission and waits for an in-flight command before shutdown", async () => {
    const runSettlement = deferred<"completed">();
    const executions: GatewayCommandExecution[] = [];
    const controlPlane: GatewayControlPlanePort = {
      execute(input) {
        executions.push(input);
        return Promise.resolve({ resultRef: "run:run-01", replayed: false });
      },
    };
    const root = createLocalAgentServiceComposition({
      controlPlane,
      reads: new InMemoryGatewayReadModel(),
      worker: {
        adapterIdentity: "remote-execution-worker",
        schemaVersion: "execution.v1",
        isReady: () => true,
        async *dispatch() {},
      },
      authenticator: new StaticLocalGatewayAuthenticator("local-credential", authentication),
      access: new InMemoryGatewayAccessPolicy([authentication]),
    });
    await root.process.start();

    await root.process.request("local-credential", cancelCommand);
    const inFlightRun = root.process.trackRun(runSettlement.promise);
    let shutdownSettled = false;
    const shutdown = root.process.shutdown().then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();

    expect(shutdownSettled).toBe(false);
    await expect(root.process.request("local-credential", cancelCommand)).rejects.toThrow(
      "SERVICE_DRAINING",
    );

    runSettlement.resolve("completed");
    await expect(inFlightRun).resolves.toBe("completed");
    await shutdown;

    expect(executions).toHaveLength(1);
    expect(root.process.isReady()).toBe(false);
  });

  it("accepts a remote execution.v1 client without changing product or domain contracts", async () => {
    const root = createLocalAgentServiceComposition({
      worker: {
        adapterIdentity: "remote-http-execution-worker",
        schemaVersion: "execution.v1",
        isReady: () => true,
        async *dispatch() {},
      },
      authenticator: new StaticLocalGatewayAuthenticator("local-credential", authentication),
      access: new InMemoryGatewayAccessPolicy([authentication]),
    });

    const diagnostics = await root.process.start();

    expect(diagnostics[1]).toMatchObject({
      adapterIdentity: "remote-http-execution-worker",
      schemaVersion: "execution.v1",
      readiness: "ready",
    });
  });
});
