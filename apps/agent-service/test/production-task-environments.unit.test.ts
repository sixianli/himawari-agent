import { describe, expect, it } from "vitest";
import { srtEnvironmentPolicyDigest } from "../src/production-task-environments.ts";

type DigestInput = Parameters<typeof srtEnvironmentPolicyDigest>[0];

function input(
  lease: Partial<DigestInput["plan"]["executionLease"]> = {},
  grant: Partial<DigestInput["grant"]> = {},
): DigestInput {
  return {
    grant: {
      id: "grant-1",
      revision: 1,
      operations: ["read", "create", "update"],
      canonicalRootId: "1:2",
      authorizationRef: "authorization-1",
      expiresAt: "2026-10-26T00:00:00.000Z",
      ...grant,
    } as DigestInput["grant"],
    binding: {
      profileRef: "authorized-project.v1",
      runtimeDigest: `sha256:${"a".repeat(64)}`,
      runner: { sha256: "b".repeat(64) },
    } as DigestInput["binding"],
    allowedDomains: ["b.example:443", "a.example:443"],
    envelope: { schemaVersion: "execution-envelope.v1" },
    plan: {
      executionLease: {
        executionLeaseId: "execution-lease-1",
        expectedLeaseRevision: 1,
        authorityLeaseId: "authority-lease-1",
        authorityFencingToken: 4,
        deploymentId: "deployment-1",
        authorityEpoch: 2,
        fencingToken: 4,
        consumerId: "agent-service",
        ...lease,
      },
      identity: { threadId: "thread-1" },
      modelRef: "model-1",
      binding: { qualificationRef: "qualification-1" },
    } as DigestInput["plan"],
  };
}

describe("SRT task environment reuse key", () => {
  it("keeps the Run's environment when the Run claims a new execution lease after an approval wait", () => {
    expect(
      srtEnvironmentPolicyDigest(
        input({ executionLeaseId: "execution-lease-2", expectedLeaseRevision: 3 }),
      ),
    ).toBe(srtEnvironmentPolicyDigest(input()));
  });

  it.each([
    ["a new authority epoch", input({ authorityEpoch: 3 })],
    ["a new authority lease", input({ authorityLeaseId: "authority-lease-2" })],
    ["a new fencing token", input({ fencingToken: 5, authorityFencingToken: 5 })],
    ["another deployment", input({ deploymentId: "deployment-2" })],
    ["a new grant revision", input({}, { revision: 2 })],
    ["a new grant expiry", input({}, { expiresAt: "2026-10-27T00:00:00.000Z" })],
  ])("replaces the environment after %s", (_name, changed) => {
    expect(srtEnvironmentPolicyDigest(changed)).not.toBe(srtEnvironmentPolicyDigest(input()));
  });
});
