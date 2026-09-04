import { randomUUID } from "node:crypto";
import type {
  AgentId,
  ApplicationServiceIdentityFactory,
  AuthorityFence,
  AuthorityLeasePort,
  AuthorityLeaseRecord,
  ClockPort,
  DeploymentAuthorityState,
  DeploymentAuthorityStatePort,
  DeploymentId,
  OwnerId,
  ProductAuthorityFence,
} from "@himawari-agent/application";
import { createApplicationServiceIdentityFactory } from "@himawari-agent/application";

export const PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES = Object.freeze({
  CONFIGURATION_INVALID: "PRODUCTION_AUTHORITY_CONFIGURATION_INVALID",
  MIRROR_MISMATCH: "PRODUCTION_AUTHORITY_MIRROR_MISMATCH",
  NOT_ACTIVE: "PRODUCTION_AUTHORITY_NOT_ACTIVE",
  LOST: "PRODUCTION_AUTHORITY_LOST",
} as const);

export type ProductionAuthorityLifecycleErrorCode =
  (typeof PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES)[keyof typeof PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES];

export class ProductionAuthorityLifecycleError extends Error {
  readonly code: ProductionAuthorityLifecycleErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: ProductionAuthorityLifecycleErrorCode,
    message: string,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "ProductionAuthorityLifecycleError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export type ProductionAuthorityLifecycleState =
  | "stopped"
  | "starting"
  | "active"
  | "draining"
  | "lost";

export interface ProductionAuthorityMirror {
  /** Read the deployment mirror before claiming. A lower fence is recoverable. */
  read(): Promise<DeploymentAuthorityState>;
  /** Persist the post-claim deployment state atomically after SQLite claim. */
  write(deployment: DeploymentAuthorityState): Promise<void>;
}

export interface ProductionAuthorityLifecycleOptions {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly deploymentId: DeploymentId;
  readonly deployment: DeploymentAuthorityStatePort;
  readonly leases: AuthorityLeasePort;
  readonly clock: ClockPort;
  readonly leaseDurationMs: number;
  readonly mirror?: ProductionAuthorityMirror;
  readonly identity?: ApplicationServiceIdentityFactory;
  readonly nextAuthorityIdentity?: () => {
    readonly leaseId: string;
    readonly holderId: string;
  };
  readonly onLost?: (error: unknown) => void | Promise<void>;
}

export interface ProductionAuthorityLifecycleSnapshot {
  readonly state: ProductionAuthorityLifecycleState;
  readonly authority: ProductAuthorityFence | null;
  readonly lease: AuthorityLeaseRecord | null;
}

type BoundProductionAuthorityLifecycleOptions = Omit<
  ProductionAuthorityLifecycleOptions,
  "identity"
> & {
  readonly identity: ApplicationServiceIdentityFactory;
};

function positiveDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProductionAuthorityLifecycleError(
      PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.CONFIGURATION_INVALID,
      "Authority lease duration must be a positive safe integer",
      { leaseDurationMs: String(value) },
    );
  }
  return value;
}

function positiveFence(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ProductionAuthorityLifecycleError(
      PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.CONFIGURATION_INVALID,
      `${field} must be a positive safe integer`,
      { field, value: String(value) },
    );
  }
  return value;
}

function sameDeploymentScope(
  left: DeploymentAuthorityState,
  right: { readonly id: DeploymentId; readonly ownerId: OwnerId; readonly agentId: AgentId },
): boolean {
  return left.id === right.id && left.ownerId === right.ownerId && left.agentId === right.agentId;
}

function assertActiveDeployment(
  deployment: DeploymentAuthorityState | undefined,
  expected: { readonly id: DeploymentId; readonly ownerId: OwnerId; readonly agentId: AgentId },
): DeploymentAuthorityState {
  if (!deployment || !sameDeploymentScope(deployment, expected) || deployment.status !== "active") {
    throw new ProductionAuthorityLifecycleError(
      PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.MIRROR_MISMATCH,
      "The persisted deployment is not an active authority for this service",
      {
        deploymentId: expected.id,
        ownerId: expected.ownerId,
        agentId: expected.agentId,
      },
    );
  }
  positiveFence(deployment.authorityEpoch, "authorityEpoch");
  positiveFence(deployment.fencingToken, "fencingToken");
  return deployment;
}

