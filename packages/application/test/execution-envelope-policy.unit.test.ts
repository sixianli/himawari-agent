import type {
  ExecutionCapabilitySource,
  ExecutionDelegationList,
  ExecutionEnvelope,
} from "@himawari-agent/execution-contracts";
import { describe, expect, it } from "vitest";
import {
  decideEnvelopeChange,
  type EnvelopeCapability,
  envelopeAfterWithdrawal,
  envelopeApprovalContext,
  type StandingCapabilityAuthorization,
} from "../src/services/execution-envelope-policy.js";

const NOW = "2026-09-25T01:00:00.000Z";
const LATER = "2026-09-25T02:00:00.000Z";
const LATEST = "2026-09-25T03:00:00.000Z";
const PAST = "2026-09-25T00:30:00.000Z";
const resources = {
  cpuMillicores: 2000,
  memoryBytes: 1073741824,
  maxProcesses: 256,
  privateStorageBytes: 1073741824,
};
const user = (authorizationRef: string, expiresAt = LATER): ExecutionCapabilitySource => ({
  authorizationRef,
  decidedBy: "user",
  delegationListRef: null,
  expiresAt,
});
const reviewed = (
  authorizationRef: string,
  delegationListRef: string | null,
): ExecutionCapabilitySource => ({
  authorizationRef,
  decidedBy: "automatic_review",
  delegationListRef,
  expiresAt: LATER,
});
const directory = (
  canonicalRootId: string,
  access: "read" | "write",
): Extract<EnvelopeCapability, { kind: "directory" }> => ({
  kind: "directory",
  hostId: "host-1",
  grantRef: `grant-${canonicalRootId}`,
  canonicalRootId,
  access,
});
const network = (target: string): EnvelopeCapability => ({ kind: "network", target });
const delegation: ExecutionDelegationList = {
  schemaVersion: "execution-delegation-list.v1",
  ref: "delegation-list-3",
  revision: 3,
  items: [
    { kind: "network", target: "registry.npmjs.org:443" },
    { kind: "directory_read", hostId: "host-1", canonicalRootId: "root-docs" },
  ],
};
const envelope = (
  directories: ExecutionEnvelope["directories"],
  networkTargets: ExecutionEnvelope["network"] = [],
): ExecutionEnvelope => ({
  schemaVersion: "execution-envelope.v1",
  directories,
  network: networkTargets,
  resources,
});
const { kind: _kind, ...projectWrite } = directory("root-project", "write");
const current = envelope([{ ...projectWrite, source: user("grant-project") }]);
const call = (
  capabilities: readonly EnvelopeCapability[],
  approval: ExecutionCapabilitySource | null,
  options: { credentials?: readonly string[]; expandsEnvelope?: boolean } = {},
) => ({
  capabilities,
  approval,
  credentials: options.credentials ?? [],
  expandsEnvelope: options.expandsEnvelope ?? true,
});
const decide = (
  input: Partial<Parameters<typeof decideEnvelopeChange>[0]> &
    Pick<Parameters<typeof decideEnvelopeChange>[0], "call">,
) =>
  decideEnvelopeChange({
    current: null,
    standing: [],
    delegation,
    resources,
    now: NOW,
    ...input,
  });

describe("initial environment envelope", () => {
  it("takes the first call's human-approved scope and the host resource budget", () => {
    const decision = decide({
      call: call(
        [directory("root-project", "write"), network("example.com:443")],
        user("approval-first"),
      ),
    });
    expect(decision).toMatchObject({ kind: "change", initial: true, rotationRequired: false });
    if (decision.kind !== "change") throw new Error("expected a change");
    expect(decision.additions.map((item) => item.approver)).toEqual(["human", "human"]);
    expect(decision.nextEnvelope).toEqual(
      envelope(
        [{ ...projectWrite, source: user("approval-first") }],
        [{ target: "example.com:443", source: user("approval-first") }],
      ),
    );
  });

  it("does not let a first call carry human-only capabilities in on an automatic approval", () => {
    const decision = decide({
      call: call(
        [directory("root-project", "write"), network("registry.npmjs.org:443")],
        reviewed("review-first", null),
      ),
    });
    if (decision.kind !== "change") throw new Error("expected a change");
    expect(decision.nextEnvelope).toBeNull();
    expect(decision.additions).toEqual([
      { capability: directory("root-project", "write"), approver: "human", grantedBy: null },
      {
        capability: network("registry.npmjs.org:443"),
        approver: "delegation_list",
        grantedBy: null,
      },
    ]);
  });
});

