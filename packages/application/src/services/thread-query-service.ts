import type { AgentId, OwnerId, ProductThread, ThreadId } from "@himawari-agent/domain";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import type { ThreadRepositoryPort } from "../ports/threads.js";

export class ThreadQueryService {
  private readonly repository: ThreadRepositoryPort;

  constructor(repository: ThreadRepositoryPort) {
    this.repository = repository;
  }

  async detail(
    ownerId: OwnerId,
    agentId: AgentId,
    threadId: ThreadId,
    afterSequence = 0,
    limit = 1000,
  ) {
    const thread = await this.repository.read(ownerId, agentId, threadId);
    if (!thread || thread.status === "deleted_verified") {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, `Thread ${threadId} not found`);
    }
    return Object.freeze({
      thread,
      messages: await this.repository.listMessages(
        ownerId,
        agentId,
        threadId,
        afterSequence,
        limit,
      ),
      runs: await this.repository.listRuns(ownerId, agentId, threadId),
    });
  }

  list(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly statuses?: readonly ProductThread["status"][];
    readonly pinnedOnly?: boolean;
    readonly afterUpdatedAt?: string | null;
    readonly limit: number;
  }) {
    return this.repository.list({
      ownerId: input.ownerId,
      agentId: input.agentId,
      statuses: input.statuses ?? ["active", "archived"],
      pinnedOnly: input.pinnedOnly ?? false,
      afterUpdatedAt: input.afterUpdatedAt ?? null,
      limit: input.limit,
    });
  }

  search(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly tokenRefs: readonly string[];
    readonly projectionVersion: string;
    readonly statuses?: readonly ProductThread["status"][];
    readonly jobStatuses?: readonly ("active" | "paused" | "revoked")[];
    readonly updatedAfter?: string | null;
    readonly updatedBefore?: string | null;
    readonly limit: number;
  }) {
    if (input.tokenRefs.length === 0) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Thread search requires opaque authorized token references",
      );
    }
    return this.repository.search({
      ownerId: input.ownerId,
      agentId: input.agentId,
      tokenRefs: input.tokenRefs,
      projectionVersion: input.projectionVersion,
      statuses: input.statuses ?? ["active", "archived"],
      jobStatuses: input.jobStatuses ?? [],
      updatedAfter: input.updatedAfter ?? null,
      updatedBefore: input.updatedBefore ?? null,
      limit: input.limit,
    });
  }
}
