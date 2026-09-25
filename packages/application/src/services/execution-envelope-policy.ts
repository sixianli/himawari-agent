import type {
  ExecutionCapabilitySource,
  ExecutionDelegationList,
  ExecutionEnvelope,
} from "@himawari-agent/execution-contracts";

export type EnvelopeCapability =
  | {
      readonly kind: "directory";
      readonly hostId: string;
      readonly grantRef: string;
      readonly canonicalRootId: string;
      readonly access: "read" | "write";
    }
  | { readonly kind: "network"; readonly target: string };

export interface StandingCapabilityAuthorization {
  readonly capability: EnvelopeCapability;
  readonly source: ExecutionCapabilitySource;
  readonly state: "not_yet_valid" | "active" | "expired" | "revoked" | "exhausted";
}

export interface EnvelopeAddition {
  readonly capability: EnvelopeCapability;
  readonly approver: "human" | "delegation_list";
  readonly grantedBy: ExecutionCapabilitySource | null;
}

export interface CredentialConfirmation {
  readonly secretRef: string;
  readonly confirmed: boolean;
}

export type EnvelopeDecision =
  | { readonly kind: "within_envelope"; readonly credentials: readonly CredentialConfirmation[] }
  | { readonly kind: "outside_envelope" }
  | {
      readonly kind: "change";
      readonly initial: boolean;
      readonly rotationRequired: boolean;
      readonly additions: readonly EnvelopeAddition[];
      readonly credentials: readonly CredentialConfirmation[];
      readonly nextEnvelope: ExecutionEnvelope | null;
    };

type Directory = Extract<EnvelopeCapability, { kind: "directory" }>;
const sameRoot = (a: Pick<Directory, "hostId" | "canonicalRootId">, b: typeof a) =>
  a.hostId === b.hostId && a.canonicalRootId === b.canonicalRootId;
const live = (source: ExecutionCapabilitySource, now: string) =>
  Date.parse(source.expiresAt) > Date.parse(now);

function covers(held: EnvelopeCapability, wanted: EnvelopeCapability): boolean {
  if (held.kind === "network" || wanted.kind === "network")
    return held.kind === "network" && wanted.kind === "network" && held.target === wanted.target;
  return sameRoot(held, wanted) && (held.access === "write" || wanted.access === "read");
}

function envelopeCapabilities(envelope: ExecutionEnvelope): EnvelopeCapability[] {
  return [
    ...envelope.directories.map(
      ({ source: _source, ...directory }): EnvelopeCapability => ({
        kind: "directory",
        ...directory,
      }),
    ),
    ...envelope.network.map(({ target }): EnvelopeCapability => ({ kind: "network", target })),
  ];
}

function approverFor(
  capability: EnvelopeCapability,
  delegation: ExecutionDelegationList | null,
): EnvelopeAddition["approver"] {
  const listed = delegation?.items.some((item) =>
    item.kind === "network"
      ? capability.kind === "network" && capability.target === item.target
      : capability.kind === "directory" &&
        capability.access === "read" &&
        sameRoot(item, capability),
  );
  return listed ? "delegation_list" : "human";
}

function grantedBy(
  capability: EnvelopeCapability,
  approver: EnvelopeAddition["approver"],
  approval: ExecutionCapabilitySource | null,
  standing: readonly StandingCapabilityAuthorization[],
  delegation: ExecutionDelegationList | null,
  now: string,
): ExecutionCapabilitySource | null {
  if (
    approval &&
    live(approval, now) &&
    (approval.decidedBy === "user" ||
      (approver === "delegation_list" &&
        delegation !== null &&
        approval.delegationListRef === delegation.ref))
  )
    return approval;
  const scoped = standing.find(
    (item) =>
      item.state === "active" &&
      item.source.decidedBy === "user" &&
      live(item.source, now) &&
      covers(item.capability, capability),
  );
  return scoped?.source ?? null;
}

