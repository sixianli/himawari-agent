import type { AgentId, OwnerId, RunId, SessionId, ThreadId } from "@himawari-agent/domain";
import type { SecretPort } from "../ports/capabilities.js";
import type {
  CausationId,
  CorrelationId,
  DataClassification,
  PayloadRef,
  TraceEventId,
} from "../ports/common.js";
import type {
  ModelDescriptor,
  ModelDisclosure,
  ModelInvocationEvent,
  ModelPort,
} from "../ports/intelligence.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";
import type { SessionTraceRecorder } from "./session-trace-recorder.js";

const DISCLOSURE_RANK = Object.freeze({
  local_only: 0,
  trusted_remote: 1,
  external_remote: 2,
});

export type ModelTaskProfile = "primary" | "specialist" | "local";

export interface ModelRouteRequest {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly threadId: ThreadId | null;
  readonly runId: RunId;
  readonly taskProfile: ModelTaskProfile;
  readonly requiredCapabilities: readonly string[];
  readonly inputRef: PayloadRef;
  readonly dataClassification: DataClassification;
  readonly maxDisclosure: ModelDisclosure;
  readonly allowedDisclosureRef: string;
  readonly forbidFallbackDisclosureExpansion: boolean;
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId;
  readonly parentEventId: TraceEventId | null;
  readonly actorId: string;
  readonly deadlineAt: string;
}

export interface ModelRouteUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
  readonly latencyMs: number;
}

export type ModelRouteResult =
  | {
      readonly status: "completed";
      readonly selectedModelRef: string;
      readonly attempts: number;
      readonly outputRefs: readonly PayloadRef[];
      readonly usage: ModelRouteUsage;
    }
  | {
      readonly status: "blocked" | "failed";
      readonly selectedModelRef: string | null;
      readonly attempts: number;
      readonly errorCode: string;
    };

export interface ModelRouterServiceDependencies {
  readonly model: ModelPort;
  readonly secrets: SecretPort;
  readonly trace: SessionTraceRecorder;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
}

interface CandidateEvaluation {
  readonly descriptor: ModelDescriptor;
  readonly allowed: boolean;
  readonly reasonCodes: readonly string[];
}

type AttemptResult =
  | {
      readonly status: "completed";
      readonly outputRefs: readonly PayloadRef[];
      readonly usage: ModelRouteUsage;
    }
  | {
      readonly status: "failed";
      readonly errorCode: string;
      readonly retryable: boolean;
    };

export class ModelRouterService {
  private readonly dependencies: ModelRouterServiceDependencies;

  constructor(dependencies: ModelRouterServiceDependencies) {
    this.dependencies = dependencies;
  }

  async route(request: ModelRouteRequest): Promise<ModelRouteResult> {
    let parentEventId = request.parentEventId;
    let causationId: CausationId = request.causationId;
    const record = async (eventType: string, payload: unknown, occurredAt?: string) => {
      const result = await this.dependencies.trace.record({
        ownerId: request.ownerId,
        agentId: request.agentId,
        sessionId: request.sessionId,
        threadId: request.threadId,
        runId: request.runId,
        turnId: null,
        parentEventId,
        causationId,
        correlationId: request.correlationId,
        actorId: request.actorId,
        dataClassification: request.dataClassification,
        eventType,
        ...(occurredAt === undefined ? {} : { occurredAt }),
        payload,
      });
      parentEventId = result.event.id;
      causationId = result.event.id;
    };

    const descriptors = await this.dependencies.model.listAvailable();
    const initialEvaluations = descriptors.map((candidate) =>
      this.evaluateCandidate(candidate, request, "initial", null),
    );
    const initial = this.select(initialEvaluations, request.taskProfile);
    await record(
      "model.route_decided",
      this.routeDecisionPayload(request, initialEvaluations, initial),
    );
    if (!initial) {
      return Object.freeze({
        status: "blocked",
        selectedModelRef: null,
        attempts: 0,
        errorCode: "MODEL_ROUTE_UNAVAILABLE",
      });
    }

    const first = await this.invoke(initial, request, record);
    if (first.status === "completed") {
      return Object.freeze({
        status: "completed",
        selectedModelRef: initial.ref,
        attempts: 1,
        outputRefs: first.outputRefs,
        usage: first.usage,
      });
    }
    if (!first.retryable) {
      return Object.freeze({
        status: "failed",
        selectedModelRef: initial.ref,
        attempts: 1,
        errorCode: first.errorCode,
      });
    }

    const fallbackEvaluations = descriptors.map((candidate) =>
      this.evaluateCandidate(candidate, request, "fallback", initial.disclosure),
    );
    const fallback = this.select(fallbackEvaluations, "fallback");
    if (!fallback) {
      const disclosureBlocked = fallbackEvaluations.some(
        ({ descriptor, reasonCodes }) =>
          descriptor.routingClass === "fallback" &&
          reasonCodes.length === 1 &&
          reasonCodes[0] === "fallback_disclosure_expansion",
      );
      const errorCode = disclosureBlocked
        ? "MODEL_FALLBACK_DISCLOSURE_BLOCKED"
        : "MODEL_FALLBACK_UNAVAILABLE";
      await record("model.fallback_blocked", {
        failedModelRef: initial.ref,
        failedErrorCode: first.errorCode,
        errorCode,
        candidates: this.candidatePayload(fallbackEvaluations),
      });
      return Object.freeze({
        status: "blocked",
        selectedModelRef: initial.ref,
        attempts: 1,
        errorCode,
      });
    }

    await record("model.retry", {
      failedModelRef: initial.ref,
      failedErrorCode: first.errorCode,
      nextModelRef: fallback.ref,
      nextDisclosure: fallback.disclosure,
    });
    await record(
      "model.route_decided",
      this.routeDecisionPayload(request, fallbackEvaluations, fallback),
    );
    const second = await this.invoke(fallback, request, record);
    if (second.status === "completed") {
      return Object.freeze({
        status: "completed",
        selectedModelRef: fallback.ref,
        attempts: 2,
        outputRefs: second.outputRefs,
        usage: second.usage,
      });
    }
    return Object.freeze({
      status: "failed",
      selectedModelRef: fallback.ref,
      attempts: 2,
      errorCode: second.errorCode,
    });
  }

