import {
  createIdempotencyKey,
  createProductThread,
  createThreadId,
  type AgentId,
  type OwnerId,
  type ProductAuthorityFence,
  type ThreadId,
  type TurnId,
} from "@himawari-agent/domain";
import type { PayloadRef } from "../ports/common.js";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import type { ThreadRepositoryPort } from "../ports/threads.js";
import type { ClockPort } from "../ports/system.js";
import { threadCommandFingerprint } from "./thread-command-service.js";

export class ThreadForkService {
  private readonly dependencies: {
    readonly repository: ThreadRepositoryPort;
    readonly clock: ClockPort;
    readonly authority: () => ProductAuthorityFence;
  };

  constructor(dependencies: ThreadForkService["dependencies"]) {
    this.dependencies = dependencies;
  }

  async fork(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly sourceThreadId: ThreadId;
    readonly sourceTurnId: TurnId;
    readonly sourceWatermark: number;
    readonly targetThreadId?: ThreadId;
    readonly summaryRefs: readonly PayloadRef[];
    readonly policyRefs: readonly string[];
    readonly idempotencyKey: string;
    readonly resultRef: PayloadRef;
  }) {
    const idempotencyKey = createIdempotencyKey(input.idempotencyKey);
    const targetIdentity = threadCommandFingerprint({
      type: "thread.fork.target",
      ownerId: input.ownerId,
      agentId: input.agentId,
      sourceThreadId: input.sourceThreadId,
      sourceTurnId: input.sourceTurnId,
      sourceWatermark: input.sourceWatermark,
      idempotencyKey,
    })
      .split(":")
      .at(-1);
    const targetThreadId =
      input.targetThreadId ??
      createThreadId(`thread-fork:${targetIdentity ?? "invalid-fingerprint"}`);
    const semanticFingerprint = threadCommandFingerprint({
      type: "thread.fork",
      sourceThreadId: input.sourceThreadId,
      sourceTurnId: input.sourceTurnId,
      sourceWatermark: input.sourceWatermark,
      targetThreadId,
      summaryRefs: input.summaryRefs,
      policyRefs: input.policyRefs,
    });
    const replay = await this.dependencies.repository.findReceipt(
      input.ownerId,
      input.agentId,
      idempotencyKey,
    );
    if (replay) {
      if (
        replay.commandType !== "thread.fork" ||
        replay.semanticFingerprint !== semanticFingerprint
      ) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.CONFLICT,
          "Thread Fork idempotency key was reused with different semantics",
        );
      }
      const existing = await this.dependencies.repository.read(
        input.ownerId,
        input.agentId,
        replay.threadId,
      );
      if (!existing) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_FOUND,
          "Replayed Fork target is missing",
        );
      }
      return { thread: existing, receipt: replay };
    }
    const source = await this.dependencies.repository.read(
      input.ownerId,
      input.agentId,
      input.sourceThreadId,
    );
    if (
      !source ||
      source.status === "deleted_verified" ||
      source.messageWatermark < input.sourceWatermark
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Fork source is missing, deleted, or not committed at the requested watermark",
      );
    }
    const sourceTurnCommitted = await this.dependencies.repository.hasCommittedTurn(
      input.ownerId,
      input.agentId,
      input.sourceThreadId,
      input.sourceTurnId,
      input.sourceWatermark,
    );
    if (!sourceTurnCommitted) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Fork requires a committed source Turn",
      );
    }
    const forkedAt = this.dependencies.clock.now();
    const targetThread = createProductThread({
      id: targetThreadId,
      ownerId: input.ownerId,
      agentId: input.agentId,
      createdAt: forkedAt,
      answerLocale: source.answerLocale,
      lineage: {
        sourceThreadId: source.id,
        sourceTurnId: input.sourceTurnId,
        sourceWatermark: input.sourceWatermark,
        summaryRefs: input.summaryRefs,
        policyRefs: input.policyRefs,
        sourceContentAvailable: true,
        forkedAt,
      },
    });
    return this.dependencies.repository.fork({
      ...input,
      targetThread,
      idempotencyKey,
      semanticFingerprint,
      authority: this.dependencies.authority(),
    });
  }
}
