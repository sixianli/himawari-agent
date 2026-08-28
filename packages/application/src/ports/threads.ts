import type {
  AgentId,
  IdempotencyKey,
  MessageId,
  OwnerId,
  ProductAuthorityFence,
  ProductThread,
  ProductThreadMessage,
  RunId,
  RunStatus,
  SessionId,
  ThreadId,
  TurnId,
  TriggerId,
} from "@himawari-agent/domain";
import type { DataClassification, PayloadRef } from "./common.js";

export interface ThreadMutationReceipt {
  readonly commandId: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly commandType: string;
  readonly semanticFingerprint: string;
  readonly threadId: ThreadId;
  readonly threadRevision: number;
  readonly resultRef: PayloadRef;
  readonly committedAt: string;
}

export interface ThreadCreateInput {
  readonly thread: ProductThread;
  readonly idempotencyKey: IdempotencyKey;
  readonly semanticFingerprint: string;
  readonly resultRef: PayloadRef;
  readonly authority: ProductAuthorityFence;
}

export interface ThreadUpdateInput {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly thread: ProductThread;
  readonly expectedRevision: number;
  readonly commandType: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly semanticFingerprint: string;
  readonly resultRef: PayloadRef;
  readonly authority: ProductAuthorityFence;
}

export interface AdmitOwnerMessageInput {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly expectedThreadRevision: number;
  readonly messageId: MessageId;
  readonly turnId: TurnId;
  readonly triggerId: TriggerId;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly idempotencyKey: IdempotencyKey;
  readonly semanticFingerprint: string;
  readonly contentRef: PayloadRef;
  readonly sourceProofRef: string;
  readonly dataClassification: DataClassification;
  readonly occurredAt: string;
  readonly resultRef: PayloadRef;
  readonly authority: ProductAuthorityFence;
}

export interface CommitAssistantMessageInput {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly expectedThreadRevision: number;
  readonly messageId: MessageId;
  readonly turnId: TurnId;
  readonly runId: RunId;
  readonly idempotencyKey: IdempotencyKey;
  readonly semanticFingerprint: string;
  readonly contentRef: PayloadRef;
  readonly dataClassification: DataClassification;
  readonly committedAt: string;
  readonly resultRef: PayloadRef;
  readonly authority: ProductAuthorityFence;
}

export interface ForkThreadInput {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly sourceThreadId: ThreadId;
  readonly sourceTurnId: TurnId;
  readonly sourceWatermark: number;
  readonly targetThread: ProductThread;
  readonly summaryRefs: readonly PayloadRef[];
  readonly policyRefs: readonly string[];
  readonly idempotencyKey: IdempotencyKey;
  readonly semanticFingerprint: string;
  readonly resultRef: PayloadRef;
  readonly authority: ProductAuthorityFence;
}

export interface ThreadListQuery {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly statuses: readonly ProductThread["status"][];
  readonly pinnedOnly: boolean;
  readonly afterThreadId: ThreadId | null;
  readonly limit: number;
}

export interface ThreadSearchQuery {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  /** Opaque, authorization-scoped search tokens. Plaintext content is never accepted here. */
  readonly tokenRefs: readonly string[];
  readonly projectionVersion: string;
  readonly statuses: readonly ProductThread["status"][];
  readonly jobStatuses: readonly ("active" | "paused" | "revoked")[];
  readonly updatedAfter: string | null;
  readonly updatedBefore: string | null;
  readonly afterThreadId: ThreadId | null;
  readonly limit: number;
}

export interface ThreadSearchProjectionInput {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly sequence: number;
  readonly dataClassification: DataClassification;
  readonly tokenRefs: readonly string[];
  readonly projectionVersion: string;
}

export interface ThreadTitleSearchProjectionInput {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly titleRevision: number;
  readonly dataClassification: DataClassification;
  readonly tokenRefs: readonly string[];
  readonly projectionVersion: string;
}

export interface ThreadTaskBinding {
  readonly taskId: string;
  readonly revision: number;
  readonly threadId: ThreadId;
  readonly status: "active" | "paused" | "cancelled";
}

export interface ThreadDeletionImpact {
  readonly threadId: ThreadId;
  readonly threadRevision: number;
  readonly associatedTasks: readonly ThreadTaskBinding[];
  readonly activeTaskIds: readonly string[];
}

