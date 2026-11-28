import { createHash } from "node:crypto";
import {
  type AuthorityFence,
  type ClockPort,
  type GovernedActionIntent,
  type HostDirectoryGrant,
  type HostFileOperationKind,
  hostDirectoryGrantStateKey,
  type IdempotentAgentCommand,
  type IdGeneratorPort,
  isModelVisible,
  type ProductConfiguration,
} from "@himawari-agent/application";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { CapabilityDeploymentSnapshotLoader } from "@himawari-agent/platform-node";
import { appendAuditRecord, applyOwnerPolicyAuthorization } from "./owner-policy-authorization.js";
import { configuredModelDisclosureIdentity } from "./production-model-disclosure.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const WORKSPACE_OPERATIONS = ["read", "ls", "find", "grep", "write", "edit", "bash"] as const;
type WorkspaceOperation = (typeof WORKSPACE_OPERATIONS)[number];

const REQUIRED_DIRECTORY_OPERATIONS: Readonly<
  Record<WorkspaceOperation, readonly HostFileOperationKind[]>
> = Object.freeze({
  read: ["read"],
  ls: ["read"],
  find: ["read"],
  grep: ["read"],
  write: ["read", "create", "update"],
  edit: ["read", "update"],
  bash: ["read", "create", "update"],
});

export interface CodingNetworkFacts {
  readonly allowedDomains: readonly string[];
  readonly operationNetwork: Readonly<Record<string, "disabled" | "grant_targets">>;
}

export async function resolveCodingNetworkFacts(
  configuration: Pick<ProductConfiguration, "capabilityDeployment" | "runPolicy">,
  clock: ClockPort,
): Promise<CodingNetworkFacts | undefined> {
  const coding = configuration.runPolicy?.coding;
  if (!configuration.capabilityDeployment || !coding) return undefined;
  const loaded = await new CapabilityDeploymentSnapshotLoader({
    ...configuration.capabilityDeployment,
    now: () => clock.now(),
  }).load();
  const entry = loaded.snapshot.capabilities.find(
    (candidate) =>
      candidate.binding.kind === "sandbox" &&
      candidate.manifest.ref === coding.capabilityRef &&
      candidate.manifest.version === coding.capabilityVersion,
  );
  if (!entry || entry.binding.kind !== "sandbox") return undefined;
  return Object.freeze({
    allowedDomains: Object.freeze([...entry.binding.value.allowedDomains]),
    operationNetwork: Object.freeze(
      Object.fromEntries(
        (entry.binding.value.operationBindings ?? []).map((binding) => [
          binding.operation,
          binding.network,
        ]),
      ),
    ),
  });
}

export class WorkspaceAutoAuthorization {
  private readonly key: string;
  private readonly options: {
    readonly configuration: Pick<
      ProductConfiguration,
      "ownerId" | "agentId" | "modelDescriptors" | "runPolicy"
    >;
    readonly repository: Pick<
      SqliteProductStateRepository,
      "readScopedState" | "commitStateAndEvents" | "authorizationStore" | "auditLedger"
    >;
    readonly clock: ClockPort;
    readonly ids: IdGeneratorPort;
    readonly network: CodingNetworkFacts;
  };

  constructor(options: WorkspaceAutoAuthorization["options"]) {
    this.options = options;
    this.key = `workspace-authorization:${digest([
      options.configuration.ownerId,
      options.configuration.agentId,
    ])}`;
  }

  private enabledFromConfiguration(): boolean {
    return (
      (this.options.configuration.runPolicy?.coding?.approval ?? "workspace_auto") ===
      "workspace_auto"
    );
  }

  private models(): readonly string[] {
    return (this.options.configuration.modelDescriptors ?? [])
      .filter((model) => model.role !== "embedding")
      .map(configuredModelDisclosureIdentity)
      .sort();
  }

