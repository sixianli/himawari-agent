import type {
  AgentAuthorityLease,
  AgentId,
  AuthorityLeaseId,
  AuthorityLeasePort,
  AuthorityLeaseRecord,
  DeploymentAuthorityState,
  DeploymentAuthorityStatePort,
  DeploymentId,
  ProductAuthorityFence,
} from "@himawari-agent/application";
import { createBeefRestaurantFixture, createV02Fixture } from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";
import {
  PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES,
  ProductionAuthorityLifecycle,
  type ProductionAuthorityMirror,
} from "../src/production-authority-lifecycle.js";

const FIXTURE = createBeefRestaurantFixture();
const OWNER_ID = FIXTURE.owner.id;
const AGENT_ID = FIXTURE.agent.id;
const DEPLOYMENT_ID = createV02DeploymentId();
const NOW = "2026-09-05T00:00:00.000Z";

function createV02DeploymentId(): DeploymentId {
  return createV02Fixture().scope.authority.deploymentId;
}

function deployment(fencingToken = 1): DeploymentAuthorityState {
  return Object.freeze({
    id: DEPLOYMENT_ID,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    revision: fencingToken,
    status: "active" as const,
    authorityEpoch: 1,
    fencingToken,
    transferId: null,
  });
}

class DeploymentFixture implements DeploymentAuthorityStatePort {
  state: DeploymentAuthorityState = deployment();

  async read(deploymentId: DeploymentId): Promise<DeploymentAuthorityState | undefined> {
    return deploymentId === this.state.id ? this.state : undefined;
  }

  async save(): Promise<DeploymentAuthorityState> {
    throw new Error("not used");
  }

  async assertCurrent(fence: ProductAuthorityFence): Promise<DeploymentAuthorityState> {
    if (
      fence.deploymentId !== this.state.id ||
      fence.authorityEpoch !== this.state.authorityEpoch ||
      fence.fencingToken !== this.state.fencingToken
    ) {
      throw new Error("STALE_AUTHORITY");
    }
    return this.state;
  }

  bumpFence(): void {
    this.state = deployment(this.state.fencingToken + 1);
  }
}

class LeaseFixture implements AuthorityLeasePort {
  currentRecord: AuthorityLeaseRecord | undefined;
  readonly releasedLeaseIds: AuthorityLeaseId[] = [];
  readonly deployment: DeploymentFixture;
  renewGate: Promise<void> | undefined;
  renewEntered: (() => void) | undefined;
  claimGate: Promise<void> | undefined;
  claimEntered: (() => void) | undefined;

  constructor(deployment: DeploymentFixture) {
    this.deployment = deployment;
  }

  async claim(lease: AgentAuthorityLease, _durationMs: number): Promise<AuthorityLeaseRecord> {
    if (this.currentRecord) throw new Error("LEASE_CONFLICT");
    this.claimEntered?.();
    if (this.claimGate) await this.claimGate;
    this.deployment.bumpFence();
    const record: AuthorityLeaseRecord = Object.freeze({
      lease,
      fencingToken: this.deployment.state.fencingToken,
      acquiredAt: NOW,
      expiresAt: "2026-09-05T00:01:00.000Z",
    });
    this.currentRecord = record;
    return record;
  }

  async current(agentId: AgentId): Promise<AuthorityLeaseRecord | undefined> {
    return this.currentRecord?.lease.agentId === agentId ? this.currentRecord : undefined;
  }

  async renew(leaseId: AuthorityLeaseId, _durationMs: number): Promise<AuthorityLeaseRecord> {
    if (!this.currentRecord || this.currentRecord.lease.id !== leaseId)
      throw new Error("LEASE_NOT_HELD");
    this.renewEntered?.();
    if (this.renewGate) await this.renewGate;
    this.currentRecord = Object.freeze({
      ...this.currentRecord,
      expiresAt: "2026-09-05T00:02:00.000Z",
    });
    return this.currentRecord;
  }

  async release(leaseId: AuthorityLeaseId): Promise<void> {
    this.releasedLeaseIds.push(leaseId);
    if (this.currentRecord?.lease.id === leaseId) this.currentRecord = undefined;
  }

  loseCurrentAuthority(): void {
    this.currentRecord = undefined;
    this.deployment.bumpFence();
  }
}

function mirrorFixture(deploymentStore: DeploymentFixture): ProductionAuthorityMirror {
  let mirror = deploymentStore.state;
  return {
    async read() {
      return mirror;
    },
    async write(next) {
      mirror = next;
    },
  };
}

