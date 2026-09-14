import type {
  PayloadStorePort,
  RunPayloadArtifact,
  RunPayloadArtifactCommitInput,
  RunPayloadArtifactCommitResult,
  RunPayloadArtifactLookupInput,
  RunPayloadArtifactPort,
} from "@himawari-agent/application";
import { ApplicationPortError, PORT_ERROR_CODES } from "@himawari-agent/application";
import type { AgentId, OwnerId } from "@himawari-agent/domain";
import { type FailureScheduler, NO_FAILURES } from "../deterministic.js";
import { frozenCopy } from "./helpers.js";

export class InMemoryRunPayloadArtifactStore implements RunPayloadArtifactPort {
  private readonly ownerId: OwnerId;
  private readonly agentId: AgentId;
  private readonly payloads: PayloadStorePort;
  private readonly failures: FailureScheduler;
  private readonly records = new Map<string, RunPayloadArtifact>();

  constructor(
    ownerId: OwnerId,
    agentId: AgentId,
    payloads: PayloadStorePort,
    failures: FailureScheduler = NO_FAILURES,
  ) {
    this.ownerId = ownerId;
    this.agentId = agentId;
    this.payloads = payloads;
    this.failures = failures;
  }

  async lookup(input: RunPayloadArtifactLookupInput): Promise<RunPayloadArtifact | undefined> {
    const record = this.records.get(this.key(input));
    if (!record) return undefined;
    if (!(await this.payloads.get(record.payloadRef))) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Run Payload artifact references a missing Payload",
        { payloadRef: record.payloadRef },
      );
    }
    return frozenCopy(record);
  }

  async commit(input: RunPayloadArtifactCommitInput): Promise<RunPayloadArtifactCommitResult> {
    this.failures.checkpoint("runPayloadArtifact.commit");
    const identity = this.key(input);
    const existing = this.records.get(identity);
    if (existing) {
      if (!this.sameIdentity(existing, input)) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.CONFLICT,
          "Run Payload artifact operation identity conflicts with its existing receipt",
        );
      }
      return { ref: existing.payloadRef, replayed: true, artifact: frozenCopy(existing) };
    }
    const prior = await this.payloads.get(input.payload.ref);
    if (prior) {
      if (
        prior.contentDigest !== input.payload.contentDigest ||
        prior.contentType !== input.payload.contentType ||
        prior.dataClassification !== input.payload.dataClassification
      ) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.CONFLICT,
          "Payload reference conflicts with existing content",
          { payloadRef: input.payload.ref },
        );
      }
    } else {
      await this.payloads.put(input.payload);
    }
    const artifact = frozenCopy({
      ownerId: this.ownerId,
      agentId: this.agentId,
      runId: input.runId,
      purpose: input.purpose,
      operationKey: input.operationKey,
      payloadRef: input.payload.ref,
      contentDigest: input.payload.contentDigest,
      contentType: input.payload.contentType,
      dataClassification: input.payload.dataClassification,
      createdAt: input.payload.createdAt,
    });
    this.records.set(identity, artifact);
    return { ref: artifact.payloadRef, replayed: false, artifact };
  }

  private key(input: RunPayloadArtifactLookupInput): string {
    return `${input.runId}\u0000${input.purpose}\u0000${input.operationKey}`;
  }

  private sameIdentity(
    existing: RunPayloadArtifact,
    input: RunPayloadArtifactCommitInput,
  ): boolean {
    return (
      existing.contentDigest === input.payload.contentDigest &&
      existing.contentType === input.payload.contentType &&
      existing.dataClassification === input.payload.dataClassification
    );
  }
}
