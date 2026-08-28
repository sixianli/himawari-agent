import { DOMAIN_ERROR_CODES, DomainError } from "./errors.js";
import type { AgentId, OwnerId, ThreadId, TurnId } from "./identifiers.js";

export const THREAD_STATUSES = [
  "active",
  "archived",
  "trashed",
  "deletion_pending",
  "deleted_verified",
] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export const ANSWER_LOCALES = ["zh-CN", "en", "ja"] as const;
export type AnswerLocale = (typeof ANSWER_LOCALES)[number];

export interface ThreadForkLineage {
  readonly sourceThreadId: ThreadId;
  readonly sourceTurnId: TurnId;
  readonly sourceWatermark: number;
  readonly summaryRefs: readonly string[];
  readonly policyRefs: readonly string[];
  readonly sourceContentAvailable: boolean;
  readonly forkedAt: string;
}

export interface ProductThread {
  readonly id: ThreadId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly revision: number;
  readonly status: ThreadStatus;
  readonly titleRef: string | null;
  readonly titleSource: "automatic" | "owner" | null;
  readonly titleRevision: number;
  readonly pinOrder: number | null;
  readonly answerLocale: AnswerLocale;
  readonly messageWatermark: number;
  readonly lineage: ThreadForkLineage | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const TRANSITIONS = Object.freeze({
  active: ["archived", "trashed", "deletion_pending"],
  archived: ["active", "trashed", "deletion_pending"],
  trashed: ["active", "archived", "deletion_pending"],
  deletion_pending: ["trashed", "deleted_verified"],
  deleted_verified: [],
} satisfies Readonly<Record<ThreadStatus, readonly ThreadStatus[]>>);

export function createProductThread(input: {
  readonly id: ThreadId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly createdAt: string;
  readonly answerLocale?: AnswerLocale;
  readonly lineage?: ThreadForkLineage | null;
}): ProductThread {
  return Object.freeze({
    id: input.id,
    ownerId: input.ownerId,
    agentId: input.agentId,
    revision: 1,
    status: "active",
    titleRef: null,
    titleSource: null,
    titleRevision: 0,
    pinOrder: null,
    answerLocale: input.answerLocale ?? "zh-CN",
    messageWatermark: 0,
    lineage: input.lineage ?? null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

export function assertAnswerLocale(value: string): asserts value is AnswerLocale {
  if (!(ANSWER_LOCALES as readonly string[]).includes(value)) {
    throw new DomainError(DOMAIN_ERROR_CODES.INVALID_STATE_VALUE, "Unsupported answer locale", {
      answerLocale: value,
    });
  }
}

export function transitionProductThread(
  current: ProductThread,
  status: ThreadStatus,
  updatedAt: string,
): ProductThread {
  if (!(TRANSITIONS[current.status] as readonly ThreadStatus[]).includes(status)) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.INVALID_STATE_TRANSITION,
      `Thread cannot move from ${current.status} to ${status}`,
      { threadId: current.id, currentStatus: current.status, requestedStatus: status },
    );
  }
  return Object.freeze({ ...current, revision: current.revision + 1, status, updatedAt });
}

export function renameProductThread(
  current: ProductThread,
  input: {
    readonly titleRef: string;
    readonly source: "automatic" | "owner";
    readonly updatedAt: string;
  },
): ProductThread {
  if (!input.titleRef || current.status === "deleted_verified") {
    throw new DomainError(
      DOMAIN_ERROR_CODES.INVALID_STATE_VALUE,
      "Thread title cannot be updated",
      {
        threadId: current.id,
      },
    );
  }
  if (input.source === "automatic" && current.titleSource === "owner") {
    throw new DomainError(
      DOMAIN_ERROR_CODES.INVALID_STATE_TRANSITION,
      "Automatic title cannot replace an Owner title",
      { threadId: current.id },
    );
  }
  return Object.freeze({
    ...current,
    revision: current.revision + 1,
    titleRef: input.titleRef,
    titleSource: input.source,
    titleRevision: current.titleRevision + 1,
    updatedAt: input.updatedAt,
  });
}

export function setThreadAnswerLocale(
  current: ProductThread,
  answerLocale: string,
  updatedAt: string,
): ProductThread {
  assertAnswerLocale(answerLocale);
  if (current.status === "deleted_verified") {
    throw new DomainError(
      DOMAIN_ERROR_CODES.INVALID_STATE_TRANSITION,
      "Deleted Thread answer locale cannot be updated",
      { threadId: current.id },
    );
  }
  return Object.freeze({
    ...current,
    revision: current.revision + 1,
    answerLocale,
    updatedAt,
  });
}

export function setThreadPinOrder(
  current: ProductThread,
  pinOrder: number | null,
  updatedAt: string,
): ProductThread {
  if (
    (pinOrder !== null && (!Number.isSafeInteger(pinOrder) || pinOrder < 0)) ||
    current.status === "deleted_verified"
  ) {
    throw new DomainError(DOMAIN_ERROR_CODES.INVALID_STATE_VALUE, "Thread pin order is invalid", {
      threadId: current.id,
      pinOrder: String(pinOrder),
    });
  }
  return Object.freeze({
    ...current,
    revision: current.revision + 1,
    pinOrder,
    updatedAt,
  });
}
