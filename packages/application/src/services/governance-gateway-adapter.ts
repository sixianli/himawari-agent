import type {
  ApprovalRequest,
  AuthorizationStorePort,
  GovernedApprovalRequest,
  GovernedGrantRecord,
} from "../ports/authorization.js";
import type {
  CapabilityManifest,
  CapabilityRegistryRecord,
  CapabilityRegistryStorePort,
} from "../ports/capabilities.js";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import type {
  GatewayAuthenticationContext,
  GatewayCommandResult,
  GatewayV2CommandExecution,
  GatewayV2ControlPlanePort,
  GatewayV2ReadModelPort,
} from "../ports/gateway.js";
import type {
  GovernanceDependencyReadPort,
  GovernanceMutationReceipt,
  GovernanceMutationReceiptStorePort,
} from "../ports/governance.js";
import type { AuditLedgerPort } from "../ports/observability.js";
import type { ClockPort } from "../ports/system.js";
import type { AgentId, OwnerId } from "@himawari-agent/domain";
import {
  gatewayV2MessageSchema,
  type GatewayV2Command,
  type GatewayV2Event,
  type GatewayV2Query,
  type GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
import type { ApprovalService } from "./approval-service.js";
import type { CapabilityLifecycleService } from "./capability-lifecycle-service.js";
import type { GrantService } from "./grant-service.js";
import { threadCommandFingerprint } from "./thread-command-service.js";

type GovernanceQuery = Extract<
  GatewayV2Query,
  {
    readonly type:
      | "approval.list"
      | "approval.detail"
      | "capability.list"
      | "capability.detail"
      | "grant.list"
      | "grant.detail";
  }
>;

type GovernanceCommand = Extract<
  GatewayV2Command,
  {
    readonly type:
      | "approval.respond"
      | "grant.revoke"
      | "capability.review"
      | "capability.install.approve"
      | "capability.update.respond"
      | "capability.disable"
      | "capability.rollback";
  }
>;

const GOVERNANCE_QUERY_TYPES = new Set<GatewayV2Query["type"]>([
  "approval.list",
  "approval.detail",
  "capability.list",
  "capability.detail",
  "grant.list",
  "grant.detail",
]);

const GOVERNANCE_COMMAND_TYPES = new Set<GatewayV2Command["type"]>([
  "approval.respond",
  "grant.revoke",
  "capability.review",
  "capability.install.approve",
  "capability.update.respond",
  "capability.disable",
  "capability.rollback",
]);

const CLASSIFICATION_ORDER = ["public", "private", "sensitive", "restricted"] as const;
type GatewayClassification = (typeof CLASSIFICATION_ORDER)[number];

function maximumClassification(
  left: GatewayClassification,
  right: GatewayClassification,
): GatewayClassification {
  return CLASSIFICATION_ORDER.indexOf(left) >= CLASSIFICATION_ORDER.indexOf(right) ? left : right;
}

function lowerRisk(value: string): "low" | "medium" | "high" | "critical" {
  const normalized = value.toLowerCase();
  if (["low", "medium", "high", "critical"].includes(normalized)) {
    return normalized as "low" | "medium" | "high" | "critical";
  }
  throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, `Unknown risk ${value}`);
}

function governedApproval(value: ApprovalRequest): value is GovernedApprovalRequest {
  const candidate = value as Partial<GovernedApprovalRequest>;
  const intent = value.intentSnapshot as Partial<GovernedApprovalRequest["intentSnapshot"]>;
  return (
    intent.contractVersion === "authorization.v2" &&
    typeof candidate.finalRisk === "string" &&
    typeof candidate.recentAuthenticationRequired === "boolean"
  );
}

function governedGrant(value: unknown): value is GovernedGrantRecord {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<GovernedGrantRecord>;
  const scope = candidate.scope as Partial<GovernedGrantRecord["scope"]> | undefined;
  return (
    typeof candidate.id === "string" &&
    typeof scope?.capabilityVersion === "string" &&
    Array.isArray(scope.resourceIdentities) &&
    typeof scope.disclosure === "string" &&
    Array.isArray(scope.recipients) &&
    scope.credentialOrAccessChange === false
  );
}

function capabilityManifest(value: unknown): value is CapabilityManifest {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Partial<CapabilityManifest>).manifestVersion === "capability.v2"
  );
}

