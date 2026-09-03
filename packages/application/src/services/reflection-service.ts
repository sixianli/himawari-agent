import type { AgentId, OwnerId, RunId } from "@himawari-agent/domain";
import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type ProactivityState,
  type ProactivityStatePort,
  type ReflectionCheckpoint,
  type ReflectionContextPort,
  type ReflectionDefinition,
  type ReflectionModelPort,
} from "../ports/index.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";
import { assertMachineSecretFree } from "./machine-secret-exclusion.js";
import type { SuggestionService } from "./suggestion-service.js";

const MAX_CAS_ATTEMPTS = 8;

export class ReflectionService {
  readonly #dependencies: {
    readonly state: ProactivityStatePort;
    readonly context: ReflectionContextPort;
    readonly model: ReflectionModelPort;
    readonly suggestions: SuggestionService;
    readonly clock: ClockPort;
    readonly ids: IdGeneratorPort;
  };

  constructor(dependencies: {
    readonly state: ProactivityStatePort;
    readonly context: ReflectionContextPort;
    readonly model: ReflectionModelPort;
    readonly suggestions: SuggestionService;
    readonly clock: ClockPort;
    readonly ids: IdGeneratorPort;
  }) {
    this.#dependencies = dependencies;
  }

  async configure(definition: ReflectionDefinition): Promise<ReflectionDefinition> {
    this.#assertDefinition(definition);
    return this.#update(definition.ownerId, definition.agentId, (state) => ({
      ...state,
      reflectionDefinition: Object.freeze({ ...definition }),
    })).then(({ reflectionDefinition }) => {
      if (!reflectionDefinition) throw new TypeError("Reflection definition was not saved");
      return reflectionDefinition;
    });
  }

  async run(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly generationRunId: RunId;
    readonly traceRef: string;
    readonly scheduledAt: string;
    readonly hostWasOnlineAtSchedule: boolean;
    readonly previousWatermark: string;
  }): Promise<ReflectionCheckpoint> {
    const checkpointId = `reflection:${input.ownerId}:${input.agentId}:${input.scheduledAt}`;
    const claimId = this.#dependencies.ids.next("reflection-attempt");
    const claimedState = await this.#update(input.ownerId, input.agentId, (state) => {
      const existing = state.reflectionCheckpoints.find(({ id }) => id === checkpointId);
      const now = this.#dependencies.clock.now();
      if (
        existing &&
        (existing.outcome !== "running" || (existing.claim && existing.claim.leaseUntil > now))
      )
        return state;
      const definition = existing?.definition ?? state.reflectionDefinition;
      if (!definition || !definition.enabled)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "Global reflection is not configured and enabled",
        );
      this.#assertDefinition(definition);
      const attempts = existing?.attempts ?? 0;
      const missed = !existing && !input.hostWasOnlineAtSchedule;
      const exhausted = attempts >= 3;
      const checkpoint: ReflectionCheckpoint = {
        id: checkpointId,
        ownerId: input.ownerId,
        agentId: input.agentId,
        generationRunId: existing?.generationRunId ?? input.generationRunId,
        traceRef: existing?.traceRef ?? input.traceRef,
        scheduledAt: input.scheduledAt,
        inputWatermark: existing?.inputWatermark ?? input.previousWatermark,
        outcome: missed ? "missed" : exhausted ? "failed" : "running",
        candidateRefs: existing?.candidateRefs ?? [],
        costMicros: existing?.costMicros ?? 0,
        attempts: missed || exhausted ? attempts : attempts + 1,
        errorCode: exhausted ? (existing?.errorCode ?? "REFLECTION_ATTEMPTS_EXHAUSTED") : null,
        completedAt: now,
        definition,
        context: existing?.context ?? null,
        output: existing?.output ?? null,
        reservedCostMicros: existing?.reservedCostMicros ?? 0,
        claim:
          missed || exhausted
            ? null
            : {
                id: claimId,
                generation: (existing?.claim?.generation ?? attempts) + 1,
                leaseUntil: new Date(Date.parse(now) + definition.timeoutMs).toISOString(),
              },
      };
      return this.#replaceCheckpoint(state, checkpoint);
    });
    let checkpoint = this.#requiredCheckpoint(claimedState, checkpointId);
    if (!this.#owns(checkpoint, claimId)) return checkpoint;
    const definition = checkpoint.definition;
    try {
      if (!checkpoint.context) {
        const context = await this.#dependencies.context.select({
          ownerId: input.ownerId,
          agentId: input.agentId,
          afterWatermark: checkpoint.inputWatermark,
          maximumItems: definition.maximumContextItems,
        });
        if (context.itemCount < 0 || context.itemCount > definition.maximumContextItems)
          throw new ApplicationPortError(
            PORT_ERROR_CODES.PROVIDER_FAILURE,
            "Reflection context exceeded its bound",
          );
        checkpoint = await this.#updateClaim(checkpoint, claimId, (current) => ({
          ...current,
          context,
          inputWatermark: context.watermark,
        }));
      }
      if (!this.#owns(checkpoint, claimId)) return checkpoint;
      if (!checkpoint.output) {
        checkpoint = await this.#updateClaim(checkpoint, claimId, (current) => ({
          ...current,
          reservedCostMicros: definition.maximumCostMicros,
        }));
        if (!this.#owns(checkpoint, claimId) || !checkpoint.context) return checkpoint;
        const output = await this.#dependencies.model.reflect({
          idempotencyKey: checkpointId,
          contextRef: checkpoint.context.inputRef,
          maximumCandidates: definition.maximumCandidates,
          maximumCostMicros: definition.maximumCostMicros,
          timeoutMs: definition.timeoutMs,
        });
        assertMachineSecretFree(JSON.stringify(output.metadata));
        if (
          output.costMicros < 0 ||
          output.costMicros > definition.maximumCostMicros ||
          output.candidates.length > definition.maximumCandidates ||
          (output.outcome === "no_change" && output.candidates.length !== 0)
        )
          throw new ApplicationPortError(
            PORT_ERROR_CODES.PROVIDER_FAILURE,
            "Reflection model exceeded its frozen output or cost contract",
          );
        checkpoint = await this.#updateClaim(checkpoint, claimId, (current) => ({
          ...current,
          output,
          costMicros: output.costMicros,
          reservedCostMicros: 0,
        }));
      }
      if (!this.#owns(checkpoint, claimId) || !checkpoint.output || !checkpoint.context)
        return checkpoint;
      for (const draft of checkpoint.output.candidates) {
        checkpoint = await this.#updateClaim(checkpoint, claimId, (current) => current);
        if (!this.#owns(checkpoint, claimId)) return checkpoint;
        const proposal = await this.#dependencies.suggestions.propose({
          ownerId: input.ownerId,
          agentId: input.agentId,
          generationRunId: checkpoint.generationRunId,
          traceRef: checkpoint.traceRef,
          draft: { ...draft, sourceWatermark: checkpoint.inputWatermark },
          dailyQuota: definition.dailySuggestionQuota,
        });
        if (proposal.candidate) {
          const candidateId = proposal.candidate.id;
          checkpoint = await this.#updateClaim(checkpoint, claimId, (current) => ({
            ...current,
            candidateRefs: [...new Set([...current.candidateRefs, candidateId])],
          }));
        }
      }
      return this.#updateClaim(checkpoint, claimId, (current) => ({
        ...current,
        outcome: current.candidateRefs.length === 0 ? "no_change" : "candidates",
        claim: null,
        completedAt: this.#dependencies.clock.now(),
      }));
    } catch (error) {
      const errorCode =
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : "REFLECTION_FAILED";
      const saved = await this.#updateClaim(checkpoint, claimId, (current) => ({
        ...current,
        outcome: current.attempts >= 3 ? "failed" : "running",
        claim: null,
        errorCode,
        completedAt: this.#dependencies.clock.now(),
      }));
      if (saved.outcome !== "running" || (saved.claim?.id !== claimId && saved.claim !== null))
        return saved;
      throw error;
    }
  }

  #owns(checkpoint: ReflectionCheckpoint, claimId: string): boolean {
    return (
      checkpoint.outcome === "running" &&
      checkpoint.claim?.id === claimId &&
      checkpoint.claim.leaseUntil > this.#dependencies.clock.now()
    );
  }

  #requiredCheckpoint(state: ProactivityState, id: string): ReflectionCheckpoint {
    const checkpoint = state.reflectionCheckpoints.find((item) => item.id === id);
    if (!checkpoint)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        "Reflection checkpoint disappeared",
      );
    return checkpoint;
  }

  #replaceCheckpoint(state: ProactivityState, checkpoint: ReflectionCheckpoint): ProactivityState {
    const others = state.reflectionCheckpoints.filter(({ id }) => id !== checkpoint.id);
    return { ...state, reflectionCheckpoints: [...others, checkpoint] };
  }

  async #updateClaim(
    checkpoint: ReflectionCheckpoint,
    claimId: string,
    update: (current: ReflectionCheckpoint) => ReflectionCheckpoint,
  ): Promise<ReflectionCheckpoint> {
    const state = await this.#update(checkpoint.ownerId, checkpoint.agentId, (current) => {
      const latest = this.#requiredCheckpoint(current, checkpoint.id);
      if (!this.#owns(latest, claimId)) return current;
      const next = update(latest);
      return next === latest ? current : this.#replaceCheckpoint(current, next);
    });
    return this.#requiredCheckpoint(state, checkpoint.id);
  }

  async #update(
    ownerId: OwnerId,
    agentId: AgentId,
    update: (state: ProactivityState) => ProactivityState,
  ): Promise<ProactivityState> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.#dependencies.state.read(ownerId, agentId);
      const updated = update(current.state);
      if (updated === current.state) return current.state;
      try {
        const saved = await this.#dependencies.state.compareAndSet({
          ownerId,
          agentId,
          expectedRevision: current.revision,
          state: Object.freeze(updated),
        });
        return saved.state;
      } catch (error) {
        if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.CONFLICT)
          throw error;
      }
    }
    throw new ApplicationPortError(
      PORT_ERROR_CODES.CONFLICT,
      "Reflection state remained concurrent",
    );
  }

  #assertDefinition(definition: ReflectionDefinition): void {
    try {
      new Intl.DateTimeFormat("en", { timeZone: definition.timezone }).format(new Date(0));
    } catch {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Invalid reflection timezone",
      );
    }
    if (
      definition.id !== "global-reflection" ||
      !definition.schedule.trim() ||
      !Number.isInteger(definition.dailySuggestionQuota) ||
      definition.dailySuggestionQuota < 1 ||
      definition.dailySuggestionQuota > 20 ||
      definition.maximumContextItems < 1 ||
      definition.maximumCandidates < 1 ||
      definition.maximumCandidates > definition.dailySuggestionQuota ||
      definition.maximumCostMicros < 0 ||
      definition.timeoutMs < 1
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Reflection definition exceeds its bounded contract",
      );
  }
}
