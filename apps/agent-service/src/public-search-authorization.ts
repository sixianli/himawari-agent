import { createHash } from "node:crypto";
import {
  ApprovalService,
  GrantService,
  actionIntentFingerprint,
  ApplicationPortError,
  PORT_ERROR_CODES,
  type AuthorityFence,
  type ClockPort,
  type GovernedActionIntent,
  type GovernedApprovalRequest,
  type IdGeneratorPort,
  type IdempotentAgentCommand,
  type ProductConfiguration,
} from "@himawari-agent/application";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { configuredModelDisclosureIdentity } from "./production-model-disclosure.js";

const recipient = "https://mcp.exa.ai" as const;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Owner policy is persisted separately from UI preferences. Each use derives a
 * scoped one-time Grant, retaining the existing Worker and sandbox authority path.
 * policyAuthorization identifies the actual source; no human click is fabricated. */
export class PublicSearchAuthorization {
  private readonly key: string;
  private readonly options: {
    configuration: Pick<ProductConfiguration, "ownerId" | "agentId"> &
      Partial<Pick<ProductConfiguration, "modelDescriptors" | "runPolicy">>;
    repository: Pick<
      SqliteProductStateRepository,
      "readScopedState" | "commitStateAndEvents" | "authorizationStore" | "auditLedger"
    >;
    clock: ClockPort;
    ids: IdGeneratorPort;
  };
  constructor(options: PublicSearchAuthorization["options"]) {
    this.options = options;
    this.key = `search-authorization:${digest([options.configuration.ownerId, options.configuration.agentId])}`;
  }
  private binding() {
    const config = this.options.configuration;
    return {
      route: config.runPolicy?.publicSearch ?? null,
      models: (config.modelDescriptors ?? [])
        .filter(
          (model) =>
            model.role !== "embedding" && model.allowedDataClassifications.includes("private"),
        )
        .map(configuredModelDisclosureIdentity)
        .sort(),
      recipient,
    };
  }
  async revision(): Promise<number> {
    return (await this.read())?.revision ?? 0;
  }
  private read() {
    const { configuration, repository } = this.options;
    return repository.readScopedState(configuration.ownerId, configuration.agentId, this.key);
  }
  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type !== "search.authorization.read")
      throw new Error("SEARCH_OPERATION_NOT_INSTALLED");
    const state = await this.read();
    const binding = this.binding();
    return {
      ...query,
      kind: "snapshot",
      type: "search.authorization.snapshot",
      payload: {
        revision: state?.revision ?? 0,
        enabled:
          state?.value["enabled"] === true && state.value["bindingDigest"] === digest(binding),
        available: binding.route !== null,
        recipient,
        generatedAt: this.options.clock.now(),
      },
    };
  }
  async set(command: GatewayV2Command, authority: AuthorityFence) {
    if (command.type !== "search.authorization.set")
      throw new Error("SEARCH_OPERATION_NOT_INSTALLED");
    const { configuration, repository, clock } = this.options;
    if (
      command.actor.actorType !== "owner" ||
      !command.authorizationRef ||
      command.scope.ownerId !== configuration.ownerId ||
      command.scope.agentId !== configuration.agentId
    )
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "SEARCH_OWNER_REQUIRED");
    const binding = this.binding();
    if (!binding.route)
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "SEARCH_NOT_CONFIGURED");
    const result = await repository.commitStateAndEvents({
      command: {
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        commandType: command.type,
        idempotencyKey: command.idempotencyKey as IdempotentAgentCommand["idempotencyKey"],
        commandFingerprint: digest({ payload: command.payload, actor: command.actor, binding }),
        authority,
      },
      state: {
        key: this.key,
        expectedRevision: command.payload.expectedRevision || null,
        value: {
          enabled: command.payload.enabled,
          bindingDigest: digest(binding),
          recipient,
          actorId: command.actor.actorId,
        },
      },
      events: [],
      resultRef: this.key,
      committedAt: clock.now(),
    });
    await this.appendAudit({
      id: `search-policy:${digest(command.idempotencyKey)}`,
      ownerId: configuration.ownerId,
      agentId: configuration.agentId,
      action: command.payload.enabled
        ? "search.authorization.enabled"
        : "search.authorization.revoked",
      targetRef: this.key,
      outcome: "completed",
      occurredAt: result.commandResult.committedAt,
    });
    return { resultRef: result.commandResult.resultRef, replayed: result.replayed };
  }
  private async appendAudit(record: import("@himawari-agent/application").AuditRecord) {
    try {
      await this.options.repository.auditLedger().append(record);
    } catch (error) {
      if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.DUPLICATE)
        throw error;
      const old = (
        await this.options.repository.auditLedger().listByAgent(record.agentId, null)
      ).find((item) => item.id === record.id);
      if (
        !old ||
        !(Object.keys(record) as (keyof typeof record)[]).every((key) => old[key] === record[key])
      )
        throw error;
    }
  }
  async authorize(intent: GovernedActionIntent): Promise<void> {
    const { configuration, repository, clock, ids } = this.options;
    const binding = this.binding(),
      route = binding.route;
    if (
      !route ||
      intent.ownerId !== configuration.ownerId ||
      intent.agentId !== configuration.agentId ||
      intent.capabilityRef !== route.capabilityRef ||
      intent.capabilityVersion !== route.capabilityVersion ||
      intent.operation !== "web_search" ||
      intent.actionKind !== "READ" ||
      intent.sideEffect !== "none" ||
      intent.credentialOrAccessChange ||
      intent.disclosure !== "named_recipients" ||
      intent.dataClassification !== "private" ||
      intent.estimatedCostMicros !== 0 ||
      intent.recipients.length !== 2 ||
      !intent.recipients.includes(recipient) ||
      !intent.recipients.some((value) => binding.models.includes(value)) ||
      !intent.targets.some((target) => target.type === "host" && target.ref === route.hostId) ||
      !intent.targets.some(
        (target) => target.type === "directory-grant" && target.ref === route.grantId,
      ) ||
      intent.targets.filter((target) => target.type === "network-domain").length !== 1 ||
      intent.targets
        .filter((target) => target.type === "network-domain")
        .some((target) => target.ref !== "mcp.exa.ai:443")
    )
      return;
    const state = await this.read();
    if (
      !state ||
      state.value["enabled"] !== true ||
      state.value["bindingDigest"] !== digest(binding)
    )
      return;
    const store = repository.authorizationStore();
    let approval = (await store.findApprovalByIntent(intent.id)) as
      | GovernedApprovalRequest
      | undefined;
    if (approval?.policyAuthorization && approval.status === "approved") {
      await this.appendAudit({
        id: `search-use:${digest(intent.id)}`,
        ownerId: intent.ownerId,
        agentId: intent.agentId,
        action: "search.authorization.policy_applied",
        targetRef: approval.id,
        outcome: "completed",
        occurredAt: approval.decidedAt ?? clock.now(),
      });
      return;
    }
    // An explicit rejection or an already requested human decision is never overridden.
    if (approval && (!approval.policyAuthorization || approval.status !== "pending")) return;
    const policyAuthorization = { key: this.key, revision: state.revision };
    if (
      approval &&
      (approval.policyAuthorization?.key !== this.key ||
        approval.policyAuthorization.revision !== state.revision)
    )
      return;
    if (!approval)
      approval = (await store.createApproval({
        id: ids.next("policy-authorization"),
        revision: 1,
        ownerId: intent.ownerId,
        agentId: intent.agentId,
        runId: intent.runId,
        intentId: intent.id,
        intentSnapshot: intent,
        semanticSnapshotHash: actionIntentFingerprint(intent),
        status: "pending",
        deliveryState: "queued_no_ui",
        requestedAt: clock.now(),
        expiresAt: intent.expiresAt,
        decidedAt: null,
        grantId: null,
        finalRisk: intent.finalRisk,
        recentAuthenticationRequired: false,
        recentAuthenticationRef: null,
        policyAuthorization,
      } as GovernedApprovalRequest)) as GovernedApprovalRequest;
    const grant = new GrantService({ store, clock, ids }).create({
      kind: "one_time",
      intent,
      approvalRequestId: approval.id,
      expiresAt: intent.expiresAt,
      maxUses: 1,
      maxTotalCostMicros: 0,
      scope: {
        capabilityRef: intent.capabilityRef,
        capabilityVersion: intent.capabilityVersion,
        operations: [intent.operation],
        exactResourceRef: intent.resourceRef,
        resourceIdentities: [...intent.resourceRefs],
        resourcePrefixes: [],
        maxDataClassification: intent.dataClassification,
        sideEffects: ["none"],
        maxCostMicrosPerUse: 0,
        maxFrequency: intent.frequency,
        disclosure: intent.disclosure,
        recipients: [...intent.recipients],
        credentialOrAccessChange: false,
      },
    });
    approval = await new ApprovalService({ store, clock }).respond({
      approvalRequestId: approval.id,
      expectedRevision: approval.revision,
      semanticSnapshotHash: approval.semanticSnapshotHash,
      response: { decision: "approved", grant, recentAuthenticationRef: null },
    });
    await this.appendAudit({
      id: `search-use:${digest(intent.id)}`,
      ownerId: intent.ownerId,
      agentId: intent.agentId,
      action: "search.authorization.policy_applied",
      targetRef: approval.id,
      outcome: "completed",
      occurredAt: approval.decidedAt ?? clock.now(),
    });
  }
}
