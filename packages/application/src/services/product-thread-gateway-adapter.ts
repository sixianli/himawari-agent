import {
  createAgentId,
  createMessageId,
  createOwnerId,
  createRunId,
  createSessionId,
  createThreadId,
  createTurnId,
  type ProductThread,
} from "@himawari-agent/domain";
import {
  type ThreadGatewayCommand,
  type ThreadGatewayEvent,
  type ThreadGatewayQuery,
  type ThreadGatewayRequestResult,
  type ThreadGatewaySubscription,
  threadGatewayMessageSchema,
} from "@himawari-agent/gateway-contracts";
import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type GatewayAuthenticationContext,
  type ThreadDistillationStatePort,
  type ThreadGatewayControlPlanePort,
  type ThreadGatewayReadModelPort,
  type ThreadMutationReceipt,
  type ThreadRepositoryPort,
} from "../ports/index.js";
import type { ClockPort } from "../ports/system.js";
import type { ThreadCommandService } from "./thread-command-service.js";
import type { ThreadDeletionCoordinationService } from "./thread-deletion-coordination-service.js";
import type { ThreadForkService } from "./thread-fork-service.js";
import type { ThreadQueryService } from "./thread-query-service.js";

export interface ProductThreadGatewayAdapterDependencies {
  readonly repository: ThreadRepositoryPort;
  readonly checkpoints: ThreadDistillationStatePort;
  readonly commands: ThreadCommandService;
  readonly queries: ThreadQueryService;
  readonly forks: ThreadForkService;
  readonly deletion: ThreadDeletionCoordinationService;
  readonly clock: ClockPort;
  readonly waitForEvents?: (milliseconds: number) => Promise<void>;
  readonly eventPollMilliseconds?: number;
}

interface ThreadCommandOutcome {
  readonly receipt: ThreadMutationReceipt;
}

function responseId(prefix: string, messageId: string): string {
  return `${prefix}:${messageId}`.slice(0, 128);
}

function threadSummary(thread: ProductThread) {
  return {
    threadId: thread.id,
    revision: thread.revision,
    status: thread.status,
    titleRef: thread.titleRef,
    titleSource: thread.titleSource,
    titleRevision: thread.titleRevision,
    pinOrder: thread.pinOrder,
    answerLocale: thread.answerLocale,
    messageWatermark: thread.messageWatermark,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  } as const;
}

function responseEnvelope(
  request: ThreadGatewayCommand | ThreadGatewayQuery,
  kind: "snapshot" | "result" | "conflict",
  type: string,
) {
  return {
    schemaVersion: request.schemaVersion,
    kind,
    type,
    messageId: responseId(kind, request.messageId),
    correlationId: request.correlationId,
    causationId: request.messageId,
    scope: request.scope,
    authority: request.authority,
    actor: { actorType: "system" as const, actorId: "thread-gateway" },
  };
}

function parseResult(value: unknown): ThreadGatewayRequestResult {
  const parsed = threadGatewayMessageSchema.parse(value);
  if (!["snapshot", "result", "conflict"].includes(parsed.kind)) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "Thread Gateway adapter produced a non-response message",
    );
  }
  return parsed as ThreadGatewayRequestResult;
}

function commandThreadId(command: ThreadGatewayCommand): string {
  if (command.type === "thread.create") return command.payload.threadId;
  if (command.type === "thread.fork") return command.payload.targetThreadId;
  return command.payload.threadId;
}

