import { createIdempotencyKey } from "@himawari-agent/domain";
import { CHAT_OWNER_SPOKEN_TURN } from "@himawari-agent/prompt-catalog";
import type {
  AuthorityFence,
  ClockPort,
  IdGeneratorPort,
  PayloadProtectorPort,
  PayloadStorePort,
  RunDispatchCandidate,
  RunDispatchPort,
  RunExecutionLease,
  RunExecutionSource,
  RunExecutionSourcePort,
  RunPayloadArtifactPort,
  ThreadRepositoryPort,
} from "../ports/index.js";
import {
  ApplicationPortError,
  claimFromRunExecutionLease,
  PORT_ERROR_CODES,
} from "../ports/index.js";
import type { ExecuteCoordinatedRunInput, RunCoordinatorCommands } from "./run-coordinator.js";
import { threadCommandFingerprint } from "./thread-command-service.js";

export interface RunExecutionPolicy {
  readonly thinkingLevel?: import("../ports/run-execution-source.js").RunThinkingLevel;
  readonly modelRef: string;
  readonly systemInstructionRef: string;
  readonly policyVersion: string;
  readonly policies: ExecuteCoordinatedRunInput["context"]["policies"];
  readonly answerLocalePolicy?: ExecuteCoordinatedRunInput["context"]["answerLocalePolicy"];
  readonly capabilities: ExecuteCoordinatedRunInput["context"]["capabilities"];
  readonly runtimeEnvironmentRef?: string;
  readonly capabilityHandleRefs: readonly string[];
  readonly memoryLimit: number;
}

interface FrozenRunInput {
  readonly version: "run-execution-input.v2";
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly source: RunExecutionSource;
  readonly policy: RunExecutionPolicy;
  readonly foldedPrompt?: {
    readonly ref: string;
    readonly dataClassification: RunExecutionSource["dataClassification"];
  };
}

const CLASSIFICATION_ORDER = ["public", "private", "sensitive", "restricted"] as const;
const DEFAULT_FOLD_LIMIT = 19;

export const PHONE_VOICE_SOURCE_ATTRIBUTE = 'source="phone-voice"';

export function ownerMessagesPrompt(
  messages: readonly {
    readonly id: string;
    readonly text: string;
    readonly viaPhoneVoice?: boolean;
    readonly viaTalk?: boolean;
  }[],
): string {
  const blocks = messages.map(
    ({ id, text, viaPhoneVoice }) =>
      `<owner-message id="${id}"${viaPhoneVoice ? ` ${PHONE_VOICE_SOURCE_ATTRIBUTE}` : ""}>\n${text.replaceAll("</owner-message>", "‹/owner-message›")}\n</owner-message>`,
  );
  if (messages.some(({ viaTalk }) => viaTalk)) blocks.push(CHAT_OWNER_SPOKEN_TURN.text);
  return blocks.join("\n\n");
}

const OPERATION_KEY = "run-execution-input:v1";

export interface RunExecutionInputServiceOptions {
  readonly maximumRunDurationMs: number;
  readonly source: RunExecutionSourcePort;
  readonly artifacts: RunPayloadArtifactPort;
  readonly payloads: Pick<PayloadStorePort, "get"> & Partial<Pick<PayloadStorePort, "put">>;
  readonly protector: PayloadProtectorPort;
  readonly folds?: Pick<ThreadRepositoryPort, "foldQueuedOwnerRuns">;
  readonly foldLimit?: () => Promise<number>;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly dispatch: Pick<RunDispatchPort, "assertHeld">;
  readonly policy: (source: RunExecutionSource) => Promise<RunExecutionPolicy>;
}

function invalid(message: string): never {
  throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, message);
}

function assertPolicy(policy: RunExecutionPolicy): void {
  if (
    !policy ||
    !policy.modelRef ||
    !policy.systemInstructionRef ||
    !policy.policyVersion ||
    !Number.isSafeInteger(policy.memoryLimit) ||
    policy.memoryLimit < 1 ||
    policy.memoryLimit > 1000 ||
    !Array.isArray(policy.capabilityHandleRefs) ||
    policy.capabilityHandleRefs.some((ref) => typeof ref !== "string" || !ref) ||
    new Set(policy.capabilityHandleRefs).size !== policy.capabilityHandleRefs.length ||
    !Array.isArray(policy.policies) ||
    !Array.isArray(policy.capabilities) ||
    (policy.runtimeEnvironmentRef !== undefined &&
      (typeof policy.runtimeEnvironmentRef !== "string" || !policy.runtimeEnvironmentRef))
  ) {
    invalid("Run execution policy is invalid");
  }
}

export class RunExecutionInputService {
  readonly #options: RunExecutionInputServiceOptions;

