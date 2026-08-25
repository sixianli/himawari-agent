import type {
  AgentRuntimePort,
  AttentionDecision,
  AttentionPort,
  AuditLedgerPort,
  AuthorizationStorePort,
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
  ProductStateRepositoryPort,
  ReliableEventPort,
  ReliableEventSinkPort,
  RuntimeEvent,
  SchedulerPort,
  SecretPort,
  SessionDeletionStatePort,
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
  DeterministicPayloadProtector,
  InMemoryAuditLedger,
  InMemoryAuthorizationStore,
  InMemoryAuthorityLeasePort,
  InMemoryMemoryPort,
  InMemoryPayloadStore,
  InMemoryProductStateRepository,
  InMemoryReliableEventSink,
  InMemoryScheduler,
  InMemorySecretPort,
  InMemorySessionDeletionState,
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
  readonly productState: ProductStateRepositoryPort;
  readonly eventSink: ReliableEventSinkPort;
  readonly trace: TraceStorePort;
  readonly payload: PayloadStorePort;
  readonly payloadProtector: DeterministicPayloadProtector;
  readonly audit: AuditLedgerPort;
  readonly authorization: AuthorizationStorePort;
  readonly deletionState: SessionDeletionStatePort;
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
  const authority = new InMemoryAuthorityLeasePort(clock, failures);
  const productState = new InMemoryProductStateRepository(authority, failures);
  const payloadProtector = new DeterministicPayloadProtector();

  return Object.freeze({
    state: productState,
    reliableEvents: productState,
    productState,
    eventSink: new InMemoryReliableEventSink(failures),
    trace: new InMemoryTraceStore(failures),
    payload: new InMemoryPayloadStore(failures),
    payloadProtector,
    audit: new InMemoryAuditLedger(failures),
    authorization: new InMemoryAuthorizationStore(failures),
    deletionState: new InMemorySessionDeletionState(failures),
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
    authority,
    clock,
    ids,
  });
}
