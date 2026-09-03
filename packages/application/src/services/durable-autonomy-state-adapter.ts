import {
  ApplicationPortError,
  candidateSecurityAttentionKey,
  PORT_ERROR_CODES,
  type AutonomyScope,
  type Delegation,
  type DelegationStatePort,
  type ImprovementCandidate,
  type ImprovementStatePort,
  type JsonObject,
  type ProactivityState,
  type ProactivityStatePort,
  type StateStorePort,
} from "../ports/index.js";
import type { AgentId, OwnerId } from "@himawari-agent/domain";
import { assertDelegationTransition } from "./delegation-transitions.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asJson(value: unknown): JsonObject {
  return clone(value) as JsonObject;
}

function emptyProactivityState(ownerId: OwnerId, agentId: AgentId): ProactivityState {
  return Object.freeze({
    ownerId,
    agentId,
    suggestions: Object.freeze([]),
    reflectionDefinition: null,
    reflectionCheckpoints: Object.freeze([]),
    quotaOverflowByCivilDay: Object.freeze({}),
  });
}

export class DurableProactivityStateAdapter implements ProactivityStatePort {
  readonly #state: StateStorePort;

  constructor(state: StateStorePort) {
    this.#state = state;
  }

  async read(ownerId: OwnerId, agentId: AgentId) {
    const record = await this.#state.read(this.#key(ownerId, agentId));
    if (!record) return { revision: 0, state: emptyProactivityState(ownerId, agentId) };
    const state = clone(record.value) as unknown as ProactivityState;
    if (state.ownerId !== ownerId || state.agentId !== agentId)
      throw new TypeError("Proactivity state scope does not match its durable key");
    return Object.freeze({ revision: record.revision, state });
  }

  async compareAndSet(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly expectedRevision: number;
    readonly state: ProactivityState;
  }) {
    if (input.state.ownerId !== input.ownerId || input.state.agentId !== input.agentId)
      throw new TypeError("Proactivity state scope cannot change");
    const record = await this.#state.compareAndSet({
      key: this.#key(input.ownerId, input.agentId),
      expectedRevision: input.expectedRevision === 0 ? null : input.expectedRevision,
      value: asJson(input.state),
    });
    return Object.freeze({
      revision: record.revision,
      state: clone(record.value) as unknown as ProactivityState,
    });
  }

  #key(ownerId: OwnerId, agentId: AgentId): string {
    return `proactivity:${ownerId}:${agentId}`;
  }
}

abstract class DurableEntityStateAdapter<
  T extends {
    readonly id: string;
    readonly revision: number;
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
  },
> {
  readonly #state: StateStorePort;
  readonly #prefix: string;

  protected constructor(state: StateStorePort, prefix: string) {
    this.#state = state;
    this.#prefix = prefix;
  }

  protected validateTransition(_previous: T, _next: T): void {}

  protected async readEntity(scope: AutonomyScope, id: string): Promise<T | undefined> {
    const record = await this.#state.read(this.#prefix);
    if (!record) return undefined;
    const values = (clone(record.value) as { readonly entities?: readonly T[] }).entities ?? [];
    const value = values.find((entity) => entity.id === id);
    if (!value || value.ownerId !== scope.ownerId || value.agentId !== scope.agentId)
      return undefined;
    if (value.revision < 1) throw new TypeError(`${this.#prefix} durable revision is invalid`);
    return Object.freeze(value);
  }

  protected async listEntities(ownerId: OwnerId, agentId: AgentId): Promise<readonly T[]> {
    const record = await this.#state.read(this.#prefix);
    const values =
      (clone(record?.value ?? {}) as { readonly entities?: readonly T[] }).entities ?? [];
    return Object.freeze(
      values
        .filter((entity) => entity.ownerId === ownerId && entity.agentId === agentId)
        .map((entity) => Object.freeze(entity)),
    );
  }

  protected async createEntity(entity: T): Promise<T> {
    if (entity.revision !== 1) throw new TypeError(`${this.#prefix} must start at revision 1`);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#state.read(this.#prefix);
      const values =
        (clone(current?.value ?? {}) as { readonly entities?: readonly T[] }).entities ?? [];
      if (values.some(({ id }) => id === entity.id))
        throw new TypeError(`${this.#prefix} identity already exists`);
      try {
        await this.#state.compareAndSet({
          key: this.#prefix,
          expectedRevision: current?.revision ?? null,
          value: asJson({ entities: [...values, entity] }),
        });
        return Object.freeze(entity);
      } catch (error) {
        if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.CONFLICT)
          throw error;
      }
    }
    throw new TypeError(`${this.#prefix} create remained concurrent`);
  }

  protected async saveEntity(entity: T, expectedRevision: number): Promise<T> {
    if (entity.revision !== expectedRevision + 1)
      throw new TypeError(`${this.#prefix} revision must advance exactly once`);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#state.read(this.#prefix);
      const values =
        (clone(current?.value ?? {}) as { readonly entities?: readonly T[] }).entities ?? [];
      const index = values.findIndex(({ id }) => id === entity.id);
      const previous = values[index];
      if (!previous || previous.revision !== expectedRevision)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.CONFLICT,
          `${this.#prefix} entity revision conflict`,
        );
      if (previous.ownerId !== entity.ownerId || previous.agentId !== entity.agentId)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          `${this.#prefix} scope cannot change`,
        );
      this.validateTransition(previous, entity);
      const next = [...values];
      next[index] = entity;
      try {
        await this.#state.compareAndSet({
          key: this.#prefix,
          expectedRevision: current?.revision ?? null,
          value: asJson({ entities: next }),
        });
        return Object.freeze(entity);
      } catch (error) {
        if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.CONFLICT)
          throw error;
      }
    }
    throw new TypeError(`${this.#prefix} save remained concurrent`);
  }
}

