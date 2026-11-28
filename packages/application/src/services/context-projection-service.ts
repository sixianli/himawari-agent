import type { AgentId, MessageId, OwnerId, RunId } from "@himawari-agent/domain";
import { CHAT_TASK_BOUNDARY } from "@himawari-agent/prompt-catalog";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import {
  contextArtifactOperationKey,
  isProductContextRunState,
  type ProductContextEnvelopeV1,
} from "../ports/context-projection.js";
import { isMemoryDates } from "../ports/memory-dates.js";
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
import { highestClassification, modelVisibleCeiling } from "./model-visibility.js";
import { isRuntimeHistoryReference, RuntimeHistoryService } from "./runtime-history-service.js";

const CLASSIFICATION_RANK = Object.freeze({ public: 0, private: 1, sensitive: 2, restricted: 3 });

const ATTACHMENT_CONTENT_TYPE = "text/x-himawari-attachment";
const ATTACHMENT_TAG = /<file name="([^"<>\n]*)" ref="([^"<>\s]+)"(?: [a-z]+="[^"<>\n]*")*\/>/g;
const UNREADABLE_ATTACHMENT = "[附件无法读取]";
const IMAGE_CONTENT_TYPE = "text/x-himawari-image";
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;
const IMAGE_KIND = / kind="image"/;
const REPLY_TAG = /^<reply to="([A-Za-z0-9_.:-]+)"\/>\n?/;
const REPLY_TAGS = /<reply to="[^"<>\n]*"\/>\n?/g;
const REPLY_QUOTE_LIMIT = 1000;
const CURRENT_TASK_POLICY = CHAT_TASK_BOUNDARY.text;

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

export class ContextProjectionService implements RuntimeProjectionPort {
  readonly #dependencies: ContextProjectionServiceDependencies;
  readonly #history: RuntimeHistoryService;

  constructor(dependencies: ContextProjectionServiceDependencies) {
    this.#dependencies = dependencies;
    this.#history = new RuntimeHistoryService(dependencies);
  }

  async resolveProjection(input: RuntimeProjectionRequest): Promise<RuntimeProjection> {
    this.assertScope(input);
    const envelope = await this.readEnvelope(input);
    const nativeHistory = envelope.runtimeHistory
      ? await this.#history.load(envelope.runtimeHistory.reference, modelVisibleCeiling())
      : undefined;
    const attachmentClassifications: DataClassification[] = [];
    const attachments = { count: 0 };
    const history = await this.readHistory(
      input,
      envelope,
      attachmentClassifications,
      attachments,
      nativeHistory?.coveredRunIds,
    );
    const images: { readonly mimeType: string; readonly data: string }[] = [];
    const prompt = await this.expandAttachments(
      input,
      await this.expandReply(
        input,
        await this.readText(input, envelope.prompt.payloadRef, "context prompt"),
        attachmentClassifications,
      ),
      attachmentClassifications,
      attachments,
      images,
    );
    const policyTexts = await Promise.all(
      envelope.systemPolicyRefs.map(({ payloadRef }) =>
        this.readText(input, payloadRef, "context system policy"),
      ),
    );
    const systemInstruction = [
      await this.readText(input, input.systemInstructionRef, "system instruction"),
      ...policyTexts,
      CURRENT_TASK_POLICY,
    ]
      .filter((text) => text.length > 0)
      .join("\n\n");
    const contextBlocks = await this.readContextBlocks(input, envelope, history.systemBlocks);
    await this.assertWorkerReferences(input);
    const workerBlocks = await this.readWorkerResults(input);
    const answerLocale = envelope.systemPolicyRefs.find(({ kind }) => kind === "answer-locale");
    const contentClassification = highestClassification(input.dataClassification, [
      ...(envelope.runtimeHistory ? [envelope.runtimeHistory.reference.dataClassification] : []),
      ...envelope.history.map(({ dataClassification }) => dataClassification),
      ...contextBlocks.map(({ dataClassification }) => dataClassification),
      ...workerBlocks.map(({ dataClassification }) => dataClassification),
      ...attachmentClassifications,
    ]);
    return Object.freeze({
      systemInstruction,
      contentClassification,
      ...(attachments.count > 0 ? { ownerAttachments: attachments.count } : {}),
      ...(answerLocale ? { answerLocaleRef: answerLocale.ref } : {}),
      ...(nativeHistory ? { nativeHistory } : {}),
      coveredRunIds: [
        ...new Set([
          ...(nativeHistory?.coveredRunIds ?? []),
          ...envelope.history.flatMap((item) => (item.runState ? [item.runState.runId] : [])),
        ]),
      ],
      ...(envelope.runtimeHistory?.runState.status === "cancelled"
        ? { interruptedRunId: envelope.runtimeHistory.runState.runId }
        : {}),
      history: Object.freeze(history.messages),
      prompt: Object.freeze({
        id: envelope.prompt.id,
        content: prompt,
        occurredAt: envelope.prompt.occurredAt,
        ...(images.length ? { images: Object.freeze(images) } : {}),
        ...(envelope.prompt.sourceType === "external_event" ? { from: "outside" as const } : {}),
      }),
      contextBlocks: Object.freeze([...contextBlocks, ...workerBlocks]),
    });
  }

  async captureHistory(input: Parameters<RuntimeHistoryService["save"]>[0]) {
    return this.#history.save(input);
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
    attachmentClassifications: DataClassification[],
    attachments: { count: number },
    coveredRunIds: readonly RunId[] = [],
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
        message.committedAt !== item.occurredAt ||
        (item.runState !== undefined && item.runState.runId !== message.runId)
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
      if (message.runId && coveredRunIds.includes(message.runId)) continue;
      const stored = await this.readText(
        input,
        item.contentRef,
        "context history",
        item.dataClassification,
        modelVisibleCeiling(),
      );
      const content =
        item.role === "owner"
          ? await this.expandAttachments(
              input,
              await this.expandReply(input, stored, attachmentClassifications),
              attachmentClassifications,
              attachments,
            )
          : stored;
      if (item.role === "owner" || item.role === "agent") {
        projected.push({
          id: item.messageId,
          role: item.role === "owner" ? "user" : "assistant",
          content: Object.freeze([
            {
              type: "text",
              text:
                item.role === "owner" && item.runState?.status === "cancelled"
                  ? "[Himawari 系统记录：此历史请求所属任务已取消，仅保留为背景，不要自动恢复。取消不代表任何工具执行成功，也不代表已撤销之前的副作用。]\n" +
                    content
                  : content,
            },
          ]),
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
          modelVisibleCeiling(),
        ),
        ...(block.sourceRef ? { sourceRef: block.sourceRef } : {}),
        dataClassification: block.dataClassification,
        ...(block.dates ? { dates: block.dates } : {}),
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

  private async expandReply(
    input: RuntimeProjectionRequest,
    text: string,
    classifications: DataClassification[],
  ): Promise<string> {
    const tag = REPLY_TAG.exec(text);
    if (!tag) return text;
    const rest = text.slice(tag[0].length);
    if (!input.threadId) return rest;
    const [original] = await this.#dependencies.threads.readCommittedMessagesByIds({
      ownerId: input.ownerId,
      agentId: input.agentId,
      threadId: input.threadId,
      messageIds: [tag[1] as MessageId],
    });
    if (
      !original ||
      original.threadId !== input.threadId ||
      original.internal ||
      (original.role !== "owner" && original.role !== "agent")
    )
      return rest;
    const quoted = await this.readText(
      input,
      original.contentRef as PayloadRef,
      "reply quote",
      undefined,
      modelVisibleCeiling(),
    ).catch((error: unknown) => {
      if (error instanceof ApplicationPortError) return undefined;
      throw error;
    });
    if (quoted === undefined) return rest;
    classifications.push(original.dataClassification);
    const plain = quoted
      .replace(REPLY_TAGS, "")
      .replace(ATTACHMENT_TAG, (_tag, name: string) => `[附件 ${name}]`)
      .trim();
    const shown =
      plain.length > REPLY_QUOTE_LIMIT ? `${plain.slice(0, REPLY_QUOTE_LIMIT)}…` : plain;
    const role = original.role === "owner" ? "user" : "assistant";
    return `<reply-to role="${role}">\n${shown}\n</reply-to>\n\n${rest}`;
  }

  private async expandAttachments(
    input: RuntimeProjectionRequest,
    text: string,
    classifications: DataClassification[],
    attachments: { count: number },
    images?: { readonly mimeType: string; readonly data: string }[],
  ): Promise<string> {
    const tags = [...text.matchAll(ATTACHMENT_TAG)];
    if (!tags.length) return text;
    attachments.count += tags.length;
    const expanded = await Promise.all(
      tags.map(async ([tag, name, ref]) => {
        const payload = ref ? await this.#dependencies.payloads.get(ref as PayloadRef) : null;
        const read = async (label: string) => {
          const text = await this.readText(
            input,
            ref as PayloadRef,
            label,
            undefined,
            modelVisibleCeiling(),
          );
          if (payload) classifications.push(payload.dataClassification);
          return text;
        };
        if (IMAGE_KIND.test(tag)) {
          if (!images) return `<image name="${name}"/>`;
          const image =
            payload?.contentType === IMAGE_CONTENT_TYPE
              ? IMAGE_DATA_URL.exec(
                  await read("image").catch((error: unknown) => {
                    if (error instanceof ApplicationPortError) return "";
                    throw error;
                  }),
                )
              : null;
          if (!image) return `<image name="${name}">${UNREADABLE_ATTACHMENT}</image>`;
          return { name, mimeType: image[1] as string, data: image[2] as string };
        }
        const content =
          payload?.contentType === ATTACHMENT_CONTENT_TYPE
            ? await read("attachment").catch((error: unknown) => {
                if (error instanceof ApplicationPortError) return UNREADABLE_ATTACHMENT;
                throw error;
              })
            : UNREADABLE_ATTACHMENT;
        return `<file name="${name}">\n${content}\n</file>`;
      }),
    );
    let index = 0;
    return text.replace(ATTACHMENT_TAG, () => {
      const item = expanded[index++];
      if (typeof item !== "object") return item ?? "";
      images?.push({ mimeType: item.mimeType, data: item.data });
      return `<image name="${item.name}" index="${images?.length ?? 0}"/>`;
    });
  }

  private async readText(
    input: RuntimeProjectionRequest,
    ref: PayloadRef,
    label: string,
    expectedClassification?: DataClassification,
    ceiling: DataClassification = input.dataClassification,
  ): Promise<string> {
    const payload = await this.#dependencies.payloads.get(ref);
    if (!payload) {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, `${label} Payload is missing`, {
        payloadRef: ref,
      });
    }
    if (CLASSIFICATION_RANK[payload.dataClassification] > CLASSIFICATION_RANK[ceiling]) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        ceiling === input.dataClassification
          ? `${label} Payload exceeds the Run data classification`
          : `${label} Payload exceeds what the model may see`,
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
      contentType: "text/plain",
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
    (value["runtimeHistory"] !== undefined &&
      (!isRecord(value["runtimeHistory"]) ||
        !isRuntimeHistoryReference(value["runtimeHistory"]["reference"]) ||
        !isProductContextRunState(value["runtimeHistory"]["runState"]) ||
        value["runtimeHistory"]["reference"].runId !==
          value["runtimeHistory"]["runState"].runId)) ||
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
        classification(item["dataClassification"]) &&
        (item["runState"] === undefined || isProductContextRunState(item["runState"]))
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
          item["kind"] === "conversation-recall" ||
          item["kind"] === "owner-rules" ||
          item["kind"] === "memory-snapshot" ||
          item["kind"] === "owner-profile" ||
          item["kind"] === "owner-agenda" ||
          item["kind"] === "capability-summary" ||
          item["kind"] === "runtime-environment") &&
        nonEmpty(item["ref"]) &&
        nonEmpty(item["payloadRef"]) &&
        (item["sourceRef"] === undefined || nonEmpty(item["sourceRef"])) &&
        (item["dates"] === undefined ||
          (item["kind"] === "memory" && isMemoryDates(item["dates"]))) &&
        classification(item["dataClassification"])
      );
    })
  )
    return false;
  return true;
}
