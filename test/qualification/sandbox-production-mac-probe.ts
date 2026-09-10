import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { hostDirectoryGrantStateKey } from "@himawari-agent/application";
import {
  type ExecutionV2Request,
  executionV2MessageSchema,
  type SandboxExecutionPlanV2,
  sandboxExecutionPlanCandidateV2Schema,
  sandboxExecutionReservationSchema,
  sandboxScopeSchema,
} from "@himawari-agent/execution-contracts";
import { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { PayloadUdsServer, resolveSandboxWorkspaceClaim } from "@himawari-agent/platform-node";
import { ProductionPayloadBrokerHandler } from "../../apps/agent-service/src/production-payload-broker-handler.js";
import {
  AGENT_ID,
  LIVE_SANDBOX,
  OWNER_ID,
  openSandboxJournal,
  operationsForDatabase,
  RUN_ID,
  SERVICE_AUTHORITY,
  serviceRequest,
  T1,
} from "../fixtures/sqlite-capability-invocation-fixture.js";

export async function qualifyProductionSandbox(v2 = false, revokeNetwork = false) {
  if (revokeNetwork && (!v2 || process.platform !== "linux"))
    throw new Error("NETWORK_REVOCATION_REQUIRES_LINUX_V2");
  if (
    !LIVE_SANDBOX ||
    !["darwin", "linux"].includes(process.platform) ||
    (process.platform === "linux" && !v2)
  )
    throw new Error("SANDBOX_PROBE_OPT_IN_REQUIRED");
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
    const fixture = await openSandboxJournal(
      false,
      revokeNetwork ? ["registry.npmjs.org:443"] : [],
    );
    cleanup.push(() => fixture.close());
    const hostRoot = v2 ? await mkdtemp("/tmp/h-v2-") : fixture.resource.stateRoot;
    if (v2) cleanup.push(() => rm(hostRoot, { recursive: true, force: true }));
    const host = await macSandboxDeployment(
      hostRoot,
      fixture.plan,
      T1,
      v2,
      process.platform as "darwin" | "linux",
      revokeNetwork,
    );
    const scope = sandboxScopeSchema.parse({ ...fixture.scope, parentToolCallId: null });
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
    let v2Plan: SandboxExecutionPlanV2 | undefined;
    if (v2) {
      const { sandboxV2Admission } = await import("../fixtures/sandbox-execution-v2-fixture.js");
      const input = sandboxV2Admission(fixture);
      const { semanticFingerprint: _fingerprint, ...candidate } = plan;
      const next = sandboxExecutionPlanCandidateV2Schema.parse({
        ...candidate,
        schemaVersion: "sandbox-execution.v2",
        mode: "foreground",
        environmentId: "live-environment",
        backendRef: "srt",
        operationContract: { ref: "fixed-read", version: "1", kind: "fixed_read" },
      });
      const workspace = await resolveSandboxWorkspaceClaim({ binding: host.binding, scope });
      const reservation = sandboxExecutionReservationSchema.parse({
        schemaVersion: "sandbox-preparation.v1",
        identity: next.identity,
        environmentId: next.environmentId,
        resourceRef: null,
        mode: next.mode,
        workspaceConflictRefs: [workspace.ref],
        sequence: 1,
        createdAt: T1,
      });
      const saved = operationsForDatabase(fixture.database).execute(
        "capabilityInvocation.sandboxV2.reserve",
        {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: { invocation: input.invocation, plan: next, reservation, workspaces: [workspace] },
        },
      ) as { admission: { plan: SandboxExecutionPlanV2 } };
      v2Plan = saved.admission.plan;
    } else
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
      modelDescriptors: [],
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
      ...(v2
        ? {
            workerSupport: () => [
              { schemaVersion: "sandbox-execution.v2" as const, mode: "foreground" as const },
            ],
          }
        : {}),
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
      sandboxExecutions: services.brokerV2,
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
    const { ProductionSandboxExecutionV2 } = await import(
      "../../apps/execution-worker/src/production-sandbox-execution-v2.js"
    );
    const makeWorker = () =>
      v2
        ? new ProductionSandboxExecutionV2({ configuration, peer, payloads: client, clock })
        : createProductionSandboxWorker({ configuration, peer, payloads: client, clock });
    const worker = makeWorker();
    cleanup.push(() => worker.shutdown());
    await server.start();
    await client.connect();
    const request = executionV2MessageSchema.parse({
      ...serviceRequest(),
      messageId: plan.identity.invocationId,
      causationId: scope.parentRequestId,
      payload: {
        ...serviceRequest().payload,
        ...(v2Plan
          ? {
              sandboxExecution: {
                schemaVersion: "sandbox-execution.v2",
                mode: v2Plan.mode,
                environmentId: v2Plan.environmentId,
                identity: v2Plan.identity,
              },
            }
          : { sandboxJob: plan.identity }),
      },
    }) as Extract<ExecutionV2Request, { type: "work.execute" }>;
    let revocationStarted: number | undefined;
    const executing = worker.execute(request);
    if (revokeNetwork) {
      const marker = path.join(host.privateRoot, plan.identity.jobId, "network-established");
      const deadline = Date.now() + 15000;
      while (!(await readFile(marker, "utf8").catch(() => ""))) {
        if (Date.now() >= deadline) throw new Error("NETWORK_CONNECTION_NOT_ESTABLISHED");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const authorizations = repository.authorizationStore();
      const grant = (await authorizations.listGrants(OWNER_ID, AGENT_ID)).find(
        (value) => value.id === scope.authorizationRef,
      );
      assert.ok(grant);
      revocationStarted = performance.now();
      await authorizations.revokeGrant(
        grant.id,
        new Date().toISOString(),
        "LIVE_NETWORK_REVOCATION",
        grant.revision,
      );
    }
    const result = await executing;
    const revokeToReleasedMs =
      revocationStarted === undefined ? null : Math.ceil(performance.now() - revocationStarted);
    assert.equal(result.outcome, "result_unknown");
    const record = v2
      ? await services.brokerV2.journal.read(plan.identity)
      : await services.broker.journal.read(plan.identity);
    const observation = record && "facts" in record ? record.facts.resource : record?.observation;
    assert.ok(observation);
    if ("supervision" in observation) {
      assert.equal(observation.supervision, process.platform === "linux" ? "released" : "lost");
      assert.equal(observation.cleanup, process.platform === "linux" ? "confirmed" : "unknown");
    } else
      assert.equal(observation.state, process.platform === "linux" ? "released" : "quarantined");
    if (revokeToReleasedMs !== null)
      assert.ok(revokeToReleasedMs < 8000, "NETWORK_REVOCATION_TOO_SLOW");
    if (!revokeNetwork) {
      const outputRef =
        record && "facts" in record && record.facts.result && "output" in record.facts.result
          ? record.facts.result.output.ref
          : record && "observation" in record
            ? record.observation.outputRef
            : null;
      const output = await repository.payloadStore(OWNER_ID, AGENT_ID).get(outputRef ?? "missing");
      if (!output) throw new Error("live output absent");
      const bytes = await fixture.protector.unprotect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        payload: output,
      });
      assert.equal(new TextDecoder().decode(bytes), '{"probe":"passed"}');
    }
    assert.equal(
      await readFile(path.join(host.privateRoot, plan.identity.jobId, "runs"), "utf8"),
      "run\n",
    );
    await worker.execute(request);
    assert.deepEqual(
      v2
        ? await services.brokerV2.journal.read(plan.identity)
        : await services.broker.journal.read(plan.identity),
      record,
    );
    const resumed = makeWorker();
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
      schema: v2 ? "sandbox-execution.v2" : "sandbox-execution.v1",
      productionSuitable: false,
      networkDenial: revokeNetwork ? null : "blocked-by-allowlist",
      networkRevocation: revokeNetwork
        ? {
            connectionEstablished: true,
            grantRevoked: true,
            revokeToReleasedMs,
            jobHostExited: true,
            taskNamespaceReleased: true,
          }
        : null,
      platform: process.platform,
      cleanup: process.platform === "linux" ? "confirmed" : "unknown",
      replayExecuted: false,
    };
  } finally {
    await dispose();
  }
}
