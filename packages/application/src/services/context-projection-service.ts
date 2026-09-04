import type { AgentId, OwnerId, RunId } from "@himawari-agent/domain";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import {
  contextArtifactOperationKey,
  type ProductContextEnvelopeV1,
} from "../ports/context-projection.js";
import type { PayloadProtectorPort, PayloadStorePort } from "../ports/observability.js";
import type { RunCheckpointStore } from "../ports/run-checkpoints.js";
import type { RunPayloadArtifactPort } from "../ports/run-payload-artifacts.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";
import type { ThreadRepositoryPort } from "../ports/threads.js";
import type {
  DataClassification,
  PayloadRef,
  RuntimeProjection,
  RuntimeProjectionContextBlock,
  RuntimeProjectionMessage,
  RuntimeProjectionPort,
  RuntimeProjectionRequest,
} from "../runtime-port.js";

const CLASSIFICATION_RANK = Object.freeze({ public: 0, private: 1, sensitive: 2, restricted: 3 });

export interface ContextProjectionServiceDependencies {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threads: Pick<ThreadRepositoryPort, "readCommittedMessagesByIds">;
  readonly checkpoints: Pick<RunCheckpointStore, "read">;
  readonly payloads: Pick<PayloadStorePort, "get">;
  readonly artifacts: RunPayloadArtifactPort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
}

/**
 * Resolves one immutable product context envelope into runtime input. It is
 * deliberately the only component that reads product message identities for
 * Pi; Pi itself never reads Trace JSON, PayloadStore, or SQLite.
 */
export class ContextProjectionService implements RuntimeProjectionPort {
  readonly #dependencies: ContextProjectionServiceDependencies;

