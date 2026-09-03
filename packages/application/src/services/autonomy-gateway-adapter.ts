import type { AgentId, OwnerId } from "@himawari-agent/domain";
import {
  gatewayV2MessageSchema,
  type GatewayV2Command,
  type GatewayV2Event,
  type GatewayV2Query,
  type GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type DelegationStatePort,
  type GatewayAuthenticationContext,
  type GatewayCommandResult,
  type GovernanceMutationReceipt,
  type GovernanceMutationReceiptStorePort,
  type GatewayV2CommandExecution,
  type GatewayV2ControlPlanePort,
  type GatewayV2ReadModelPort,
  type ImprovementStatePort,
  type JsonObject,
  type ProactivityStatePort,
} from "../ports/index.js";
import type { ClockPort } from "../ports/system.js";
import type { ImprovementCandidateService } from "./improvement-candidate-service.js";
import type { ReflectionService } from "./reflection-service.js";
import type { SuggestionService } from "./suggestion-service.js";
import { threadCommandFingerprint } from "./thread-command-service.js";

type AutonomyCommand = Extract<
  GatewayV2Command,
  { readonly type: "suggestion.respond" | "reflection.configure" | "improvement.review" }
>;
type AutonomyQuery = Extract<
  GatewayV2Query,
  {
    readonly type:
      | "suggestion.list"
      | "suggestion.detail"
      | "reflection.detail"
      | "delegation.detail"
      | "delegation.list"
      | "improvement.list"
      | "improvement.detail";
  }
>;

const COMMANDS = new Set<GatewayV2Command["type"]>([
  "suggestion.respond",
  "reflection.configure",
  "improvement.review",
]);
const QUERIES = new Set<GatewayV2Query["type"]>([
  "suggestion.list",
  "suggestion.detail",
  "reflection.detail",
  "delegation.detail",
  "delegation.list",
  "improvement.list",
  "improvement.detail",
]);

function parseSnapshot(value: unknown): GatewayV2Snapshot {
  const parsed = gatewayV2MessageSchema.parse(value);
  if (parsed.kind !== "snapshot") throw new TypeError("Autonomy projection is not a snapshot");
  return parsed;
}

function page(refs: readonly string[], afterCursor: string | null, limit: number) {
  const start = afterCursor === null ? 0 : refs.indexOf(afterCursor) + 1;
  if (afterCursor !== null && start === 0)
    throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Collection cursor not found");
  const itemRefs = refs.slice(start, start + limit);
  return {
    itemRefs,
    nextCursor: start + itemRefs.length < refs.length ? (itemRefs.at(-1) ?? null) : null,
  };
}

