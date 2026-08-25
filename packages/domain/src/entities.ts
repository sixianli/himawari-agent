import { DOMAIN_ERROR_CODES, DomainError } from "./errors.js";
import type {
  AgentId,
  IdempotencyKey,
  OwnerId,
  SessionId,
  ThreadId,
  TriggerId,
  TurnId,
} from "./identifiers.js";
import type { Run } from "./run-state.js";

export interface Owner {
  readonly id: OwnerId;
}

export interface Agent {
  readonly id: AgentId;
  readonly ownerId: OwnerId;
}

export interface Thread {
  readonly id: ThreadId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface Session {
  readonly id: SessionId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId?: ThreadId;
}

export interface Trigger {
  readonly id: TriggerId;
  readonly idempotencyKey: IdempotencyKey;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId?: ThreadId;
}

export interface Turn {
  readonly id: TurnId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly runId: Run["id"];
  readonly threadId?: ThreadId;
}

function assertThreadOwnership(agent: Agent, thread: Thread, operation: string): void {
  if (thread.ownerId !== agent.ownerId || thread.agentId !== agent.id) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.OWNERSHIP_MISMATCH,
      `${operation} requires Thread and Agent ownership to match`,
      {
        operation,
        agentId: agent.id,
        agentOwnerId: agent.ownerId,
        threadId: thread.id,
        threadAgentId: thread.agentId,
        threadOwnerId: thread.ownerId,
      },
    );
  }
}

export function createOwner(id: OwnerId): Owner {
  return Object.freeze({ id });
}

export function createAgent(input: { readonly id: AgentId; readonly owner: Owner }): Agent {
  return Object.freeze({ id: input.id, ownerId: input.owner.id });
}

export function createThread(input: { readonly id: ThreadId; readonly agent: Agent }): Thread {
  return Object.freeze({
    id: input.id,
    ownerId: input.agent.ownerId,
    agentId: input.agent.id,
  });
}

export function createSession(input: {
  readonly id: SessionId;
  readonly agent: Agent;
  readonly thread?: Thread;
}): Session {
  if (input.thread) assertThreadOwnership(input.agent, input.thread, "createSession");

  return Object.freeze({
    id: input.id,
    ownerId: input.agent.ownerId,
    agentId: input.agent.id,
    ...(input.thread ? { threadId: input.thread.id } : {}),
  });
}

export function createTrigger(input: {
  readonly id: TriggerId;
  readonly idempotencyKey: IdempotencyKey;
  readonly agent: Agent;
  readonly thread?: Thread;
}): Trigger {
  if (input.thread) assertThreadOwnership(input.agent, input.thread, "createTrigger");

  return Object.freeze({
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    ownerId: input.agent.ownerId,
    agentId: input.agent.id,
    ...(input.thread ? { threadId: input.thread.id } : {}),
  });
}

export function createTurn(input: { readonly id: TurnId; readonly run: Run }): Turn {
  return Object.freeze({
    id: input.id,
    ownerId: input.run.ownerId,
    agentId: input.run.agentId,
    sessionId: input.run.sessionId,
    runId: input.run.id,
    ...(input.run.threadId ? { threadId: input.run.threadId } : {}),
  });
}