  constructor(dependencies: ContextProjectionServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async resolveProjection(input: RuntimeProjectionRequest): Promise<RuntimeProjection> {
    this.assertScope(input);
    const envelope = await this.readEnvelope(input);
    const history = await this.readHistory(input, envelope);
    const prompt = await this.readText(input, envelope.prompt.payloadRef, "context prompt");
    const policyTexts = await Promise.all(
      envelope.systemPolicyRefs.map(({ payloadRef }) =>
        this.readText(input, payloadRef, "context system policy"),
      ),
    );
    const systemInstruction = [
      await this.readText(input, input.systemInstructionRef, "system instruction"),
      ...policyTexts,
    ]
      .filter((text) => text.length > 0)
      .join("\n\n");
    const contextBlocks = await this.readContextBlocks(input, envelope, history.systemBlocks);
    await this.assertWorkerReferences(input);
    const workerBlocks = await this.readWorkerResults(input);
    return Object.freeze({
      systemInstruction,
      history: Object.freeze(history.messages),
      prompt: Object.freeze({
        id: envelope.prompt.id,
        content: prompt,
        occurredAt: envelope.prompt.occurredAt,
      }),
      contextBlocks: Object.freeze([...contextBlocks, ...workerBlocks]),
    });
  }

  async capture(input: {
    readonly runId: RunId;
    readonly kind:
      | "message"
      | "tool_intent"
      | "tool_result"
      | "provider_request"
      | "provider_response";
    readonly value: unknown;
    readonly dataClassification: DataClassification;
  }): Promise<PayloadRef> {
    const ref = this.#dependencies.ids.next("runtime-payload");
    const plaintext = new TextEncoder().encode(JSON.stringify(input.value) ?? "null");
    const payload = await this.#dependencies.protector.protect({
      ownerId: this.#dependencies.ownerId,
      agentId: this.#dependencies.agentId,
      ref,
      dataClassification: input.dataClassification,
      contentType: "application/json",
      plaintext,
      createdAt: this.#dependencies.clock.now(),
    });
    const receipt = await this.#dependencies.artifacts.commit({
      runId: input.runId,
      purpose: "trace",
      operationKey: `runtime:${input.runId}:${input.kind}:${ref}`,
      payload,
    });
    return receipt.ref;
  }

  async captureFinalAnswer(input: {
    readonly runId: RunId;
    readonly text: string;
    readonly dataClassification: DataClassification;
  }): Promise<PayloadRef> {
    if (input.text.trim().length === 0) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "A final answer Payload cannot be empty",
      );
    }
    return this.commitTextArtifact(
      input.runId,
      "final_answer",
      `final-answer:${input.runId}`,
      input.text,
      input.dataClassification,
    );
  }

  async proposeCompaction(input: {
    readonly runId: RunId;
    readonly sessionId: RuntimeProjectionRequest["sessionId"];
    readonly summary: string;
    readonly firstKeptEntryId: string;
    readonly tokensBefore: number;
    readonly dataClassification: DataClassification;
  }): Promise<PayloadRef> {
    if (
      input.summary.trim().length === 0 ||
      !Number.isSafeInteger(input.tokensBefore) ||
      input.tokensBefore < 0
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Compaction proposal is invalid",
      );
    }
    return this.commitTextArtifact(
      input.runId,
      "context",
      `compaction:${input.runId}:${input.firstKeptEntryId}`,
      input.summary,
      input.dataClassification,
    );
  }

  private async readEnvelope(input: RuntimeProjectionRequest): Promise<ProductContextEnvelopeV1> {
    const artifact = await this.#dependencies.artifacts.lookup({
      runId: input.runId,
      purpose: "context",
      operationKey: contextArtifactOperationKey(input.runId),
    });
    if (!artifact) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        "The Run context artifact is missing",
        { runId: input.runId },
      );
    }
    if (
      artifact.payloadRef !== input.contextEnvelopeRef ||
      artifact.contentType !== "application/json" ||
      artifact.ownerId !== input.ownerId ||
      artifact.agentId !== input.agentId
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "The context artifact is outside the requested Run scope",
        { runId: input.runId },
      );
    }
    const payload = await this.#dependencies.payloads.get(artifact.payloadRef);
    if (
      !payload ||
      payload.ref !== artifact.payloadRef ||
      payload.contentDigest !== artifact.contentDigest ||
      payload.contentType !== artifact.contentType ||
      payload.dataClassification !== artifact.dataClassification
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        "The Run context Payload is missing or does not match its receipt",
        { runId: input.runId, payloadRef: artifact.payloadRef },
      );
    }
    const plaintext = await this.#dependencies.protector.unprotect({
      ownerId: input.ownerId,
      agentId: input.agentId,
      payload,
    });
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    } catch {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "The Run context Payload is not valid JSON",
        { runId: input.runId },
      );
    }
    if (!isContextEnvelope(value)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "The Run context Payload is not a context.v1 envelope",
        { runId: input.runId },
      );
    }
    if (
      value.ownerId !== input.ownerId ||
      value.agentId !== input.agentId ||
      value.sessionId !== input.sessionId ||
      value.threadId !== input.threadId ||
      value.runId !== input.runId
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "The context envelope does not match the requested Run scope",
        { runId: input.runId },
      );
    }
    if (value.sourceWatermark !== null && !Number.isSafeInteger(value.sourceWatermark)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "The context source watermark is invalid",
        { runId: input.runId },
      );
    }
    return value;
  }

  private async readHistory(
    input: RuntimeProjectionRequest,
    envelope: ProductContextEnvelopeV1,
  ): Promise<{
    readonly messages: readonly RuntimeProjectionMessage[];
    readonly systemBlocks: readonly RuntimeProjectionContextBlock[];
  }> {
    if (envelope.history.length === 0) {
      return { messages: [], systemBlocks: [] };
    }
    if (input.threadId === null) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "A context history requires a Thread scope",
      );
    }
    const messageIds = envelope.history.map(({ messageId }) => messageId);
    if (new Set(messageIds).size !== messageIds.length) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "The context history contains duplicate message IDs",
      );
    }
    const messages = await this.#dependencies.threads.readCommittedMessagesByIds({
      ownerId: input.ownerId,
      agentId: input.agentId,
      threadId: input.threadId,
      messageIds,
    });
    if (messages.length !== envelope.history.length) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        "The context history is missing a selected committed message",
      );
    }
    const byId = new Map(messages.map((message) => [message.id, message]));
    const projected: RuntimeProjectionMessage[] = [];
    const systemBlocks: RuntimeProjectionContextBlock[] = [];
    let previousSequence = 0;
    for (const item of envelope.history) {
      const message = byId.get(item.messageId);
      if (
        !message ||
        message.ownerId !== input.ownerId ||
        message.agentId !== input.agentId ||
        message.threadId !== input.threadId ||
        message.status !== "committed" ||
        message.role !== item.role ||
        message.contentRef !== item.contentRef ||
        message.dataClassification !== item.dataClassification ||
        message.committedAt !== item.occurredAt
      ) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "The context history message does not match its selected identity",
          { messageId: item.messageId },
        );
      }
      if (message.sequence <= previousSequence) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "The context history is not ordered by committed message sequence",
          { messageId: item.messageId },
        );
      }
      previousSequence = message.sequence;
      const content = await this.readText(
        input,
        item.contentRef,
        "context history",
        item.dataClassification,
      );
      if (item.role === "owner" || item.role === "agent") {
        projected.push({
          id: item.messageId,
          role: item.role === "owner" ? "user" : "assistant",
          content: Object.freeze([{ type: "text", text: content }]),
          occurredAt: item.occurredAt,
        });
      } else {
        systemBlocks.push({
          authority: "non-authoritative",
          kind: "system-history",
          ref: item.messageId,
          content,
          dataClassification: item.dataClassification,
          productRole: "system",
        });
      }
    }
    return { messages: projected, systemBlocks };
  }

  private async readContextBlocks(
    input: RuntimeProjectionRequest,
    envelope: ProductContextEnvelopeV1,
    systemBlocks: readonly RuntimeProjectionContextBlock[],
  ): Promise<readonly RuntimeProjectionContextBlock[]> {
    const refs = new Set<string>();
    const blocks: RuntimeProjectionContextBlock[] = [...systemBlocks];
    for (const block of envelope.contextBlocks) {
      if (refs.has(block.ref)) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "The context envelope contains duplicate block references",
          { ref: block.ref },
        );
      }
      refs.add(block.ref);
      blocks.push({
        authority: "non-authoritative",
        kind: block.kind,
        ref: block.ref,
        content: await this.readText(
          input,
          block.payloadRef,
          "context block",
          block.dataClassification,
        ),
        ...(block.sourceRef ? { sourceRef: block.sourceRef } : {}),
        dataClassification: block.dataClassification,
      });
    }
    return Object.freeze(blocks);
  }

  private async readWorkerResults(
    input: RuntimeProjectionRequest,
  ): Promise<readonly RuntimeProjectionContextBlock[]> {
    const refs = new Set<PayloadRef>();
    const blocks: RuntimeProjectionContextBlock[] = [];
    for (const worker of input.workerResultRefs) {
      if (refs.has(worker.resultRef)) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "Runtime projection contains duplicate Worker result Payloads",
          { payloadRef: worker.resultRef },
        );
      }
      refs.add(worker.resultRef);
      const payload = await this.#dependencies.payloads.get(worker.resultRef);
      if (!payload) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_FOUND,
          "A Worker result Payload is missing",
          { payloadRef: worker.resultRef, workerRunId: worker.workerRunId },
        );
      }
      if (
        CLASSIFICATION_RANK[payload.dataClassification] >
        CLASSIFICATION_RANK[input.dataClassification]
      ) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "A Worker result Payload exceeds the Run data classification",
          { payloadRef: worker.resultRef, workerRunId: worker.workerRunId },
        );
      }
      const plaintext = await this.#dependencies.protector.unprotect({
        ownerId: input.ownerId,
        agentId: input.agentId,
        payload,
      });
      const content = new TextDecoder().decode(plaintext);
      if (content.trim().length === 0) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "A Worker result Payload is empty",
          { payloadRef: worker.resultRef, workerRunId: worker.workerRunId },
        );
      }
      blocks.push({
        authority: "non-authoritative",
        kind: "worker-result",
        ref: worker.resultRef,
        sourceRef: worker.workerRunId,
        content,
        dataClassification: payload.dataClassification,
      });
    }
    return Object.freeze(blocks);
  }

  private async readText(
    input: RuntimeProjectionRequest,
    ref: PayloadRef,
    label: string,
    expectedClassification?: DataClassification,
  ): Promise<string> {
    const payload = await this.#dependencies.payloads.get(ref);
    if (!payload) {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, `${label} Payload is missing`, {
        payloadRef: ref,
      });
    }
    if (
      CLASSIFICATION_RANK[payload.dataClassification] >
      CLASSIFICATION_RANK[input.dataClassification]
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `${label} Payload exceeds the Run data classification`,
        { payloadRef: ref },
      );
    }
    if (
      expectedClassification !== undefined &&
      payload.dataClassification !== expectedClassification
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `${label} Payload classification does not match the selected context item`,
        { payloadRef: ref },
      );
    }
    if (!payload.contentType.startsWith("text/")) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `${label} Payload is not text content`,
        { payloadRef: ref },
      );
    }
    const plaintext = await this.#dependencies.protector.unprotect({
      ownerId: input.ownerId,
      agentId: input.agentId,
      payload,
    });
    const text = new TextDecoder().decode(plaintext);
    if (text.trim().length === 0) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `${label} Payload is empty`,
        { payloadRef: ref },
      );
    }
    return text;
  }

  private async commitTextArtifact(
    runId: RunId,
    purpose: "trace" | "context" | "final_answer",
    operationKey: string,
    text: string,
    dataClassification: DataClassification,
  ): Promise<PayloadRef> {
    const ref = this.#dependencies.ids.next("runtime-payload");
    const payload = await this.#dependencies.protector.protect({
      ownerId: this.#dependencies.ownerId,
      agentId: this.#dependencies.agentId,
      ref,
      dataClassification,
      contentType: "text/plain; charset=utf-8",
      plaintext: new TextEncoder().encode(text),
      createdAt: this.#dependencies.clock.now(),
    });
    const receipt = await this.#dependencies.artifacts.commit({
      runId,
      purpose,
      operationKey,
      payload,
    });
    return receipt.ref;
  }

  private assertScope(input: RuntimeProjectionRequest): void {
    if (
      input.ownerId !== this.#dependencies.ownerId ||
      input.agentId !== this.#dependencies.agentId
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Runtime projection scope is outside the bound Owner and Agent",
      );
    }
    if (
      input.workerResultRefs.some(
        ({ workerRunId, resultRef }) => workerRunId.length === 0 || resultRef.length === 0,
      )
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Worker result references must identify a Worker Run and Payload",
      );
    }
  }

  private async assertWorkerReferences(input: RuntimeProjectionRequest): Promise<void> {
    const workerRunIds = input.workerResultRefs.map(({ workerRunId }) => workerRunId);
    if (new Set(workerRunIds).size !== workerRunIds.length) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Runtime projection contains duplicate Worker result identities",
      );
    }
    if (input.workerResultRefs.length === 0) return;
    const stored = await this.#dependencies.checkpoints.read(input.runId);
    if (!stored) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        "The Run checkpoint required to authorize Worker results is missing",
        { runId: input.runId },
      );
    }
    const workerResults = Object.entries(stored.checkpoint.workerResults);
    for (const reference of input.workerResultRefs) {
      const matching = workerResults.find(
        ([workerRunId, resultRef]) =>
          workerRunId === reference.workerRunId && resultRef === reference.resultRef,
      );
      if (!matching) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          "Worker result is not recorded by the canonical Run checkpoint",
          { runId: input.runId, workerRunId: reference.workerRunId },
        );
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function classification(value: unknown): value is DataClassification {
  return (
    value === "public" || value === "private" || value === "sensitive" || value === "restricted"
  );
}