export class AutonomyGatewayV2ControlPlane implements GatewayV2ControlPlanePort {
  readonly #dependencies: {
    readonly delegate: GatewayV2ControlPlanePort;
    readonly suggestions: SuggestionService;
    readonly reflections: ReflectionService;
    readonly improvements: ImprovementCandidateService;
    readonly proactivityState: ProactivityStatePort;
    readonly improvementState: ImprovementStatePort;
    readonly receipts: GovernanceMutationReceiptStorePort;
    readonly clock: ClockPort;
  };

  constructor(dependencies: {
    readonly delegate: GatewayV2ControlPlanePort;
    readonly suggestions: SuggestionService;
    readonly reflections: ReflectionService;
    readonly improvements: ImprovementCandidateService;
    readonly proactivityState: ProactivityStatePort;
    readonly improvementState: ImprovementStatePort;
    readonly receipts: GovernanceMutationReceiptStorePort;
    readonly clock: ClockPort;
  }) {
    this.#dependencies = dependencies;
  }

  async execute(input: GatewayV2CommandExecution): Promise<GatewayCommandResult> {
    if (!COMMANDS.has(input.command.type)) return this.#dependencies.delegate.execute(input);
    const command = input.command as AutonomyCommand;
    this.#assertAuthentication(input.authentication, command);
    const attempt = await this.#begin(command);
    if (attempt.completed) return attempt.completed;
    const resultRef = await this.#mutate(command, attempt.recovering);
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

  async #mutate(command: AutonomyCommand, recovering: boolean): Promise<string> {
    if (command.type === "suggestion.respond") {
      const state = await this.#dependencies.proactivityState.read(
        command.scope.ownerId as OwnerId,
        command.scope.agentId as AgentId,
      );
      const candidate = state.state.suggestions.find(
        ({ id }) => id === command.payload.suggestionId,
      );
      if (!candidate)
        throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Suggestion was not found");
      if (candidate.revision !== command.payload.expectedRevision) {
        const recoveredStatus = command.payload.decision === "approve" ? "approved" : "rejected";
        if (
          recovering &&
          candidate.status === recoveredStatus &&
          candidate.responseIdempotencyKeys.includes(command.idempotencyKey)
        ) {
          const recovered = await this.#dependencies.suggestions.respond({
            ownerId: command.scope.ownerId as OwnerId,
            agentId: command.scope.agentId as AgentId,
            suggestionId: candidate.id,
            decision: command.payload.decision,
            idempotencyKey: command.idempotencyKey,
            expectedRevision: command.payload.expectedRevision,
          });
          return `suggestion:${recovered.id}:${recovered.revision}`;
        }
        throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Suggestion revision changed");
      }
      const result = await this.#dependencies.suggestions.respond({
        ownerId: command.scope.ownerId as OwnerId,
        agentId: command.scope.agentId as AgentId,
        suggestionId: command.payload.suggestionId,
        decision: command.payload.decision,
        expectedRevision: command.payload.expectedRevision,
        idempotencyKey: command.idempotencyKey,
      });
      return `suggestion:${result.id}:${result.revision}`;
    }
    if (command.type === "reflection.configure") {
      const state = await this.#dependencies.proactivityState.read(
        command.scope.ownerId as OwnerId,
        command.scope.agentId as AgentId,
      );
      const currentRevision = state.state.reflectionDefinition?.revision ?? 0;
      if (currentRevision !== command.payload.expectedRevision) {
        const current = state.state.reflectionDefinition;
        if (
          recovering &&
          currentRevision === command.payload.expectedRevision + 1 &&
          current !== null &&
          this.#reflectionMatches(current, command)
        ) {
          return `reflection:${current.revision}`;
        }
        throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Reflection revision changed");
      }
      const saved = await this.#dependencies.reflections.configure({
        id: "global-reflection",
        revision: currentRevision + 1,
        ownerId: command.scope.ownerId as OwnerId,
        agentId: command.scope.agentId as AgentId,
        schedule: command.payload.schedule,
        timezone: command.payload.timezone,
        dailySuggestionQuota: command.payload.dailySuggestionQuota,
        maximumContextItems: command.payload.maximumContextItems,
        maximumCostMicros: command.payload.maximumCostMicros,
        timeoutMs: command.payload.timeoutMs,
        maximumCandidates: command.payload.maximumCandidates,
        enabled: command.payload.enabled,
      });
      return `reflection:${saved.revision}`;
    }
    const candidate = await this.#dependencies.improvementState.read(
      { ownerId: command.scope.ownerId as OwnerId, agentId: command.scope.agentId as AgentId },
      command.payload.candidateId,
    );
    if (!candidate)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Improvement not found");
    if (candidate.revision !== command.payload.expectedRevision) {
      const recoveredStatus =
        command.payload.decision === "reject" ? "rejected" : "revision_requested";
      if (
        recovering &&
        candidate?.revision === command.payload.expectedRevision + 1 &&
        candidate.status === recoveredStatus
      ) {
        return `improvement:${candidate.id}:${candidate.revision}`;
      }
      throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Improvement revision changed");
    }
    const result = await this.#dependencies.improvements.review({
      candidateId: command.payload.candidateId,
      decision: command.payload.decision,
      scope: {
        ownerId: command.scope.ownerId as OwnerId,
        agentId: command.scope.agentId as AgentId,
      },
      expectedRevision: command.payload.expectedRevision,
    });
    return `improvement:${result.id}:${result.revision}`;
  }

  #reflectionMatches(
    current: NonNullable<
      Awaited<ReturnType<ProactivityStatePort["read"]>>["state"]["reflectionDefinition"]
    >,
    command: Extract<AutonomyCommand, { readonly type: "reflection.configure" }>,
  ): boolean {
    return (
      current.schedule === command.payload.schedule &&
      current.timezone === command.payload.timezone &&
      current.dailySuggestionQuota === command.payload.dailySuggestionQuota &&
      current.maximumContextItems === command.payload.maximumContextItems &&
      current.maximumCostMicros === command.payload.maximumCostMicros &&
      current.timeoutMs === command.payload.timeoutMs &&
      current.maximumCandidates === command.payload.maximumCandidates &&
      current.enabled === command.payload.enabled
    );
  }

  async #begin(command: AutonomyCommand): Promise<{
    readonly receipt: GovernanceMutationReceipt;
    readonly recovering: boolean;
    readonly completed: GatewayCommandResult | null;
  }> {
    const fingerprint = threadCommandFingerprint({
      type: command.type,
      scope: command.scope,
      authority: command.authority,
      actor: command.actor,
      payload: command.payload,
    });
    let receipt = await this.#dependencies.receipts.get(
      command.scope.ownerId as OwnerId,
      command.scope.agentId as AgentId,
      command.idempotencyKey,
    );
    let recovering = receipt !== undefined;
    if (!receipt) {
      try {
        receipt = await this.#dependencies.receipts.create({
          ownerId: command.scope.ownerId as OwnerId,
          agentId: command.scope.agentId as AgentId,
          idempotencyKey: command.idempotencyKey,
          revision: 1,
          commandType: command.type,
          semanticFingerprint: fingerprint,
          phase: "executing",
          resultRef: null,
          startedAt: this.#dependencies.clock.now(),
          committedAt: null,
        });
      } catch (error) {
        if (
          !(error instanceof ApplicationPortError) ||
          ![PORT_ERROR_CODES.DUPLICATE, PORT_ERROR_CODES.CONFLICT].includes(error.code as never)
        ) {
          throw error;
        }
        receipt = await this.#dependencies.receipts.get(
          command.scope.ownerId as OwnerId,
          command.scope.agentId as AgentId,
          command.idempotencyKey,
        );
        recovering = true;
      }
    }
    if (!receipt)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.PROVIDER_FAILURE,
        "Autonomy receipt unavailable",
      );
    if (receipt.commandType !== command.type || receipt.semanticFingerprint !== fingerprint)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        "Autonomy idempotency key was reused",
      );
    return Object.freeze({
      receipt,
      recovering,
      completed:
        receipt.phase === "completed"
          ? Object.freeze({ resultRef: receipt.resultRef as string, replayed: true })
          : null,
    });
  }

  #assertAuthentication(authentication: GatewayAuthenticationContext, command: AutonomyCommand) {
    if (
      authentication.ownerId !== command.scope.ownerId ||
      authentication.subjectId !== command.actor.actorId ||
      command.actor.actorType !== "owner"
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Autonomy governance commands require the authenticated Owner",
      );
  }
}

