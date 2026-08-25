import type { AgentId, AuthorityLeaseId, IdempotencyKey, OwnerId } from "@himawari-agent/domain";
import type { JsonObject, PayloadRef } from "./common.js";

export interface StateRecord {
  readonly key: string;
  readonly revision: number;
  readonly value: JsonObject;
}

export interface CompareAndSetStateInput {
  readonly key: string;
  readonly expectedRevision: number | null;
  readonly value: JsonObject;
}

export interface StateStorePort {
  read(key: string): Promise<StateRecord | undefined>;
  compareAndSet(input: CompareAndSetStateInput): Promise<StateRecord>;
}

export interface ReliableEvent {
  readonly id: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly topic: string;
  readonly payloadRef: PayloadRef;
  readonly occurredAt: string;
}

export interface ReliableEventRecord extends ReliableEvent {
  readonly publishedAt: string | null;
}

export interface ReliableEventPort {
  append(event: ReliableEvent): Promise<ReliableEventRecord>;
  listPending(limit: number): Promise<readonly ReliableEventRecord[]>;
  markPublished(eventId: string, publishedAt: string): Promise<ReliableEventRecord>;
}

export interface AuthorityFence {
  readonly leaseId: AuthorityLeaseId;
  readonly fencingToken: number;
}

export interface IdempotentAgentCommand {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly idempotencyKey: IdempotencyKey;
  readonly commandType: string;
  readonly commandFingerprint: string;
  readonly authority: AuthorityFence;
}

export interface CommandResultLookup {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly idempotencyKey: IdempotencyKey;
}

export interface CommandResultRecord extends CommandResultLookup {
  readonly commandType: string;
  readonly commandFingerprint: string;
  readonly resultRef: string;
  readonly stateKey: string;
  readonly stateRevision: number;
  readonly committedAt: string;
}

export interface CommitStateAndEventsInput {
  readonly command: IdempotentAgentCommand;
  readonly state: CompareAndSetStateInput;
  readonly events: readonly ReliableEvent[];
  readonly resultRef: string;
  readonly committedAt: string;
}

export interface CommitStateAndEventsResult {
  readonly state: StateRecord;
  readonly events: readonly ReliableEventRecord[];
  readonly commandResult: CommandResultRecord;
  readonly replayed: boolean;
}

export interface ProductStateRepositoryPort {
  read(key: string): Promise<StateRecord | undefined>;
  listPending(limit: number): Promise<readonly ReliableEventRecord[]>;
  markPublished(eventId: string, publishedAt: string): Promise<ReliableEventRecord>;
  findCommandResult(lookup: CommandResultLookup): Promise<CommandResultRecord | undefined>;
  findCommandCommit(lookup: CommandResultLookup): Promise<CommitStateAndEventsResult | undefined>;
  commitStateAndEvents(input: CommitStateAndEventsInput): Promise<CommitStateAndEventsResult>;
}

export interface ReliableEventDelivery {
  readonly eventId: string;
  readonly outcome: "published" | "duplicate";
}

export interface ReliableEventSinkPort {
  publish(event: ReliableEventRecord): Promise<ReliableEventDelivery>;
}