function lifecycle(
  deploymentStore: DeploymentFixture,
  leases: LeaseFixture,
  mirror?: ProductionAuthorityMirror,
  onLost?: (error: unknown) => void,
): ProductionAuthorityLifecycle {
  const options = {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    deploymentId: DEPLOYMENT_ID,
    deployment: deploymentStore,
    leases,
    clock: { now: () => NOW },
    leaseDurationMs: 60_000,
    nextAuthorityIdentity: () => ({
      leaseId: "authority-lease-production",
      holderId: "authority-holder-production",
    }),
    ...(onLost === undefined ? {} : { onLost }),
  };
  return new ProductionAuthorityLifecycle(mirror ? { ...options, mirror } : options);
}

describe("ProductionAuthorityLifecycle", () => {
  it("publishes the post-claim database fence and repairs a stale mirror", async () => {
    const deploymentStore = new DeploymentFixture();
    const leases = new LeaseFixture(deploymentStore);
    const mirror = mirrorFixture(deploymentStore);
    const service = lifecycle(deploymentStore, leases, mirror);

    const first = await service.start();
    expect(first.authority).toMatchObject({ fencingToken: 2, authorityEpoch: 1 });
    expect(first.lease?.fencingToken).toBe(2);
    expect(service.authorityLease()).toEqual({
      leaseId: "authority-lease-production",
      fencingToken: 2,
    });
    await service.stop();

    deploymentStore.bumpFence();
    const second = lifecycle(deploymentStore, leases, mirror);
    const repaired = await second.start();
    expect(repaired.authority?.fencingToken).toBe(4);
    expect((await mirror.read()).fencingToken).toBe(4);
    await second.stop();
  });

  it("rejects a mirror from a different authority or a future fence", async () => {
    const deploymentStore = new DeploymentFixture();
    const leases = new LeaseFixture(deploymentStore);
    const mismatched: ProductionAuthorityMirror = {
      async read() {
        return Object.freeze({
          ...deploymentStore.state,
          ownerId: createV02Fixture().scope.ownerId,
        });
      },
      async write() {
        throw new Error("not reached");
      },
    };
    await expect(lifecycle(deploymentStore, leases, mismatched).start()).rejects.toMatchObject({
      code: PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.MIRROR_MISMATCH,
    });
    expect(leases.currentRecord).toBeUndefined();

    const futureMirror: ProductionAuthorityMirror = {
      async read() {
        return Object.freeze({ ...deploymentStore.state, fencingToken: 99 });
      },
      async write() {
        throw new Error("not reached");
      },
    };
    await expect(lifecycle(deploymentStore, leases, futureMirror).start()).rejects.toMatchObject({
      code: PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.MIRROR_MISMATCH,
    });

    const changedDeploymentMirror: ProductionAuthorityMirror = {
      async read() {
        return Object.freeze({ ...deploymentStore.state, revision: 0 });
      },
      async write() {
        throw new Error("not reached");
      },
    };
    await expect(
      lifecycle(deploymentStore, leases, changedDeploymentMirror).start(),
    ).rejects.toMatchObject({
      code: PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.MIRROR_MISMATCH,
    });
  });

  it("releases a lease when post-claim mirror publication fails", async () => {
    const deploymentStore = new DeploymentFixture();
    const leases = new LeaseFixture(deploymentStore);
    const mirror: ProductionAuthorityMirror = {
      async read() {
        return deploymentStore.state;
      },
      async write() {
        throw new Error("MIRROR_WRITE_FAILED");
      },
    };
    const service = lifecycle(deploymentStore, leases, mirror);

    await expect(service.start()).rejects.toThrow("MIRROR_WRITE_FAILED");
    expect(service.state).toBe("stopped");
    expect(leases.currentRecord).toBeUndefined();
    expect(leases.releasedLeaseIds).toEqual(["authority-lease-production"]);
  });

  it("stops accepting and reports lost authority when the lease disappears", async () => {
    const deploymentStore = new DeploymentFixture();
    const leases = new LeaseFixture(deploymentStore);
    let lossNotification: unknown;
    const service = lifecycle(deploymentStore, leases, undefined, (error) => {
      lossNotification = error;
    });
    await service.start();
    leases.loseCurrentAuthority();

    await expect(service.assertActive()).rejects.toMatchObject({
      code: PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.LOST,
    });
    expect(service.state).toBe("lost");
    expect(service.isAccepting()).toBe(false);
    expect(lossNotification).toMatchObject({
      code: PRODUCTION_AUTHORITY_LIFECYCLE_ERROR_CODES.LOST,
    });
    await service.stop();
    expect(leases.releasedLeaseIds).toEqual([]);
  });

  it("does not let an in-flight renewal resurrect authority after stop", async () => {
    const deploymentStore = new DeploymentFixture();
    const leases = new LeaseFixture(deploymentStore);
    const service = lifecycle(deploymentStore, leases);
    await service.start();
    let releaseRenewal!: () => void;
    leases.renewGate = new Promise((resolve) => {
      releaseRenewal = resolve;
    });
    const renewalEntered = new Promise<void>((resolve) => {
      leases.renewEntered = resolve;
    });

    const renewal = service.renew();
    await renewalEntered;
    const stopping = service.stop();
    expect(service.state).toBe("draining");
    releaseRenewal();
    await Promise.allSettled([renewal, stopping]);

    expect(service.state).toBe("stopped");
    expect(service.isAccepting()).toBe(false);
    expect(leases.releasedLeaseIds).toEqual(["authority-lease-production"]);
  });

  it("does not become active when startup is superseded by stop", async () => {
    const deploymentStore = new DeploymentFixture();
    const leases = new LeaseFixture(deploymentStore);
    const service = lifecycle(deploymentStore, leases);
    let releaseClaim!: () => void;
    leases.claimGate = new Promise((resolve) => {
      releaseClaim = resolve;
    });
    const claimEntered = new Promise<void>((resolve) => {
      leases.claimEntered = resolve;
    });

    const starting = service.start();
    await claimEntered;
    const stopping = service.stop();
    releaseClaim();
    await Promise.allSettled([starting, stopping]);

    expect(service.state).toBe("stopped");
    expect(service.isAccepting()).toBe(false);
    expect(leases.currentRecord).toBeUndefined();
    expect(leases.releasedLeaseIds).toEqual(["authority-lease-production"]);
  });

  it("does not resurrect startup after a superseding stop during mirror publication", async () => {
    const deploymentStore = new DeploymentFixture();
    const leases = new LeaseFixture(deploymentStore);
    let releaseMirror!: () => void;
    let enterMirror!: () => void;
    const mirrorEntered = new Promise<void>((resolve) => {
      enterMirror = resolve;
    });
    const mirrorGate = new Promise<void>((resolve) => {
      releaseMirror = resolve;
    });
    const mirror: ProductionAuthorityMirror = {
      async read() {
        return deploymentStore.state;
      },
      async write() {
        enterMirror();
        await mirrorGate;
      },
    };
    const service = lifecycle(deploymentStore, leases, mirror);

    const starting = service.start();
    await mirrorEntered;
    const stopping = service.stop();
    releaseMirror();
    await Promise.allSettled([starting, stopping]);

    expect(service.state).toBe("stopped");
    expect(service.isAccepting()).toBe(false);
    expect(leases.currentRecord).toBeUndefined();
    expect(leases.releasedLeaseIds).toEqual(["authority-lease-production"]);
  });

  it("does not resurrect renewal after a superseding stop during mirror publication", async () => {
    const deploymentStore = new DeploymentFixture();
    const leases = new LeaseFixture(deploymentStore);
    let writes = 0;
    let releaseMirror!: () => void;
    let enterMirror!: () => void;
    const mirrorEntered = new Promise<void>((resolve) => {
      enterMirror = resolve;
    });
    const mirrorGate = new Promise<void>((resolve) => {
      releaseMirror = resolve;
    });
    const mirror: ProductionAuthorityMirror = {
      async read() {
        return deploymentStore.state;
      },
      async write(next) {
        writes += 1;
        if (writes === 2) {
          enterMirror();
          await mirrorGate;
        }
        void next;
      },
    };
    const service = lifecycle(deploymentStore, leases, mirror);
    await service.start();

    const renewing = service.renew();
    await mirrorEntered;
    const stopping = service.stop();
    expect(service.state).toBe("draining");
    releaseMirror();
    await Promise.allSettled([renewing, stopping]);

    expect(service.state).toBe("stopped");
    expect(service.isAccepting()).toBe(false);
    expect(leases.currentRecord).toBeUndefined();
    expect(leases.releasedLeaseIds).toEqual(["authority-lease-production"]);
  });

  it("does not mark authority lost after a superseding stop during final validation", async () => {
    const deploymentStore = new DeploymentFixture();
    const leases = new LeaseFixture(deploymentStore);
    const service = lifecycle(deploymentStore, leases);
    await service.start();
    let releaseValidation!: () => void;
    let enterValidation!: () => void;
    const validationEntered = new Promise<void>((resolve) => {
      enterValidation = resolve;
    });
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const assertCurrent = deploymentStore.assertCurrent.bind(deploymentStore);
    deploymentStore.assertCurrent = async (fence) => {
      enterValidation();
      await validationGate;
      return assertCurrent(fence);
    };

    const asserting = service.assertActive();
    await validationEntered;
    const stopping = service.stop();
    expect(service.state).toBe("draining");
    releaseValidation();
    await Promise.allSettled([asserting, stopping]);

    expect(service.state).toBe("stopped");
    expect(service.isAccepting()).toBe(false);
    expect(leases.currentRecord).toBeUndefined();
    expect(leases.releasedLeaseIds).toEqual(["authority-lease-production"]);
  });
});
