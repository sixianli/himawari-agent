import {
  AgentGatewayService,
  AttentionPolicyService,
  CapabilityRegistryService,
  ContextFormationService,
  ModelRouterService,
  PermissionService,
  ReliableEventPublisher,
  RunCoordinator,
  RunStateCommitCoordinator,
  SessionTraceRecorder,
  type GatewayAccessPolicyPort,
  type GatewayAuthenticationContext,
  type GatewayControlPlanePort,
  type GatewayReadModelPort,
  type GatewayRequestResult,
  type SecretPort,
} from "@himawari-agent/application";
import type {
  EXECUTION_SCHEMA_VERSION,
  ExecutionEvent,
  ExecutionRequest,
} from "@himawari-agent/execution-contracts";
import { GATEWAY_SCHEMA_VERSION, type StreamEvent } from "@himawari-agent/gateway-contracts";
import {
  InMemoryGatewayControlPlane,
  InMemoryGatewayReadModel,
  type ReferenceAdapterSet,
  createReferenceAdapterSet,
} from "@himawari-agent/testing";
import { type GatewayAuthenticatorPort, InProcessGatewayTransport } from "./in-process-gateway.js";

export interface ExecutionWorkerClientBoundary {
  readonly adapterIdentity: string;
  readonly schemaVersion: typeof EXECUTION_SCHEMA_VERSION;
  isReady(): boolean;
  dispatch(request: ExecutionRequest): AsyncIterable<ExecutionEvent>;
}

export interface LocalServiceDiagnostic {
  readonly component: "agent-service" | "execution-worker-client";
  readonly adapterIdentity: string;
  readonly schemaVersion: typeof GATEWAY_SCHEMA_VERSION | typeof EXECUTION_SCHEMA_VERSION;
  readonly readiness: "ready";
}

export class StaticLocalGatewayAuthenticator implements GatewayAuthenticatorPort {
  private readonly credential: unknown;
  private readonly context: GatewayAuthenticationContext;

  constructor(credential: unknown, context: GatewayAuthenticationContext) {
    this.credential = credential;
    this.context = Object.freeze({ ...context });
  }

  async authenticate(credential: unknown): Promise<GatewayAuthenticationContext> {
    if (credential !== this.credential) throw new Error("AUTHENTICATION_FAILED");
    return this.context;
  }
}

export interface LocalAgentServiceCompositionOptions {
  readonly authenticator: GatewayAuthenticatorPort;
  readonly access: GatewayAccessPolicyPort;
  readonly worker: ExecutionWorkerClientBoundary;
  readonly adapters?: ReferenceAdapterSet;
  readonly secret?: SecretPort;
  readonly controlPlane?: GatewayControlPlanePort;
  readonly reads?: GatewayReadModelPort;
}

export class LocalAgentServiceProcess {
  private readonly transport: InProcessGatewayTransport;
  private readonly worker: ExecutionWorkerClientBoundary;
  private readonly activeRequests = new Set<Promise<unknown>>();
  private lifecycle: "stopped" | "ready" | "draining" = "stopped";

  constructor(transport: InProcessGatewayTransport, worker: ExecutionWorkerClientBoundary) {
    this.transport = transport;
    this.worker = worker;
  }

  async start(): Promise<readonly LocalServiceDiagnostic[]> {
    if (!this.worker.isReady()) throw new Error("EXECUTION_WORKER_NOT_READY");
    if (this.lifecycle === "draining") throw new Error("SERVICE_DRAINING");
    this.lifecycle = "ready";
    return Object.freeze([
      Object.freeze({
        component: "agent-service" as const,
        adapterIdentity: "local-foreground-composition",
        schemaVersion: GATEWAY_SCHEMA_VERSION,
        readiness: "ready" as const,
      }),
      Object.freeze({
        component: "execution-worker-client" as const,
        adapterIdentity: this.worker.adapterIdentity,
        schemaVersion: this.worker.schemaVersion,
        readiness: "ready" as const,
      }),
    ]);
  }

