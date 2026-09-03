import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type HostFileDigestPort,
  type ProactivityState,
  type ProactivityStatePort,
  type ReflectionCandidateDraft,
  type SuggestionCandidate,
  type SuggestionDeliveryPort,
  type SuggestionTaskCreationPort,
} from "../ports/index.js";
import type { AgentId, OwnerId, RunId } from "@himawari-agent/domain";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";

const MAX_CAS_ATTEMPTS = 8;

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      `Invalid IANA timezone ${timezone}`,
    );
  }
}

function civilDay(instant: string, timezone: string): string {
  assertTimezone(timezone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const partValue = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${partValue("year")}-${partValue("month")}-${partValue("day")}`;
}

function activeForDedupe(candidate: SuggestionCandidate, now: string): boolean {
  return (
    candidate.expiresAt > now && ["candidate", "delivered", "approved"].includes(candidate.status)
  );
}

export class SuggestionService {
  readonly #dependencies: {
    readonly state: ProactivityStatePort;
    readonly delivery: SuggestionDeliveryPort;
    readonly tasks: SuggestionTaskCreationPort;
    readonly digest: HostFileDigestPort;
    readonly clock: ClockPort;
    readonly ids: IdGeneratorPort;
  };

  constructor(dependencies: {
    readonly state: ProactivityStatePort;
    readonly delivery: SuggestionDeliveryPort;
    readonly tasks: SuggestionTaskCreationPort;
    readonly digest: HostFileDigestPort;
    readonly clock: ClockPort;
    readonly ids: IdGeneratorPort;
  }) {
    this.#dependencies = dependencies;
  }

  async propose(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly generationRunId: RunId;
    readonly traceRef: string;
    readonly draft: ReflectionCandidateDraft;
    readonly dailyQuota?: number;
  }): Promise<
    | { readonly outcome: "accepted"; readonly candidate: SuggestionCandidate }
    | { readonly outcome: "duplicate"; readonly candidate: SuggestionCandidate }
    | { readonly outcome: "quota_exhausted"; readonly candidate: null }
  > {
    this.#assertDraft(input.draft);
    const now = this.#dependencies.clock.now();
    const timezone = input.draft.taskDraft.timezone;
    const quota = input.dailyQuota ?? 3;
    if (!Number.isInteger(quota) || quota < 1 || quota > 20)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Daily suggestion quota must be an integer from 1 to 20",
      );
    const evidenceFingerprint = this.#dependencies.digest.digestCanonical(
      JSON.stringify([...input.draft.evidenceRefs].sort()),
    );
    const semanticKey = this.#dependencies.digest.digestCanonical(
      JSON.stringify({
        kind: input.draft.kind,
        targetEntity: input.draft.targetEntity,
        proposedAction: input.draft.proposedAction,
        evidenceFingerprint,
      }),
    );
    const day = civilDay(now, timezone);

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.#dependencies.state.read(input.ownerId, input.agentId);
      const duplicate = current.state.suggestions.find(
        (candidate) =>
          candidate.semanticKey === semanticKey &&
          (activeForDedupe(candidate, now) ||
            (candidate.status === "rejected" &&
              candidate.evidenceFingerprint === evidenceFingerprint &&
              candidate.ownerScopeRevision === input.draft.ownerScopeRevision)),
      );
      if (duplicate) {
        if (duplicate.status === "candidate") {
          const delivered = await this.#deliver(duplicate);
          return Object.freeze({ outcome: "accepted", candidate: delivered });
        }
        return Object.freeze({ outcome: "duplicate", candidate: duplicate });
      }
      const acceptedToday = current.state.suggestions.filter(
        (candidate) =>
          civilDay(candidate.createdAt, timezone) === day &&
          !["rejected", "superseded"].includes(candidate.status),
      ).length;
      if (acceptedToday >= quota) {
        const nextState: ProactivityState = Object.freeze({
          ...current.state,
          quotaOverflowByCivilDay: Object.freeze({
            ...current.state.quotaOverflowByCivilDay,
            [day]: (current.state.quotaOverflowByCivilDay[day] ?? 0) + 1,
          }),
        });
        try {
          await this.#dependencies.state.compareAndSet({
            ownerId: input.ownerId,
            agentId: input.agentId,
            expectedRevision: current.revision,
            state: nextState,
          });
          return Object.freeze({ outcome: "quota_exhausted", candidate: null });
        } catch (error) {
          if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.CONFLICT)
            throw error;
          continue;
        }
      }
      const candidate: SuggestionCandidate = Object.freeze({
        id: this.#dependencies.ids.next("suggestion"),
        revision: 1,
        ownerId: input.ownerId,
        agentId: input.agentId,
        generationRunId: input.generationRunId,
        traceRef: input.traceRef,
        kind: input.draft.kind,
        titleRef: input.draft.titleRef,
        bodyRef: input.draft.bodyRef,
        evidenceRefs: Object.freeze([...input.draft.evidenceRefs]),
        sourceWatermark: input.draft.sourceWatermark,
        goalRef: input.draft.goalRef,
        commitmentRef: input.draft.commitmentRef,
        taskDraft: Object.freeze({ ...input.draft.taskDraft }),
        confidencePermille: input.draft.confidencePermille,
        noveltyPermille: input.draft.noveltyPermille,
        semanticKey,
        evidenceFingerprint,
        ownerScopeRevision: input.draft.ownerScopeRevision,
        estimatedDataClasses: Object.freeze([...input.draft.estimatedDataClasses]),
        createdAt: now,
        expiresAt: input.draft.expiresAt,
        status: "candidate",
        deliveryRef: null,
        taskRef: null,
        taskCreationKey: null,
        responseIdempotencyKeys: Object.freeze([]),
      });
      const nextState: ProactivityState = Object.freeze({
        ...current.state,
        suggestions: Object.freeze([...current.state.suggestions, candidate]),
      });
      try {
        await this.#dependencies.state.compareAndSet({
          ownerId: input.ownerId,
          agentId: input.agentId,
          expectedRevision: current.revision,
          state: nextState,
        });
        const delivered = await this.#deliver(candidate);
        return Object.freeze({ outcome: "accepted", candidate: delivered });
      } catch (error) {
        if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.CONFLICT)
          throw error;
      }
    }
    throw new ApplicationPortError(
      PORT_ERROR_CODES.CONFLICT,
      "Suggestion quota state remained concurrent",
    );
  }

  async respond(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly suggestionId: string;
    readonly decision: "approve" | "reject";
    readonly idempotencyKey: string;
    readonly expectedRevision?: number;
  }): Promise<SuggestionCandidate> {
    const decision = input.decision === "approve" ? "approved" : "rejected";
    const claimed = await this.#transition(
      input.ownerId,
      input.agentId,
      input.suggestionId,
      (current) => {
        if (current.responseIdempotencyKeys.includes(input.idempotencyKey)) {
          if (current.status !== decision)
            throw new ApplicationPortError(
              PORT_ERROR_CODES.CONFLICT,
              "Suggestion response key changed decision",
            );
          return current;
        }
        if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision)
          throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Suggestion revision changed");
        if (current.status !== "delivered" || current.expiresAt <= this.#dependencies.clock.now())
          throw new ApplicationPortError(
            PORT_ERROR_CODES.INVALID_OPERATION,
            "Suggestion is not awaiting an Owner response",
          );
        return {
          ...current,
          status: decision,
          taskCreationKey:
            decision === "approved"
              ? `suggestion:${current.ownerId}:${current.agentId}:${current.id}:task`
              : null,
          responseIdempotencyKeys: Object.freeze([input.idempotencyKey]),
        };
      },
    );
    return this.#completeTaskIntent(claimed);
  }

  async recoverTaskIntents(ownerId: OwnerId, agentId: AgentId): Promise<void> {
    const current = await this.#dependencies.state.read(ownerId, agentId);
    for (const candidate of current.state.suggestions) {
      if (candidate.status === "approved" && candidate.taskRef === null)
        await this.#completeTaskIntent(candidate);
    }
  }

  async #completeTaskIntent(candidate: SuggestionCandidate): Promise<SuggestionCandidate> {
    if (candidate.status !== "approved" || candidate.taskRef !== null) return candidate;
    if (!candidate.taskCreationKey)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Approved suggestion has no Task intent",
      );
    const taskRef = await this.#dependencies.tasks.createOrdinaryTask({
      ownerId: candidate.ownerId,
      agentId: candidate.agentId,
      suggestionId: candidate.id,
      draft: candidate.taskDraft,
      idempotencyKey: candidate.taskCreationKey,
      capabilityHandleRefs: [],
      approvalRefs: [],
    });
    return this.#transition(candidate.ownerId, candidate.agentId, candidate.id, (current) => {
      if (current.status !== "approved" || current.taskCreationKey !== candidate.taskCreationKey)
        throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Suggestion Task intent changed");
      if (current.taskRef !== null) {
        if (current.taskRef !== taskRef)
          throw new ApplicationPortError(
            PORT_ERROR_CODES.CONFLICT,
            "Task creation violated its idempotency contract",
          );
        return current;
      }
      return { ...current, taskRef };
    });
  }

  async expire(ownerId: OwnerId, agentId: AgentId, now = this.#dependencies.clock.now()) {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.#dependencies.state.read(ownerId, agentId);
      const suggestions = current.state.suggestions.map((candidate) =>
        candidate.expiresAt <= now && ["candidate", "delivered"].includes(candidate.status)
          ? Object.freeze({
              ...candidate,
              revision: candidate.revision + 1,
              status: "expired" as const,
            })
          : candidate,
      );
      if (suggestions.every((candidate, index) => candidate === current.state.suggestions[index]))
        return current.state.suggestions;
      try {
        const saved = await this.#dependencies.state.compareAndSet({
          ownerId,
          agentId,
          expectedRevision: current.revision,
          state: Object.freeze({ ...current.state, suggestions: Object.freeze(suggestions) }),
        });
        return saved.state.suggestions;
      } catch (error) {
        if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.CONFLICT)
          throw error;
      }
    }
    throw new ApplicationPortError(
      PORT_ERROR_CODES.CONFLICT,
      "Suggestion expiry remained concurrent",
    );
  }

  async #deliver(candidate: SuggestionCandidate): Promise<SuggestionCandidate> {
    const deliveryRef = await this.#dependencies.delivery.enqueue({
      suggestion: candidate,
      idempotencyKey: candidate.id,
      resultRef: candidate.bodyRef,
      level: "INBOX",
    });
    return this.#transition(candidate.ownerId, candidate.agentId, candidate.id, (current) => {
      if (current.status !== "candidate") return current;
      return {
        ...current,
        status: current.expiresAt <= this.#dependencies.clock.now() ? "expired" : "delivered",
        deliveryRef,
      };
    });
  }

  async #transition(
    ownerId: OwnerId,
    agentId: AgentId,
    suggestionId: string,
    update: (current: SuggestionCandidate) => SuggestionCandidate,
  ): Promise<SuggestionCandidate> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.#dependencies.state.read(ownerId, agentId);
      const index = current.state.suggestions.findIndex(({ id }) => id === suggestionId);
      if (index < 0)
        throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Suggestion was not found");
      const previous = current.state.suggestions[index];
      if (!previous) throw new TypeError("Suggestion index is invalid");
      const updated = update(previous);
      if (updated === previous) return previous;
      const next = Object.freeze({ ...updated, revision: previous.revision + 1 });
      const suggestions = [...current.state.suggestions];
      suggestions[index] = next;
      try {
        await this.#dependencies.state.compareAndSet({
          ownerId,
          agentId,
          expectedRevision: current.revision,
          state: Object.freeze({ ...current.state, suggestions: Object.freeze(suggestions) }),
        });
        return next;
      } catch (error) {
        if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.CONFLICT)
          throw error;
      }
    }
    throw new ApplicationPortError(
      PORT_ERROR_CODES.CONFLICT,
      "Suggestion update remained concurrent",
    );
  }

  #assertDraft(draft: ReflectionCandidateDraft): void {
    if (
      !draft.kind.trim() ||
      draft.evidenceRefs.length === 0 ||
      draft.expiresAt <= this.#dependencies.clock.now() ||
      draft.confidencePermille < 0 ||
      draft.confidencePermille > 1000 ||
      draft.noveltyPermille < 0 ||
      draft.noveltyPermille > 1000 ||
      draft.taskDraft.estimatedCostMicros < 0 ||
      draft.taskDraft.timeoutMs <= 0
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Suggestion candidate is incomplete or outside its bounded contract",
      );
    assertTimezone(draft.taskDraft.timezone);
  }
}
