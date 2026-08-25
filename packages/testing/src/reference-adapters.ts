import type {
  AgentRuntimePort,
  AttentionDecision,
  AttentionPort,
  AuditLedgerPort,
  AuthorityLeasePort,
  CapabilityDescriptor,
  CapabilityInvocationEvent,
  CapabilityPort,
  ClockPort,
  IdGeneratorPort,
  MemoryPort,
  ModelDescriptor,
  ModelInvocationEvent,
  ModelPort,
  PayloadStorePort,
  ReliableEventPort,
  RuntimeEvent,
  SchedulerPort,
  SecretPort,
  StateStorePort,
  TraceStorePort,
} from "@himawari-agent/application";
import {
  DeterministicIdGenerator,
  type FailureScheduler,
  ManualClock,
  NO_FAILURES,
} from "./deterministic.js";
import {
  InMemoryAuditLedger,
  InMemoryAuthorityLeasePort,
  InMemoryMemoryPort,
  InMemoryPayloadStore,
  InMemoryReliableEventPort,
  InMemoryScheduler,
  InMemorySecretPort,
  InMemoryStateStore,
  InMemoryTraceStore,
  ScriptedAgentRuntime,
  ScriptedAttentionPort,
  ScriptedCapabilityPort,
  ScriptedModelPort,
} from "./in-memory/index.js";

export interface ReferenceAdapterOptions {
  readonly clock?: ClockPort;
  readonly ids?: IdGeneratorPort;
  readonly failures?: FailureScheduler;
  readonly model?: {
    readonly descriptors: readonly ModelDescriptor[];
    readonly events: readonly ModelInvocationEvent[];
  };
  readonly runtime?: { readonly events: readonly RuntimeEvent[] };
  readonly capability?: {
    readonly descriptors: readonly CapabilityDescriptor[];
    readonly events: readonly CapabilityInvocationEvent[];
  };
  readonly attention?: { readonly decision: AttentionDecision };
}

export interface ReferenceAdapterSet {
  readonly state: StateStorePort;
  readonly reliableEvents: ReliableEventPort;
  readonly trace: TraceStorePort;
  readonly payload: PayloadStorePort;
  readonly audit: AuditLedgerPort;
  readonly memory: MemoryPort;
  readonly model: ModelPort;
  readonly runtime: AgentRuntimePort;
  readonly capability: CapabilityPort;
  readonly secret: SecretPort;
  readonly scheduler: SchedulerPort;
  readonly attention: AttentionPort;
  readonly authority: AuthorityLeasePort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
}

export function createReferenceAdapterSet(
  options: ReferenceAdapterOptions = {},
): ReferenceAdapterSet {
  const clock = options.clock ?? new ManualClock();
  const ids = options.ids ?? new DeterministicIdGenerator();
  const failures = options.failures ?? NO_FAILURES;
  const attentionDecision = options.attention?.decision ?? {
    candidateId: "attention-default",
    level: "SILENT" as const,
    reasonCode: "default_silent",
    interruptAuthorizationRef: null,
  };

  return Object.freeze({
    state: new InMemoryStateStore(failures),
    reliableEvents: new InMemoryReliableEventPort(failures),
    trace: new InMemoryTraceStore(failures),
    payload: new InMemoryPayloadStore(failures),
    audit: new InMemoryAuditLedger(failures),
    memory: new InMemoryMemoryPort(failures),
    model: new ScriptedModelPort(options.model?.descriptors, options.model?.events),
    runtime: new ScriptedAgentRuntime(() => clock.now(), options.runtime?.events),
    capability: new ScriptedCapabilityPort(
      options.capability?.descriptors,
      options.capability?.events,
    ),
    secret: new InMemorySecretPort(ids, failures),
    scheduler: new InMemoryScheduler(failures),
    attention: new ScriptedAttentionPort(attentionDecision),
    authority: new InMemoryAuthorityLeasePort(clock, failures),
    clock,
    ids,
  });
}
