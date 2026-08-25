import { describe, expect, it } from "vitest";
import {
  DOMAIN_ERROR_CODES,
  DomainError,
  claimAgentAuthority,
  createAgent,
  createAgentAuthorityLease,
  createAgentId,
  createAuthorityHolderId,
  createAuthorityLeaseId,
  createOwner,
  createOwnerId,
  releaseAgentAuthority,
} from "../src/index.js";

function expectDomainError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected a DomainError");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

describe("single logical Agent authority", () => {
  it("allows one active lease and makes reclaiming the same lease idempotent", () => {
    const owner = createOwner(createOwnerId("owner-01"));
    const agent = createAgent({ id: createAgentId("agent-01"), owner });
    const lease = createAgentAuthorityLease({
      id: createAuthorityLeaseId("lease-01"),
      agent,
      holderId: createAuthorityHolderId("node-01"),
    });

    const claimed = claimAgentAuthority(undefined, lease);

    expect(claimed).toBe(lease);
    expect(claimAgentAuthority(claimed, lease)).toBe(lease);
    expect(Object.isFrozen(lease)).toBe(true);
  });

  it("rejects a simultaneous second lease for the same Agent", () => {
    const owner = createOwner(createOwnerId("owner-01"));
    const agent = createAgent({ id: createAgentId("agent-01"), owner });
    const first = createAgentAuthorityLease({
      id: createAuthorityLeaseId("lease-01"),
      agent,
      holderId: createAuthorityHolderId("node-01"),
    });
    const second = createAgentAuthorityLease({
      id: createAuthorityLeaseId("lease-02"),
      agent,
      holderId: createAuthorityHolderId("node-02"),
    });

    expectDomainError(
      () => claimAgentAuthority(first, second),
      DOMAIN_ERROR_CODES.AUTHORITY_LEASE_CONFLICT,
    );
  });

  it("rejects reusing a lease identity for a different holder", () => {
    const owner = createOwner(createOwnerId("owner-01"));
    const agent = createAgent({ id: createAgentId("agent-01"), owner });
    const first = createAgentAuthorityLease({
      id: createAuthorityLeaseId("lease-01"),
      agent,
      holderId: createAuthorityHolderId("node-01"),
    });
    const conflicting = createAgentAuthorityLease({
      id: createAuthorityLeaseId("lease-01"),
      agent,
      holderId: createAuthorityHolderId("node-02"),
    });

    expectDomainError(
      () => claimAgentAuthority(first, conflicting),
      DOMAIN_ERROR_CODES.AUTHORITY_LEASE_CONFLICT,
    );
  });

  it("rejects using one Agent authority slot for another Agent", () => {
    const owner = createOwner(createOwnerId("owner-01"));
    const firstAgent = createAgent({ id: createAgentId("agent-01"), owner });
    const secondAgent = createAgent({ id: createAgentId("agent-02"), owner });
    const first = createAgentAuthorityLease({
      id: createAuthorityLeaseId("lease-01"),
      agent: firstAgent,
      holderId: createAuthorityHolderId("node-01"),
    });
    const second = createAgentAuthorityLease({
      id: createAuthorityLeaseId("lease-02"),
      agent: secondAgent,
      holderId: createAuthorityHolderId("node-02"),
    });

    expectDomainError(
      () => claimAgentAuthority(first, second),
      DOMAIN_ERROR_CODES.AUTHORITY_LEASE_SCOPE_MISMATCH,
    );
  });

  it("releases only the currently held lease and allows a successor", () => {
    const owner = createOwner(createOwnerId("owner-01"));
    const agent = createAgent({ id: createAgentId("agent-01"), owner });
    const first = createAgentAuthorityLease({
      id: createAuthorityLeaseId("lease-01"),
      agent,
      holderId: createAuthorityHolderId("node-01"),
    });
    const successor = createAgentAuthorityLease({
      id: createAuthorityLeaseId("lease-02"),
      agent,
      holderId: createAuthorityHolderId("node-02"),
    });

    expectDomainError(
      () => releaseAgentAuthority(first, successor.id),
      DOMAIN_ERROR_CODES.AUTHORITY_LEASE_NOT_HELD,
    );

    const released = releaseAgentAuthority(first, first.id);
    expect(released).toBeUndefined();
    expect(claimAgentAuthority(released, successor)).toBe(successor);
  });
});