function isContextEnvelope(value: unknown): value is ProductContextEnvelopeV1 {
  if (!isRecord(value)) return false;
  if (
    value["schemaVersion"] !== "context.v1" ||
    !nonEmpty(value["ownerId"]) ||
    !nonEmpty(value["agentId"]) ||
    !nonEmpty(value["sessionId"]) ||
    !(value["threadId"] === null || nonEmpty(value["threadId"])) ||
    !nonEmpty(value["runId"]) ||
    !nonEmpty(value["formedAt"]) ||
    !(
      value["sourceWatermark"] === null ||
      (typeof value["sourceWatermark"] === "number" &&
        Number.isSafeInteger(value["sourceWatermark"]) &&
        value["sourceWatermark"] >= 0)
    ) ||
    !nonEmpty(value["policyVersion"]) ||
    !Array.isArray(value["history"]) ||
    !isRecord(value["prompt"]) ||
    !Array.isArray(value["systemPolicyRefs"]) ||
    !Array.isArray(value["contextBlocks"])
  )
    return false;
  const prompt = value["prompt"];
  if (
    !nonEmpty(prompt["id"]) ||
    !(
      prompt["sourceType"] === "user_message" ||
      prompt["sourceType"] === "schedule" ||
      prompt["sourceType"] === "external_event"
    ) ||
    !nonEmpty(prompt["payloadRef"]) ||
    !nonEmpty(prompt["occurredAt"])
  )
    return false;
  if (
    !value["history"].every((item: unknown) => {
      if (!isRecord(item)) return false;
      return (
        nonEmpty(item["messageId"]) &&
        (item["role"] === "owner" || item["role"] === "agent" || item["role"] === "system") &&
        nonEmpty(item["contentRef"]) &&
        nonEmpty(item["occurredAt"]) &&
        classification(item["dataClassification"])
      );
    }) ||
    !value["systemPolicyRefs"].every((item: unknown) => {
      if (!isRecord(item)) return false;
      return (
        nonEmpty(item["ref"]) &&
        nonEmpty(item["payloadRef"]) &&
        (item["kind"] === "policy" || item["kind"] === "answer-locale")
      );
    }) ||
    !value["contextBlocks"].every((item: unknown) => {
      if (!isRecord(item)) return false;
      return (
        (item["kind"] === "thread-summary" ||
          item["kind"] === "memory" ||
          item["kind"] === "capability-summary") &&
        nonEmpty(item["ref"]) &&
        nonEmpty(item["payloadRef"]) &&
        (item["sourceRef"] === undefined || nonEmpty(item["sourceRef"])) &&
        classification(item["dataClassification"])
      );
    })
  )
    return false;
  return true;
}
