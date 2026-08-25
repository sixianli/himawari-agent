import {
  PORT_ERROR_CODES,
  ApplicationPortError,
  type GatewayAccessPolicyPort,
  type GatewayAuthenticationContext,
  type GatewayCommandExecution,
  type GatewayCommandResult,
  type GatewayControlPlanePort,
  type GatewayReadModelPort,
} from "@himawari-agent/application";
import type {
  EventSubscription,
  GetRunSnapshotQuery,
  GetThreadSnapshotQuery,
  RunSnapshot,
  StreamEvent,
  ThreadSnapshot,
  TraceQuery,
} from "@himawari-agent/gateway-contracts";
import { frozenCopy, valuesEqual } from "./helpers.js";

export class InMemoryGatewayAccessPolicy implements GatewayAccessPolicyPort {
  private readonly authorized: readonly GatewayAuthenticationContext[];

  constructor(authorized: readonly GatewayAuthenticationContext[] = []) {
    this.authorized = frozenCopy([...authorized]);
  }

  async authorize(input: {
    readonly authentication: GatewayAuthenticationContext;
  }): Promise<{ readonly allowed: boolean; readonly reasonCode: string }> {
    const allowed = this.authorized.some(
      (candidate) =>
        candidate.subjectId === input.authentication.subjectId &&
        candidate.ownerId === input.authentication.ownerId &&
        candidate.deviceId === input.authentication.deviceId &&
        candidate.authenticationRef === input.authentication.authenticationRef,
    );
    return allowed
      ? { allowed: true, reasonCode: "OWNER_DEVICE_AUTHORIZED" }
      : { allowed: false, reasonCode: "OWNER_DEVICE_NOT_AUTHORIZED" };
  }
}

export type InMemoryGatewayCommandHandler = (
  input: GatewayCommandExecution,
) => Promise<GatewayCommandResult>;

export class InMemoryGatewayControlPlane implements GatewayControlPlanePort {
  private readonly commits = new Map<
    string,
    { readonly command: GatewayCommandExecution["command"]; readonly resultRef: string }
  >();
  private readonly executions: GatewayCommandExecution[] = [];
  private readonly handler: InMemoryGatewayCommandHandler | undefined;

  constructor(handler?: InMemoryGatewayCommandHandler) {
    this.handler = handler;
  }

  async execute(input: GatewayCommandExecution): Promise<GatewayCommandResult> {
    const key = JSON.stringify([
      input.command.scope.ownerId,
      input.command.scope.agentId,
      input.command.idempotencyKey,
    ]);
    const current = this.commits.get(key);
    if (current) {
      if (!valuesEqual(current.command, input.command)) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.CONFLICT,
          `Gateway idempotency key ${input.command.idempotencyKey} was reused`,
          { idempotencyKey: input.command.idempotencyKey },
        );
      }
      return frozenCopy({ resultRef: current.resultRef, replayed: true });
    }

    this.executions.push(frozenCopy(input));
    const result = this.handler
      ? await this.handler(input)
      : { resultRef: `command:${input.command.idempotencyKey}`, replayed: false };
    this.commits.set(key, frozenCopy({ command: input.command, resultRef: result.resultRef }));
    return frozenCopy({ ...result, replayed: false });
  }

  observedExecutions(): readonly GatewayCommandExecution[] {
    return this.executions.map(frozenCopy);
  }
}

export class InMemoryGatewayReadModel implements GatewayReadModelPort {
  private readonly threads = new Map<string, ThreadSnapshot>();
  private readonly runs = new Map<string, RunSnapshot>();
  private readonly events: StreamEvent[] = [];

  seedThreadSnapshot(snapshot: ThreadSnapshot): void {
    this.threads.set(snapshot.payload.threadId, frozenCopy(snapshot));
  }

  seedRunSnapshot(snapshot: RunSnapshot): void {
    this.runs.set(snapshot.payload.runId, frozenCopy(snapshot));
  }

  appendEvent(event: StreamEvent): void {
    if (this.events.some(({ payload }) => payload.cursor === event.payload.cursor)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.DUPLICATE,
        `Gateway cursor ${event.payload.cursor} already exists`,
      );
    }
    this.events.push(frozenCopy(event));
  }

  async getThreadSnapshot(query: GetThreadSnapshotQuery): Promise<ThreadSnapshot> {
    const snapshot = this.threads.get(query.payload.threadId);
    if (!snapshot) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Thread ${query.payload.threadId} not found`,
      );
    }
    return frozenCopy(snapshot);
  }

  async getRunSnapshot(query: GetRunSnapshotQuery): Promise<RunSnapshot> {
    const snapshot = this.runs.get(query.payload.runId);
    if (!snapshot) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Run ${query.payload.runId} not found`,
      );
    }
    return frozenCopy(snapshot);
  }

  async queryTrace(query: TraceQuery): Promise<readonly StreamEvent[]> {
    return this.events
      .filter(
        (event) =>
          event.scope.ownerId === query.scope.ownerId &&
          event.scope.agentId === query.scope.agentId &&
          event.payload.sessionId === query.payload.sessionId &&
          (query.payload.runId === null || event.payload.runId === query.payload.runId) &&
          event.payload.sequence > query.payload.afterSequence,
      )
      .slice(0, query.payload.limit)
      .map(frozenCopy);
  }

  async *subscribe(subscription: EventSubscription): AsyncIterable<StreamEvent> {
    const afterIndex =
      subscription.payload.afterCursor === null
        ? -1
        : this.events.findIndex(
            ({ payload }) => payload.cursor === subscription.payload.afterCursor,
          );
    if (subscription.payload.afterCursor !== null && afterIndex < 0) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Gateway cursor ${subscription.payload.afterCursor} not found`,
      );
    }
    for (const event of this.events.slice(afterIndex + 1)) {
      const matches =
        event.scope.ownerId === subscription.scope.ownerId &&
        event.scope.agentId === subscription.scope.agentId &&
        (subscription.payload.sessionId === null ||
          event.payload.sessionId === subscription.payload.sessionId) &&
        (subscription.payload.threadId === null ||
          event.payload.threadId === subscription.payload.threadId) &&
        (subscription.payload.runId === null || event.payload.runId === subscription.payload.runId);
      if (matches) yield frozenCopy(event);
    }
  }
}