export class ProductThreadGatewayAdapter
  implements ThreadGatewayControlPlanePort, ThreadGatewayReadModelPort
{
  readonly #dependencies: ProductThreadGatewayAdapterDependencies;

  constructor(dependencies: ProductThreadGatewayAdapterDependencies) {
    this.#dependencies = dependencies;
  }

  async execute(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly command: ThreadGatewayCommand;
  }): Promise<ThreadGatewayRequestResult> {
    const { command } = input;
    const ownerId = createOwnerId(command.scope.ownerId);
    const agentId = createAgentId(command.scope.agentId);
    const replay = await this.#dependencies.repository.findReceipt(
      ownerId,
      agentId,
      command.idempotencyKey as ThreadMutationReceipt["idempotencyKey"],
    );
    try {
      const outcome = await this.#executeCommand(command, ownerId, agentId);
      return parseResult({
        ...responseEnvelope(command, "result", "thread.command_result"),
        payload: {
          commandType: command.type,
          commandId: outcome.receipt.commandId,
          threadId: outcome.receipt.threadId,
          threadRevision: outcome.receipt.threadRevision,
          resultRef: outcome.receipt.resultRef,
          replayed: replay !== undefined,
          committedAt: outcome.receipt.committedAt,
        },
      });
    } catch (error) {
      if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.CONFLICT) {
        throw error;
      }
      const threadId = createThreadId(commandThreadId(command));
      const latest = await this.#dependencies.repository.read(ownerId, agentId, threadId);
      return parseResult({
        ...responseEnvelope(command, "conflict", "thread.conflict"),
        payload: {
          commandType: command.type,
          threadId,
          reasonCode: error.code,
          latest: latest ? threadSummary(latest) : null,
          generatedAt: this.#dependencies.clock.now(),
        },
      });
    }
  }

  async query(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly query: ThreadGatewayQuery;
  }): Promise<ThreadGatewayRequestResult> {
    const { query } = input;
    const ownerId = createOwnerId(query.scope.ownerId);
    const agentId = createAgentId(query.scope.agentId);
    const generatedAt = this.#dependencies.clock.now();
    const snapshotRef = responseId("snapshot", query.messageId);
    switch (query.type) {
      case "thread.list": {
        const threads = await this.#dependencies.queries.list({
          ownerId,
          agentId,
          statuses: query.payload.statuses,
          pinnedOnly: query.payload.pinnedOnly,
          afterThreadId:
            query.payload.afterCursor === null ? null : createThreadId(query.payload.afterCursor),
          limit: query.payload.limit,
        });
        return parseResult({
          ...responseEnvelope(query, "snapshot", "thread.collection_snapshot"),
          payload: {
            threads: threads.map(threadSummary),
            nextCursor:
              threads.length === query.payload.limit ? (threads.at(-1)?.id ?? null) : null,
            snapshotRef,
            generatedAt,
          },
        });
      }
      case "thread.detail": {
        const result = await this.#dependencies.queries.detail(
          ownerId,
          agentId,
          createThreadId(query.payload.threadId),
          query.payload.afterSequence,
          query.payload.limit,
        );
        const lastMessage = result.messages.at(-1);
        return parseResult({
          ...responseEnvelope(query, "snapshot", "thread.detail_snapshot"),
          payload: {
            thread: threadSummary(result.thread),
            messages: result.messages.map((message) => ({
              messageId: message.id,
              sequence: message.sequence,
              role: message.role,
              contentRef: message.contentRef,
              dataClassification: message.dataClassification,
              status: message.status,
              turnId: message.turnId,
              runId: message.runId,
              committedAt: message.committedAt,
            })),
            runs: result.runs.map((run) => ({ ...run, runId: run.runId })),
            nextSequence:
              result.messages.length === query.payload.limit &&
              lastMessage &&
              lastMessage.sequence < result.thread.messageWatermark
                ? lastMessage.sequence
                : null,
            snapshotRef,
            generatedAt,
          },
        });
      }
      case "thread.search": {
        const threads = await this.#dependencies.queries.search({
          ownerId,
          agentId,
          tokenRefs: query.payload.tokenRefs,
          projectionVersion: query.payload.projectionVersion,
          statuses: query.payload.statuses,
          jobStatuses: query.payload.jobStatuses,
          updatedAfter: query.payload.updatedAfter,
          updatedBefore: query.payload.updatedBefore,
          afterThreadId:
            query.payload.afterCursor === null ? null : createThreadId(query.payload.afterCursor),
          limit: query.payload.limit,
        });
        return parseResult({
          ...responseEnvelope(query, "snapshot", "thread.search_snapshot"),
          payload: {
            queryRef: query.payload.queryRef,
            projectionVersion: query.payload.projectionVersion,
            threads: threads.map(threadSummary),
            nextCursor:
              threads.length === query.payload.limit ? (threads.at(-1)?.id ?? null) : null,
            degraded: false,
            reasonCode: null,
            snapshotRef,
            generatedAt,
          },
        });
      }
      case "thread.lineage": {
        const detail = await this.#dependencies.queries.detail(
          ownerId,
          agentId,
          createThreadId(query.payload.threadId),
          0,
          1,
        );
        const lineage = detail.thread.lineage;
        return parseResult({
          ...responseEnvelope(query, "snapshot", "thread.lineage_snapshot"),
          payload: {
            threadId: detail.thread.id,
            sourceThreadId: lineage?.sourceThreadId ?? null,
            sourceTurnId: lineage?.sourceTurnId ?? null,
            sourceWatermark: lineage?.sourceWatermark ?? null,
            summaryRefs: lineage?.summaryRefs ?? [],
            policyRefs: lineage?.policyRefs ?? [],
            sourceContentAvailable: lineage?.sourceContentAvailable ?? false,
            forkedAt: lineage?.forkedAt ?? null,
            snapshotRef,
            generatedAt,
          },
        });
      }
      case "thread.checkpoint": {
        const threadId = createThreadId(query.payload.threadId);
        const work = await this.#dependencies.checkpoints.latestCheckpoint({
          ownerId,
          agentId,
          threadId,
          sourceWatermark: query.payload.sourceWatermark,
        });
        return parseResult({
          ...responseEnvelope(query, "snapshot", "thread.checkpoint_snapshot"),
          payload: {
            threadId,
            jobId: work?.jobId ?? null,
            generationId: work?.generationId ?? null,
            sourceWatermark: work?.sourceWatermark ?? null,
            policyVersion: work?.policyVersion ?? null,
            modelDescriptorRef: work?.modelDescriptorRef ?? null,
            trigger: work?.trigger ?? null,
            summaryRef: work?.summaryRef ?? null,
            status: work?.status ?? null,
            revision: work?.revision ?? null,
            attemptCount: work?.attemptCount ?? null,
            nextRetryAt: work?.nextRetryAt ?? null,
            errorCode: work?.errorCode ?? null,
            snapshotRef,
            generatedAt,
          },
        });
      }
      case "thread.deletion_impact": {
        const impact = await this.#dependencies.deletion.inspect(
          ownerId,
          agentId,
          createThreadId(query.payload.threadId),
        );
        return parseResult({
          ...responseEnvelope(query, "snapshot", "thread.deletion_impact_snapshot"),
          payload: {
            ...impact,
            deletionAllowed: impact.activeTaskIds.length === 0,
            snapshotRef,
            generatedAt,
          },
        });
      }
    }
  }

  async *subscribe(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly subscription: ThreadGatewaySubscription;
  }): AsyncIterable<ThreadGatewayEvent> {
    const ownerId = createOwnerId(input.authentication.ownerId);
    const agentId = createAgentId(input.subscription.scope.agentId);
    let cursor = input.subscription.payload.afterCursor;
    const wait =
      this.#dependencies.waitForEvents ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, milliseconds);
        }));
    while (true) {
      const events = await this.#dependencies.repository.listGatewayEvents(
        ownerId,
        agentId,
        cursor,
        1000,
      );
      for (const event of events) {
        const parsed = threadGatewayMessageSchema.parse({
          schemaVersion: "gateway.thread.v3",
          kind: "event",
          type: "thread.event",
          messageId: event.eventId,
          correlationId: event.causationCommandId,
          causationId: event.causationCommandId,
          scope: { ownerId: event.ownerId, agentId: event.agentId },
          authority: event.authority,
          actor: { actorType: "system", actorId: "thread-gateway" },
          payload: {
            eventId: event.eventId,
            threadId: event.threadId,
            revision: event.revision,
            cursor: event.cursor,
            causationCommandId: event.causationCommandId,
            eventType: event.eventType,
            payloadRef: event.payloadRef,
            occurredAt: event.occurredAt,
          },
        });
        if (parsed.kind !== "event") {
          throw new ApplicationPortError(
            PORT_ERROR_CODES.INVALID_OPERATION,
            "Thread Gateway event adapter produced an invalid message",
          );
        }
        cursor = parsed.payload.cursor;
        yield parsed;
      }
      await wait(this.#dependencies.eventPollMilliseconds ?? 1000);
    }
  }

  async #executeCommand(
    command: ThreadGatewayCommand,
    ownerId: ReturnType<typeof createOwnerId>,
    agentId: ReturnType<typeof createAgentId>,
  ): Promise<ThreadCommandOutcome> {
    switch (command.type) {
      case "thread.create":
        return this.#dependencies.commands.create({
          ownerId,
          agentId,
          threadId: createThreadId(command.payload.threadId),
          idempotencyKey: command.idempotencyKey,
          answerLocale: command.payload.answerLocale,
          resultRef: command.payload.resultRef,
        });
      case "thread.message.submit":
        return this.#dependencies.commands.admitOwnerMessage({
          ownerId,
          agentId,
          threadId: createThreadId(command.payload.threadId),
          expectedThreadRevision: command.payload.expectedRevision,
          messageId: createMessageId(command.payload.messageId),
          turnId: createTurnId(command.payload.turnId),
          runId: createRunId(command.payload.runId),
          sessionId: createSessionId(command.payload.sessionId),
          idempotencyKey: command.idempotencyKey,
          contentRef: command.payload.contentRef,
          sourceProofRef: command.payload.sourceProofRef,
          dataClassification: command.payload.dataClassification,
          occurredAt: command.payload.occurredAt,
          resultRef: command.payload.resultRef,
        });
      case "thread.message.commit_assistant":
        return this.#dependencies.commands.commitAssistantMessage({
          ownerId,
          agentId,
          threadId: createThreadId(command.payload.threadId),
          expectedThreadRevision: command.payload.expectedRevision,
          messageId: createMessageId(command.payload.messageId),
          turnId: createTurnId(command.payload.turnId),
          runId: createRunId(command.payload.runId),
          idempotencyKey: command.idempotencyKey,
          contentRef: command.payload.contentRef,
          dataClassification: command.payload.dataClassification,
          committedAt: command.payload.committedAt,
          resultRef: command.payload.resultRef,
        });
      case "thread.rename":
        return this.#dependencies.commands.rename({
          ownerId,
          agentId,
          threadId: createThreadId(command.payload.threadId),
          expectedRevision: command.payload.expectedRevision,
          titleRef: command.payload.titleRef,
          source: command.payload.titleSource,
          idempotencyKey: command.idempotencyKey,
          resultRef: command.payload.resultRef,
        });
      case "thread.pin":
        return this.#dependencies.commands.pin({
          ownerId,
          agentId,
          threadId: createThreadId(command.payload.threadId),
          expectedRevision: command.payload.expectedRevision,
          pinOrder: command.payload.pinOrder,
          idempotencyKey: command.idempotencyKey,
          resultRef: command.payload.resultRef,
        });
      case "thread.archive":
      case "thread.restore":
        return this.#dependencies.commands.setLifecycle({
          ownerId,
          agentId,
          threadId: createThreadId(command.payload.threadId),
          expectedRevision: command.payload.expectedRevision,
          status: command.type === "thread.archive" ? "archived" : "active",
          reasonCode: command.payload.reasonCode,
          idempotencyKey: command.idempotencyKey,
          resultRef: command.payload.resultRef,
        });
      case "thread.fork":
        return this.#dependencies.forks.fork({
          ownerId,
          agentId,
          sourceThreadId: createThreadId(command.payload.sourceThreadId),
          sourceTurnId: createTurnId(command.payload.sourceTurnId),
          sourceWatermark: command.payload.sourceWatermark,
          targetThreadId: createThreadId(command.payload.targetThreadId),
          summaryRefs: command.payload.summaryRefs,
          policyRefs: command.payload.policyRefs,
          idempotencyKey: command.idempotencyKey,
          resultRef: command.payload.resultRef,
        });
      case "thread.set_answer_locale":
        return this.#dependencies.commands.setAnswerLocale({
          ownerId,
          agentId,
          threadId: createThreadId(command.payload.threadId),
          expectedRevision: command.payload.expectedRevision,
          answerLocale: command.payload.answerLocale,
          idempotencyKey: command.idempotencyKey,
          resultRef: command.payload.resultRef,
        });
      case "thread.trash":
        return this.#dependencies.deletion.trash({
          ownerId,
          agentId,
          threadId: createThreadId(command.payload.threadId),
          expectedThreadRevision: command.payload.expectedRevision,
          reasonCode: command.payload.reasonCode,
          idempotencyKey: command.idempotencyKey,
          resultRef: command.payload.resultRef,
        });
      case "thread.delete_permanently":
        return this.#dependencies.deletion.deletePermanently({
          ownerId,
          agentId,
          threadId: createThreadId(command.payload.threadId),
          expectedThreadRevision: command.payload.expectedRevision,
          reasonCode: command.payload.reasonCode,
          authorizationRef: command.payload.authorizationRef,
          recentAuthenticationRef: command.payload.recentAuthenticationRef,
          idempotencyKey: command.idempotencyKey,
          resultRef: command.payload.resultRef,
        });
      case "thread.task.resolve":
        return this.#dependencies.deletion.resolveTask({
          ownerId,
          agentId,
          threadId: createThreadId(command.payload.threadId),
          taskId: command.payload.taskId,
          expectedTaskRevision: command.payload.expectedTaskRevision,
          resolution:
            command.payload.action === "rebind"
              ? {
                  action: "rebind",
                  targetThreadId: createThreadId(command.payload.targetThreadId as string),
                }
              : { action: command.payload.action },
          reasonCode: command.payload.reasonCode,
          idempotencyKey: command.idempotencyKey,
          resultRef: command.payload.resultRef,
        });
    }
  }
}