function withAdditions(
  base: ExecutionEnvelope,
  additions: readonly EnvelopeAddition[],
): ExecutionEnvelope {
  let directories = [...base.directories];
  let network = [...base.network];
  for (const { capability, grantedBy: source } of additions) {
    if (!source) throw new Error("EXECUTION_ENVELOPE_ADDITION_UNGRANTED");
    if (capability.kind === "network") {
      network = [...network, { target: capability.target, source }];
      continue;
    }
    const { kind: _kind, ...directory } = capability;
    const entry = { ...directory, source };
    const index = directories.findIndex((held) => sameRoot(held, capability));
    directories =
      index === -1
        ? [...directories, entry]
        : directories.map((held, position) => (position === index ? entry : held));
  }
  return { ...base, directories, network };
}

export function decideEnvelopeChange(input: {
  readonly current: ExecutionEnvelope | null;
  readonly call: {
    readonly capabilities: readonly EnvelopeCapability[];
    readonly credentials: readonly string[];
    readonly expandsEnvelope: boolean;
    readonly approval: ExecutionCapabilitySource | null;
  };
  readonly standing: readonly StandingCapabilityAuthorization[];
  readonly delegation: ExecutionDelegationList | null;
  readonly resources: ExecutionEnvelope["resources"];
  readonly now: string;
}): EnvelopeDecision {
  const { current, call, delegation, now } = input;
  const credentials = call.credentials.map((secretRef) => ({
    secretRef,
    confirmed:
      call.approval !== null && call.approval.decidedBy === "user" && live(call.approval, now),
  }));
  const held = current ? envelopeCapabilities(current) : [];
  const missing = call.capabilities.filter(
    (wanted) => !held.some((capability) => covers(capability, wanted)),
  );
  if (current && missing.length === 0) return { kind: "within_envelope", credentials };
  if (current && !call.expandsEnvelope) return { kind: "outside_envelope" };
  const additions = missing.map((capability): EnvelopeAddition => {
    const approver = approverFor(capability, delegation);
    return {
      capability,
      approver,
      grantedBy: grantedBy(capability, approver, call.approval, input.standing, delegation, now),
    };
  });
  const base: ExecutionEnvelope = current ?? {
    schemaVersion: "execution-envelope.v1",
    directories: [],
    network: [],
    resources: input.resources,
  };
  return {
    kind: "change",
    initial: current === null,
    rotationRequired: current !== null,
    additions,
    credentials,
    nextEnvelope: additions.every((addition) => addition.grantedBy !== null)
      ? withAdditions(base, additions)
      : null,
  };
}

export function envelopeAfterWithdrawal(
  envelope: ExecutionEnvelope,
  input: { readonly now: string; readonly withdrawnAuthorizationRefs: readonly string[] },
): {
  readonly envelope: ExecutionEnvelope;
  readonly removed: readonly EnvelopeCapability[];
  readonly nextExpiryAt: string | null;
} {
  const withdrawn = (source: ExecutionCapabilitySource) =>
    !live(source, input.now) || input.withdrawnAuthorizationRefs.includes(source.authorizationRef);
  const directories = envelope.directories.filter((item) => !withdrawn(item.source));
  const network = envelope.network.filter((item) => !withdrawn(item.source));
  const remaining = { ...envelope, directories, network };
  const kept = new Set<unknown>([...directories, ...network]);
  const removed = envelopeCapabilities({
    ...envelope,
    directories: envelope.directories.filter((item) => !kept.has(item)),
    network: envelope.network.filter((item) => !kept.has(item)),
  });
  const expiries = [...directories, ...network].map((item) => item.source.expiresAt).sort();
  return {
    envelope: removed.length === 0 ? envelope : remaining,
    removed,
    nextExpiryAt: expiries[0] ?? null,
  };
}

export function envelopeApprovalContext(input: {
  readonly current: ExecutionEnvelope | null;
  readonly decision: EnvelopeDecision;
  readonly backgroundResourceRefs: readonly string[];
}): {
  readonly currentCapabilities: readonly EnvelopeCapability[];
  readonly additions: readonly EnvelopeAddition[];
  readonly stoppedResourceRefs: readonly string[];
} {
  const change = input.decision.kind === "change" ? input.decision : null;
  return {
    currentCapabilities: input.current ? envelopeCapabilities(input.current) : [],
    additions: change?.additions ?? [],
    stoppedResourceRefs: change?.rotationRequired ? [...input.backgroundResourceRefs] : [],
  };
}