function assertMirror(
  mirror: DeploymentAuthorityState,
  persisted: DeploymentAuthorityState,
  expected: { readonly id: DeploymentId; readonly ownerId: OwnerId; readonly agentId: AgentId },
): void {
  const recoverableClaimGap = mirror.fencingToken < persisted.fencingToken;
  if (
    !sameDeploymentScope(mirror, expected) ||
    mirror.status !== persisted.status ||
    mirror.authorityEpoch !== persisted.authorityEpoch ||
    mirror.transferId !== persisted.transferId ||
    mirror.revision > persisted.revision ||
    (!recoverableClaimGap && mirror.revision !== persisted.revision) ||
    mirror.fencingToken > persisted.fencingToken
  ) {
    throw new ProductionAuthorityLifecycleError(
      PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.MIRROR_MISMATCH,
      "The authority mirror is inconsistent with the persisted deployment",
      {
        deploymentId: expected.id,
        mirrorEpoch: String(mirror.authorityEpoch),
        persistedEpoch: String(persisted.authorityEpoch),
        mirrorFence: String(mirror.fencingToken),
        persistedFence: String(persisted.fencingToken),
      },
    );
  }
}

function defaultAuthorityIdentity(agentId: AgentId): {
  readonly leaseId: string;
  readonly holderId: string;
} {
  return {
    leaseId: `authority:${agentId}:${randomUUID()}`,
    holderId: `agent-service:${randomUUID()}`,
  };
}

function authorityFrom(
  deployment: DeploymentAuthorityState,
  record: AuthorityLeaseRecord,
): ProductAuthorityFence {
  if (record.lease.ownerId !== deployment.ownerId || record.lease.agentId !== deployment.agentId) {
    throw new ProductionAuthorityLifecycleError(
      PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.LOST,
      "Authority lease scope does not match the persisted deployment",
      { deploymentId: deployment.id },
    );
  }
  if (record.fencingToken !== deployment.fencingToken) {
    throw new ProductionAuthorityLifecycleError(
      PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.LOST,
      "Authority lease fence does not match the persisted deployment",
      {
        deploymentId: deployment.id,
        leaseFence: String(record.fencingToken),
        deploymentFence: String(deployment.fencingToken),
      },
    );
  }
  return Object.freeze({
    deploymentId: deployment.id,
    authorityEpoch: deployment.authorityEpoch,
    fencingToken: record.fencingToken,
  });
}

function isMissingAuthorityLease(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "PORT_NOT_FOUND" || error.code === "PORT_NOT_AUTHORITATIVE")
  );
}

export class ProductionAuthorityLifecycle {
  readonly #options: BoundProductionAuthorityLifecycleOptions;
  #state: ProductionAuthorityLifecycleState = "stopped";
  #record: AuthorityLeaseRecord | null = null;
  #authority: ProductAuthorityFence | null = null;
  #renewalTimer: ReturnType<typeof setInterval> | undefined;
  #generation = 0;
  #renewalInFlight: Promise<ProductionAuthorityLifecycleSnapshot> | undefined;