  private evaluateCandidate(
    descriptor: ModelDescriptor,
    request: ModelRouteRequest,
    phase: "initial" | "fallback",
    previousDisclosure: ModelDisclosure | null,
  ): CandidateEvaluation {
    const reasons: string[] = [];
    if (phase === "initial" && descriptor.routingClass === "fallback") {
      reasons.push("fallback_only");
    }
    if (phase === "fallback" && descriptor.routingClass !== "fallback") {
      reasons.push("not_fallback");
    }
    if (!request.requiredCapabilities.every((item) => descriptor.capabilities.includes(item))) {
      reasons.push("capability_mismatch");
    }
    if (!descriptor.allowedDataClassifications.includes(request.dataClassification)) {
      reasons.push("classification_not_allowed");
    }
    if (DISCLOSURE_RANK[descriptor.disclosure] > DISCLOSURE_RANK[request.maxDisclosure]) {
      reasons.push("request_disclosure_exceeded");
    }
    if (
      phase === "fallback" &&
      previousDisclosure !== null &&
      request.forbidFallbackDisclosureExpansion &&
      DISCLOSURE_RANK[descriptor.disclosure] > DISCLOSURE_RANK[previousDisclosure]
    ) {
      reasons.push("fallback_disclosure_expansion");
    }
    return Object.freeze({
      descriptor,
      allowed: reasons.length === 0,
      reasonCodes: Object.freeze(reasons),
    });
  }

  private select(
    evaluations: readonly CandidateEvaluation[],
    routingClass: ModelDescriptor["routingClass"],
  ): ModelDescriptor | undefined {
    return evaluations
      .filter(({ allowed, descriptor }) => allowed && descriptor.routingClass === routingClass)
      .sort(
        (left, right) =>
          left.descriptor.priority - right.descriptor.priority ||
          left.descriptor.ref.localeCompare(right.descriptor.ref),
      )[0]?.descriptor;
  }

  private routeDecisionPayload(
    request: ModelRouteRequest,
    evaluations: readonly CandidateEvaluation[],
    selected: ModelDescriptor | undefined,
  ) {
    return {
      taskProfile: request.taskProfile,
      requiredCapabilities: request.requiredCapabilities,
      dataClassification: request.dataClassification,
      maxDisclosure: request.maxDisclosure,
      allowedDisclosureRef: request.allowedDisclosureRef,
      forbidFallbackDisclosureExpansion: request.forbidFallbackDisclosureExpansion,
      candidates: this.candidatePayload(evaluations),
      selected: selected ? this.modelIdentity(selected) : null,
    };
  }

  private candidatePayload(evaluations: readonly CandidateEvaluation[]) {
    return evaluations.map(({ descriptor, allowed, reasonCodes }) => ({
      ...this.modelIdentity(descriptor),
      allowed,
      reasonCodes,
    }));
  }

  private modelIdentity(descriptor: ModelDescriptor) {
    return {
      modelRef: descriptor.ref,
      provider: descriptor.provider,
      model: descriptor.model,
      version: descriptor.version,
      routingClass: descriptor.routingClass,
      disclosure: descriptor.disclosure,
    };
  }

