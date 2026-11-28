import { createHash } from "node:crypto";
import {
  ApplicationPortError,
  type AuthorityFence,
  type ClockPort,
  type GovernedActionIntent,
  type IdempotentAgentCommand,
  type IdGeneratorPort,
  isModelVisible,
  PORT_ERROR_CODES,
  type ProductConfiguration,
  webProviderEgress,
  webProviderRecipients,
} from "@himawari-agent/application";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { appendAuditRecord, applyOwnerPolicyAuthorization } from "./owner-policy-authorization.js";
import { configuredModelDisclosureIdentity } from "./production-model-disclosure.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sameRecipients = (stored: readonly unknown[], current: readonly string[]) =>
  [...stored].sort().join("\n") === [...current].sort().join("\n");
type SearchAuthorizationState = Awaited<
  ReturnType<SqliteProductStateRepository["readScopedState"]>
>;

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
    authority?: () => AuthorityFence;
  };
  constructor(options: PublicSearchAuthorization["options"]) {
    this.options = options;
    this.key = `search-authorization:${digest([options.configuration.ownerId, options.configuration.agentId])}`;
  }
  private recipients() {
    const runPolicy = this.options.configuration.runPolicy;
    return [
      ...new Set([
        ...(runPolicy?.publicSearch ? webProviderRecipients(runPolicy.publicSearch.providers) : []),
        ...(runPolicy?.publicFetch ? webProviderRecipients(runPolicy.publicFetch.providers) : []),
      ]),
    ];
  }
  private routes() {
    const runPolicy = this.options.configuration.runPolicy;
    return { search: runPolicy?.publicSearch ?? null, fetch: runPolicy?.publicFetch ?? null };
  }
  private models() {
    return (this.options.configuration.modelDescriptors ?? [])
      .filter((model) => model.role !== "embedding")
      .map(configuredModelDisclosureIdentity);
  }
  private agreedRecipients(state: SearchAuthorizationState) {
    const stored = state?.value["recipients"];
    return Array.isArray(stored) && sameRecipients(stored, this.recipients());
  }
  private enabled(state: SearchAuthorizationState) {
    return !state || (state.value["enabled"] === true && this.agreedRecipients(state));
  }
  private providersChanged(state: SearchAuthorizationState) {
    return state?.value["enabled"] === true && !this.agreedRecipients(state);
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
    const routes = this.routes();
    const available = routes.search !== null || routes.fetch !== null;
    return {
      ...query,
      kind: "snapshot",
      type: "search.authorization.snapshot",
      payload: {
        revision: state?.revision ?? 0,
        enabled: available && this.enabled(state),
        providersChanged: available && this.providersChanged(state),
        available,
        recipients: this.recipients(),
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
    const routes = this.routes();
    if (!routes.search && !routes.fetch)
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "SEARCH_NOT_CONFIGURED");
    if (
      command.payload.enabled &&
      command.payload.recipients.join(",") !== this.recipients().join(",")
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "SEARCH_RECIPIENTS_CHANGED",
      );
    const result = await repository.commitStateAndEvents({
      command: {
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        commandType: command.type,
        idempotencyKey: command.idempotencyKey as IdempotentAgentCommand["idempotencyKey"],
        commandFingerprint: digest({
          payload: command.payload,
          actor: command.actor,
          recipients: [...this.recipients()].sort(),
        }),
        authority,
      },
      state: {
        key: this.key,
        expectedRevision: command.payload.expectedRevision || null,
        value: {
          enabled: command.payload.enabled,
          recipients: [...this.recipients()].sort(),
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
  private async recordDefault(): Promise<SearchAuthorizationState> {
    const { configuration, repository, clock } = this.options;
    if (!this.options.authority) return undefined;
    const idempotencyKey = `${this.key}:default`;
    const recipients = [...this.recipients()].sort();
    const result = await repository.commitStateAndEvents({
      command: {
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        commandType: "search.authorization.default",
        idempotencyKey: idempotencyKey as IdempotentAgentCommand["idempotencyKey"],
        commandFingerprint: digest({ enabled: true, recipients }),
        authority: this.options.authority(),
      },
      state: {
        key: this.key,
        expectedRevision: null,
        value: { enabled: true, recipients, actorId: "default" },
      },
      events: [],
      resultRef: this.key,
      committedAt: clock.now(),
    });
    if (!result.replayed)
      await this.appendAudit({
        id: `search-policy:${digest(idempotencyKey)}`,
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        action: "search.authorization.enabled",
        targetRef: this.key,
        outcome: "completed",
        occurredAt: result.commandResult.committedAt,
      });
    return this.read();
  }
  private async appendAudit(record: import("@himawari-agent/application").AuditRecord) {
    await appendAuditRecord(this.options.repository.auditLedger(), record);
  }
  async authorize(intent: GovernedActionIntent): Promise<void> {
    const { configuration, repository, clock, ids } = this.options;
    const routes = this.routes();
    const models = this.models();
    const route =
      intent.operation === "web_search"
        ? routes.search
        : intent.operation === "web_fetch"
          ? routes.fetch
          : null;
    if (!route) return;
    const recipients = webProviderRecipients(route.providers);
    const egress = webProviderEgress(route.providers);
    const domains = intent.targets
      .filter((target) => target.type === "network-domain")
      .map((target) => target.ref)
      .sort();
    if (
      intent.ownerId !== configuration.ownerId ||
      intent.agentId !== configuration.agentId ||
      intent.capabilityRef !== route.capabilityRef ||
      intent.capabilityVersion !== route.capabilityVersion ||
      intent.actionKind !== "READ" ||
      intent.sideEffect !== "none" ||
      intent.credentialOrAccessChange ||
      intent.disclosure !== "named_recipients" ||
      !isModelVisible(intent.dataClassification) ||
      intent.estimatedCostMicros !== 0 ||
      intent.recipients.length !== recipients.length + 1 ||
      !recipients.every((value) => intent.recipients.includes(value)) ||
      !intent.recipients.some((value) => models.includes(value)) ||
      !intent.targets.some((target) => target.type === "host" && target.ref === route.hostId) ||
      ("scopeSource" in route
        ? intent.targets.some((target) =>
            ["directory-grant", "directory-path", "file-path"].includes(target.type),
          )
        : !intent.targets.some(
            (target) => target.type === "directory-grant" && target.ref === route.grantId,
          )) ||
      domains.join(",") !== egress.join(",")
    )
      return;
    const state = (await this.read()) ?? (await this.recordDefault());
    if (!state || !this.enabled(state)) return;
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