function parseSnapshot(value: unknown): GatewayV2Snapshot {
  const parsed = gatewayV2MessageSchema.parse(value);
  if (parsed.kind !== "snapshot") {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "Governance Gateway adapter produced a non-snapshot response",
    );
  }
  return parsed;
}

function responseId(prefix: string, messageId: string): string {
  return `${prefix}:${messageId}`.slice(0, 128);
}

function distinctSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function paginate(
  refs: readonly string[],
  afterCursor: string | null,
  limit: number,
): { readonly itemRefs: readonly string[]; readonly nextCursor: string | null } {
  let start = 0;
  if (afterCursor !== null) {
    const index = refs.indexOf(afterCursor);
    if (index < 0) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Collection cursor ${afterCursor} is not present in the authoritative snapshot`,
        { cursor: afterCursor },
      );
    }
    start = index + 1;
  }
  const itemRefs = refs.slice(start, start + limit);
  const nextCursor = start + itemRefs.length < refs.length ? (itemRefs.at(-1) ?? null) : null;
  return { itemRefs, nextCursor };
}

function isGovernanceQuery(query: GatewayV2Query): query is GovernanceQuery {
  return GOVERNANCE_QUERY_TYPES.has(query.type);
}

function isGovernanceCommand(command: GatewayV2Command): command is GovernanceCommand {
  return GOVERNANCE_COMMAND_TYPES.has(command.type);
}

export interface GovernanceGatewayV2ReadModelDependencies {
  readonly delegate: GatewayV2ReadModelPort;
  readonly authorization: AuthorizationStorePort;
  readonly capabilities: CapabilityRegistryStorePort;
  readonly dependencies: GovernanceDependencyReadPort;
  readonly clock: ClockPort;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export class GovernanceGatewayV2ReadModel implements GatewayV2ReadModelPort {
  readonly #dependencies: GovernanceGatewayV2ReadModelDependencies;

  constructor(dependencies: GovernanceGatewayV2ReadModelDependencies) {
    this.#dependencies = dependencies;
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (!isGovernanceQuery(query)) return this.#dependencies.delegate.query(query);
    this.#assertScope(query);
    switch (query.type) {
      case "approval.list": {
        const approvals = (
          await this.#dependencies.authorization.listApprovals(
            this.#dependencies.ownerId,
            this.#dependencies.agentId,
          )
        ).filter(
          (approval) =>
            governedApproval(approval) &&
            (query.payload.status === null || approval.status === query.payload.status),
        );
        return this.#collection(
          query,
          "approvals",
          distinctSorted(approvals.map(({ id }) => id)),
          query.payload.afterCursor,
          query.payload.limit,
        );
      }
      case "approval.detail":
        return this.#approvalSnapshot(query);
      case "capability.list": {
        const records = (await this.#dependencies.capabilities.list()).filter(
          (record) =>
            capabilityManifest(record.declaration) &&
            (query.payload.lifecycle === null || record.lifecycle === query.payload.lifecycle),
        );
        return this.#collection(
          query,
          "capabilities",
          distinctSorted(records.map(({ ref }) => ref)),
          query.payload.afterCursor,
          query.payload.limit,
        );
      }
      case "capability.detail":
        return this.#capabilitySnapshot(query);
      case "grant.list": {
        const grants = (
          await this.#dependencies.authorization.listGrants(
            this.#dependencies.ownerId,
            this.#dependencies.agentId,
          )
        ).filter(
          (grant) =>
            governedGrant(grant) && (query.payload.includeRevoked || grant.revokedAt === null),
        );
        return this.#collection(
          query,
          "grants",
          distinctSorted(grants.map(({ id }) => id)),
          query.payload.afterCursor,
          query.payload.limit,
        );
      }
      case "grant.detail":
        return this.#grantSnapshot(query);
    }
  }

  subscribe(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly afterCursor: string | null;
  }): AsyncIterable<GatewayV2Event> {
    return this.#dependencies.delegate.subscribe(input);
  }

  #assertScope(query: GovernanceQuery): void {
    if (
      query.scope.ownerId !== this.#dependencies.ownerId ||
      query.scope.agentId !== this.#dependencies.agentId
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Governance query is outside the configured Owner and Agent scope",
      );
    }
  }

  #envelope(
    query: GovernanceQuery,
    type: GatewayV2Snapshot["type"],
    dataClassification: GatewayClassification,
    risk: "low" | "medium" | "high" | "critical",
  ) {
    return {
      schemaVersion: query.schemaVersion,
      kind: "snapshot" as const,
      type,
      messageId: responseId("snapshot", query.messageId),
      correlationId: query.correlationId,
      causationId: query.messageId,
      dataClassification,
      risk,
      authorizationRef: query.authorizationRef,
      scope: query.scope,
      authority: query.authority,
      actor: { actorType: "system" as const, actorId: "governance-gateway" },
    };
  }

  #collection(
    query: GovernanceQuery,
    category: "approvals" | "capabilities" | "grants",
    refs: readonly string[],
    afterCursor: string | null,
    limit: number,
  ): GatewayV2Snapshot {
    const generatedAt = this.#dependencies.clock.now();
    const page = paginate(refs, afterCursor, limit);
    return parseSnapshot({
      ...this.#envelope(query, "collection.snapshot", "private", "low"),
      payload: {
        category,
        ...page,
        snapshotRef: responseId(`snapshot-${category}`, query.messageId),
        generatedAt,
      },
    });
  }

  async #approvalSnapshot(
    query: Extract<GovernanceQuery, { readonly type: "approval.detail" }>,
  ): Promise<GatewayV2Snapshot> {
    const approval = await this.#dependencies.authorization.getApproval(
      query.payload.approvalRequestId,
    );
    if (!approval || !governedApproval(approval)) {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Governed Approval not found");
    }
    if (
      approval.ownerId !== this.#dependencies.ownerId ||
      approval.agentId !== this.#dependencies.agentId
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Approval is outside scope",
      );
    }
    const intent = approval.intentSnapshot;
    const generatedAt = this.#dependencies.clock.now();
    const trueResultRef = await this.#dependencies.dependencies.trueResultRefForApproval(
      approval.id,
    );
    return parseSnapshot({
      ...this.#envelope(
        query,
        "approval.snapshot",
        maximumClassification("private", intent.dataClassification),
        lowerRisk(approval.finalRisk),
      ),
      payload: {
        approvalRequestId: approval.id,
        revision: approval.revision,
        status: approval.status,
        deliveryState: approval.deliveryState,
        semanticSnapshotHash: approval.semanticSnapshotHash,
        finalRisk: lowerRisk(approval.finalRisk),
        recentAuthenticationRequired: approval.recentAuthenticationRequired,
        recentAuthenticationRef: approval.recentAuthenticationRef,
        requestedAt: approval.requestedAt,
        expiresAt: approval.expiresAt,
        decidedAt: approval.decidedAt,
        grantId: approval.grantId,
        intent: {
          intentId: intent.id,
          threadId: intent.threadId,
          runId: intent.runId,
          actionKind: intent.actionKind,
          capabilityRef: intent.capabilityRef,
          capabilityVersion: intent.capabilityVersion,
          operation: intent.operation,
          targetRefs: intent.targets.map(({ ref }) => ref),
          resourceRefs: intent.resourceRefs,
          dataClassification: intent.dataClassification,
          disclosure: intent.disclosure,
          recipientRefs: intent.recipients,
          sideEffect: intent.sideEffect,
          estimatedCostMicros: intent.estimatedCostMicros,
          frequency: intent.frequency,
          credentialOrAccessChange: intent.credentialOrAccessChange,
          reversible: intent.reversible,
          idempotencyKey: intent.idempotencyKey,
          deterministicFactCodes: intent.deterministicFacts.map(({ code }) => code),
          modelReasonCode: intent.modelClassification.reasonCode,
          requestedAt: intent.requestedAt,
          expiresAt: intent.expiresAt,
        },
        trueResultRef,
        generatedAt,
      },
    });
  }

  async #capabilitySnapshot(
    query: Extract<GovernanceQuery, { readonly type: "capability.detail" }>,
  ): Promise<GatewayV2Snapshot> {
    const record = await this.#dependencies.capabilities.get(query.payload.capabilityRef);
    if (!record || !capabilityManifest(record.declaration)) {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Governed Capability not found");
    }
    const manifest = record.declaration;
    const taskRefs = distinctSorted(
      await this.#dependencies.dependencies.listTaskRefsByCapability(record.ref),
    );
    const generatedAt = this.#dependencies.clock.now();
    return parseSnapshot({
      ...this.#envelope(
        query,
        "capability.snapshot",
        manifest.scopes.dataClassifications.reduce(
          (classification, value) => maximumClassification(classification, value),
          "private" as GatewayClassification,
        ),
        record.pendingUpdateAssessment ? lowerRisk(record.pendingUpdateAssessment.risk) : "medium",
      ),
      payload: {
        capabilityRef: record.ref,
        revision: record.revision,
        lifecycle: record.lifecycle,
        displayName: manifest.displayName,
        sourceType: manifest.source.type,
        sourceLocator: manifest.source.locator,
        sourceIdentity: manifest.sourceIdentity,
        version: manifest.version,
        integrity: manifest.integrity,
        signatureStatus: manifest.artifact.signatureStatus,
        signerRef: manifest.artifact.signerRef,
        operations: manifest.operations,
        permissionRefs: manifest.permissionRefs,
        dataClassifications: manifest.scopes.dataClassifications,
        networkScopes: manifest.scopes.network,
        filesystemScopes: manifest.scopes.filesystem,
        secretRefs: manifest.scopes.secrets,
        isolation: manifest.isolation,
        currency: manifest.cost.currency,
        maxMicrosPerInvocation: manifest.cost.maxMicrosPerInvocation,
        healthStatus: manifest.health.status,
        healthCheckedAt: manifest.health.checkedAt,
        reviewedBy: manifest.reviewedBy,
        reviewedAt: manifest.reviewedAt,
        approvalRefs: record.approvalRefs,
        dependencyTaskRefs: taskRefs,
        runtimeQualification: record.runtimeQualification
          ? {
              platform: record.runtimeQualification.platform,
              runtimeIdentity: record.runtimeQualification.runtimeIdentity,
              productionSuitable: record.runtimeQualification.productionSuitable,
              reasonCodes: record.runtimeQualification.reasonCodes,
              checkedAt: record.runtimeQualification.checkedAt,
            }
          : null,
        pendingVersion: record.pendingDeclaration?.version ?? null,
        updateAssessment: record.pendingUpdateAssessment
          ? {
              ...record.pendingUpdateAssessment,
              risk: lowerRisk(record.pendingUpdateAssessment.risk),
            }
          : null,
        rollbackVersion: record.rollbackDeclaration?.version ?? null,
        rollbackAvailable: record.rollbackDeclaration !== null,
        lastTransition: record.lastVersionTransition
          ? {
              fromVersion: record.lastVersionTransition.fromVersion,
              toVersion: record.lastVersionTransition.toVersion,
              outcome: record.lastVersionTransition.outcome,
              occurredAt: record.lastVersionTransition.occurredAt,
              externalEffectsRolledBack: false,
              productStateRolledBack: false,
            }
          : null,
        generatedAt,
      },
    });
  }

  async #grantSnapshot(
    query: Extract<GovernanceQuery, { readonly type: "grant.detail" }>,
  ): Promise<GatewayV2Snapshot> {
    const grant = (
      await this.#dependencies.authorization.listGrants(
        this.#dependencies.ownerId,
        this.#dependencies.agentId,
      )
    ).find(({ id }) => id === query.payload.grantId);
    if (!grant || !governedGrant(grant)) {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Governed Grant not found");
    }
    if (
      grant.ownerId !== this.#dependencies.ownerId ||
      grant.agentId !== this.#dependencies.agentId
    ) {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "Grant is outside scope");
    }
    const generatedAt = this.#dependencies.clock.now();
    const exhausted =
      grant.uses >= grant.maxUses ||
      (grant.maxTotalCostMicros > 0 && grant.spentCostMicros >= grant.maxTotalCostMicros);
    const status =
      grant.revokedAt !== null
        ? "revoked"
        : generatedAt >= grant.expiresAt
          ? "expired"
          : exhausted
            ? "exhausted"
            : "active";
    const affectedTaskRefs = distinctSorted(
      await this.#dependencies.dependencies.listTaskRefsByGrant(grant.id),
    );
    return parseSnapshot({
      ...this.#envelope(
        query,
        "grant.snapshot",
        maximumClassification("private", grant.scope.maxDataClassification),
        "medium",
      ),
      payload: {
        grantId: grant.id,
        revision: grant.revision,
        kind: grant.kind,
        status,
        capabilityRef: grant.scope.capabilityRef,
        capabilityVersion: grant.scope.capabilityVersion,
        operations: grant.scope.operations,
        exactResourceRef: grant.scope.exactResourceRef,
        resourceIdentities: grant.scope.resourceIdentities,
        resourcePrefixes: grant.scope.resourcePrefixes,
        maxDataClassification: grant.scope.maxDataClassification,
        disclosure: grant.scope.disclosure,
        sideEffects: grant.scope.sideEffects,
        recipientRefs: grant.scope.recipients,
        maxCostMicrosPerUse: grant.scope.maxCostMicrosPerUse,
        maxFrequency: grant.scope.maxFrequency,
        validFrom: grant.validFrom,
        expiresAt: grant.expiresAt,
        uses: grant.uses,
        maxUses: grant.maxUses,
        spentCostMicros: grant.spentCostMicros,
        maxTotalCostMicros: grant.maxTotalCostMicros,
        sourceApprovalRequestId: grant.sourceApprovalRequestId,
        revokedAt: grant.revokedAt,
        revocationReasonCode: grant.revocationReasonCode,
        affectedTaskRefs,
        generatedAt,
      },
    });
  }
}

export interface GovernanceGatewayV2ControlPlaneDependencies {
  readonly delegate: GatewayV2ControlPlanePort;
  readonly receipts: GovernanceMutationReceiptStorePort;
  readonly authorization: AuthorizationStorePort;
  readonly capabilities: CapabilityRegistryStorePort;
  readonly approvalService: ApprovalService;
  readonly grantService: GrantService;
  readonly capabilityLifecycle: CapabilityLifecycleService;
  readonly audit: AuditLedgerPort;
  readonly clock: ClockPort;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

interface ReceiptAttempt {
  readonly receipt: GovernanceMutationReceipt;
  readonly recovering: boolean;
  readonly completedResult: GatewayCommandResult | null;
}

export class GovernanceGatewayV2ControlPlane implements GatewayV2ControlPlanePort {
  readonly #dependencies: GovernanceGatewayV2ControlPlaneDependencies;

  constructor(dependencies: GovernanceGatewayV2ControlPlaneDependencies) {
    this.#dependencies = dependencies;
  }

  async execute(input: GatewayV2CommandExecution): Promise<GatewayCommandResult> {
    if (!isGovernanceCommand(input.command)) return this.#dependencies.delegate.execute(input);
    this.#assertCommand(input.authentication, input.command);
    const attempt = await this.#begin(input.command);
    if (attempt.completedResult) return attempt.completedResult;

    const resultRef = await this.#mutate(input.authentication, input.command, attempt.recovering);
    await this.#appendAudit(input.command, resultRef);
    const completed = await this.#dependencies.receipts.complete(
      {
        ...attempt.receipt,
        revision: attempt.receipt.revision + 1,
        phase: "completed",
        resultRef,
        committedAt: this.#dependencies.clock.now(),
      },
      attempt.receipt.revision,
    );
    return Object.freeze({
      resultRef: completed.resultRef as string,
      replayed: attempt.recovering,
    });
  }

  #assertCommand(authentication: GatewayAuthenticationContext, command: GovernanceCommand): void {
    if (
      command.scope.ownerId !== this.#dependencies.ownerId ||
      command.scope.agentId !== this.#dependencies.agentId ||
      authentication.ownerId !== this.#dependencies.ownerId ||
      authentication.subjectId !== command.actor.actorId ||
      command.actor.actorType !== "owner" ||
      command.authorizationRef === null
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Governance mutations require the scoped authenticated Owner and authorization",
      );
    }
    if (
      command.type === "approval.respond" &&
      command.payload.recentAuthenticationRef !== null &&
      command.payload.recentAuthenticationRef !== authentication.authenticationRef
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Approval recent authentication does not match the authenticated session",
      );
    }
  }

  async #begin(command: GovernanceCommand): Promise<ReceiptAttempt> {
    const fingerprint = this.#fingerprint(command);
    let receipt = await this.#dependencies.receipts.get(
      this.#dependencies.ownerId,
      this.#dependencies.agentId,
      command.idempotencyKey,
    );
    let recovering = receipt !== undefined;
    if (!receipt) {
      const created: GovernanceMutationReceipt = {
        ownerId: this.#dependencies.ownerId,
        agentId: this.#dependencies.agentId,
        idempotencyKey: command.idempotencyKey,
        revision: 1,
        commandType: command.type,
        semanticFingerprint: fingerprint,
        phase: "executing",
        resultRef: null,
        startedAt: this.#dependencies.clock.now(),
        committedAt: null,
      };
      try {
        receipt = await this.#dependencies.receipts.create(created);
      } catch (error) {
        if (
          !(error instanceof ApplicationPortError) ||
          (error.code !== PORT_ERROR_CODES.DUPLICATE && error.code !== PORT_ERROR_CODES.CONFLICT)
        ) {
          throw error;
        }
        receipt = await this.#dependencies.receipts.get(
          this.#dependencies.ownerId,
          this.#dependencies.agentId,
          command.idempotencyKey,
        );
        recovering = true;
      }
    }
    if (!receipt) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.PROVIDER_FAILURE,
        "Governance receipt could not be established",
      );
    }
    if (receipt.commandType !== command.type || receipt.semanticFingerprint !== fingerprint) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        "Governance idempotency key was already used for a different command",
        { idempotencyKey: command.idempotencyKey },
      );
    }
    return {
      receipt,
      recovering,
      completedResult:
        receipt.phase === "completed"
          ? Object.freeze({ resultRef: receipt.resultRef as string, replayed: true })
          : null,
    };
  }

  #fingerprint(command: GovernanceCommand): string {
    return threadCommandFingerprint({
      type: command.type,
      scope: command.scope,
      authority: command.authority,
      actor: command.actor,
      dataClassification: command.dataClassification,
      risk: command.risk,
      authorizationRef: command.authorizationRef,
      payload: command.payload,
    }).replace("thread-command", "governance-command");
  }

  async #mutate(
    authentication: GatewayAuthenticationContext,
    command: GovernanceCommand,
    recovering: boolean,
  ): Promise<string> {
    switch (command.type) {
      case "approval.respond":
        return this.#respondApproval(authentication, command, recovering);
      case "grant.revoke":
        return this.#revokeGrant(command, recovering);
      case "capability.review":
        return this.#reviewCapability(authentication, command, recovering);
      case "capability.install.approve":
        return this.#approveCapabilityInstallation(command, recovering);
      case "capability.update.respond":
        return this.#respondCapabilityUpdate(command, recovering);
      case "capability.disable":
        return this.#disableCapability(command, recovering);
      case "capability.rollback":
        return this.#rollbackCapability(command, recovering);
    }
  }

  async #respondApproval(
    authentication: GatewayAuthenticationContext,
    command: Extract<GovernanceCommand, { readonly type: "approval.respond" }>,
    recovering: boolean,
  ): Promise<string> {
    if (command.payload.editedPayloadRef !== null) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Edited Approval payloads require a newly frozen ActionIntent",
      );
    }
    const current = await this.#dependencies.authorization.getApproval(
      command.payload.approvalRequestId,
    );
    if (!current || !governedApproval(current)) {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Governed Approval not found");
    }
    this.#assertAuthorizationScope(current.ownerId, current.agentId, "Approval");
    if (
      recovering &&
      current.revision === command.payload.expectedRevision + 1 &&
      current.status === command.payload.decision &&
      current.semanticSnapshotHash === command.payload.semanticSnapshotHash
    ) {
      return `approval:${current.id}:revision-${current.revision}`;
    }
    if (
      command.payload.decision === "approved" &&
      current.recentAuthenticationRequired &&
      command.payload.recentAuthenticationRef !== authentication.authenticationRef
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "This Approval requires the current recent authentication reference",
      );
    }
    const response =
      command.payload.decision === "denied"
        ? ({ decision: "denied" } as const)
        : ({
            decision: "approved" as const,
            grant: this.#dependencies.grantService.create({
              kind: "one_time",
              intent: current.intentSnapshot,
              approvalRequestId: current.id,
              scope: {
                capabilityRef: current.intentSnapshot.capabilityRef,
                capabilityVersion: current.intentSnapshot.capabilityVersion,
                operations: [current.intentSnapshot.operation],
                exactResourceRef: current.intentSnapshot.resourceRef,
                resourcePrefixes: [],
                resourceIdentities: current.intentSnapshot.resourceRefs,
                maxDataClassification: current.intentSnapshot.dataClassification,
                disclosure: current.intentSnapshot.disclosure,
                sideEffects: [current.intentSnapshot.sideEffect],
                recipients: current.intentSnapshot.recipients,
                credentialOrAccessChange: false,
                maxCostMicrosPerUse: current.intentSnapshot.estimatedCostMicros,
                maxFrequency: current.intentSnapshot.frequency,
              },
              expiresAt:
                current.expiresAt <= current.intentSnapshot.expiresAt
                  ? current.expiresAt
                  : current.intentSnapshot.expiresAt,
              maxUses: 1,
              maxTotalCostMicros: current.intentSnapshot.estimatedCostMicros,
            }),
            recentAuthenticationRef: command.payload.recentAuthenticationRef,
          } as const);
    const resolved = await this.#dependencies.approvalService.respond({
      approvalRequestId: current.id,
      expectedRevision: command.payload.expectedRevision,
      semanticSnapshotHash: command.payload.semanticSnapshotHash,
      response,
    });
    return `approval:${resolved.id}:revision-${resolved.revision}`;
  }

  async #revokeGrant(
    command: Extract<GovernanceCommand, { readonly type: "grant.revoke" }>,
    recovering: boolean,
  ): Promise<string> {
    const current = (
      await this.#dependencies.authorization.listGrants(
        this.#dependencies.ownerId,
        this.#dependencies.agentId,
      )
    ).find(({ id }) => id === command.payload.grantId);
    if (!current || !governedGrant(current)) {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Governed Grant not found");
    }
    this.#assertAuthorizationScope(current.ownerId, current.agentId, "Grant");
    if (
      recovering &&
      current.revision === command.payload.expectedRevision + 1 &&
      current.revokedAt !== null &&
      current.revocationReasonCode === command.payload.reasonCode
    ) {
      return `grant:${current.id}:revision-${current.revision}`;
    }
    const revoked = await this.#dependencies.grantService.revoke(
      current.id,
      command.payload.reasonCode,
      command.payload.expectedRevision,
    );
    return `grant:${revoked.id}:revision-${revoked.revision}`;
  }

  async #reviewCapability(
    authentication: GatewayAuthenticationContext,
    command: Extract<GovernanceCommand, { readonly type: "capability.review" }>,
    recovering: boolean,
  ): Promise<string> {
    const current = await this.#requireCapability(command.payload.capabilityRef);
    if (
      recovering &&
      current.revision === command.payload.expectedRevision + 1 &&
      current.lifecycle === "installation_proposed" &&
      capabilityManifest(current.declaration) &&
      current.declaration.reviewedBy === authentication.subjectId
    ) {
      return this.#capabilityResult(current);
    }
    const reviewed = await this.#dependencies.capabilityLifecycle.recordSourceReview(
      current.ref,
      { reviewer: authentication.subjectId, reviewedAt: this.#dependencies.clock.now() },
      command.payload.expectedRevision,
    );
    return this.#capabilityResult(reviewed);
  }

  async #approveCapabilityInstallation(
    command: Extract<GovernanceCommand, { readonly type: "capability.install.approve" }>,
    recovering: boolean,
  ): Promise<string> {
    let current = await this.#requireCapability(command.payload.capabilityRef);
    if (
      recovering &&
      current.revision === command.payload.expectedRevision + 2 &&
      current.lifecycle === "active" &&
      current.approvalRefs.includes(command.payload.approvalRef)
    ) {
      return this.#capabilityResult(current);
    }
    if (
      recovering &&
      current.revision === command.payload.expectedRevision + 1 &&
      current.lifecycle === "installation_approved" &&
      current.approvalRefs.includes(command.payload.approvalRef)
    ) {
      current = await this.#dependencies.capabilityLifecycle.activate(
        current.ref,
        current.revision,
      );
      return this.#capabilityResult(current);
    }
    current = await this.#dependencies.capabilityLifecycle.approveInstallation(
      current.ref,
      command.payload.approvalRef,
      command.payload.expectedRevision,
    );
    current = await this.#dependencies.capabilityLifecycle.activate(current.ref, current.revision);
    return this.#capabilityResult(current);
  }

  async #respondCapabilityUpdate(
    command: Extract<GovernanceCommand, { readonly type: "capability.update.respond" }>,
    recovering: boolean,
  ): Promise<string> {
    let current = await this.#requireCapability(command.payload.capabilityRef);
    if (command.payload.decision === "denied") {
      if (
        recovering &&
        current.revision === command.payload.expectedRevision + 1 &&
        current.lifecycle === "active" &&
        current.lastVersionTransition?.outcome === "rejected"
      ) {
        return this.#capabilityResult(current);
      }
      current = await this.#dependencies.capabilityLifecycle.rejectUpdate(
        current.ref,
        command.payload.expectedRevision,
      );
      return this.#capabilityResult(current);
    }
    const approvalRef = command.payload.approvalRef;
    if (approvalRef === null) {
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "Approval ref required");
    }
    if (
      recovering &&
      current.revision === command.payload.expectedRevision + 2 &&
      current.lifecycle === "active" &&
      current.approvalRefs.includes(approvalRef) &&
      current.lastVersionTransition?.outcome === "activated"
    ) {
      return this.#capabilityResult(current);
    }
    if (
      recovering &&
      current.revision === command.payload.expectedRevision + 1 &&
      current.lifecycle === "update_approved" &&
      current.approvalRefs.includes(approvalRef)
    ) {
      current = await this.#dependencies.capabilityLifecycle.activateUpdate(
        current.ref,
        current.revision,
      );
      return this.#capabilityResult(current);
    }
    current = await this.#dependencies.capabilityLifecycle.approveUpdate(
      current.ref,
      approvalRef,
      command.payload.expectedRevision,
    );
    current = await this.#dependencies.capabilityLifecycle.activateUpdate(
      current.ref,
      current.revision,
    );
    return this.#capabilityResult(current);
  }

  async #disableCapability(
    command: Extract<GovernanceCommand, { readonly type: "capability.disable" }>,
    recovering: boolean,
  ): Promise<string> {
    const current = await this.#requireCapability(command.payload.capabilityRef);
    if (
      recovering &&
      current.revision === command.payload.expectedRevision + 1 &&
      current.lifecycle === "disabled"
    ) {
      return this.#capabilityResult(current);
    }
    const disabled = await this.#dependencies.capabilityLifecycle.disable(
      current.ref,
      command.payload.expectedRevision,
    );
    return this.#capabilityResult(disabled);
  }

  async #rollbackCapability(
    command: Extract<GovernanceCommand, { readonly type: "capability.rollback" }>,
    recovering: boolean,
  ): Promise<string> {
    const current = await this.#requireCapability(command.payload.capabilityRef);
    if (
      recovering &&
      current.revision === command.payload.expectedRevision + 1 &&
      current.lifecycle === "active" &&
      current.lastVersionTransition?.outcome === "rolled_back"
    ) {
      return this.#capabilityResult(current);
    }
    const rolledBack = await this.#dependencies.capabilityLifecycle.rollback(
      current.ref,
      command.payload.expectedRevision,
    );
    return this.#capabilityResult(rolledBack);
  }

  async #requireCapability(capabilityRef: string): Promise<CapabilityRegistryRecord> {
    const record = await this.#dependencies.capabilities.get(capabilityRef);
    if (!record || !capabilityManifest(record.declaration)) {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Governed Capability not found");
    }
    return record;
  }

  #assertAuthorizationScope(ownerId: OwnerId, agentId: AgentId, kind: string): void {
    if (ownerId !== this.#dependencies.ownerId || agentId !== this.#dependencies.agentId) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        `${kind} is outside the configured Owner and Agent scope`,
      );
    }
  }

  #capabilityResult(record: CapabilityRegistryRecord): string {
    return `capability:${record.ref}:revision-${record.revision}`;
  }

  async #appendAudit(command: GovernanceCommand, resultRef: string): Promise<void> {
    try {
      await this.#dependencies.audit.append({
        id: `governance-audit:${command.idempotencyKey}`,
        ownerId: this.#dependencies.ownerId,
        agentId: this.#dependencies.agentId,
        action: command.type,
        targetRef: `${this.#target(command)}@${resultRef}`,
        outcome: "completed",
        occurredAt: this.#dependencies.clock.now(),
      });
    } catch (error) {
      if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.DUPLICATE) {
        throw error;
      }
    }
  }

  #target(command: GovernanceCommand): string {
    switch (command.type) {
      case "approval.respond":
        return command.payload.approvalRequestId;
      case "grant.revoke":
        return command.payload.grantId;
      default:
        return command.payload.capabilityRef;
    }
  }
}