  constructor(options: ProductionAuthorityLifecycleOptions) {
    this.#options = Object.freeze({
      ...options,
      leaseDurationMs: positiveDuration(options.leaseDurationMs),
      identity: options.identity ?? createApplicationServiceIdentityFactory(),
    });
  }

  get state(): ProductionAuthorityLifecycleState {
    return this.#state;
  }

  snapshot(): ProductionAuthorityLifecycleSnapshot {
    return Object.freeze({
      state: this.#state,
      authority: this.#authority,
      lease: this.#record,
    });
  }

  isAccepting(): boolean {
    return this.#state === "active";
  }

  authorityFence(): ProductAuthorityFence {
    if (this.#state !== "active" || !this.#authority) {
      throw new ProductionAuthorityLifecycleError(
        PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.NOT_ACTIVE,
        "The service does not currently hold production authority",
      );
    }
    return this.#authority;
  }

  authorityLease(): AuthorityFence {
    if (this.#state !== "active" || !this.#record) {
      throw new ProductionAuthorityLifecycleError(
        PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.NOT_ACTIVE,
        "The service does not currently hold an authority lease",
      );
    }
    return Object.freeze({
      leaseId: this.#record.lease.id,
      fencingToken: this.#record.fencingToken,
    });
  }

  async assertActive(): Promise<void> {
    if (this.#state !== "active" || !this.#record || !this.#authority) {
      throw new ProductionAuthorityLifecycleError(
        PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.NOT_ACTIVE,
        "The service does not currently hold production authority",
      );
    }
    const record = this.#record;
    const generation = this.#generation;
    try {
      const current = await this.#options.leases.current(this.#options.agentId);
      this.assertActiveGeneration(generation, record);
      if (
        !current ||
        current.lease.id !== record.lease.id ||
        current.lease.holderId !== record.lease.holderId ||
        current.fencingToken !== record.fencingToken
      ) {
        throw new ProductionAuthorityLifecycleError(
          PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.LOST,
          "The authority lease is no longer current",
          { leaseId: record.lease.id },
        );
      }
      const deployment = assertActiveDeployment(
        await this.#options.deployment.read(this.#options.deploymentId),
        {
          id: this.#options.deploymentId,
          ownerId: this.#options.ownerId,
          agentId: this.#options.agentId,
        },
      );
      this.assertActiveGeneration(generation, record);
      const authority = authorityFrom(deployment, current);
      await this.#options.deployment.assertCurrent(authority);
      this.assertActiveGeneration(generation, record);
    } catch (error) {
      if (generation !== this.#generation || this.#state !== "active") throw error;
      this.markLost(error);
      throw error;
    }
  }

  async start(): Promise<ProductionAuthorityLifecycleSnapshot> {
    if (this.#state === "active") return this.snapshot();
    if (this.#state === "starting" || this.#state === "draining") {
      throw new ProductionAuthorityLifecycleError(
        PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.NOT_ACTIVE,
        `Cannot start authority lifecycle while it is ${this.#state}`,
      );
    }
    this.#state = "starting";
    const generation = ++this.#generation;
    const scope = {
      id: this.#options.deploymentId,
      ownerId: this.#options.ownerId,
      agentId: this.#options.agentId,
    } as const;
    let claimedRecord: AuthorityLeaseRecord | undefined;
    try {
      const persisted = assertActiveDeployment(
        await this.#options.deployment.read(this.#options.deploymentId),
        scope,
      );
      if (this.#options.mirror) {
        assertMirror(await this.#options.mirror.read(), persisted, scope);
      }
      this.assertStartingGeneration(generation);
      const identity =
        this.#options.nextAuthorityIdentity?.() ?? defaultAuthorityIdentity(this.#options.agentId);
      const lease = this.#options.identity.createAuthorityLease({
        ownerId: this.#options.ownerId,
        agentId: this.#options.agentId,
        leaseId: identity.leaseId,
        holderId: identity.holderId,
      });
      const record = await this.#options.leases.claim(lease, this.#options.leaseDurationMs);
      claimedRecord = record;
      this.assertStartingGeneration(generation);
      const claimedDeployment = assertActiveDeployment(
        await this.#options.deployment.read(this.#options.deploymentId),
        scope,
      );
      const authority = authorityFrom(claimedDeployment, record);
      await this.#options.deployment.assertCurrent(authority);
      this.assertStartingGeneration(generation);
      if (this.#options.mirror) await this.#options.mirror.write(claimedDeployment);
      this.assertStartingGeneration(generation);
      this.#record = record;
      this.#authority = authority;
      this.#state = "active";
      return this.snapshot();
    } catch (error) {
      if (claimedRecord) {
        try {
          await this.#options.leases.release(claimedRecord.lease.id);
        } catch {
          // Preserve the original startup failure. A later startup can observe
          // the retained lease and fail closed until it expires or is released.
        }
      }
      if (generation === this.#generation) {
        this.#state = "stopped";
        this.#record = null;
        this.#authority = null;
      }
      throw error;
    }
  }

  async renew(): Promise<ProductionAuthorityLifecycleSnapshot> {
    if (this.#renewalInFlight) return this.#renewalInFlight;
    const operation = this.renewInternal();
    this.#renewalInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.#renewalInFlight === operation) this.#renewalInFlight = undefined;
    }
  }

  private async renewInternal(): Promise<ProductionAuthorityLifecycleSnapshot> {
    if (this.#state !== "active" || !this.#record || !this.#authority) {
      throw new ProductionAuthorityLifecycleError(
        PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.NOT_ACTIVE,
        "Cannot renew authority when the lifecycle is not active",
      );
    }
    const record = this.#record;
    const generation = this.#generation;
    try {
      const current = await this.#options.leases.current(this.#options.agentId);
      this.assertActiveGeneration(generation, record);
      if (!current || current.lease.id !== record.lease.id) {
        throw new ProductionAuthorityLifecycleError(
          PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.LOST,
          "The authority lease is no longer current",
          { leaseId: record.lease.id },
        );
      }
      const renewed = await this.#options.leases.renew(
        record.lease.id,
        this.#options.leaseDurationMs,
      );
      this.assertActiveGeneration(generation, record);
      if (
        renewed.lease.id !== record.lease.id ||
        renewed.lease.holderId !== record.lease.holderId ||
        renewed.lease.ownerId !== record.lease.ownerId ||
        renewed.lease.agentId !== record.lease.agentId ||
        renewed.fencingToken !== record.fencingToken
      ) {
        throw new ProductionAuthorityLifecycleError(
          PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.LOST,
          "Authority renewal returned a different lease identity",
          { leaseId: record.lease.id },
        );
      }
      const deployment = assertActiveDeployment(
        await this.#options.deployment.read(this.#options.deploymentId),
        {
          id: this.#options.deploymentId,
          ownerId: this.#options.ownerId,
          agentId: this.#options.agentId,
        },
      );
      this.assertActiveGeneration(generation, record);
      const authority = authorityFrom(deployment, renewed);
      await this.#options.deployment.assertCurrent(authority);
      this.assertActiveGeneration(generation, record);
      if (this.#options.mirror) await this.#options.mirror.write(deployment);
      this.assertActiveGeneration(generation, record);
      this.#record = renewed;
      this.#authority = authority;
      return this.snapshot();
    } catch (error) {
      if (generation !== this.#generation || this.#state !== "active" || this.#record !== record) {
        throw error;
      }
      this.markLost(error);
      throw error;
    }
  }

  startAutomaticRenewal(intervalMs = Math.floor(this.#options.leaseDurationMs / 2)): void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new ProductionAuthorityLifecycleError(
        PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.CONFIGURATION_INVALID,
        "Authority renewal interval must be a positive safe integer",
        { intervalMs: String(intervalMs) },
      );
    }
    if (this.#renewalTimer) return;
    this.#renewalTimer = setInterval(() => {
      void this.renew().catch(() => undefined);
    }, intervalMs);
    this.#renewalTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#renewalTimer) {
      clearInterval(this.#renewalTimer);
      this.#renewalTimer = undefined;
    }
    if (this.#state === "stopped") return;
    const wasLost = this.#state === "lost";
    ++this.#generation;
    this.#state = "draining";
    const renewal = this.#renewalInFlight;
    if (renewal) await Promise.allSettled([renewal]);
    const record = this.#record;
    this.#record = null;
    this.#authority = null;
    try {
      if (record && !wasLost) {
        await this.#options.leases.release(record.lease.id);
      }
    } catch (error) {
      if (!isMissingAuthorityLease(error)) throw error;
    } finally {
      this.#state = "stopped";
    }
  }

  private markLost(error: unknown): void {
    if (this.#state !== "active") return;
    ++this.#generation;
    this.#state = "lost";
    this.#renewalTimer && clearInterval(this.#renewalTimer);
    this.#renewalTimer = undefined;
    void Promise.resolve(this.#options.onLost?.(error)).catch(() => undefined);
  }

  private assertStartingGeneration(generation: number): void {
    if (this.#state !== "starting" || this.#generation !== generation) {
      throw new ProductionAuthorityLifecycleError(
        PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.NOT_ACTIVE,
        "Authority startup was superseded before it became active",
      );
    }
  }

  private assertActiveGeneration(generation: number, record: AuthorityLeaseRecord): void {
    if (this.#state !== "active" || this.#generation !== generation || this.#record !== record) {
      throw new ProductionAuthorityLifecycleError(
        PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.NOT_ACTIVE,
        "Authority operation was superseded before it completed",
      );
    }
  }
}

export function createProductionAuthorityLifecycle(
  options: ProductionAuthorityLifecycleOptions,
): ProductionAuthorityLifecycle {
  return new ProductionAuthorityLifecycle(options);
}
