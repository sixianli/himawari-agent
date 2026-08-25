import type { IdempotencyKey } from "@himawari-agent/domain";
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