  isReady(): boolean {
    return this.lifecycle === "ready";
  }

  async request(credential: unknown, input: unknown): Promise<GatewayRequestResult> {
    this.assertReady();
    return this.trackRun(this.transport.request(credential, input));
  }

  async trackRun<TResult>(settlement: Promise<TResult>): Promise<TResult> {
    this.assertReady();
    this.activeRequests.add(settlement);
    try {
      return await settlement;
    } finally {
      this.activeRequests.delete(settlement);
    }
  }

  async *subscribe(credential: unknown, input: unknown): AsyncIterable<StreamEvent> {
    this.assertReady();
    let settle!: () => void;
    const settlement = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.activeRequests.add(settlement);
    try {
      for await (const event of this.transport.subscribe(credential, input)) yield event;
    } finally {
      settle();
      this.activeRequests.delete(settlement);
    }
  }

  async shutdown(): Promise<void> {
    if (this.lifecycle === "stopped") return;
    this.lifecycle = "draining";
    await Promise.allSettled([...this.activeRequests]);
    this.lifecycle = "stopped";
  }

  private assertReady(): void {
    if (this.lifecycle === "draining") throw new Error("SERVICE_DRAINING");
    if (this.lifecycle !== "ready") throw new Error("SERVICE_NOT_READY");
  }
}

export function createLocalAgentServiceComposition(options: LocalAgentServiceCompositionOptions) {
  const adapters = options.adapters ?? createReferenceAdapterSet();
  const secret = options.secret ?? adapters.secret;
  const controlPlane = options.controlPlane ?? new InMemoryGatewayControlPlane();
  const reads = options.reads ?? new InMemoryGatewayReadModel();
  const traceRecorder = new SessionTraceRecorder({
    trace: adapters.trace,
    payloads: adapters.payload,
    protector: adapters.payloadProtector,
    audit: adapters.audit,
    clock: adapters.clock,
    ids: adapters.ids,
  });
  const runState = new RunStateCommitCoordinator(adapters.productState, adapters.clock);
  const gateway = new AgentGatewayService({ access: options.access, controlPlane, reads });
  const transport = new InProcessGatewayTransport(options.authenticator, gateway);
  const services = Object.freeze({
    adapters,
    secret,
    gateway,
    trace: traceRecorder,
    runState,
    events: new ReliableEventPublisher(adapters.productState, adapters.eventSink, adapters.clock),
    context: new ContextFormationService({ memory: adapters.memory, trace: traceRecorder }),
    models: new ModelRouterService({
      model: adapters.model,
      secrets: secret,
      trace: traceRecorder,
      clock: adapters.clock,
      ids: adapters.ids,
    }),
    permissions: new PermissionService({
      store: adapters.authorization,
      clock: adapters.clock,
      ids: adapters.ids,
      policy: { version: "local-deny-by-default-v1", rules: [] },
    }),
    capabilities: new CapabilityRegistryService({
      store: adapters.capabilityRegistry,
      clock: adapters.clock,
      ids: adapters.ids,
    }),
    attention: new AttentionPolicyService({
      state: adapters.attentionState,
      delivery: adapters.delivery,
      clock: adapters.clock,
      policy: {
        duplicateWindowMs: 60_000,
        rateLimitWindowMs: 60_000,
        maxImmediateDeliveries: 1,
        quietHours: null,
        authorizedInterruptRefs: [],
      },
    }),
    coordinator: new RunCoordinator({
      runs: runState,
      checkpoints: adapters.state,
      context: new ContextFormationService({ memory: adapters.memory, trace: traceRecorder }),
      runtime: adapters.runtime,
      workers: adapters.workers,
      trace: traceRecorder,
    }),
    executionWorker: options.worker,
  });
  return Object.freeze({
    services,
    process: new LocalAgentServiceProcess(transport, options.worker),
  });
}