export class AutonomyGatewayV2ReadModel implements GatewayV2ReadModelPort {
  readonly #dependencies: {
    readonly delegate: GatewayV2ReadModelPort;
    readonly proactivity: ProactivityStatePort;
    readonly delegations: DelegationStatePort;
    readonly improvements: ImprovementStatePort;
    readonly protectJson: (value: JsonObject) => Promise<string>;
    readonly clock: ClockPort;
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
  };

  constructor(dependencies: {
    readonly delegate: GatewayV2ReadModelPort;
    readonly proactivity: ProactivityStatePort;
    readonly delegations: DelegationStatePort;
    readonly improvements: ImprovementStatePort;
    readonly protectJson: (value: JsonObject) => Promise<string>;
    readonly clock: ClockPort;
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
  }) {
    this.#dependencies = dependencies;
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (!QUERIES.has(query.type)) return this.#dependencies.delegate.query(query);
    const autonomy = query as AutonomyQuery;
    this.#assertScope(autonomy);
    if (autonomy.type === "suggestion.list") return this.#suggestionList(autonomy);
    if (autonomy.type === "suggestion.detail") return this.#suggestionDetail(autonomy);
    if (autonomy.type === "reflection.detail") return this.#reflectionDetail(autonomy);
    if (autonomy.type === "delegation.detail") return this.#delegationDetail(autonomy);
    if (autonomy.type === "delegation.list") return this.#delegationList(autonomy);
    if (autonomy.type === "improvement.list") return this.#improvementList(autonomy);
    return this.#improvementDetail(autonomy);
  }

  subscribe(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly afterCursor: string | null;
  }): AsyncIterable<GatewayV2Event> {
    return this.#dependencies.delegate.subscribe(input);
  }

  async #suggestionList(query: Extract<AutonomyQuery, { type: "suggestion.list" }>) {
    const state = await this.#dependencies.proactivity.read(
      this.#dependencies.ownerId,
      this.#dependencies.agentId,
    );
    const refs = state.state.suggestions
      .filter(({ status }) => query.payload.status === null || status === query.payload.status)
      .map(({ id }) => id)
      .sort();
    return this.#collection(
      query,
      "suggestions",
      page(refs, query.payload.afterCursor, query.payload.limit),
    );
  }

  async #suggestionDetail(query: Extract<AutonomyQuery, { type: "suggestion.detail" }>) {
    const state = await this.#dependencies.proactivity.read(
      this.#dependencies.ownerId,
      this.#dependencies.agentId,
    );
    const item = state.state.suggestions.find(({ id }) => id === query.payload.suggestionId);
    if (!item) throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Suggestion not found");
    return parseSnapshot({
      ...this.#envelope(query, "suggestion.snapshot", "private", "low"),
      payload: {
        suggestionId: item.id,
        revision: item.revision,
        status: item.status,
        kind: item.kind,
        titleRef: item.titleRef,
        bodyRef: item.bodyRef,
        evidenceRefs: item.evidenceRefs,
        sourceWatermark: item.sourceWatermark,
        goalRef: item.goalRef,
        commitmentRef: item.commitmentRef,
        confidencePermille: item.confidencePermille,
        noveltyPermille: item.noveltyPermille,
        semanticKey: item.semanticKey,
        estimatedCapabilityRefs: item.taskDraft.capabilityRefs,
        estimatedDataClassifications: item.estimatedDataClasses,
        estimatedCostMicros: item.taskDraft.estimatedCostMicros,
        deliveryRef: item.deliveryRef,
        taskRef: item.taskRef,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
        generatedAt: this.#dependencies.clock.now(),
      },
    });
  }

  async #reflectionDetail(query: Extract<AutonomyQuery, { type: "reflection.detail" }>) {
    const state = await this.#dependencies.proactivity.read(
      this.#dependencies.ownerId,
      this.#dependencies.agentId,
    );
    const definition = state.state.reflectionDefinition;
    if (!definition)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Reflection is not configured");
    const latest = query.payload.includeCheckpoints
      ? state.state.reflectionCheckpoints.at(-1)
      : undefined;
    return parseSnapshot({
      ...this.#envelope(query, "reflection.snapshot", "private", "low"),
      payload: {
        revision: definition.revision,
        schedule: definition.schedule,
        timezone: definition.timezone,
        dailySuggestionQuota: definition.dailySuggestionQuota,
        maximumContextItems: definition.maximumContextItems,
        maximumCostMicros: definition.maximumCostMicros,
        timeoutMs: definition.timeoutMs,
        maximumCandidates: definition.maximumCandidates,
        enabled: definition.enabled,
        latestInputWatermark: latest?.inputWatermark ?? null,
        latestOutcome: latest?.outcome ?? null,
        latestErrorCode: latest?.errorCode ?? null,
        generatedAt: this.#dependencies.clock.now(),
      },
    });
  }

  async #delegationDetail(query: Extract<AutonomyQuery, { type: "delegation.detail" }>) {
    const item = await this.#dependencies.delegations.read(
      this.#dependencies,
      query.payload.delegationId,
    );
    if (!item) throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Delegation not found");
    const outputSchemaRef = await this.#dependencies.protectJson(item.outputSchema);
    return parseSnapshot({
      ...this.#envelope(query, "delegation.snapshot", item.dataClassification, "low"),
      payload: {
        delegationId: item.id,
        revision: item.revision,
        parentRunId: item.parentRunId,
        workerRunId: item.workerRunId,
        traceRef: item.traceRef,
        subtaskRef: item.subtaskRef,
        outputSchemaRef,
        contextRefs: item.contextRefs,
        capabilityHandleRefs: item.capabilityHandleRefs,
        allowedModelRefs: item.allowedModelRefs,
        dataClassification: item.dataClassification,
        maximumDurationMs: item.budget.maximumDurationMs,
        maximumCostMicros: item.budget.maximumCostMicros,
        maximumProgressEvents: item.budget.maximumProgressEvents,
        status: item.status,
        resultRef: item.workerResult?.conclusionRef ?? null,
        failureReasonCode: item.failureReasonCode,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        generatedAt: this.#dependencies.clock.now(),
      },
    });
  }

  async #delegationList(query: Extract<AutonomyQuery, { type: "delegation.list" }>) {
    const items = await this.#dependencies.delegations.list(
      this.#dependencies.ownerId,
      this.#dependencies.agentId,
    );
    const refs = items
      .filter(({ status }) => query.payload.status === null || status === query.payload.status)
      .map(({ id }) => id)
      .sort();
    return this.#collection(
      query,
      "delegations",
      page(refs, query.payload.afterCursor, query.payload.limit),
    );
  }

  async #improvementList(query: Extract<AutonomyQuery, { type: "improvement.list" }>) {
    const items = await this.#dependencies.improvements.list(
      this.#dependencies.ownerId,
      this.#dependencies.agentId,
    );
    const refs = items
      .filter(({ status }) => query.payload.status === null || status === query.payload.status)
      .map(({ id }) => id)
      .sort();
    return this.#collection(
      query,
      "improvements",
      page(refs, query.payload.afterCursor, query.payload.limit),
    );
  }

  async #improvementDetail(query: Extract<AutonomyQuery, { type: "improvement.detail" }>) {
    const item = await this.#dependencies.improvements.read(
      this.#dependencies,
      query.payload.candidateId,
    );
    if (!item) throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Improvement not found");
    const comparisonRef = item.comparison
      ? await this.#dependencies.protectJson(item.comparison as unknown as JsonObject)
      : null;
    return parseSnapshot({
      ...this.#envelope(query, "improvement.snapshot", "private", item.risk),
      payload: {
        candidateId: item.id,
        revision: item.revision,
        baseRevision: item.baseRevision,
        baseDigest: item.baseDigest,
        observableProblemRef: item.observableProblemRef,
        goalRef: item.goalRef,
        invariantRefs: item.invariantRefs,
        allowedPathRefs: item.allowedPaths,
        patchRef: item.patchRef,
        patchDigest: item.patchDigest,
        validationRefs: item.validation.map(({ commandObservationRef }) => commandObservationRef),
        comparisonRef,
        artifactRef: item.artifactRef,
        artifactDigest: item.artifactDigest,
        risk: item.risk,
        protectedRootFacts: item.protectedRootFacts,
        status: item.status,
        reviewRequired: true,
        expiresAt: item.expiresAt,
        generatedAt: this.#dependencies.clock.now(),
      },
    });
  }

  #collection(
    query: AutonomyQuery,
    category: "suggestions" | "improvements" | "delegations",
    payload: { readonly itemRefs: readonly string[]; readonly nextCursor: string | null },
  ) {
    return parseSnapshot({
      ...this.#envelope(query, "collection.snapshot", "private", "low"),
      payload: {
        category,
        ...payload,
        snapshotRef: `snapshot:${category}:${query.messageId}`,
        generatedAt: this.#dependencies.clock.now(),
      },
    });
  }

  #envelope(
    query: AutonomyQuery,
    type: GatewayV2Snapshot["type"],
    dataClassification: "public" | "private" | "sensitive" | "restricted",
    risk: "low" | "medium" | "high" | "critical",
  ) {
    return {
      schemaVersion: query.schemaVersion,
      kind: "snapshot" as const,
      type,
      messageId: `snapshot:${query.messageId}`.slice(0, 128),
      correlationId: query.correlationId,
      causationId: query.messageId,
      dataClassification,
      risk,
      authorizationRef: query.authorizationRef,
      scope: query.scope,
      authority: query.authority,
      actor: { actorType: "system" as const, actorId: "autonomy-gateway" },
    };
  }

  #assertScope(query: AutonomyQuery): void {
    if (
      query.scope.ownerId !== this.#dependencies.ownerId ||
      query.scope.agentId !== this.#dependencies.agentId
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Autonomy query is outside scope",
      );
  }
}
