import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  DurableHostWorkspaceStateAdapter,
  DurableHostWorkspaceProjectionAdapter,
  FileOperationService,
  WorkspaceCopyService,
  HostWorkspaceGatewayV2ControlPlane,
  type AuthorityFence,
  type ClockPort,
  type GatewayV2ControlPlanePort,
  type IdempotentAgentCommand,
  type PayloadProtectorPort,
  type ProductConfiguration,
  type StateStorePort,
  type ThreadCreateInput,
} from "@himawari-agent/application";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import {
  CapabilityDeploymentSnapshotLoader,
  ConstrainedHostFileSystem,
  WorkspaceCopyStore,
} from "@himawari-agent/platform-node";

export const PRODUCTION_COPY_OPERATIONS = [
  "workspace.copy.create",
  "workspace.copy.select",
  "workspace.copy.prepare",
] as const;

/** Owner controls store data; commands still run through the existing Pi/Worker/SRT path. */
export async function createProductionWorkspaceCopies(options: {
  readonly configuration: Pick<
    ProductConfiguration,
    "ownerId" | "agentId" | "runPolicy" | "capabilityDeployment"
  >;
  readonly repository: SqliteProductStateRepository;
  readonly protector: PayloadProtectorPort;
  readonly authority: () => AuthorityFence;
  readonly clock: ClockPort;
}): Promise<GatewayV2ControlPlanePort | undefined> {
  const { configuration, repository, protector, clock } = options;
  const route = configuration.runPolicy?.coding;
  if (!route?.enabledTools.includes("bash") || !configuration.capabilityDeployment)
    return undefined;
  const loaded = await new CapabilityDeploymentSnapshotLoader({
    ...configuration.capabilityDeployment,
    now: () => clock.now(),
  }).load();
  const entry = loaded.snapshot.capabilities.find(
    (entry) =>
      entry.manifest.ref === route.capabilityRef &&
      entry.manifest.version === route.capabilityVersion,
  );
  if (
    entry?.binding.kind !== "sandbox" ||
    entry.binding.value.hostId !== route.hostId ||
    !entry.binding.value.operationBindings?.some(
      (op) =>
        op.operation === "bash" && op.mode === "foreground" && op.scopeSource === "grant_targets",
    )
  )
    return undefined;
  const binding = entry.binding.value;
  const { ownerId, agentId } = configuration;
  const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  const invalid = () =>
    new ApplicationPortError(
      PORT_ERROR_CODES.NOT_AUTHORITATIVE,
      "WORKSPACE_COPY_AUTHORITY_CHANGED",
    );
  const writeState = async (
    input: Parameters<StateStorePort["compareAndSet"]>[0],
    commandId: string = randomUUID(),
  ) => {
    const fingerprint = hash(JSON.stringify(input));
    const result = await repository.commitStateAndEvents({
      command: {
        ownerId,
        agentId,
        idempotencyKey:
          `workspace-copy:${hash(commandId)}:${fingerprint}` as IdempotentAgentCommand["idempotencyKey"],
        commandType: "workspace.copy.state",
        commandFingerprint: fingerprint,
        authority: options.authority(),
      },
      state: input,
      events: [],
      resultRef: input.key,
      committedAt: clock.now(),
    });
    return result.state;
  };
  const state: StateStorePort = {
    read: (key) => repository.readScopedState(ownerId, agentId, key),
    compareAndSet: (input) => writeState(input),
  };
  const payloadStore = repository.payloadStore(ownerId, agentId);
  const readBytes = async (ref: string) => {
    const payload = await payloadStore.get(ref);
    if (!payload) throw invalid();
    return protector.unprotect({ ownerId, agentId, payload });
  };
  const protectBytes = async (plaintext: Uint8Array) => {
    const payload = await protector.protect({
      ownerId,
      agentId,
      ref: `workspace-copy:${randomUUID()}`,
      plaintext,
      contentType: "application/octet-stream",
      dataClassification: "private",
      createdAt: clock.now(),
    });
    await payloadStore.put(payload);
    return payload.ref;
  };
  const payloads = {
    readBytes,
    readText: async (ref: string) =>
      new TextDecoder("utf-8", { fatal: true }).decode(await readBytes(ref)),
    protectJson: async (value: import("@himawari-agent/application").JsonObject) =>
      protectBytes(Buffer.from(JSON.stringify(value))),
  };
  const hostState = new DurableHostWorkspaceStateAdapter(state);
  const platform = new ConstrainedHostFileSystem();
  const digest = {
    digest: (value: Uint8Array) => `sha256:${hash(value)}`,
    digestCanonical: (value: string) => `sha256:${hash(value)}`,
  };
  const ids = { next: (scope: string) => `${scope}:${randomUUID()}` };
  const files = new FileOperationService({
    state: hostState,
    platform,
    digest,
    clock,
    ids,
    hostId: route.hostId,
  });
  const store = new WorkspaceCopyStore({
    candidateRoot: path.join(binding.privateRoot, "workspace-copies"),
    protectPayload: protectBytes,
  });
  const copies = new WorkspaceCopyService({
    hostId: route.hostId,
    state: hostState,
    platform,
    copies: store,
    files,
    digest,
    readPayload: readBytes,
    clock,
    ids,
  });
  const currentGrant = async () => {
    const grant = await hostState.readGrant(route.grantId);
    if (
      !grant ||
      grant.hostId !== route.hostId ||
      grant.revokedAt ||
      grant.expiresAt <= clock.now() ||
      !grant.operations.includes("read") ||
      !binding.roots.some(
        (root) =>
          root.canonicalRootId === grant.canonicalRootId &&
          root.canonicalPath === grant.displayPath,
      )
    )
      throw invalid();
    return grant;
  };
  const delegate: GatewayV2ControlPlanePort = {
    execute: async () => {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Gateway operation is not installed",
      );
    },
  };
  const control = new HostWorkspaceGatewayV2ControlPlane({
    delegate,
    copies,
    hostState,
    projections: new DurableHostWorkspaceProjectionAdapter(state),
    payloads,
    receipts: repository.governanceMutationReceiptStore(),
    clock,
    ownerId,
    agentId,
    selectCopy: async (input, commandId) => {
      if (
        !(await repository
          .threadRepository()
          .read(ownerId, agentId, input.threadId as ThreadCreateInput["thread"]["id"]))
      )
        throw invalid();
      const key = `workspace-copy-selection:${input.threadId}`;
      let value: import("@himawari-agent/application").JsonObject = { workspaceRef: null };
      if (input.workspaceRef !== null) {
        const reference: unknown = JSON.parse(await payloads.readText(input.workspaceRef));
        if (
          !reference ||
          typeof reference !== "object" ||
          !("workspaceRef" in reference) ||
          typeof reference.workspaceRef !== "string"
        )
          throw invalid();
        const copy = await store.describeCopy(reference.workspaceRef);
        const grant = await currentGrant();
        if (
          copy.baseline.grantId !== grant.id ||
          copy.baseline.grantRevision !== grant.revision ||
          copy.baseline.canonicalRootId !== grant.canonicalRootId
        )
          throw invalid();
        value = {
          workspaceRef: input.workspaceRef,
          hostId: grant.hostId,
          grantId: grant.id,
          grantRevision: grant.revision,
          root: { ...copy.root },
        };
      }
      const selected = await writeState(
        { key, expectedRevision: input.expectedRevision, value },
        commandId,
      );
      return payloads.protectJson({
        threadId: input.threadId,
        revision: selected.revision,
        workspaceRef: input.workspaceRef,
      });
    },
  });
  return {
    execute: async (input) => {
      if (input.command.type === "workspace.copy.create") {
        const grant = await currentGrant();
        if (input.command.payload.grantId !== grant.id) throw invalid();
      }
      return control.execute(input);
    },
  };
}
