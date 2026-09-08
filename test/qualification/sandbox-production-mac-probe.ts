import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { hostDirectoryGrantStateKey } from "@himawari-agent/application";
import {
  type ExecutionV2Request,
  executionV2MessageSchema,
} from "@himawari-agent/execution-contracts";
import { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { PayloadUdsServer } from "@himawari-agent/platform-node";
import assert from "node:assert/strict";
import { ProductionPayloadBrokerHandler } from "../../apps/agent-service/src/production-payload-broker-handler.js";
import {
  OWNER_ID,
  AGENT_ID,
  RUN_ID,
  LIVE_SANDBOX,
  T1,
  SERVICE_AUTHORITY,
  serviceRequest,
  openSandboxJournal,
} from "../fixtures/sqlite-capability-invocation-fixture.js";

export async function qualifyProductionSandboxMac() {
  if (!LIVE_SANDBOX || process.platform !== "darwin")
    throw new Error("MAC_SANDBOX_PROBE_OPT_IN_REQUIRED");
  const { macSandboxDeployment } = await import("../fixtures/mac-sandbox-deployment.js");
  const { createProductionSandboxServices } = await import(
    "../../apps/agent-service/src/production-sandbox-services.js"
  );
  const { createProductionSandboxWorker } = await import(
    "../../apps/execution-worker/src/production-sandbox-worker.js"
  );
  const { ProductionPayloadBrokerClient } = await import(
    "../../apps/execution-worker/src/production-payload-broker-client.js"
  );
  const cleanup: (() => Promise<unknown>)[] = [];
  const dispose = async () => {
    const errors: unknown[] = [];
    for (const close of cleanup.splice(0).reverse()) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "live probe cleanup failed");
  };

  try {
    const fixture = await openSandboxJournal();
    cleanup.push(() => fixture.close());
    const host = await macSandboxDeployment(fixture.resource.stateRoot, fixture.plan, T1);
    const scope = { ...fixture.scope, parentToolCallId: null };
    const payload = await fixture.protector.protect({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      ref: fixture.scopePayload.ref,
      dataClassification: "private",
      contentType: "application/json",
      plaintext: new TextEncoder().encode(JSON.stringify(scope)),
      createdAt: T1,
    });
    const plan = {
      ...fixture.plan,
      binding: {
        ...fixture.plan.binding,
        scopeDigest: payload.contentDigest.slice(7),
        runtimeDigest: host.binding.runtimeDigest,
        runnerDigest: host.binding.runner.sha256,
        requiredGuarantees: host.sandbox.guarantees,
      },
    };
    fixture.database
      .prepare(
        "INSERT INTO product_state_records (key, owner_id, agent_id, revision, value_json, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
      )
      .run(
        hostDirectoryGrantStateKey(scope.directoryGrant.ref),
        OWNER_ID,
        AGENT_ID,
        JSON.stringify({ ...fixture.directoryGrant, displayPath: host.workspace }),
        T1,
      );
    fixture.call("Prepare", { plan, observation: { ...fixture.prepared, policyDigest: null } });
    fixture.database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot: fixture.resource.stateRoot,
      minimumFreeBytes: 0,
      now: () => new Date().toISOString(),
    });
    cleanup.push(() => repository.close());
    const directory = await mkdtemp("/tmp/h-live-");
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const peer = { ...SERVICE_AUTHORITY, ...SERVICE_AUTHORITY.product };
    const common = {
      credential: { tokenRef: "live-probe", tokenValue: "0123456789abcdef0123456789abcdef" },
      agentServiceInstanceId: peer.agentServiceInstanceId,
      agentServiceBootId: peer.agentServiceBootId,
      authorityEpoch: peer.authorityEpoch,
      fencingToken: peer.fencingToken,
      maximumBodyBytes: 131072,
      maximumPayloadBytes: 4096,
      requestTimeoutMs: 10000,
    };
    const artifacts = repository.runPayloadArtifactPort(OWNER_ID, AGENT_ID, {
      product: SERVICE_AUTHORITY.product,
      lease: SERVICE_AUTHORITY.lease,
    });
    let counter = 0;
    const ids = { next: () => `live-payload:${++counter}` };
    const clock = { now: () => new Date().toISOString() };
    const configuration = {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      deploymentId: SERVICE_AUTHORITY.product.deploymentId,
      capabilityDeployment: host.capabilityDeployment,
    };
    const services = await createProductionSandboxServices({
      configuration,
      repository,
      protector: fixture.protector,
      authority: () => SERVICE_AUTHORITY,
      fileRead: {
        binding: async () => undefined,
        authorize: async () => {
          throw new Error("unused");
        },
        issue: async () => {
          throw new Error("unused");
        },
      },
      clock,
      ids,
    });
    if (!services) throw new Error("sandbox composition absent");
    const protectTrace = async (ref: string, value: unknown, operationKey: string) =>
      artifacts.commit({
        runId: RUN_ID,
        purpose: "trace",
        operationKey,
        payload: await fixture.protector.protect({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          ref,
          dataClassification: "private",
          contentType: "application/json",
          plaintext: new TextEncoder().encode(JSON.stringify(value)),
          createdAt: T1,
        }),
      });
    await artifacts.commit({
      runId: RUN_ID,
      purpose: "trace",
      operationKey: "live-scope",
      payload,
    });
    await protectTrace(
      "live-intent",
      {
        request: {
          messageId: plan.identity.invocationId,
          causationId: scope.parentRequestId,
          payload: { inputRef: plan.inputRef, capabilityHandleRef: plan.handleRef },
        },
      },
      `runtime-tool-intent:${createHash("sha256")
        .update(JSON.stringify([RUN_ID, plan.identity.toolCallId]))
        .digest("hex")}`,
    );
    await artifacts.commit({
      runId: RUN_ID,
      purpose: "trace",
      operationKey: "live-input",
      payload: await fixture.protector.protect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        ref: plan.inputRef,
        dataClassification: "private",
        contentType: "application/octet-stream",
        plaintext: new TextEncoder().encode("synthetic-input"),
        createdAt: T1,
      }),
    });
    const handler = new ProductionPayloadBrokerHandler({
      receipts: repository.capabilityInvocationReceiptPort(OWNER_ID, AGENT_ID),
      results: repository.capabilityInvocationResultPort(OWNER_ID, AGENT_ID),
      payloadsFor: (owner, agent) => repository.payloadStore(owner, agent),
      protector: fixture.protector,
      currentAuthority: () => SERVICE_AUTHORITY,
      clock,
      ids,
      agentServiceInstanceId: peer.agentServiceInstanceId,
      agentServiceBootId: peer.agentServiceBootId,
      maximumPayloadBytes: 4096,
      allowedContentTypes: ["application/json", "application/octet-stream"],
      sandboxJobs: services.broker,
    });
    const server = new PayloadUdsServer({
      ...common,
      runtimeDirectory: directory,
      allowedWorkerIdentities: [
        { workerInstanceId: peer.workerInstanceId, workerBootId: peer.workerBootId },
      ],
      handler,
    });
    cleanup.push(() => server.stop());
    const client = new ProductionPayloadBrokerClient({
      ...common,
      socketPath: server.socketPath,
      workerInstanceId: peer.workerInstanceId,
      workerBootId: peer.workerBootId,
      nextId: () => `live-rpc:${++counter}`,
    });
    cleanup.push(async () => client.disconnect());
    const worker = createProductionSandboxWorker({ configuration, peer, payloads: client, clock });
    cleanup.push(() => worker.shutdown());
    await server.start();
    await client.connect();
    const request = executionV2MessageSchema.parse({
      ...serviceRequest(),
      messageId: plan.identity.invocationId,
      causationId: scope.parentRequestId,
      payload: { ...serviceRequest().payload, sandboxJob: plan.identity },
    }) as Extract<ExecutionV2Request, { type: "work.execute" }>;
    const result = await worker.execute(request);
    assert.equal(result.outcome, "result_unknown");
    const record = await services.broker.journal.read(plan.identity);
    assert.equal(record?.observation.state, "quarantined");
    assert.ok((record?.observation.resources?.samples ?? 0) > 0);
    const output = await repository
      .payloadStore(OWNER_ID, AGENT_ID)
      .get(record?.observation.outputRef ?? "missing");
    if (!output) throw new Error("live output absent");
    const bytes = await fixture.protector.unprotect({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      payload: output,
    });
    assert.equal(new TextDecoder().decode(bytes), '{"probe":"passed"}');
    assert.equal(
      await readFile(path.join(host.privateRoot, plan.identity.jobId, "runs"), "utf8"),
      "run\n",
    );
    await worker.execute(request);
    assert.deepEqual(await services.broker.journal.read(plan.identity), record);
    const resumed = createProductionSandboxWorker({
      configuration,
      peer,
      payloads: client,
      clock,
    });
    try {
      await resumed.execute(request);
    } finally {
      await resumed.shutdown();
    }
    assert.equal(
      await readFile(path.join(host.privateRoot, plan.identity.jobId, "runs"), "utf8"),
      "run\n",
    );
    return {
      productionSandboxProbePassed: true,
      productionSuitable: false,
      networkDenial: "blocked-by-allowlist",
      cleanup: "unknown",
      replayExecuted: false,
    };
  } finally {
    await dispose();
  }
}
