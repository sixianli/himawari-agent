import {
  createIdempotencyKey,
  type AgentId,
  type OwnerId,
  type ProductAuthorityFence,
  type ThreadId,
} from "@himawari-agent/domain";
import { ApplicationPortError, PORT_ERROR_CODES, type PayloadRef } from "../ports/common.js";
import type { GatewayAuthenticationContext } from "../ports/gateway.js";
import type { RecentAuthenticationGuardPort } from "../ports/recent-authentication.js";
import type { ThreadRepositoryPort, ThreadTaskResolution } from "../ports/threads.js";
import type { ClockPort } from "../ports/system.js";
import { threadCommandFingerprint } from "./thread-command-service.js";

export interface ThreadDeletionCoordinationServiceDependencies {
  readonly repository: ThreadRepositoryPort;
  readonly clock: ClockPort;
  readonly authority: () => ProductAuthorityFence;
  readonly recentAuthentication?: RecentAuthenticationGuardPort;
}

export class ThreadDeletionCoordinationService {
  private readonly dependencies: ThreadDeletionCoordinationServiceDependencies;

  constructor(dependencies: ThreadDeletionCoordinationServiceDependencies) {
    this.dependencies = dependencies;
  }

  inspect(ownerId: OwnerId, agentId: AgentId, threadId: ThreadId) {
    return this.dependencies.repository.inspectDeletionImpact(ownerId, agentId, threadId);
  }

  resolveTask(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly threadId: ThreadId;
    readonly taskId: string;
    readonly expectedTaskRevision: number;
    readonly resolution: ThreadTaskResolution;
    readonly reasonCode: string;
    readonly idempotencyKey: string;
    readonly resultRef: PayloadRef;
  }) {
    const idempotencyKey = createIdempotencyKey(input.idempotencyKey);
    return this.dependencies.repository.resolveDeletionTask({
      ...input,
      idempotencyKey,
      semanticFingerprint: threadCommandFingerprint({
        type: "thread.task.resolve",
        ownerId: input.ownerId,
        agentId: input.agentId,
        threadId: input.threadId,
        taskId: input.taskId,
        expectedTaskRevision: input.expectedTaskRevision,
        resolution: input.resolution,
        reasonCode: input.reasonCode,
      }),
      resolvedAt: this.dependencies.clock.now(),
      authority: this.dependencies.authority(),
    });
  }

  trash(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly threadId: ThreadId;
    readonly expectedThreadRevision: number;
    readonly reasonCode: string;
    readonly idempotencyKey: string;
    readonly resultRef: PayloadRef;
  }) {
    return this.requestDeletion({
      ...input,
      mode: "trash",
      authorizationRef: null,
      recentAuthenticationRef: null,
    });
  }

  async deletePermanently(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly threadId: ThreadId;
    readonly expectedThreadRevision: number;
    readonly reasonCode: string;
    readonly authorizationRef: string;
    readonly recentAuthenticationRef: string;
    readonly authentication: GatewayAuthenticationContext;
    readonly idempotencyKey: string;
    readonly resultRef: PayloadRef;
  }) {
    if (!input.authorizationRef || !input.recentAuthenticationRef) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Permanent Thread deletion requires one-time authorization and recent authentication",
      );
    }
    if (input.authentication.ownerId !== input.ownerId) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Permanent Thread deletion requires the scoped authenticated Owner",
      );
    }
    const idempotencyKey = createIdempotencyKey(input.idempotencyKey);
    const existing = await this.dependencies.repository.findReceipt(
      input.ownerId,
      input.agentId,
      idempotencyKey,
    );
    const replayed =
      existing?.commandType === "thread.delete_permanently" &&
      existing.semanticFingerprint ===
        threadCommandFingerprint({
          type: "thread.delete_permanently",
          ownerId: input.ownerId,
          agentId: input.agentId,
          threadId: input.threadId,
          expectedThreadRevision: input.expectedThreadRevision,
          reasonCode: input.reasonCode,
          authorizationRef: input.authorizationRef,
          recentAuthenticationRef: input.recentAuthenticationRef,
        });
    if (!replayed) {
      if (!this.dependencies.recentAuthentication) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          "Recent Owner authentication evidence is required",
          { reasonCode: "RECENT_AUTH_REQUIRED" },
        );
      }
      await this.dependencies.recentAuthentication.assertRecentAuthentication({
        authentication: input.authentication,
        expectedAuthenticationRef: input.recentAuthenticationRef,
      });
    }
    return this.requestDeletion({
      ownerId: input.ownerId,
      agentId: input.agentId,
      threadId: input.threadId,
      expectedThreadRevision: input.expectedThreadRevision,
      reasonCode: input.reasonCode,
      authorizationRef: input.authorizationRef,
      recentAuthenticationRef: input.recentAuthenticationRef,
      idempotencyKey,
      resultRef: input.resultRef,
      mode: "permanent",
    });
  }

  private requestDeletion(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly threadId: ThreadId;
    readonly expectedThreadRevision: number;
    readonly mode: "trash" | "permanent";
    readonly reasonCode: string;
    readonly authorizationRef: string | null;
    readonly recentAuthenticationRef: string | null;
    readonly idempotencyKey: string;
    readonly resultRef: PayloadRef;
  }) {
    const idempotencyKey = createIdempotencyKey(input.idempotencyKey);
    return this.dependencies.repository.requestDeletion({
      ...input,
      idempotencyKey,
      semanticFingerprint: threadCommandFingerprint({
        type: input.mode === "trash" ? "thread.trash" : "thread.delete_permanently",
        ownerId: input.ownerId,
        agentId: input.agentId,
        threadId: input.threadId,
        expectedThreadRevision: input.expectedThreadRevision,
        reasonCode: input.reasonCode,
        authorizationRef: input.authorizationRef,
        recentAuthenticationRef: input.recentAuthenticationRef,
      }),
      requestedAt: this.dependencies.clock.now(),
      authority: this.dependencies.authority(),
    });
  }
}
