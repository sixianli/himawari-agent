import type {
  EventSubscription,
  GatewayCommand,
  GatewayQuery,
  GatewaySnapshot,
  GetRunSnapshotQuery,
  GetThreadSnapshotQuery,
  RunSnapshot,
  StreamEvent,
  ThreadSnapshot,
  TraceQuery,
  GatewayV2Command,
  GatewayV2Event,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";

export interface GatewayAuthenticationContext {
  readonly subjectId: string;
  readonly ownerId: string;
  readonly deviceId: string;
  readonly authenticatedAt: string;
  readonly authenticationRef: string;
}

export type GatewayInboundMessage = GatewayCommand | GatewayQuery | EventSubscription;

export interface GatewayAccessDecision {
  readonly allowed: boolean;
  readonly reasonCode: string;
}

export interface GatewayAccessPolicyPort {
  authorize(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly message: GatewayInboundMessage;
  }): Promise<GatewayAccessDecision>;
}

export interface GatewayCommandExecution {
  readonly authentication: GatewayAuthenticationContext;
  readonly command: GatewayCommand;
}

export interface GatewayCommandResult {
  readonly resultRef: string;
  readonly replayed: boolean;
}

export interface GatewayControlPlanePort {
  execute(input: GatewayCommandExecution): Promise<GatewayCommandResult>;
}

export interface GatewayReadModelPort {
  getThreadSnapshot(query: GetThreadSnapshotQuery): Promise<ThreadSnapshot>;
  getRunSnapshot(query: GetRunSnapshotQuery): Promise<RunSnapshot>;
  queryTrace(query: TraceQuery): Promise<readonly StreamEvent[]>;
  subscribe(subscription: EventSubscription): AsyncIterable<StreamEvent>;
}

export type GatewayRequestMessage = GatewayCommand | GatewayQuery;
export type GatewayRequestResult = GatewayCommandResult | GatewaySnapshot | readonly StreamEvent[];

export interface AgentGatewayPort {
  request(
    authentication: GatewayAuthenticationContext,
    message: GatewayRequestMessage,
  ): Promise<GatewayRequestResult>;
  subscribe(
    authentication: GatewayAuthenticationContext,
    subscription: EventSubscription,
  ): AsyncIterable<StreamEvent>;
}

export interface GatewayV2CommandExecution {
  readonly authentication: GatewayAuthenticationContext;
  readonly command: GatewayV2Command;
}

export interface GatewayV2ControlPlanePort {
  execute(input: GatewayV2CommandExecution): Promise<GatewayCommandResult>;
}

export interface GatewayV2ReadModelPort {
  query(query: GatewayV2Query): Promise<GatewayV2Snapshot>;
  subscribe(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly afterCursor: string | null;
  }): AsyncIterable<GatewayV2Event>;
}
