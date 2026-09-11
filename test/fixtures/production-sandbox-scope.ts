import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  actionIntentFingerprint,
  type ConsumeCapabilityInvocationInput,
  type GovernedActionIntent,
  hostDirectoryGrantStateKey,
  type ProductConfiguration,
  type RuntimeToolInvocation,
} from "@himawari-agent/application";
import { createThreadId } from "@himawari-agent/domain";
import type {
  SandboxExecutionSupport,
  SandboxOperationBinding,
} from "@himawari-agent/execution-contracts";
import { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { PayloadUdsClient, PayloadUdsServer } from "@himawari-agent/platform-node";
import { configuredModelDisclosureIdentity } from "../../apps/agent-service/src/production-model-disclosure.ts";
import { ProductionPayloadBrokerHandler } from "../../apps/agent-service/src/production-payload-broker-handler.ts";
import { createProductionSandboxServices } from "../../apps/agent-service/src/production-sandbox-services.ts";
import { macSandboxDeployment } from "./mac-sandbox-deployment.ts";
import {
  AGENT_ID,
  capability,
  grant,
  grantApproval,
  grantHandle,
  invocation,
  OWNER_ID,
  openSandboxJournal,
  RUN_ID,
  SERVICE_AUTHORITY,
  T0,
  T1,
  T2,
} from "./sqlite-capability-invocation-fixture.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Real SQLite authorities, encrypted artifacts and installed-file checks;
 * qualification is a controlled fixture, never a production certificate. */
export async function productionSandboxScope(
  descriptor: SandboxOperationBinding,
  changeIntent: (intent: GovernedActionIntent) => GovernedActionIntent = (value) => value,
) {
  const f = await openSandboxJournal();
  const h = {
    ...grantHandle(),
    operation: descriptor.operation,
    operations: [descriptor.operation],
  };
  const c = capability();
  f.database.prepare("UPDATE capability_declarations SET record_json=? WHERE id=?").run(
    JSON.stringify({
      ...c,
      declaration: { ...c.declaration, operations: [descriptor.operation] },
    }),
    c.ref,
  );
  f.database
    .prepare("UPDATE capability_handles SET id=?, authorization_ref=?, record_json=? WHERE id=?")
    .run(h.ref, h.authorizationRef, JSON.stringify(h), f.plan.handleRef);
  const host = await macSandboxDeployment(
    f.resource.stateRoot,
    { ...f.plan, operation: descriptor.operation },
    T1,
    true,
    process.platform === "darwin" ? "darwin" : "linux",
  );
  const snapshot = JSON.parse(await readFile(host.capabilityDeployment.snapshotPath, "utf8"));
  const entry = snapshot.capabilities[0];
  entry.binding.value.operationBindings = [descriptor];
  entry.binding.value.allowedDomains = ["example.com:443"];
  const support: SandboxExecutionSupport = [
    { schemaVersion: "sandbox-execution.v2", mode: descriptor.mode },
  ];
  entry.binding.value.supportedExecutions = support;
  entry.qualification.sandbox.supportedExecutions = support;
  const snapshotBytes = JSON.stringify(snapshot);
  await writeFile(host.capabilityDeployment.snapshotPath, snapshotBytes);
  const directory = {
    ...f.directoryGrant,
    operations: ["read", "create", "update"] as const,
    displayPath: host.workspace,
  };
  f.database
    .prepare(
      "INSERT INTO product_state_records (key,owner_id,agent_id,revision,value_json,updated_at) VALUES (?,?,?,1,?,?)",
    )
    .run(
      hostDirectoryGrantStateKey(directory.id),
      OWNER_ID,
      AGENT_ID,
      JSON.stringify(directory),
      T1,
    );
  f.database.close();
  const repository = await SqliteProductStateRepository.open({
    stateRoot: f.resource.stateRoot,
    minimumFreeBytes: 0,
    now: () => T1,
  });
  const model: ProductConfiguration["modelDescriptors"][number] = {
    ref: "model-fixture",
    role: "primary",
    provider: "deterministic",
    model: "fixture",
    version: "1",
    allowedDataClassifications: ["private"],
    disclosure: "local_only",
    secretRef: null,
    capabilities: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    priority: 1,
    name: "Fixture",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    contextWindow: 8192,
    maxTokens: 1024,
  };
  const approval = grantApproval();
  const intent: GovernedActionIntent = changeIntent({
    ...approval.intentSnapshot,
    contractVersion: "authorization.v2",
    capabilityVersion: h.capabilityVersion,
    threadId: f.plan.identity.threadId ?? "",
    actionKind: "READ",
    operation: descriptor.operation,
    targets: [
      { type: "directory-grant", ref: directory.id },
      { type: "host", ref: host.binding.hostId },
      ...(descriptor.network === "grant_targets"
        ? [{ type: "network-domain", ref: "example.com:443" }]
        : []),
    ],
    resourceRefs: [directory.id],
    disclosure: "named_recipients",
    recipients: [configuredModelDisclosureIdentity(model)],
    credentialOrAccessChange: false,
    expiresAt: T2,
    modelClassification: { actionKind: "READ", suggestedRisk: "LOW", reasonCode: "fixture" },
    deterministicFacts: [],
    finalRisk: "LOW",
  });
  const fingerprint = actionIntentFingerprint(intent);
  const authorization = repository.authorizationStore();
  await authorization.createApproval({
    ...approval,
    intentSnapshot: intent,
    semanticSnapshotHash: fingerprint,
  });
  const g = grant();
  await authorization.resolveApproval({
    approvalRequestId: approval.id,
    expectedRevision: 1,
    semanticSnapshotHash: fingerprint,
    resolution: "approved",
    decidedAt: T0,
    grant: {
      ...g,
      uses: 1,
      intentFingerprint: fingerprint,
      scope: { ...g.scope, operations: [descriptor.operation] },
    },
  });
  const call: RuntimeToolInvocation = {
    runId: RUN_ID,
    toolCallId: `tool-${descriptor.operation}`,
    capabilityRef: h.capabilityRef,
    capabilityHandleRef: h.ref,
    arguments: { inputRef: h.inputRefs[0] ?? "" },
    dataClassification: "private",
    executionDeadlineAt: T2,
    context: {
      threadId: createThreadId(f.plan.identity.threadId ?? ""),
      modelRef: model.ref,
      executionLease: f.plan.executionLease as NonNullable<
        RuntimeToolInvocation["context"]
      >["executionLease"],
    },
  };
  const invocationId = `runtime-tool:${hash([call.runId, call.toolCallId])}`;
  const input = invocation({
    handleRef: h.ref,
    invocationId,
    idempotencyKey: invocationId,
    operation: descriptor.operation,
    authorizationRef: h.authorizationRef,
    requestedAt: T1,
  }) as unknown as ConsumeCapabilityInvocationInput;
  let counter = 0;
  let now = T1;
  let workerSupport = support;
  const artifacts = () => repository.runPayloadArtifactPort(OWNER_ID, AGENT_ID, SERVICE_AUTHORITY);
  const persist = async (operationKey: string, value: unknown) =>
    artifacts().commit({
      runId: RUN_ID,
      purpose: "trace",
      operationKey,
      payload: await f.protector.protect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        ref: `scope-test:${++counter}`,
        dataClassification: "private",
        contentType: "application/json",
        plaintext: Buffer.from(JSON.stringify(value)),
        createdAt: T1,
      }),
    });
  await persist(`runtime-tool-intent:${hash([call.runId, call.toolCallId])}`, {
    request: {
      messageId: invocationId,
      causationId: RUN_ID,
      payload: { inputRef: input.inputRef, capabilityHandleRef: h.ref },
    },
  });
  const services = await createProductionSandboxServices({
    configuration: {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      capabilityDeployment: {
        ...host.capabilityDeployment,
        sha256: `sha256:${createHash("sha256").update(snapshotBytes).digest("hex")}`,
      },
      modelDescriptors: [model],
    },
    repository,
    protector: f.protector,
    authority: () => SERVICE_AUTHORITY,
    fileRead: {
      binding: async () => undefined,
      authorize: async () => {
        throw new Error("not a file workflow");
      },
      issue: async () => {
        throw new Error("unused");
      },
    },
    clock: { now: () => now },
    ids: { next: () => `scope-id:${++counter}` },
    workerSupport: () => workerSupport,
  });
  if (!services) throw new Error("composition absent");
  const connections: Array<() => Promise<void>> = [];
  let afterResolve = async () => {};
  const connect = async (
    identity: import("@himawari-agent/execution-contracts").SandboxJobIdentity,
  ) => {
    const directory = await mkdtemp("/tmp/r3-s-");
    const shared = {
      credential: { tokenRef: "scope-test", tokenValue: "0123456789abcdef0123456789abcdef" },
      agentServiceInstanceId: SERVICE_AUTHORITY.agentServiceInstanceId,
      agentServiceBootId: SERVICE_AUTHORITY.agentServiceBootId,
      workerInstanceId: SERVICE_AUTHORITY.workerInstanceId,
      workerBootId: SERVICE_AUTHORITY.workerBootId,
      authorityEpoch: 1,
      fencingToken: 1,
      maximumBodyBytes: 131072,
      maximumPayloadBytes: 4096,
      requestTimeoutMs: 3000,
    };
    const handler = new ProductionPayloadBrokerHandler({
      receipts: repository.capabilityInvocationReceiptPort(OWNER_ID, AGENT_ID),
      results: repository.capabilityInvocationResultPort(OWNER_ID, AGENT_ID),
      payloadsFor: (owner, agent) => repository.payloadStore(owner, agent),
      protector: f.protector,
      currentAuthority: () => SERVICE_AUTHORITY,
      clock: { now: () => now },
      ids: { next: () => `rpc:${++counter}` },
      agentServiceInstanceId: shared.agentServiceInstanceId,
      agentServiceBootId: shared.agentServiceBootId,
      maximumPayloadBytes: 4096,
      allowedContentTypes: ["application/json"],
      sandboxExecutions: {
        ...services.brokerV2,
        resolveScope: async (plan) => {
          const result = await services.brokerV2.resolveScope(plan);
          await afterResolve();
          return result;
        },
      },
    });
    const server = new PayloadUdsServer({
      ...shared,
      runtimeDirectory: directory,
      allowedWorkerIdentities: [
        { workerInstanceId: shared.workerInstanceId, workerBootId: shared.workerBootId },
      ],
      handler,
    });
    await server.start();
    const client = new PayloadUdsClient({
      ...shared,
      socketPath: server.socketPath,
      nextId: () => `rpc:${++counter}`,
    });
    await client.connect();
    connections.push(async () => {
      await client.disconnect();
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    });
    return (command: import("@himawari-agent/execution-contracts").SandboxExecutionBrokerCommand) =>
      client.sandboxExecution(
        {
          handleRef: h.ref,
          invocationId: input.invocationId,
          workerInstanceId: shared.workerInstanceId,
          workerBootId: shared.workerBootId,
          authorityEpoch: 1,
          fencingToken: 1,
        },
        identity,
        command,
      );
  };
  return {
    connect,
    setAfterResolve: (hook: () => Promise<void>) => {
      afterResolve = hook;
    },
    f,
    repository,
    services,
    input,
    call,
    intent,
    host,
    artifacts,
    persist,
    setNow: (value: string) => {
      now = value;
    },
    setSupport: (value: SandboxExecutionSupport) => {
      workerSupport = value;
    },
    close: async () => {
      for (const close of connections.reverse()) await close();
      await repository.close();
      await f.close();
    },
  };
}
