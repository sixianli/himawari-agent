import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  hostDirectoryGrantStateKey,
  type SandboxExecutionPreparationPort,
  ThreadExecutionProjection,
} from "@himawari-agent/application";
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
import { readThreadExecutionResources } from "../../packages/application/src/services/thread-execution-resources.js";
import { revokeFixtureDirectoryGrant } from "../fixtures/revoke-directory-grant.ts";
import { sandboxV2Admission } from "../fixtures/sandbox-execution-v2-fixture.js";
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

export async function qualifyProductionSandbox(
  v2 = false,
  revokeNetwork = false,
  revokeDirectory = false,
  browser?: {
    running: (readState: () => ReturnType<ThreadExecutionProjection["readState"]>) => Promise<void>;
    stopped: () => Promise<void>;
  },
) {
  const withdraw = revokeNetwork || revokeDirectory;
  if (withdraw && (!v2 || (revokeNetwork && revokeDirectory)))
    throw new Error("REVOCATION_REQUIRES_V2_AND_ONE_AUTHORITY");
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
    const fixture = await openSandboxJournal(false, withdraw ? ["registry.npmjs.org:443"] : []);
    cleanup.push(() => fixture.close());
    // Gateway Run summaries start at revision 1. This controlled fixture creates
    // the initial Run directly; do not relax the browser's revision validation.
    if (browser) fixture.database.prepare("UPDATE runs SET revision=1 WHERE id=?").run(RUN_ID);
    const hostRoot = v2 ? await mkdtemp("/tmp/h-v2-") : fixture.resource.stateRoot;
    if (v2) cleanup.push(() => rm(hostRoot, { recursive: true, force: true }));
    const host = await macSandboxDeployment(
      hostRoot,
      fixture.plan,
      T1,
      v2,
      process.platform as "darwin" | "linux",
      withdraw,
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
    let competingReservation: Parameters<SandboxExecutionPreparationPort["reserve"]>[0] | undefined;
    if (v2) {
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
      const competitor = sandboxV2Admission(fixture, "-competing");
      const competingPlan = sandboxExecutionPlanCandidateV2Schema.parse({
        ...next,
        identity: competitor.plan.identity,
        environmentId: competitor.plan.environmentId,
      });
      competingReservation = {
        invocation: competitor.invocation,
        plan: competingPlan,
        reservation: sandboxExecutionReservationSchema.parse({
          ...reservation,
          identity: competingPlan.identity,
          environmentId: competingPlan.environmentId,
        }),
        workspaces: [{ ...workspace, access: "write" }],
      };
    } else
      fixture.call("Prepare", { plan, observation: { ...fixture.prepared, policyDigest: null } });
    fixture.database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot: fixture.resource.stateRoot,
      minimumFreeBytes: 0,
      now: () => new Date().toISOString(),
    });
    cleanup.push(() => repository.close());
    const preparations = repository.sandboxExecutionPreparations(OWNER_ID, AGENT_ID);
    const occupied = (error: unknown) =>
      error instanceof Error &&
      /Workspace (has a pending preparation|remains occupied)/.test(error.message);
    if (competingReservation)
      await assert.rejects(preparations.reserve(competingReservation), occupied);
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
    if (browser) {
      const call = client.sandboxExecution.bind(client);
      client.sandboxExecution = async (...args) => {
        try {
          const reply = await call(...args);
          if (args[2].kind === "observe_control" && reply.record.phase === "bound")
            console.error(
              JSON.stringify({ event: "probe.control", resource: reply.record.facts.resource }),
            );
          return reply;
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "probe.broker_error",
              command: args[2].kind,
              error: String(error),
            }),
          );
          throw error;
        }
      };
    }
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
    let originalApproval: unknown;
    let originalUses: number | undefined;
    let originalOutput: string | undefined;
    let originalRunsIdentity: { ino: number; mtimeMs: number; ctimeMs: number } | undefined;
    const executing = worker.execute(request);
    if (withdraw) {
      const marker = path.join(host.privateRoot, plan.identity.jobId, "network-established");
      const deadline = Date.now() + 15000;
      while (!(await readFile(marker, "utf8").catch(() => ""))) {
        if (Date.now() >= deadline) throw new Error("NETWORK_CONNECTION_NOT_ESTABLISHED");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (browser) {
        const projection = new ThreadExecutionProjection({
          threads: repository.threadRepository(),
          trace: repository.traceStore(),
          payloads: () => repository.payloadStore(OWNER_ID, AGENT_ID),
          protector: fixture.protector,
          resources: {
            readInventory: ({ runId }) => preparations.readRunInventory({ runId }),
            now: clock.now,
            digest: (bytes) => createHash("sha256").update(bytes).digest("hex"),
          },
        });
        await browser.running(() =>
          projection.readState({
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            threadId: plan.identity.threadId ?? "",
            runId: RUN_ID,
            canCancelRun: true,
          }),
        );
      }
      const authorizations = repository.authorizationStore();
      const grant = (await authorizations.listGrants(OWNER_ID, AGENT_ID)).find(
        (value) => value.id === scope.authorizationRef,
      );
      assert.ok(grant);
      originalApproval = await authorizations.getApproval(grant.sourceApprovalRequestId);
      originalUses = grant.uses;
      originalOutput = await readFile(
        path.join(host.privateRoot, plan.identity.jobId, "runs"),
        "utf8",
      );
      const before = await stat(path.join(host.privateRoot, plan.identity.jobId, "runs"));
      originalRunsIdentity = { ino: before.ino, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs };
      revocationStarted = performance.now();
      if (revokeDirectory) {
        const revokedAt = clock.now();
        const saved = await revokeFixtureDirectoryGrant(
          repository,
          scope.directoryGrant.ref,
          revokedAt,
        );
        assert.equal(saved?.value["revokedAt"], revokedAt);
        assert.equal(
          (await authorizations.listGrants(OWNER_ID, AGENT_ID)).find(
            (value) => value.id === grant.id,
          )?.revokedAt,
          null,
        );
      } else
        await authorizations.revokeGrant(
          grant.id,
          new Date().toISOString(),
          "LIVE_NETWORK_REVOCATION",
          grant.revision,
        );
    }
    const result = await executing;
    const revokeToObservedStopMs =
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
    if (revokeToObservedStopMs !== null)
      assert.ok(revokeToObservedStopMs < 8000, "AUTHORITY_REVOCATION_TOO_SLOW");
    // Read through the same durable inventory/projection used by status queries;
    // no event or successful task result is synthesized by this probe.
    const projected = v2
      ? await readThreadExecutionResources({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          threadId: plan.identity.threadId ?? "",
          runId: RUN_ID,
          inventory: await preparations.readRunInventory({ runId: RUN_ID }),
          now: clock.now(),
          payloads: repository.payloadStore(OWNER_ID, AGENT_ID),
          protector: fixture.protector,
          digest: (bytes) => createHash("sha256").update(bytes).digest("hex"),
          itemId: (toolCallId) => `probe:${toolCallId}`,
        })
      : null;
    if (projected) {
      assert.equal(projected.allReleased, process.platform === "linux");
      assert.equal(projected.pendingResources, process.platform !== "linux");
    }
    if (withdraw) {
      assert.ok(v2Plan);
      // Use the same live scope check as Worker disclosure/network admission.
      await assert.rejects(services.brokerV2.resolveScope(v2Plan));
      const grant = (await repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID)).find(
        (value) => value.id === scope.authorizationRef,
      );
      assert.ok(grant);
      assert.equal(grant.uses, originalUses);
      assert.deepEqual(
        await repository.authorizationStore().getApproval(grant.sourceApprovalRequestId),
        originalApproval,
      );
    }
    await browser?.stopped();
    if (competingReservation) {
      assert.ok(record && "facts" in record);
      assert.equal(Boolean(record.releaseReceipt), process.platform === "linux");
      assert.equal(record.workspaceBlocked, process.platform !== "linux");
      // A competitor using the original revoked Grant cannot test release:
      // current authority rejects it before workspace admission is reached.
      if (!withdraw && process.platform === "linux") {
        await preparations.reserve(competingReservation);
        const admitted = await preparations.readAdmission(competingReservation.plan.identity);
        assert.ok(admitted?.phase === "reserved");
        assert.equal(admitted.plan.identity.jobId, competingReservation.plan.identity.jobId);
      } else if (!withdraw)
        await assert.rejects(preparations.reserve(competingReservation), occupied);
    }
    {
      const resultOutputRef =
        record && "facts" in record && record.facts.result && "output" in record.facts.result
          ? record.facts.result.output.ref
          : record && "observation" in record
            ? record.observation.outputRef
            : null;
      // Unknown completion intentionally has no successful-result output field.
      // The frozen invocation receipt retains bytes observed before stopping.
      const retained = await repository
        .capabilityInvocationResultPort(OWNER_ID, AGENT_ID)
        .lookupOutput({
          handleRef: plan.handleRef,
          invocationId: plan.identity.invocationId,
          authority: SERVICE_AUTHORITY,
          now: clock.now(),
        });
      assert.ok(retained, "original invocation output receipt missing");
      if (resultOutputRef !== null) assert.equal(retained.payloadRef, resultOutputRef);
      const output = await repository.payloadStore(OWNER_ID, AGENT_ID).get(retained.payloadRef);
      if (!output) throw new Error("live output absent");
      const bytes = await fixture.protector.unprotect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        payload: output,
      });
      assert.equal(
        new TextDecoder().decode(bytes),
        withdraw ? '{"probe":"network-established"}' : '{"probe":"passed"}',
      );
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
    if (withdraw) {
      const preservedPath = path.join(host.privateRoot, plan.identity.jobId, "runs");
      assert.equal(await readFile(preservedPath, "utf8"), originalOutput);
      const after = await stat(preservedPath);
      assert.deepEqual(
        { ino: after.ino, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs },
        originalRunsIdentity,
      );
      const grant = (await repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID)).find(
        (value) => value.id === scope.authorizationRef,
      );
      assert.equal(grant?.uses, originalUses);
    }
    return {
      productionSandboxProbePassed: true,
      schema: v2 ? "sandbox-execution.v2" : "sandbox-execution.v1",
      productionSuitable: false,
      networkDenial: withdraw ? null : "blocked-by-allowlist",
      networkRevocation: withdraw
        ? {
            connectionEstablished: true,
            authorityRevoked: revokeDirectory ? "directory" : "action_grant",
            grantRevoked: revokeNetwork,
            revokeToObservedStopMs,
            jobHostExited: true,
            currentScopeRejected: true,
            approvalHistoryPreserved: true,
            quotaUsesUnchanged: true,
            preRevocationFileBytesAndIdentityPreserved: true,
            fileEvidenceBoundary:
              "private execution marker; user-file publication is independently covered by the existing queued Worker probe",
            taskNamespaceReleased: process.platform === "linux",
          }
        : null,
      platform: process.platform,
      resourceProjection: projected,
      cleanup: process.platform === "linux" ? "confirmed" : "unknown",
      replayExecuted: false,
      workspaceProtection: v2
        ? {
            blockedBeforeExecution: true,
            admittedAfterExecution: withdraw ? null : process.platform === "linux",
            occupiedAfterExecution: record && "facts" in record ? record.workspaceBlocked : null,
          }
        : null,
    };
  } finally {
    await dispose();
  }
}