describe("expansion of an existing envelope", () => {
  it("keeps calls inside the envelope in the same environment", () => {
    expect(
      decide({
        current,
        call: call([directory("root-project", "read")], reviewed("review-command", null)),
      }),
    ).toEqual({ kind: "within_envelope", credentials: [] });
  });

  it("lets automatic review add a listed item only under the current list version", () => {
    const approved = decide({
      current,
      call: call([network("registry.npmjs.org:443")], reviewed("review-npm", "delegation-list-3")),
    });
    expect(approved).toMatchObject({ kind: "change", initial: false, rotationRequired: true });
    if (approved.kind !== "change") throw new Error("expected a change");
    expect(approved.nextEnvelope).toEqual({
      ...current,
      network: [
        { target: "registry.npmjs.org:443", source: reviewed("review-npm", "delegation-list-3") },
      ],
    });
    for (const approval of [
      reviewed("review-npm", "delegation-list-2"),
      reviewed("review-npm", null),
    ]) {
      const stale = decide({ current, call: call([network("registry.npmjs.org:443")], approval) });
      if (stale.kind !== "change") throw new Error("expected a change");
      expect(stale.nextEnvelope).toBeNull();
      expect(stale.additions[0]).toMatchObject({ approver: "delegation_list", grantedBy: null });
    }
  });

  it("sends new directory writes, unlisted network and unlisted reads to a person", () => {
    for (const capability of [
      directory("root-other", "write"),
      directory("root-other", "read"),
      network("example.org:443"),
    ]) {
      const decision = decide({
        current,
        call: call([capability], reviewed("review-any", "delegation-list-3")),
      });
      if (decision.kind !== "change") throw new Error("expected a change");
      expect(decision.additions).toEqual([{ capability, approver: "human", grantedBy: null }]);
      expect(decision.nextEnvelope).toBeNull();
    }
    const listedRead = decide({
      current,
      call: call([directory("root-docs", "read")], reviewed("review-docs", "delegation-list-3")),
    });
    expect(listedRead).toMatchObject({
      kind: "change",
      additions: [{ approver: "delegation_list", grantedBy: { authorizationRef: "review-docs" } }],
    });
  });

  it("upgrades read to write for the same root only with a person's approval", () => {
    const readOnly = envelope([
      { ...projectWrite, access: "read", source: user("grant-project-read") },
    ]);
    const decision = decide({
      current: readOnly,
      call: call([directory("root-project", "write")], user("approval-write")),
    });
    if (decision.kind !== "change") throw new Error("expected a change");
    expect(decision.nextEnvelope?.directories).toEqual([
      { ...projectWrite, source: user("approval-write") },
    ]);
  });

  it("lets a person's live, exactly matching scoped authorization stand in for asking", () => {
    const standing: StandingCapabilityAuthorization[] = [
      {
        capability: network("example.org:443"),
        source: user("grant-example", LATEST),
        state: "active",
      },
    ];
    const decision = decide({
      current,
      standing,
      call: call([network("example.org:443")], reviewed("review-command", null)),
    });
    if (decision.kind !== "change") throw new Error("expected a change");
    expect(decision.additions).toEqual([
      {
        capability: network("example.org:443"),
        approver: "human",
        grantedBy: user("grant-example", LATEST),
      },
    ]);
    expect(decision.nextEnvelope?.network).toEqual([
      { target: "example.org:443", source: user("grant-example", LATEST) },
    ]);
  });

  it("does not accept automatic, expired, revoked or broader scoped authorizations", () => {
    const wanted = directory("root-child", "write");
    const cases: StandingCapabilityAuthorization[] = [
      { capability: wanted, source: reviewed("grant-auto", null), state: "active" },
      { capability: wanted, source: user("grant-old", PAST), state: "active" },
      { capability: wanted, source: user("grant-revoked"), state: "revoked" },
      { capability: wanted, source: user("grant-used"), state: "exhausted" },
      {
        capability: directory("root-parent", "write"),
        source: user("grant-parent"),
        state: "active",
      },
      { capability: directory("root-child", "read"), source: user("grant-read"), state: "active" },
    ];
    for (const standing of cases) {
      const decision = decide({
        current,
        standing: [standing],
        call: call([wanted], reviewed("review-command", null)),
      });
      if (decision.kind !== "change") throw new Error("expected a change");
      expect(decision.additions).toEqual([
        { capability: wanted, approver: "human", grantedBy: null },
      ]);
    }
  });

  it("keeps fixed file tools inside the envelope instead of expanding it", () => {
    expect(
      decide({
        current,
        call: call([directory("root-other", "write")], user("approval-file"), {
          expandsEnvelope: false,
        }),
      }),
    ).toEqual({ kind: "outside_envelope" });
  });
});

