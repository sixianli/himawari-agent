import { createHash } from "node:crypto";
import {
  ApplicationPortError,
  type AuthorityFence,
  type ClockPort,
  type GovernedActionIntent,
  type IdempotentAgentCommand,
  type IdGeneratorPort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
} from "@himawari-agent/application";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { appendAuditRecord, applyOwnerPolicyAuthorization } from "./owner-policy-authorization.js";
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
    await appendAuditRecord(this.options.repository.auditLedger(), record);
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
      ("scopeSource" in route
        ? intent.targets.some((target) =>
            ["directory-grant", "directory-path", "file-path"].includes(target.type),
          )
        : !intent.targets.some(
            (target) => target.type === "directory-grant" && target.ref === route.grantId,
          )) ||
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
    await applyOwnerPolicyAuthorization({
      store,
      clock,
      ids,
      intent,
      key: this.key,
      revision: state.revision,
      auditId: `search-use:${digest(intent.id)}`,
      auditAction: "search.authorization.policy_applied",
      appendAudit: (record) => this.appendAudit(record),
    });
  }
}
