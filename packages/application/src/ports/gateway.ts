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
  ThreadGatewayCommand,
  ThreadGatewayEvent,
  ThreadGatewayQuery,
  ThreadGatewayRequestResult,
  ThreadGatewaySubscription,
} from "@himawari-agent/gateway-contracts";
import type { RecentAuthenticationEvidence } from "./recent-authentication.js";

export interface GatewayAuthenticationContext {
  readonly subjectId: string;
  readonly ownerId: string;
  readonly deviceId: string;
  readonly authenticatedAt: string;
  readonly authenticationRef: string;
  /** Verified product session identity, when the transport uses product sessions. */
  readonly sessionId?: string;
  /** Optional provider evidence; ordinary authentication remains usable without it. */
  readonly recentAuthenticationEvidence?: RecentAuthenticationEvidence;
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

/** Snapshot invalidations are hints, not durable events or replay cursors. */
export type GatewayV2StreamItem =
  | GatewayV2Event
  | {
      readonly kind: "snapshot_required";
      readonly scope: { readonly ownerId: string; readonly agentId: string };
      readonly reason: "state_changed";
    };

export interface GatewayV2ReadModelPort {
  query(query: GatewayV2Query): Promise<GatewayV2Snapshot>;
  subscribe(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly afterCursor: string | null;
    readonly signal?: AbortSignal;
  }): AsyncIterable<GatewayV2StreamItem>;
}

export type GatewayV2InboundMessage = GatewayV2Command | GatewayV2Query;

export interface GatewayV2AccessPolicyPort {
  authorize(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly message: GatewayV2InboundMessage;
  }): Promise<GatewayAccessDecision>;
}

export interface AgentGatewayV2Port {
  request(
    authentication: GatewayAuthenticationContext,
    message: GatewayV2InboundMessage,
  ): Promise<GatewayCommandResult | GatewayV2Snapshot>;
  subscribe(
    authentication: GatewayAuthenticationContext,
    afterCursor: string | null,
    signal?: AbortSignal,
  ): AsyncIterable<GatewayV2StreamItem>;
}

export type ThreadGatewayRequestMessage = ThreadGatewayCommand | ThreadGatewayQuery;
export type ThreadGatewayInboundMessage = ThreadGatewayRequestMessage | ThreadGatewaySubscription;

export interface ThreadGatewayAccessPolicyPort {
  authorize(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly message: ThreadGatewayInboundMessage;
  }): Promise<GatewayAccessDecision>;
}

export interface ThreadGatewayControlPlanePort {
  execute(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly command: ThreadGatewayCommand;
  }): Promise<ThreadGatewayRequestResult>;
}

export interface ThreadGatewayReadModelPort {
  query(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly query: ThreadGatewayQuery;
  }): Promise<ThreadGatewayRequestResult>;
  subscribe(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly subscription: ThreadGatewaySubscription;
    readonly signal?: AbortSignal;
  }): AsyncIterable<ThreadGatewayEvent>;
}

export interface AgentThreadGatewayPort {
  request(
    authentication: GatewayAuthenticationContext,
    message: ThreadGatewayRequestMessage,
  ): Promise<ThreadGatewayRequestResult>;
  subscribe(
    authentication: GatewayAuthenticationContext,
    subscription: ThreadGatewaySubscription,
    signal?: AbortSignal,
  ): AsyncIterable<ThreadGatewayEvent>;
}
