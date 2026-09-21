import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import {
  actionIntentFingerprint,
  type CapabilityInvocationAuthority,
  type ConsumeCapabilityInvocationInput,
  type GovernedActionIntent,
  type HostFileOperationKind,
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
import {
  ConstrainedHostFileSystem,
  WorkspaceCopyStore,
  digestSandboxRuntime,
  PayloadUdsClient,
  PayloadUdsServer,
} from "@himawari-agent/platform-node";
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
  options: {
    readonly workspaceCopy?: boolean;
    readonly resourceCeiling?: ConsumeCapabilityInvocationInput["resourceCeiling"];
    readonly legacyFileRead?: boolean;
    readonly piParameters?: Readonly<Record<string, unknown>>;
    readonly realFileIdentity?: boolean;
    readonly directoryOperations?: readonly HostFileOperationKind[];
    readonly fixedFileCompletionQualification?: boolean;
    readonly piRuntimeRoot?: string;
    readonly liveHostParent?: string;
    readonly authority?: () => CapabilityInvocationAuthority;
    readonly seedRuntimeIntent?: boolean;
    readonly realRun?: boolean;
    readonly reserveAuthorization?: boolean;
    readonly policyAuthorization?: { readonly key: string; readonly revision: number };
    readonly runtimeFingerprint?: (call: RuntimeToolInvocation) => string;
  } = {},
) {
  const f = await openSandboxJournal(
    false,
    [],
    options.realRun || options.seedRuntimeIntent === false,
  );
  const h = {
    ...grantHandle(),
    ...(options.piParameters ? { inputRefs: ["payload-pi-parameters"] } : {}),
    operation: descriptor.operation,
    operations: [descriptor.operation],
    ...(options.reserveAuthorization ? { maxUses: 1, maxTotalCostMicros: 0 } : {}),
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
  // Real JobHost control sockets must fit the platform's Unix socket path limit.
  const liveHostRoot = options.piRuntimeRoot
    ? await mkdtemp(options.liveHostParent ? `${options.liveHostParent}/h-` : "/tmp/h-qh-")
    : undefined;
  const host = await macSandboxDeployment(
    liveHostRoot ?? f.resource.stateRoot,
    {
      ...f.plan,
      operation: descriptor.operation,
      ...(options.resourceCeiling ? { resourceCeiling: options.resourceCeiling } : {}),
    },
    T1,
    true,
    process.platform === "darwin" ? "darwin" : "linux",
  );
  const snapshot = JSON.parse(await readFile(host.capabilityDeployment.snapshotPath, "utf8"));
  const entry = snapshot.capabilities[0];
  if (options.legacyFileRead) delete entry.binding.value.operationBindings;
  else entry.binding.value.operationBindings = [descriptor];
  entry.binding.value.allowedDomains = ["example.com:443"];
  const support: SandboxExecutionSupport = [
    {
      schemaVersion: options.legacyFileRead ? "sandbox-execution.v1" : "sandbox-execution.v2",
      mode: descriptor.mode,
    },
  ];
  entry.binding.value.supportedExecutions = support;
  entry.qualification.sandbox.supportedExecutions = support;
  if (options.piRuntimeRoot) {
    const runtimeRoot = await realpath(options.piRuntimeRoot);
    const executable = await realpath(process.execPath);
    const runner = `${runtimeRoot}/node_modules/@himawari-agent/agent-service/dist/capability-programs/pi-coding-main.js`;
    const fileHash = async (p: string) =>
      createHash("sha256")
        .update(await readFile(p))
        .digest("hex");
    const runnerDigest = await fileHash(runner);
    const runtimeDigest = await digestSandboxRuntime(runtimeRoot);
    Object.assign(entry.binding.value, {
      runtimeRoot,
      runtimeDigest,
      profileRef: "authorized-project.v1",
      executable: { path: executable, sha256: await fileHash(executable) },
      runner: { path: runner, sha256: runnerDigest },
      artifactDigest: `sha256:${runnerDigest}`,
      readOnlyToolchainPaths: [...entry.binding.value.readOnlyToolchainPaths, executable],
    });
    Object.assign(entry.qualification.sandbox, {
      runtimeDigest,
      runnerDigest,
      profileRef: "authorized-project.v1",
    });
    if (options.fixedFileCompletionQualification)
      entry.qualification.sandbox.guarantees.push("fixed-file-terminal-no-writer.v1");
    entry.qualification.artifactDigest = `sha256:${runnerDigest}`;
    entry.manifest.integrity = `sha256:${runnerDigest}`;
    entry.manifest.artifact.digest = `sha256:${runnerDigest}`;
    entry.manifest.runtime.argv = [executable, runner];
  }
  const actualRoot = entry.binding.value.roots[0];
  if (options.realFileIdentity)
    actualRoot.canonicalRootId = `${actualRoot.device}:${actualRoot.inode}`;
  if (descriptor.scopeSource === "private_temp") entry.binding.value.roots = [];
  if (options.seedRuntimeIntent === false)
    f.database
      .prepare("UPDATE capability_declarations SET record_json=? WHERE id=?")
      .run(JSON.stringify({ ...c, declaration: entry.manifest }), c.ref);
  const snapshotBytes = JSON.stringify(snapshot);
  await writeFile(host.capabilityDeployment.snapshotPath, snapshotBytes);
  const directory = {
    ...f.directoryGrant,
    ...(options.seedRuntimeIntent === false ? { disclosure: "model" as const } : {}),
    operations: options.directoryOperations ?? (["read", "create", "update"] as const),
    displayPath: host.workspace,
    ...(options.realFileIdentity ? { canonicalRootId: actualRoot.canonicalRootId } : {}),
  };
  if (descriptor.scopeSource !== "private_temp")
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
  if (options.policyAuthorization)
    f.database
      .prepare(
        "INSERT INTO product_state_records (key,owner_id,agent_id,revision,value_json,updated_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        options.policyAuthorization.key,
        OWNER_ID,
        AGENT_ID,
        options.policyAuthorization.revision,
        JSON.stringify({ enabled: true }),
        T1,
      );
  if (options.reserveAuthorization)
    f.database.prepare("DELETE FROM capability_handles WHERE id=?").run(h.ref);
  f.database.close();
  let repository = await SqliteProductStateRepository.open({
    stateRoot: f.resource.stateRoot,
    minimumFreeBytes: 0,
    now: () => T1,
  });
  let workspaceCopy: Awaited<ReturnType<WorkspaceCopyStore["describeCopy"]>> | undefined;
  if (options.workspaceCopy) {
    await writeFile(`${directory.displayPath}/copy-input.txt`, "current dirty input");
    const platform = new ConstrainedHostFileSystem();
    const identity = await platform.inspect(directory, "copy-input.txt");
    if (!identity) throw new Error("copy input missing");
    const bytes = await platform.read(directory, "copy-input.txt", 4096, identity);
    const copies = new WorkspaceCopyStore({
      candidateRoot: `${entry.binding.value.privateRoot}/workspace-copies`,
      protectPayload: async () => {
        throw new Error("diff protection unused in scope fixture");
      },
    });
    const ref = await copies.createFromSnapshot({
      candidateId: "copy-fixture",
      baseline: {
        grantId: directory.id,
        grantRevision: directory.revision,
        canonicalRootId: directory.canonicalRootId,
        files: [
          {
            path: "copy-input.txt",
            identity,
            digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          },
        ],
      },
      files: [{ path: "copy-input.txt", bytes }],
      allowedPaths: ["copy-input.txt"],
      spaceBudgetBytes: 4096,
    });
    workspaceCopy = await copies.describeCopy(ref);
  }
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
      ...(workspaceCopy
        ? [{ type: "workspace-copy", ref: workspaceCopy.root.canonicalRootId }]
        : []),
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
    ...(options.policyAuthorization ? { policyAuthorization: options.policyAuthorization } : {}),
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
      uses: options.reserveAuthorization ? 0 : 1,
      intentFingerprint: fingerprint,
      scope: {
        ...g.scope,
        operations: [descriptor.operation],
        ...(options.reserveAuthorization
          ? {
              exactResourceRef: intent.resourceRef,
              capabilityVersion: h.capabilityVersion,
              resourceIdentities: intent.resourceRefs,
              disclosure: intent.disclosure,
              recipients: intent.recipients,
              credentialOrAccessChange: false as const,
            }
          : {}),
      },
    },
  });
  if (options.reserveAuthorization) {
    if (!authorization.reserveAuthorization) throw new Error("Reservation port missing");
    const reserved = await authorization.reserveAuthorization({ grantId: g.id, intent, now: T1 });
    await repository.capabilityStore(OWNER_ID, AGENT_ID).createExecutionHandle(h, {
      authorizationReservationId: reserved.id,
    });
  }
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
    ...(options.resourceCeiling ? { resourceCeiling: options.resourceCeiling } : {}),
    handleRef: h.ref,
    inputRef: h.inputRefs[0],
    invocationId,
    idempotencyKey: invocationId,
    operation: descriptor.operation,
    authorizationRef: h.authorizationRef,
    requestedAt: T1,
  }) as unknown as ConsumeCapabilityInvocationInput;
  let counter = 0;
  let now = T1;
  // A real JobHost timestamps its own observations; a frozen fixture clock
  // would incorrectly reject every later observation as coming from the future.
  const clock = { now: () => (options.piRuntimeRoot ? new Date().toISOString() : now) };
  let workerSupport = support;
  const artifacts = () =>
    repository.runPayloadArtifactPort(
      OWNER_ID,
      AGENT_ID,
      options.authority?.() ?? SERVICE_AUTHORITY,
    );
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
  if (options.seedRuntimeIntent !== false)
    await persist(`runtime-tool-intent:${hash([call.runId, call.toolCallId])}`, {
      ...(options.runtimeFingerprint ? { fingerprint: options.runtimeFingerprint(call) } : {}),
      request: {
        schemaVersion: "execution.v2",
        kind: "request",
        type: "work.execute",
        messageId: invocationId,
        correlationId: `run:${RUN_ID}`,
        causationId: RUN_ID,
        dataClassification: input.dataClassification,
        risk: "high",
        authorizationRef: input.authorizationRef,
        scope: input.requestScope,
        idempotencyKey: input.idempotencyKey,
        payload: {
          inputRef: input.inputRef,
          capabilityHandleRef: h.ref,
          capabilityId: h.capabilityRef,
          capabilityVersion: h.capabilityVersion,
          operation: input.operation,
          delegatedContextRefs: input.delegatedContextRefs,
          secretRefs: input.secretRefs,
          resourceCeiling: input.resourceCeiling,
          requestedAt: input.requestedAt,
          deadlineAt: input.deadlineAt,
        },
      },
    });
  const fileBinding = {
    ...(workspaceCopy ? { workspaceCopy: workspaceCopy.root } : {}),
    workerInstanceId: "worker-instance-capability-invocation",
    revision: 1,
    hostId: host.binding.hostId,
    grant: directory,
    capabilityRef: h.capabilityRef,
    capabilityVersion: h.capabilityVersion,
    maximumBytes: 4096,
    threadId: call.context?.threadId ?? "",
    modelRef: model.ref,
    modelIdentity: configuredModelDisclosureIdentity(model),
  };
  let fileBindingAvailable =
    options.workspaceCopy || options.legacyFileRead || descriptor.scopeSource === "file_workflow";
  if (options.piParameters)
    await repository.payloadStore(OWNER_ID, AGENT_ID).put(
      await f.protector.protect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        ref: "payload-pi-parameters",
        dataClassification: "private",
        contentType: "application/json",
        plaintext: Buffer.from(JSON.stringify(options.piParameters)),
        createdAt: T1,
      }),
    );
  const capabilityDeployment = {
    ...host.capabilityDeployment,
    sha256: `sha256:${createHash("sha256").update(snapshotBytes).digest("hex")}`,
  };
  const makeServices = async () => {
    const result = await createProductionSandboxServices({
      configuration: {
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        capabilityDeployment,
        modelDescriptors: [model],
      },
      repository,
      protector: f.protector,
      authority: options.authority ?? (() => SERVICE_AUTHORITY),
      fileRead: {
        binding: async () => (fileBindingAvailable ? fileBinding : undefined),
        authorize: async () => {
          throw new Error("not a file workflow");
        },
        issue: async () => {
          throw new Error("unused");
        },
      },
      clock,
      ids: { next: () => `scope-id:${++counter}` },
      workerSupport: () => workerSupport,
    });
    if (!result) throw new Error("composition absent");
    return result;
  };
  let services = await makeServices();
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
      clock,
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
    capabilityDeployment,
    workspaceCopy,
    connect,
    model,
    setAfterResolve: (hook: () => Promise<void>) => {
      afterResolve = hook;
    },
    f,
    fileBinding,
    setFileBindingAvailable: (value: boolean) => {
      fileBindingAvailable = value;
    },
    get repository() {
      return repository;
    },
    get services() {
      if (!services) throw new Error("composition absent");
      return services;
    },
    reopen: async () => {
      await repository.close();
      repository = await SqliteProductStateRepository.open({
        stateRoot: f.resource.stateRoot,
        minimumFreeBytes: 0,
        now: clock.now,
      });
      services = await makeServices();
    },
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
      if (liveHostRoot) await rm(liveHostRoot, { recursive: true, force: true });
    },
  };
}
