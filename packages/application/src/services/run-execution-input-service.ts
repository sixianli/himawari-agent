import { createIdempotencyKey } from "@himawari-agent/domain";
import type {
  AuthorityFence,
  ClockPort,
  DataClassification,
  IdGeneratorPort,
  PayloadProtectorPort,
  PayloadStorePort,
  RunDispatchCandidate,
  RunDispatchPort,
  RunExecutionLease,
  RunExecutionSource,
  RunExecutionSourcePort,
  RunPayloadArtifactPort,
} from "../ports/index.js";
import {
  ApplicationPortError,
  claimFromRunExecutionLease,
  PORT_ERROR_CODES,
} from "../ports/index.js";
import type { ExecuteCoordinatedRunInput, RunCoordinatorCommands } from "./run-coordinator.js";
import { threadCommandFingerprint } from "./thread-command-service.js";

/** Trusted Core policy; browser messages and model output cannot supply this object. */
export interface RunExecutionPolicy {
  readonly modelRef: string;
  readonly systemInstructionRef: string;
  readonly policyVersion: string;
  readonly policies: ExecuteCoordinatedRunInput["context"]["policies"];
  readonly answerLocalePolicy?: ExecuteCoordinatedRunInput["context"]["answerLocalePolicy"];
  readonly capabilities: ExecuteCoordinatedRunInput["context"]["capabilities"];
  readonly capabilityHandleRefs: readonly string[];
  readonly maxMemoryClassification: DataClassification;
  readonly memoryLimit: number;
  readonly maxSelectedMemories: number;
}

interface FrozenRunInput {
  readonly version: "run-execution-input.v2";
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly source: RunExecutionSource;
  readonly policy: RunExecutionPolicy;
}

// Keep the durable operation identity: a version change must not issue a fresh budget.
const OPERATION_KEY = "run-execution-input:v1";
const CLASSIFICATIONS = ["public", "private", "sensitive", "restricted"] as const;

export interface RunExecutionInputServiceOptions {
  readonly maximumRunDurationMs: number;
  readonly source: RunExecutionSourcePort;
  readonly artifacts: RunPayloadArtifactPort;
  readonly payloads: Pick<PayloadStorePort, "get">;
  readonly protector: PayloadProtectorPort;
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
    !CLASSIFICATIONS.includes(policy.maxMemoryClassification) ||
    !Number.isSafeInteger(policy.memoryLimit) ||
    policy.memoryLimit < 1 ||
    policy.memoryLimit > 1000 ||
    !Number.isSafeInteger(policy.maxSelectedMemories) ||
    policy.maxSelectedMemories < 0 ||
    policy.maxSelectedMemories > policy.memoryLimit ||
    !Array.isArray(policy.capabilityHandleRefs) ||
    policy.capabilityHandleRefs.some((ref) => typeof ref !== "string" || !ref) ||
    new Set(policy.capabilityHandleRefs).size !== policy.capabilityHandleRefs.length ||
    !Array.isArray(policy.policies) ||
    !Array.isArray(policy.capabilities)
  ) {
    invalid("Run execution policy is invalid");
  }
}

/**
 * Freezes execution policy once, while resolving the triggering input from its
 * canonical durable identity. Only the current lease is replaced after restart.
 */
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
    const frozen = await this.#freeze(source);
    const { policy } = frozen;
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
      payloadRef: source.payloadRef,
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
      // Configuration may shorten a persisted budget, but never extend it on restart.
      executionDeadlineAt: new Date(
        Math.min(
          Date.parse(frozen.deadlineAt),
          Date.parse(frozen.startedAt) + this.#options.maximumRunDurationMs,
        ),
      ).toISOString(),
      context: {
        ...scope,
        trigger: {
          id: source.triggerId,
          sourceType: source.sourceType,
          payloadRef: source.payloadRef,
          occurredAt: source.occurredAt,
        },
        threadMessages: [],
        sourceWatermark: null,
        policyVersion: policy.policyVersion,
        policies: policy.policies,
        ...(policy.answerLocalePolicy ? { answerLocalePolicy: policy.answerLocalePolicy } : {}),
        memoryQueryRef: source.payloadRef,
        memoryQueryTerms: [],
        memoryLimit: policy.memoryLimit,
        maxSelectedMemories: policy.maxSelectedMemories,
        maxMemoryClassification: policy.maxMemoryClassification,
        capabilities: policy.capabilities,
        correlationId,
        causationId: source.triggerId,
        parentEventId: null,
        actorId: "agent-service",
        dataClassification: source.dataClassification,
      },
      runtime: {
        ...scope,
        modelRef: policy.modelRef,
        systemInstructionRef: policy.systemInstructionRef,
        capabilityHandleRefs: policy.capabilityHandleRefs,
        budget: {},
        correlationId,
        dataClassification: source.dataClassification,
      },
      workers: [],
      delegableCapabilityHandleRefs: policy.capabilityHandleRefs,
      delegableContextRefs: [],
      commands,
    };
  }

  async #freeze(source: RunExecutionSource): Promise<FrozenRunInput> {
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
    const startedAt = this.#options.clock.now();
    if (!Number.isFinite(Date.parse(startedAt))) invalid("Run clock is invalid");
    const deadlineAt = new Date(
      Date.parse(startedAt) + this.#options.maximumRunDurationMs,
    ).toISOString();
    const policy = await this.#options.policy(source);
    assertPolicy(policy);
    const frozen: FrozenRunInput = {
      version: "run-execution-input.v2",
      startedAt,
      deadlineAt,
      source,
      policy,
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
    // Read the committed value so all callers use the same persisted representation.
    return this.#freeze(source);
  }
}