  private binding() {
    const coding = this.options.configuration.runPolicy?.coding ?? null;
    return {
      route: coding,
      hostId: coding?.hostId ?? null,
      grantId: coding?.grantId ?? null,
      capabilityRef: coding?.capabilityRef ?? null,
      capabilityVersion: coding?.capabilityVersion ?? null,
      operations: [...WORKSPACE_OPERATIONS],
      models: this.models(),
      allowedDomains: [...this.options.network.allowedDomains].sort(),
      operationNetwork: Object.fromEntries(
        Object.entries(this.options.network.operationNetwork).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    };
  }

  private bashIsOffline(binding: ReturnType<WorkspaceAutoAuthorization["binding"]>): boolean {
    return binding.allowedDomains.length === 0 && binding.operationNetwork["bash"] === "disabled";
  }

  private read() {
    const { configuration, repository } = this.options;
    return repository.readScopedState(configuration.ownerId, configuration.agentId, this.key);
  }

  async sync(authority: AuthorityFence): Promise<void> {
    const { configuration, repository, clock } = this.options;
    const binding = this.binding();
    const enabled = this.enabledFromConfiguration();
    const bindingDigest = digest(binding);
    const current = await this.read();
    if (
      current &&
      current.value["enabled"] === enabled &&
      current.value["bindingDigest"] === bindingDigest
    )
      return;
    const idempotencyKey = `workspace-authorization-sync:${digest([
      enabled,
      bindingDigest,
      current?.revision ?? null,
    ])}` as IdempotentAgentCommand["idempotencyKey"];
    const result = await repository.commitStateAndEvents({
      command: {
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        commandType: "workspace.authorization.sync",
        idempotencyKey,
        commandFingerprint: digest({ enabled, bindingDigest }),
        authority,
      },
      state: {
        key: this.key,
        expectedRevision: current?.revision ?? null,
        value: { enabled, bindingDigest },
      },
      events: [],
      resultRef: this.key,
      committedAt: clock.now(),
    });
    await appendAuditRecord(repository.auditLedger(), {
      id: `workspace-policy:${digest(idempotencyKey)}`,
      ownerId: configuration.ownerId,
      agentId: configuration.agentId,
      action: enabled ? "workspace.authorization.enabled" : "workspace.authorization.revoked",
      targetRef: this.key,
      outcome: "completed",
      occurredAt: result.commandResult.committedAt,
    });
  }

  private async directoryGrantCovers(
    grantId: string,
    hostId: string,
    operation: WorkspaceOperation,
    now: string,
  ): Promise<boolean> {
    const { configuration, repository } = this.options;
    const stored = await repository.readScopedState(
      configuration.ownerId,
      configuration.agentId,
      hostDirectoryGrantStateKey(grantId),
    );
    const grant = stored?.value as unknown as HostDirectoryGrant | undefined;
    if (!grant) return false;
    return (
      grant.id === grantId &&
      grant.hostId === hostId &&
      grant.revokedAt === null &&
      Number.isFinite(Date.parse(grant.expiresAt)) &&
      Date.parse(grant.expiresAt) > Date.parse(now) &&
      grant.pathPolicy === "same_filesystem_no_links" &&
      grant.mountPolicy === "fixed_device" &&
      isModelVisible(grant.dataClassification) &&
      ["model", "external_approved"].includes(grant.disclosure) &&
      Number.isSafeInteger(grant.revision) &&
      grant.revision >= 1 &&
      REQUIRED_DIRECTORY_OPERATIONS[operation].every((required) =>
        grant.operations.includes(required),
      )
    );
  }

  async authorize(intent: GovernedActionIntent): Promise<void> {
    const { configuration, repository, clock, ids } = this.options;
    const binding = this.binding();
    const route = binding.route;
    if (
      !route ||
      intent.ownerId !== configuration.ownerId ||
      intent.agentId !== configuration.agentId ||
      intent.capabilityRef !== route.capabilityRef ||
      intent.capabilityVersion !== route.capabilityVersion ||
      !(WORKSPACE_OPERATIONS as readonly string[]).includes(intent.operation) ||
      intent.actionKind === "DELETE" ||
      !isModelVisible(intent.dataClassification) ||
      intent.credentialOrAccessChange ||
      intent.disclosure !== "named_recipients" ||
      intent.estimatedCostMicros !== 0 ||
      intent.recipients.length !== 1 ||
      !binding.models.includes(intent.recipients[0] as string) ||
      !intent.targets.some(
        (target) => target.type === "directory-grant" && target.ref === route.grantId,
      )
    )
      return;
    if (intent.operation === "bash" && !this.bashIsOffline(binding)) return;
    if (
      !(await this.directoryGrantCovers(
        route.grantId,
        route.hostId,
        intent.operation as WorkspaceOperation,
        clock.now(),
      ))
    )
      return;
    const state = await this.read();
    if (
      !state ||
      state.value["enabled"] !== true ||
      state.value["bindingDigest"] !== digest(binding)
    )
      return;
    await applyOwnerPolicyAuthorization({
      store: repository.authorizationStore(),
      clock,
      ids,
      intent,
      key: this.key,
      revision: state.revision,
      auditId: `workspace-use:${digest(intent.id)}`,
      auditAction: "workspace.authorization.policy_applied",
      appendAudit: (record) => appendAuditRecord(repository.auditLedger(), record),
    });
  }
}
