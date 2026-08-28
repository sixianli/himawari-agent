import {
  createIdempotencyKey,
  createMessageId,
  createProductThread,
  createRunId,
  createThreadId,
  createTriggerId,
  createTurnId,
  renameProductThread,
  setThreadAnswerLocale,
  setThreadPinOrder,
  transitionProductThread,
  type AgentId,
  type AnswerLocale,
  type MessageId,
  type OwnerId,
  type ProductAuthorityFence,
  type ProductThread,
  type RunId,
  type SessionId,
  type ThreadId,
  type TurnId,
} from "@himawari-agent/domain";
import type { DataClassification, PayloadRef } from "../ports/common.js";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import type { ThreadRepositoryPort } from "../ports/threads.js";
import type { ClockPort } from "../ports/system.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function threadCommandFingerprint(value: unknown): string {
  let left = 14_695_981_039_346_656_037n;
  let right = 10_995_116_282_11n;
  for (const byte of new TextEncoder().encode(canonical(value))) {
    left ^= BigInt(byte);
    left = BigInt.asUintN(64, left * 1_099_511_628_211n);
    right ^= BigInt(byte + 1);
    right = BigInt.asUintN(64, right * 14_029_467_366_897_019_727n);
  }
  return `thread-command:v1:${left.toString(16).padStart(16, "0")}${right
    .toString(16)
    .padStart(16, "0")}`;
}

function fingerprintSuffix(value: unknown): string {
  return threadCommandFingerprint(value).split(":").at(-1) ?? "invalid";
}

/** Parse only an explicit Owner request to change the Thread answer-language setting. */
export function parseAnswerLocaleSettingIntent(input: string): AnswerLocale | null {
  const normalized = input.normalize("NFKC").trim().toLowerCase();
  const explicit =
    /(?:回答|回复|回覆|応答|返信|answer|reply|respond)(?:语言|語言|言語| language)?[\s，,：:を]*(?:设置|設定|改|切换|切換|変更|にして|で|set|switch|change|in|to)?[\s，,：:为成を]*(简体中文|中文|中国語|英文|英语|英語|日文|日语|日本語|chinese|english|japanese)/u.exec(
      normalized,
    );
  const language = explicit?.[1];
  if (!language) return null;
  if (["简体中文", "中文", "中国語", "chinese"].includes(language)) return "zh-CN";
  if (["英文", "英语", "英語", "english"].includes(language)) return "en";
  return "ja";
}

export interface ThreadCommandServiceDependencies {
  readonly repository: ThreadRepositoryPort;
  readonly clock: ClockPort;
  readonly authority: () => ProductAuthorityFence;
}

export class ThreadCommandService {
  private readonly dependencies: ThreadCommandServiceDependencies;

  constructor(dependencies: ThreadCommandServiceDependencies) {
    this.dependencies = dependencies;
  }