  constructor(options: RunExecutionInputServiceOptions) {
    if (
      !Number.isSafeInteger(options.maximumRunDurationMs) ||
      options.maximumRunDurationMs < 1 ||
      options.maximumRunDurationMs > 86_400_000
    )
      invalid("Run duration must be between 1 and 86400000 milliseconds");
    this.#options = options;
  }

  async create(input: {
    readonly candidate: RunDispatchCandidate;
    readonly lease: RunExecutionLease;
  }): Promise<ExecuteCoordinatedRunInput> {
    const { candidate } = input;
    const lease = await this.#options.dispatch.assertHeld({
      runId: input.lease.runId,
      expectedLeaseRevision: input.lease.revision,
      executionLeaseId: input.lease.executionLeaseId,
      at: this.#options.clock.now(),
    });
    if (
      candidate.ownerId !== lease.ownerId ||
      candidate.agentId !== lease.agentId ||
      candidate.runId !== lease.runId ||
      lease.releasedAt !== null ||
      Date.parse(lease.expiresAt) <= Date.parse(this.#options.clock.now())
    ) {
      invalid("Run execution input requires the current scoped execution lease");
    }
    const source = await this.#options.source.read(candidate.runId);
    if (
      !source ||
      source.ownerId !== candidate.ownerId ||
      source.agentId !== candidate.agentId ||
      source.runId !== candidate.runId ||
      source.sessionId !== candidate.sessionId ||
      source.threadId !== candidate.threadId ||
      source.triggerId !== candidate.triggerId
    ) {
      invalid("Run execution source does not match the claimed candidate");
    }
    const frozen = await this.#freeze(source, candidate.action !== "deliver_completed");
    const { policy } = frozen;
    const promptRef = (frozen.foldedPrompt?.ref ?? source.payloadRef) as typeof source.payloadRef;
    const dataClassification = frozen.foldedPrompt?.dataClassification ?? source.dataClassification;
    const scope = {
      ownerId: source.ownerId,
      agentId: source.agentId,
      runId: source.runId,
      sessionId: source.sessionId,
      threadId: source.threadId,
    };
    const authority: AuthorityFence = {
      leaseId: lease.authorityLeaseId,
      fencingToken: lease.fencingToken,
    };
    const correlationId = `run:${source.runId}`;
    const transition = (phase: keyof RunCoordinatorCommands) => ({
      idempotencyKey: createIdempotencyKey(`run-execution:${source.runId}:${phase}`),
      commandFingerprint: threadCommandFingerprint({ runId: source.runId, phase, version: 1 }),
      payloadRef: promptRef,
    });
    const commands: RunCoordinatorCommands = {
      buildingContext: transition("buildingContext"),
      running: transition("running"),
      reconcilingExternalResult: transition("reconcilingExternalResult"),
      completed: transition("completed"),
      failed: transition("failed"),
      cancelled: transition("cancelled"),
    };
    return {
      ...scope,
      authority,
      executionLease: claimFromRunExecutionLease(lease),
      executionDeadlineAt: new Date(
        Math.min(
          Date.parse(frozen.deadlineAt),
          Date.parse(frozen.startedAt) + this.#options.maximumRunDurationMs,
        ),
      ).toISOString(),
      context: {
        ...scope,
        executionLease: claimFromRunExecutionLease(lease),
        trigger: {
          id: source.triggerId,
          sourceType: source.sourceType,
          payloadRef: promptRef,
          occurredAt: source.occurredAt,
        },
        threadMessages: [],
        sourceWatermark: null,
        policyVersion: policy.policyVersion,
        policies: policy.policies,
        ...(policy.answerLocalePolicy ? { answerLocalePolicy: policy.answerLocalePolicy } : {}),
        memoryQueryRef: promptRef,
        memoryQueryTerms: [],
        memoryLimit: policy.memoryLimit,
        capabilities: policy.capabilities,
        ...(policy.runtimeEnvironmentRef
          ? { runtimeEnvironmentRef: policy.runtimeEnvironmentRef }
          : {}),
        correlationId,
        causationId: source.triggerId,
        parentEventId: null,
        actorId: "agent-service",
        dataClassification,
      },
      runtime: {
        ...scope,
        modelRef: policy.modelRef,
        ...(policy.thinkingLevel ? { thinkingLevel: policy.thinkingLevel } : {}),
        systemInstructionRef: policy.systemInstructionRef,
        capabilityHandleRefs: policy.capabilityHandleRefs,
        budget: {},
        correlationId,
        dataClassification,
      },
      workers: [],
      delegableCapabilityHandleRefs: policy.capabilityHandleRefs,
      delegableContextRefs: [],
      commands,
    };
  }

  async #freeze(source: RunExecutionSource, allowCreate = true): Promise<FrozenRunInput> {
    const key = { runId: source.runId, purpose: "context" as const, operationKey: OPERATION_KEY };
    const existing = await this.#options.artifacts.lookup(key);
    if (existing) {
      const payload = await this.#options.payloads.get(existing.payloadRef);
      if (!payload || payload.contentType !== "application/json")
        invalid("Run execution snapshot is unavailable");
      const plaintext = await this.#options.protector.unprotect({
        ownerId: source.ownerId,
        agentId: source.agentId,
        payload,
      });
      const frozen = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
      ) as FrozenRunInput;
      if (
        frozen.version !== "run-execution-input.v2" ||
        !Number.isFinite(Date.parse(frozen.startedAt)) ||
        !Number.isFinite(Date.parse(frozen.deadlineAt)) ||
        Date.parse(frozen.deadlineAt) <= Date.parse(frozen.startedAt) ||
        Date.parse(frozen.deadlineAt) - Date.parse(frozen.startedAt) > 86_400_000 ||
        threadCommandFingerprint(frozen.source) !== threadCommandFingerprint(source)
      ) {
        invalid("Run execution snapshot source changed");
      }
      assertPolicy(frozen.policy);
      return frozen;
    }
    if (!allowCreate) invalid("Completion recovery requires the original Run execution snapshot");
    const startedAt = this.#options.clock.now();
    if (!Number.isFinite(Date.parse(startedAt))) invalid("Run clock is invalid");
    const deadlineAt = new Date(
      Date.parse(startedAt) + this.#options.maximumRunDurationMs,
    ).toISOString();
    const policy = await this.#options.policy(source);
    assertPolicy(policy);
    const foldedPrompt = await this.#foldQueuedMessages(source);
    const frozen: FrozenRunInput = {
      version: "run-execution-input.v2",
      startedAt,
      deadlineAt,
      source,
      policy,
      ...(foldedPrompt ? { foldedPrompt } : {}),
    };
    const payload = await this.#options.protector.protect({
      ownerId: source.ownerId,
      agentId: source.agentId,
      ref: this.#options.ids.next("run-input"),
      dataClassification: source.dataClassification,
      contentType: "application/json",
      plaintext: new TextEncoder().encode(JSON.stringify(frozen)),
      createdAt: this.#options.clock.now(),
    });
    await this.#options.artifacts.commit({ ...key, payload });
    return this.#freeze(source);
  }

  async #foldQueuedMessages(
    source: RunExecutionSource,
  ): Promise<FrozenRunInput["foldedPrompt"] | undefined> {
    const { folds, payloads, protector, clock } = this.#options;
    if (!folds || !payloads.put || source.sourceType !== "user_message" || !source.threadId)
      return undefined;
    const limit = (await this.#options.foldLimit?.()) ?? DEFAULT_FOLD_LIMIT;
    const folded = await folds.foldQueuedOwnerRuns({
      ownerId: source.ownerId,
      agentId: source.agentId,
      runId: source.runId,
      limit,
      now: clock.now(),
    });
    if (folded.length === 0 && !source.viaPhoneVoice && !source.viaTalk) return undefined;
    const read = async (ref: string) => {
      const payload = await payloads.get(ref as never);
      if (!payload) invalid("Folded owner message is unavailable");
      return new TextDecoder("utf-8", { fatal: false }).decode(
        await protector.unprotect({ ownerId: source.ownerId, agentId: source.agentId, payload }),
      );
    };
    const parts = [
      {
        id: source.sourceId,
        text: await read(source.payloadRef),
        viaPhoneVoice: source.viaPhoneVoice === true,
        viaTalk: source.viaTalk === true,
      },
    ];
    for (const message of folded)
      parts.push({
        id: message.messageId,
        text: await read(message.contentRef),
        viaPhoneVoice: message.viaPhoneVoice === true,
        viaTalk: message.viaTalk === true,
      });
    const text = ownerMessagesPrompt(parts);
    const rank = Math.max(
      CLASSIFICATION_ORDER.indexOf(source.dataClassification),
      ...folded.map(({ dataClassification }) => CLASSIFICATION_ORDER.indexOf(dataClassification)),
    );
    const dataClassification = CLASSIFICATION_ORDER[rank] ?? "restricted";
    const ref = `fold-prompt:${source.runId}`;
    if (!(await payloads.get(ref as never)))
      await payloads.put(
        await protector.protect({
          ownerId: source.ownerId,
          agentId: source.agentId,
          ref: ref as never,
          contentType: "text/plain",
          dataClassification,
          plaintext: new TextEncoder().encode(text),
          createdAt: clock.now(),
        }),
      );
    return { ref, dataClassification };
  }
}