export class DurableDelegationStateAdapter
  extends DurableEntityStateAdapter<Delegation>
  implements DelegationStatePort
{
  constructor(state: StateStorePort) {
    super(state, "delegation");
  }

  protected override validateTransition(previous: Delegation, next: Delegation): void {
    assertDelegationTransition(previous, next);
  }

  read(scope: AutonomyScope, delegationId: string): Promise<Delegation | undefined> {
    return this.readEntity(scope, delegationId);
  }

  list(ownerId: OwnerId, agentId: AgentId): Promise<readonly Delegation[]> {
    return this.listEntities(ownerId, agentId);
  }

  create(delegation: Delegation): Promise<Delegation> {
    return this.createEntity(delegation);
  }

  save(delegation: Delegation, expectedRevision: number): Promise<Delegation> {
    return this.saveEntity(delegation, expectedRevision);
  }
}

export class DurableImprovementStateAdapter
  extends DurableEntityStateAdapter<ImprovementCandidate>
  implements ImprovementStatePort
{
  constructor(state: StateStorePort) {
    super(state, "improvement");
  }

  async read(scope: AutonomyScope, candidateId: string): Promise<ImprovementCandidate | undefined> {
    const candidate = await this.readEntity(scope, candidateId);
    return candidate ? this.#withRecoveryState(candidate) : undefined;
  }

  async list(ownerId: OwnerId, agentId: AgentId): Promise<readonly ImprovementCandidate[]> {
    return (await this.listEntities(ownerId, agentId)).map((candidate) =>
      this.#withRecoveryState(candidate),
    );
  }

  #withRecoveryState(candidate: ImprovementCandidate): ImprovementCandidate {
    const securityResponse: ImprovementCandidate["securityResponse"] =
      candidate.securityResponse ??
      (candidate.status === "security_failure"
        ? {
            status: "quarantine_pending",
            reasonCode:
              candidate.protectedRootFacts
                .find((fact) => fact.startsWith("security-failure:"))
                ?.slice("security-failure:".length) || "CANDIDATE_RECOVERED_SECURITY_FAILURE",
            requestedAt: candidate.updatedAt,
            attentionIdempotencyKey: candidateSecurityAttentionKey(candidate),
          }
        : { status: "not_requested" });
    return {
      ...candidate,
      cleanup: candidate.cleanup ?? { status: "not_requested" },
      securityResponse,
    };
  }

  create(candidate: ImprovementCandidate): Promise<ImprovementCandidate> {
    return this.createEntity(candidate);
  }

  save(candidate: ImprovementCandidate, expectedRevision: number): Promise<ImprovementCandidate> {
    return this.saveEntity(candidate, expectedRevision);
  }
}