  async create(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly threadId?: ThreadId;
    readonly idempotencyKey: string;
    readonly answerLocale?: AnswerLocale;
    readonly resultRef: PayloadRef;
  }) {
    const idempotencyKey = createIdempotencyKey(input.idempotencyKey);
    const identity = fingerprintSuffix({
      type: "thread.create",
      ownerId: input.ownerId,
      agentId: input.agentId,
      idempotencyKey,
    });
    const thread = createProductThread({
      id: input.threadId ?? createThreadId(`thread:${identity}`),
      ownerId: input.ownerId,
      agentId: input.agentId,
      createdAt: this.dependencies.clock.now(),
      ...(input.answerLocale === undefined ? {} : { answerLocale: input.answerLocale }),
    });
    return this.dependencies.repository.create({
      thread,
      idempotencyKey,
      semanticFingerprint: threadCommandFingerprint({
        type: "thread.create",
        ownerId: thread.ownerId,
        agentId: thread.agentId,
        threadId: thread.id,
        answerLocale: thread.answerLocale,
      }),
      resultRef: input.resultRef,
      authority: this.dependencies.authority(),
    });
  }

  rename(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly threadId: ThreadId;
    readonly expectedRevision: number;
    readonly titleRef: PayloadRef;
    readonly source: "automatic" | "owner";
    readonly idempotencyKey: string;
    readonly resultRef: PayloadRef;
  }) {
    return this.update(
      input,
      "thread.rename",
      { titleRef: input.titleRef, source: input.source },
      (thread) =>
        renameProductThread(thread, {
          titleRef: input.titleRef,
          source: input.source,
          updatedAt: this.dependencies.clock.now(),
        }),
    );
  }

  pin(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly threadId: ThreadId;
    readonly expectedRevision: number;
    readonly pinOrder: number | null;
    readonly idempotencyKey: string;
    readonly resultRef: PayloadRef;
  }) {
    return this.update(input, "thread.pin", { pinOrder: input.pinOrder }, (thread) =>
      setThreadPinOrder(thread, input.pinOrder, this.dependencies.clock.now()),
    );
  }

  setAnswerLocale(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly threadId: ThreadId;
    readonly expectedRevision: number;
    readonly answerLocale: string;
    readonly idempotencyKey: string;
    readonly resultRef: PayloadRef;
  }) {
    return this.update(
      input,
      "thread.set_answer_locale",
      { answerLocale: input.answerLocale },
      (thread) => setThreadAnswerLocale(thread, input.answerLocale, this.dependencies.clock.now()),
    );
  }

  setLifecycle(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly threadId: ThreadId;
    readonly expectedRevision: number;
    readonly status: "active" | "archived" | "trashed";
    readonly idempotencyKey: string;
    readonly resultRef: PayloadRef;
  }) {
    return this.update(input, `thread.${input.status}`, { status: input.status }, (thread) =>
      transitionProductThread(thread, input.status, this.dependencies.clock.now()),
    );
  }

  async admitOwnerMessage(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly threadId: ThreadId;
    readonly expectedThreadRevision: number;
    readonly sessionId: SessionId;
    readonly idempotencyKey: string;
    readonly contentRef: PayloadRef;
    readonly sourceProofRef: string;
    readonly dataClassification: DataClassification;
    readonly resultRef: PayloadRef;
    readonly messageId?: MessageId;
    readonly turnId?: TurnId;
    readonly runId?: RunId;
  }) {
    const occurredAt = this.dependencies.clock.now();
    const idempotencyKey = createIdempotencyKey(input.idempotencyKey);
    const identity = fingerprintSuffix({
      type: "thread.message.submit",
      ownerId: input.ownerId,
      agentId: input.agentId,
      threadId: input.threadId,
      idempotencyKey,
      contentRef: input.contentRef,
    });
    const messageId = input.messageId ?? createMessageId(`message:${identity}`);
    const turnId = input.turnId ?? createTurnId(`turn:${identity}`);
    const runId = input.runId ?? createRunId(`run:${identity}`);
    const triggerId = createTriggerId(`trigger:${identity}`);
    return this.dependencies.repository.admitOwnerMessage({
      ...input,
      messageId,
      turnId,
      runId,
      triggerId,
      idempotencyKey,
      semanticFingerprint: threadCommandFingerprint({
        type: "thread.message.submit",
        threadId: input.threadId,
        messageId,
        contentRef: input.contentRef,
      }),
      occurredAt,
      authority: this.dependencies.authority(),
    });
  }

  commitAssistantMessage(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly threadId: ThreadId;
    readonly expectedThreadRevision: number;
    readonly turnId: TurnId;
    readonly runId: RunId;
    readonly idempotencyKey: string;
    readonly contentRef: PayloadRef;
    readonly dataClassification: DataClassification;
    readonly resultRef: PayloadRef;
    readonly messageId?: MessageId;
  }) {
    const idempotencyKey = createIdempotencyKey(input.idempotencyKey);
    const identity = fingerprintSuffix({
      type: "thread.message.commit_assistant",
      ownerId: input.ownerId,
      agentId: input.agentId,
      threadId: input.threadId,
      runId: input.runId,
      idempotencyKey,
      contentRef: input.contentRef,
    });
    const messageId = input.messageId ?? createMessageId(`message:${identity}`);
    return this.dependencies.repository.commitAssistantMessage({
      ...input,
      messageId,
      idempotencyKey,
      semanticFingerprint: threadCommandFingerprint({
        type: "thread.message.commit_assistant",
        threadId: input.threadId,
        turnId: input.turnId,
        runId: input.runId,
        messageId,
        contentRef: input.contentRef,
      }),
      committedAt: this.dependencies.clock.now(),
      authority: this.dependencies.authority(),
    });
  }

  private async update(
    input: {
      readonly ownerId: OwnerId;
      readonly agentId: AgentId;
      readonly threadId: ThreadId;
      readonly expectedRevision: number;
      readonly idempotencyKey: string;
      readonly resultRef: PayloadRef;
    },
    commandType: string,
    semanticIntent: unknown,
    mutate: (thread: ProductThread) => ProductThread,
  ) {
    const idempotencyKey = createIdempotencyKey(input.idempotencyKey);
    const semanticFingerprint = threadCommandFingerprint({
      commandType,
      ownerId: input.ownerId,
      agentId: input.agentId,
      threadId: input.threadId,
      expectedRevision: input.expectedRevision,
      semanticIntent,
    });
    const replay = await this.dependencies.repository.findReceipt(
      input.ownerId,
      input.agentId,
      idempotencyKey,
    );
    if (replay) {
      if (
        replay.commandType !== commandType ||
        replay.semanticFingerprint !== semanticFingerprint
      ) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.CONFLICT,
          "Thread idempotency key was reused with different semantics",
          { idempotencyKey },
        );
      }
      const thread = await this.dependencies.repository.read(
        input.ownerId,
        input.agentId,
        replay.threadId,
      );
      if (!thread) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_FOUND,
          `Thread ${replay.threadId} not found`,
        );
      }
      return { thread, receipt: replay };
    }
    const current = await this.dependencies.repository.read(
      input.ownerId,
      input.agentId,
      input.threadId,
    );
    if (!current) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Thread ${input.threadId} not found`,
      );
    }
    if (current.revision !== input.expectedRevision) {
      throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Thread revision conflict", {
        threadId: input.threadId,
        expectedRevision: String(input.expectedRevision),
        actualRevision: String(current.revision),
      });
    }
    const thread = mutate(current);
    return this.dependencies.repository.update({
      ownerId: input.ownerId,
      agentId: input.agentId,
      thread,
      expectedRevision: input.expectedRevision,
      commandType,
      idempotencyKey,
      semanticFingerprint,
      resultRef: input.resultRef,
      authority: this.dependencies.authority(),
    });
  }
}
