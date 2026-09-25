import { describe, expect, it } from "vitest";
import {
  ContractValidationError,
  EXECUTION_BACKEND_PROTOCOL_V1,
  EXECUTION_ENVIRONMENT_V1,
  executionBackendCapabilitiesSchema,
  executionDelegationListSchema,
  executionEnvelopeSchema,
  executionEnvironmentIdentitySchema,
  executionEnvironmentLocatorSchema,
  executionEnvironmentStopProofSchema,
  TASK_ENVIRONMENT_GUARANTEES,
} from "../src/index.ts";

const digest = "a".repeat(64);
const identity = {
  schemaVersion: EXECUTION_ENVIRONMENT_V1,
  ownerId: "owner-1",
  agentId: "agent-1",
  runId: "run-1",
  hostId: "host-1",
  executionJobId: "execution-job-1",
  environmentId: "environment-1",
  environmentGeneration: 1,
  role: "primary",
};
const source = {
  authorizationRef: "grant-1",
  decidedBy: "user",
  delegationListRef: null,
  expiresAt: "2026-09-25T02:00:00.000Z",
};
const envelope = {
  schemaVersion: "execution-envelope.v1",
  directories: [
    { hostId: "host-1", grantRef: "grant-dir", canonicalRootId: "root-1", access: "write", source },
  ],
  network: [{ target: "registry.npmjs.org:443", source }],
  resources: {
    cpuMillicores: 2000,
    memoryBytes: 1073741824,
    maxProcesses: 256,
    privateStorageBytes: 1073741824,
  },
};
const locator = {
  backendRef: "container",
  runtimeInstanceId: "runtime-1",
  runtimeEnvironmentId: "runtime-environment-1",
  createIntentId: "create-intent-1",
  effectivePolicyDigest: digest,
};
const verifiedProof = {
  basis: "verified_stopped",
  identity,
  locator,
  createIntentId: "create-intent-1",
  stopIntentId: "stop-intent-1",
  stopFence: 1,
  coverage: [
    "environment_terminated",
    "no_restart",
    "execute_closed",
    "egress_closed",
    "credentials_revoked",
  ],
  verifierRef: "verifier-1",
  checkedAt: "2026-09-25T01:00:00.000Z",
  validUntil: "2026-09-25T01:05:00.000Z",
  evidence: [{ ref: "evidence-1", digest }],
};

describe("execution environment contract v1", () => {
  it("accepts a backend declaring every required task-environment guarantee", () => {
    const parsed = executionBackendCapabilitiesSchema.parse({
      protocolVersion: EXECUTION_BACKEND_PROTOCOL_V1,
      backendRef: "container",
      runtimeInstanceId: "runtime-1",
      guarantees: [...TASK_ENVIRONMENT_GUARANTEES],
      checkedAt: "2026-09-25T01:00:00.000Z",
    });
    expect(parsed.guarantees).toEqual(TASK_ENVIRONMENT_GUARANTEES);
  });

  it("rejects unknown guarantees, repeated guarantees and other protocol versions", () => {
    const base = {
      protocolVersion: EXECUTION_BACKEND_PROTOCOL_V1,
      backendRef: "container",
      runtimeInstanceId: "runtime-1",
      guarantees: [...TASK_ENVIRONMENT_GUARANTEES],
      checkedAt: "2026-09-25T01:00:00.000Z",
    };
    for (const value of [
      { ...base, guarantees: [...base.guarantees, "future-guarantee.v1"] },
      { ...base, guarantees: [...base.guarantees, base.guarantees[0]] },
      { ...base, protocolVersion: "execution-backend.v0" },
      { ...base, protocolVersion: "execution-backend.v2" },
      { ...base, dockerSocket: "/var/run/docker.sock" },
    ])
      expect(() => executionBackendCapabilitiesSchema.parse(value)).toThrow(
        ContractValidationError,
      );
  });

  it("parses identities, envelopes and locators strictly", () => {
    expect(executionEnvironmentIdentitySchema.parse(identity)).toEqual(identity);
    expect(executionEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(executionEnvironmentLocatorSchema.parse(locator)).toEqual(locator);
    for (const value of [
      { ...identity, environmentGeneration: 0 },
      { ...identity, role: "shared" },
      { ...identity, schemaVersion: "execution-environment.v2" },
    ])
      expect(() => executionEnvironmentIdentitySchema.parse(value)).toThrow(
        ContractValidationError,
      );
    for (const value of [
      { ...envelope, directories: [envelope.directories[0], envelope.directories[0]] },
      { ...envelope, network: [{ target: "registry.npmjs.org", source }] },
      { ...envelope, network: [{ target: "*:443", source }] },
      { ...envelope, network: [envelope.network[0], envelope.network[0]] },
      {
        ...envelope,
        directories: [{ ...envelope.directories[0], source: { ...source, decidedBy: "model" } }],
      },
    ])
      expect(() => executionEnvelopeSchema.parse(value)).toThrow(ContractValidationError);
  });

  it("requires a stop proof to cover every closed capability within a valid window", () => {
    expect(executionEnvironmentStopProofSchema.parse(verifiedProof)).toEqual(verifiedProof);
    const neverCreated = {
      basis: "never_created",
      identity,
      createIntentId: "create-intent-1",
      stopIntentId: "stop-intent-1",
      stopFence: 1,
      verifierRef: "verifier-1",
      checkedAt: "2026-09-25T01:00:00.000Z",
      validUntil: "2026-09-25T01:05:00.000Z",
      evidence: [{ ref: "evidence-1", digest }],
    };
    expect(executionEnvironmentStopProofSchema.parse(neverCreated)).toEqual(neverCreated);
    for (const value of [
      { ...verifiedProof, coverage: verifiedProof.coverage.slice(1) },
      { ...verifiedProof, coverage: [...verifiedProof.coverage, "no_restart"] },
      { ...verifiedProof, evidence: [] },
      { ...verifiedProof, validUntil: verifiedProof.checkedAt },
      { ...verifiedProof, stopFence: 0 },
      { ...verifiedProof, basis: "exit_code_zero" },
      { ...neverCreated, locator },
    ])
      expect(() => executionEnvironmentStopProofSchema.parse(value)).toThrow(
        ContractValidationError,
      );
  });

  it("accepts only exact network targets and directory reads in a delegation list", () => {
    const list = {
      schemaVersion: "execution-delegation-list.v1",
      ref: "delegation-list-1",
      revision: 1,
      items: [
        { kind: "network", target: "registry.npmjs.org:443" },
        { kind: "directory_read", hostId: "host-1", canonicalRootId: "root-docs" },
      ],
    };
    expect(executionDelegationListSchema.parse(list)).toEqual(list);
    for (const item of [
      { kind: "directory_write", hostId: "host-1", canonicalRootId: "root-docs" },
      { kind: "directory_read", hostId: "host-1", canonicalRootId: "root-docs", access: "write" },
      { kind: "credential", secretRef: "secret-github" },
      { kind: "network", target: "*:443" },
      { kind: "network", target: "0.0.0.0:0" },
      { kind: "network", target: "registry.npmjs.org" },
    ])
      expect(() => executionDelegationListSchema.parse({ ...list, items: [item] })).toThrow(
        ContractValidationError,
      );
    expect(() =>
      executionDelegationListSchema.parse({ ...list, items: [list.items[0], list.items[0]] }),
    ).toThrow(ContractValidationError);
  });
});