  private async invoke(
    descriptor: ModelDescriptor,
    request: ModelRouteRequest,
    record: (eventType: string, payload: unknown, occurredAt?: string) => Promise<void>,
  ): Promise<AttemptResult> {
    const invocationId = this.dependencies.ids.next("model-invocation");
    const secretHandleRefs: string[] = [];
    try {
      if (descriptor.secretRequirement) {
        const handle = await this.dependencies.secrets.issueHandle({
          ownerId: request.ownerId,
          agentId: request.agentId,
          runId: request.runId,
          secretRef: descriptor.secretRequirement.secretRef,
          secretVersion: descriptor.secretRequirement.secretVersion,
          purpose: descriptor.secretRequirement.purpose,
          scopeRef: invocationId,
          expiresAt: request.deadlineAt,
        });
        secretHandleRefs.push(handle.ref);
      }

      await record("model.request", {
        invocationId,
        ...this.modelIdentity(descriptor),
        inputRef: request.inputRef,
        dataClassification: request.dataClassification,
        allowedDisclosureRef: request.allowedDisclosureRef,
        secretUsage: descriptor.secretRequirement,
        secretHandleRefs,
      });

      const outputRefs: PayloadRef[] = [];
      const outputSequences = new Set<number>();
      try {
        for await (const event of this.dependencies.model.invoke({
          invocationId,
          runId: request.runId,
          modelRef: descriptor.ref,
          inputRef: request.inputRef,
          dataClassification: request.dataClassification,
          allowedDisclosureRef: request.allowedDisclosureRef,
          secretHandleRefs,
          correlationId: request.correlationId,
        })) {
          if (event.invocationId !== invocationId) {
            return await this.recordFailure(
              descriptor,
              record,
              "MODEL_INVOCATION_MISMATCH",
              false,
              0,
              this.dependencies.clock.now(),
            );
          }
          // Providers may retry a streamed chunk after a transport boundary. A
          // repeated sequence is not a second business result and must not create
          // another Trace/Payload reference.
          if (event.type === "model.output") {
            if (outputSequences.has(event.sequence)) continue;
            outputSequences.add(event.sequence);
          }
          const terminal = await this.mapProviderEvent(descriptor, event, outputRefs, record);
          if (terminal) return terminal;
        }
      } catch {
        return await this.recordFailure(
          descriptor,
          record,
          "MODEL_PROVIDER_ERROR",
          false,
          0,
          this.dependencies.clock.now(),
        );
      }
      return await this.recordFailure(
        descriptor,
        record,
        "MODEL_STREAM_INCOMPLETE",
        true,
        0,
        this.dependencies.clock.now(),
      );
    } finally {
      for (const handleRef of secretHandleRefs) {
        await this.dependencies.secrets.revokeHandle(handleRef, this.dependencies.clock.now());
      }
    }
  }

  private async mapProviderEvent(
    descriptor: ModelDescriptor,
    event: ModelInvocationEvent,
    outputRefs: PayloadRef[],
    record: (eventType: string, payload: unknown, occurredAt?: string) => Promise<void>,
  ): Promise<AttemptResult | undefined> {
    if (event.type === "model.started") {
      await record(
        event.type,
        { invocationId: event.invocationId, modelRef: descriptor.ref },
        event.occurredAt,
      );
      return undefined;
    }
    if (event.type === "model.output") {
      outputRefs.push(event.payloadRef);
      await record(
        event.type,
        {
          invocationId: event.invocationId,
          modelRef: descriptor.ref,
          sequence: event.sequence,
          payloadRef: event.payloadRef,
        },
        event.occurredAt,
      );
      return undefined;
    }
    if (event.type === "model.completed") {
      const usage = Object.freeze({
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        costMicros: event.costMicros,
        latencyMs: event.latencyMs,
      });
      await record(
        event.type,
        { invocationId: event.invocationId, modelRef: descriptor.ref, ...usage },
        event.occurredAt,
      );
      return Object.freeze({
        status: "completed",
        outputRefs: Object.freeze([...outputRefs]),
        usage,
      });
    }
    await record(
      event.type,
      {
        invocationId: event.invocationId,
        modelRef: descriptor.ref,
        errorCode: event.errorCode,
        retryable: event.retryable,
        latencyMs: event.latencyMs,
      },
      event.occurredAt,
    );
    return Object.freeze({
      status: "failed",
      errorCode: event.errorCode,
      retryable: event.retryable,
    });
  }

  private async recordFailure(
    descriptor: ModelDescriptor,
    record: (eventType: string, payload: unknown, occurredAt?: string) => Promise<void>,
    errorCode: string,
    retryable: boolean,
    latencyMs: number,
    occurredAt: string,
  ): Promise<AttemptResult> {
    await record(
      "model.failed",
      { modelRef: descriptor.ref, errorCode, retryable, latencyMs },
      occurredAt,
    );
    return Object.freeze({ status: "failed", errorCode, retryable });
  }
}