describe("credentials", () => {
  it("never enter the envelope and need a person in this approval every time", () => {
    const standing: StandingCapabilityAuthorization[] = [
      { capability: network("example.org:443"), source: user("grant-example"), state: "active" },
    ];
    expect(
      decide({
        current,
        standing,
        call: call([], user("approval-credential"), { credentials: ["secret-github"] }),
      }),
    ).toEqual({
      kind: "within_envelope",
      credentials: [{ secretRef: "secret-github", confirmed: true }],
    });
    for (const approval of [reviewed("review-credential", "delegation-list-3"), null]) {
      expect(
        decide({
          current,
          standing,
          call: call([], approval, { credentials: ["secret-github"] }),
        }),
      ).toEqual({
        kind: "within_envelope",
        credentials: [{ secretRef: "secret-github", confirmed: false }],
      });
    }
  });
});

describe("withdrawal and expiry", () => {
  const withNetwork = envelope(
    [{ ...projectWrite, source: user("grant-project", LATEST) }],
    [
      { target: "registry.npmjs.org:443", source: user("grant-npm", NOW) },
      { target: "example.org:443", source: user("grant-example", LATER) },
    ],
  );

  it("removes the earliest expired capability first and reports the next expiry", () => {
    expect(
      envelopeAfterWithdrawal(withNetwork, { now: NOW, withdrawnAuthorizationRefs: [] }),
    ).toEqual({
      envelope: { ...withNetwork, network: [withNetwork.network[1]] },
      removed: [{ kind: "network", target: "registry.npmjs.org:443" }],
      nextExpiryAt: LATER,
    });
  });

  it("removes every capability that came from a revoked authorization", () => {
    expect(
      envelopeAfterWithdrawal(withNetwork, {
        now: PAST,
        withdrawnAuthorizationRefs: ["grant-project"],
      }),
    ).toEqual({
      envelope: { ...withNetwork, directories: [] },
      removed: [directory("root-project", "write")],
      nextExpiryAt: NOW,
    });
  });

  it("leaves an envelope without withdrawn capabilities unchanged", () => {
    expect(
      envelopeAfterWithdrawal(withNetwork, { now: PAST, withdrawnAuthorizationRefs: [] }),
    ).toEqual({
      envelope: withNetwork,
      removed: [],
      nextExpiryAt: NOW,
    });
  });
});

describe("approval context", () => {
  it("shows current capabilities and lists background programs only when the environment changes", () => {
    const expansion = decide({
      current,
      call: call([network("registry.npmjs.org:443")], null),
    });
    expect(
      envelopeApprovalContext({
        current,
        decision: expansion,
        backgroundResourceRefs: ["resource-watcher"],
      }),
    ).toEqual({
      currentCapabilities: [directory("root-project", "write")],
      additions: [
        {
          capability: network("registry.npmjs.org:443"),
          approver: "delegation_list",
          grantedBy: null,
        },
      ],
      stoppedResourceRefs: ["resource-watcher"],
    });
    const within = decide({ current, call: call([directory("root-project", "read")], null) });
    expect(
      envelopeApprovalContext({
        current,
        decision: within,
        backgroundResourceRefs: ["resource-watcher"],
      }),
    ).toEqual({
      currentCapabilities: [directory("root-project", "write")],
      additions: [],
      stoppedResourceRefs: [],
    });
  });
});