export interface ThreadRunSummaryRecord {
  readonly runId: RunId;
  readonly revision: number;
  readonly status: RunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ThreadGatewayEventRecord {
  readonly cursorSequence: number;
  readonly cursor: string;
  readonly eventId: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly authority: ProductAuthorityFence;
  readonly threadId: ThreadId;
  readonly revision: number;
  readonly causationCommandId: string;
  readonly eventType: string;
  readonly payloadRef: PayloadRef | null;
  readonly occurredAt: string;
}

export type ThreadTaskResolution =
  | { readonly action: "pause" }
  | { readonly action: "cancel" }
  | { readonly action: "rebind"; readonly targetThreadId: ThreadId };

export interface ResolveThreadTaskInput {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly taskId: string;
  readonly expectedTaskRevision: number;
  readonly resolution: ThreadTaskResolution;
  readonly reasonCode: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly semanticFingerprint: string;
  readonly resultRef: PayloadRef;
  readonly resolvedAt: string;
  readonly authority: ProductAuthorityFence;
}

export interface RequestThreadDeletionInput {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly expectedThreadRevision: number;
  readonly mode: "trash" | "permanent";
  readonly reasonCode: string;
  readonly authorizationRef: string | null;
  readonly recentAuthenticationRef: string | null;
  readonly idempotencyKey: IdempotencyKey;
  readonly semanticFingerprint: string;
  readonly resultRef: PayloadRef;
  readonly requestedAt: string;
  readonly authority: ProductAuthorityFence;
}

export interface ThreadRepositoryPort {
  create(
    input: ThreadCreateInput,
  ): Promise<{ thread: ProductThread; receipt: ThreadMutationReceipt }>;
  read(ownerId: OwnerId, agentId: AgentId, threadId: ThreadId): Promise<ProductThread | undefined>;
  update(
    input: ThreadUpdateInput,
  ): Promise<{ thread: ProductThread; receipt: ThreadMutationReceipt }>;
  findReceipt(
    ownerId: OwnerId,
    agentId: AgentId,
    idempotencyKey: IdempotencyKey,
  ): Promise<ThreadMutationReceipt | undefined>;
  admitOwnerMessage(input: AdmitOwnerMessageInput): Promise<{
    thread: ProductThread;
    message: ProductThreadMessage;
    receipt: ThreadMutationReceipt;
  }>;
  commitAssistantMessage(input: CommitAssistantMessageInput): Promise<{
    thread: ProductThread;
    message: ProductThreadMessage;
    receipt: ThreadMutationReceipt;
  }>;
  fork(input: ForkThreadInput): Promise<{ thread: ProductThread; receipt: ThreadMutationReceipt }>;
  list(query: ThreadListQuery): Promise<readonly ProductThread[]>;
  listMessages(
    ownerId: OwnerId,
    agentId: AgentId,
    threadId: ThreadId,
    afterSequence: number,
    limit: number,
  ): Promise<readonly ProductThreadMessage[]>;
  listRuns(
    ownerId: OwnerId,
    agentId: AgentId,
    threadId: ThreadId,
  ): Promise<readonly ThreadRunSummaryRecord[]>;
  listGatewayEvents(
    ownerId: OwnerId,
    agentId: AgentId,
    afterCursor: string | null,
    limit: number,
  ): Promise<readonly ThreadGatewayEventRecord[]>;
  hasCommittedTurn(
    ownerId: OwnerId,
    agentId: AgentId,
    threadId: ThreadId,
    turnId: TurnId,
    atOrBeforeWatermark: number,
  ): Promise<boolean>;
  projectSearch(input: ThreadSearchProjectionInput): Promise<void>;
  projectTitleSearch(input: ThreadTitleSearchProjectionInput): Promise<void>;
  search(query: ThreadSearchQuery): Promise<readonly ProductThread[]>;
  rebuildSearch(
    ownerId: OwnerId,
    agentId: AgentId,
    threadId: ThreadId,
    projectionVersion: string,
  ): Promise<number>;
  inspectDeletionImpact(
    ownerId: OwnerId,
    agentId: AgentId,
    threadId: ThreadId,
  ): Promise<ThreadDeletionImpact>;
  resolveDeletionTask(input: ResolveThreadTaskInput): Promise<{
    impact: ThreadDeletionImpact;
    task: ThreadTaskBinding;
    receipt: ThreadMutationReceipt;
  }>;
  requestDeletion(input: RequestThreadDeletionInput): Promise<{
    thread: ProductThread;
    impact: ThreadDeletionImpact;
    receipt: ThreadMutationReceipt;
  }>;
}
