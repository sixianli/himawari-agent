import type {
  CapabilityInvocationAuthority,
  CapabilityInvocationReceiptPort,
  CapabilityInvocationResultPort,
  ClockPort,
  DataClassification,
  IdGeneratorPort,
  PayloadProtectionRequest,
  PayloadProtectorPort,
  PayloadRecord,
  PayloadStorePort,
  SandboxExecutionPlan,
  SandboxJobJournalPort,
} from "@himawari-agent/application";
import {
  type PayloadBrokerInputReadRequest,
  type PayloadBrokerOutputWriteRequest,
  type PayloadBrokerSandboxJobRequest,
  type PayloadBrokerSandboxJobResult,
  payloadSandboxJobRequestSchema,
} from "@himawari-agent/execution-contracts";
import type {
  PayloadBrokerOutputReceipt,
  PayloadBrokerTrustedHandler,
} from "@himawari-agent/platform-node";

type OwnerId = PayloadProtectionRequest["ownerId"];
type AgentId = PayloadProtectionRequest["agentId"];

export const PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES = Object.freeze({
  SANDBOX_JOB_REJECTED: "PAYLOAD_HANDLER_SANDBOX_JOB_REJECTED",
  AUTHORITY_REJECTED: "PAYLOAD_HANDLER_AUTHORITY_REJECTED",
  CONTENT_TYPE_MISMATCH: "PAYLOAD_HANDLER_CONTENT_TYPE_MISMATCH",
  CONTENT_TYPE_UNSUPPORTED: "PAYLOAD_HANDLER_CONTENT_TYPE_UNSUPPORTED",
  INPUT_NOT_FOUND: "PAYLOAD_HANDLER_INPUT_NOT_FOUND",
  INPUT_REJECTED: "PAYLOAD_HANDLER_INPUT_REJECTED",
  INVOCATION_MISMATCH: "PAYLOAD_HANDLER_INVOCATION_MISMATCH",
  INVOCATION_NOT_FOUND: "PAYLOAD_HANDLER_INVOCATION_NOT_FOUND",
  OBSERVATION_REJECTED: "PAYLOAD_HANDLER_OBSERVATION_REJECTED",
  OUTPUT_TOO_LARGE: "PAYLOAD_HANDLER_OUTPUT_TOO_LARGE",
  PAYLOAD_CLASSIFICATION_MISMATCH: "PAYLOAD_HANDLER_CLASSIFICATION_MISMATCH",
  PAYLOAD_READ_FAILED: "PAYLOAD_HANDLER_PAYLOAD_READ_FAILED",
  PROTECTION_FAILED: "PAYLOAD_HANDLER_PROTECTION_FAILED",
} as const);

const CLASSIFICATION_RANK: Readonly<Record<DataClassification, number>> = Object.freeze({
  public: 0,
  private: 1,
  sensitive: 2,
  restricted: 3,
});

type ProductionPayloadHandlerErrorCode =
  (typeof PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES)[keyof typeof PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES];

export class ProductionPayloadBrokerHandlerError extends Error {
  readonly code: ProductionPayloadHandlerErrorCode;

  constructor(code: ProductionPayloadHandlerErrorCode) {
    super(code);
    this.name = "ProductionPayloadBrokerHandlerError";
    this.code = code;
  }
}

export interface ProductionPayloadBrokerHandlerOptions {
  /** Host binding comes from trusted composition, never the request. */
  readonly sandboxJobs?: {
    readonly hostId: string;
    readonly journal: SandboxJobJournalPort;
    /** Agent-owned scope and qualification sources; called before a new start
     * observation, never for cleanup or an exact replay of an old observation. */
    readonly verifyStart: (plan: SandboxExecutionPlan) => Promise<void>;
    readonly resolveScope: (
      plan: SandboxExecutionPlan,
    ) => Promise<NonNullable<PayloadBrokerSandboxJobResult["payload"]["resolvedScope"]>>;
  };
  /** Scoped to the trusted Agent owner; no Worker-provided scope is accepted. */
  readonly receipts: CapabilityInvocationReceiptPort;
  /** Scoped to the same trusted Agent owner as the receipt port. */
  readonly results: CapabilityInvocationResultPort;
  /** Resolve the Payload store only after the durable receipt supplies its scope. */
  readonly payloadsFor: (ownerId: OwnerId, agentId: AgentId) => Pick<PayloadStorePort, "get">;
  readonly protector: PayloadProtectorPort;
  readonly currentAuthority: () => Pick<CapabilityInvocationAuthority, "product" | "lease">;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly agentServiceInstanceId: string;
  readonly agentServiceBootId: string;
  readonly maximumPayloadBytes: number;
  /** Product-approved media types; protocol syntax validation remains in execution-contracts. */
  readonly allowedContentTypes: readonly string[];
}

function sameAuthority(
  left: CapabilityInvocationAuthority,
  right: CapabilityInvocationAuthority,
): boolean {
  return (
    left.product.deploymentId === right.product.deploymentId &&
    left.product.authorityEpoch === right.product.authorityEpoch &&
    left.product.fencingToken === right.product.fencingToken &&
    left.lease.leaseId === right.lease.leaseId &&
    left.lease.fencingToken === right.lease.fencingToken &&
    left.agentServiceInstanceId === right.agentServiceInstanceId &&
    left.agentServiceBootId === right.agentServiceBootId &&
    left.workerInstanceId === right.workerInstanceId &&
    left.workerBootId === right.workerBootId
  );
}

function samePayloadIdentity(payload: PayloadRecord, classification: string, contentType: string) {
  return (
    payload.dataClassification === classification &&
    payload.contentType === contentType &&
    payload.ciphertext instanceof Uint8Array
  );
}

export class ProductionPayloadBrokerHandler implements PayloadBrokerTrustedHandler {
  readonly #options: ProductionPayloadBrokerHandlerOptions;

  constructor(options: ProductionPayloadBrokerHandlerOptions) {
    if (!Number.isSafeInteger(options.maximumPayloadBytes) || options.maximumPayloadBytes < 1) {
      throw new TypeError("Payload handler maximum bytes must be a positive safe integer");
    }
    if (options.allowedContentTypes.length === 0) {
      throw new TypeError("Payload handler requires an allowed content type");
    }
    this.#options = options;
  }

  async sandboxJob(
    value: PayloadBrokerSandboxJobRequest,
  ): Promise<
    Pick<PayloadBrokerSandboxJobResult["payload"], "record" | "applied" | "resolvedScope">
  > {
    try {
      const request = payloadSandboxJobRequestSchema.parse(value);
      const configured = this.#options.sandboxJobs;
      if (!configured) throw new Error("unavailable");
      const authority = this.authorityFor(request);
      const lookup = {
        handleRef: request.payload.handleRef,
        invocationId: request.payload.invocationId,
        authority,
        now: this.#options.clock.now(),
      };
      const receipt = await this.#options.results.lookupFrozen(lookup);
      if (!receipt) throw new Error("receipt missing");
      this.assertReceiptAttempt(receipt, request, authority);
      const record = await configured.journal.read(request.payload.identity);
      if (
        !record ||
        record.plan.identity.hostId !== configured.hostId ||
        record.plan.handleRef !== receipt.handleRef ||
        record.plan.inputRef !== receipt.inputRef ||
        record.plan.semanticFingerprint !== receipt.semanticFingerprint ||
        record.plan.identity.receiptRef !== receipt.receiptRef ||
        record.plan.identity.runId !== receipt.runId ||
        record.plan.identity.ownerId !== receipt.ownerId ||
        record.plan.identity.agentId !== receipt.agentId ||
        record.plan.identity.invocationId !== receipt.invocationId
      )
        throw new Error("job binding mismatch");
      if (request.payload.observation) {
        const observation = request.payload.observation;
        if (
          observation.state === "starting" &&
          observation.sequence > record.observation.sequence
        ) {
          await configured.verifyStart(record.plan);
          if (!sameAuthority(authority, this.authorityFor(request)))
            throw new Error("authority changed during start verification");
        }
        const appended = await configured.journal.append({
          observation: request.payload.observation,
          authority,
          now: this.#options.clock.now(),
        });
        return { ...appended, resolvedScope: null };
      }
      if (request.payload.resolveScope && !(await this.#options.receipts.read(lookup)))
        throw new Error("scope authority unavailable");
      const resolvedScope = request.payload.resolveScope
        ? await configured.resolveScope(record.plan)
        : null;
      if (
        request.payload.resolveScope &&
        !(await this.#options.receipts.read({
          ...lookup,
          now: this.#options.clock.now(),
          authority: this.authorityFor(request),
        }))
      )
        throw new Error("scope authority changed");
      // A read must not disclose a plan after authority changes during lookup.
      const current = await this.#options.results.lookupFrozen({
        ...lookup,
        now: this.#options.clock.now(),
        authority: this.authorityFor(request),
      });
      if (!current || !sameAuthority(current.authority, authority))
        throw new Error("authority changed");
      return { record, applied: false, resolvedScope };
    } catch {
      throw new ProductionPayloadBrokerHandlerError(
        PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.SANDBOX_JOB_REJECTED,
      );
    }
  }

  async readInput(request: PayloadBrokerInputReadRequest): Promise<Uint8Array> {
    try {
      return await this.readInputInternal(request);
    } catch (error) {
      if (error instanceof ProductionPayloadBrokerHandlerError) throw error;
      throw new ProductionPayloadBrokerHandlerError(
        PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.INPUT_REJECTED,
      );
    }
  }

  async writeOutput(
    request: PayloadBrokerOutputWriteRequest,
    plaintext: Uint8Array,
    contentType: string,
  ): Promise<PayloadBrokerOutputReceipt> {
    try {
      return await this.writeOutputInternal(request, plaintext, contentType);
    } catch (error) {
      if (error instanceof ProductionPayloadBrokerHandlerError) throw error;
      throw new ProductionPayloadBrokerHandlerError(
        PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.OBSERVATION_REJECTED,
      );
    }
  }

  private authorityFor(
    request:
      | PayloadBrokerInputReadRequest
      | PayloadBrokerOutputWriteRequest
      | PayloadBrokerSandboxJobRequest,
  ): CapabilityInvocationAuthority {
    const current = this.#options.currentAuthority();
    if (
      current.product.authorityEpoch !== request.payload.authorityEpoch ||
      current.product.fencingToken !== request.payload.fencingToken ||
      current.lease.fencingToken !== request.payload.fencingToken ||
      current.product.fencingToken !== current.lease.fencingToken
    ) {
      throw new ProductionPayloadBrokerHandlerError(
        PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.AUTHORITY_REJECTED,
      );
    }
    return Object.freeze({
      product: current.product,
      lease: current.lease,
      agentServiceInstanceId: this.#options.agentServiceInstanceId,
      agentServiceBootId: this.#options.agentServiceBootId,
      workerInstanceId: request.payload.workerInstanceId,
      workerBootId: request.payload.workerBootId,
    });
  }

  private assertReceiptAttempt(
    receipt: {
      readonly handleRef: string;
      readonly invocationId: string;
      readonly authority: CapabilityInvocationAuthority;
    },
    request:
      | PayloadBrokerInputReadRequest
      | PayloadBrokerOutputWriteRequest
      | PayloadBrokerSandboxJobRequest,
    authority: CapabilityInvocationAuthority,
  ): void {
    if (
      receipt.handleRef !== request.payload.handleRef ||
      receipt.invocationId !== request.payload.invocationId ||
      !sameAuthority(receipt.authority, authority)
    ) {
      throw new ProductionPayloadBrokerHandlerError(
        PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.INVOCATION_MISMATCH,
      );
    }
  }

  private async readInputInternal(request: PayloadBrokerInputReadRequest): Promise<Uint8Array> {
    const authority = this.authorityFor(request);
    const receipt = await this.#options.receipts.read({
      handleRef: request.payload.handleRef,
      invocationId: request.payload.invocationId,
      authority,
      now: this.#options.clock.now(),
    });
    if (!receipt) {
      throw new ProductionPayloadBrokerHandlerError(
        PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.INVOCATION_NOT_FOUND,
      );
    }
    this.assertReceiptAttempt(receipt, request, authority);

    const payload = await this.#options
      .payloadsFor(receipt.ownerId, receipt.agentId)
      .get(receipt.inputRef);
    if (!payload || payload.ref !== receipt.inputRef) {
      throw new ProductionPayloadBrokerHandlerError(
        PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.INPUT_NOT_FOUND,
      );
    }
    if (
      CLASSIFICATION_RANK[payload.dataClassification] >
      CLASSIFICATION_RANK[receipt.dataClassification]
    ) {
      throw new ProductionPayloadBrokerHandlerError(
        PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.PAYLOAD_CLASSIFICATION_MISMATCH,
      );
    }

    let plaintext: Uint8Array;
    try {
      plaintext = await this.#options.protector.unprotect({
        ownerId: receipt.ownerId,
        agentId: receipt.agentId,
        payload,
      });
    } catch {
      throw new ProductionPayloadBrokerHandlerError(
        PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.PAYLOAD_READ_FAILED,
      );
    }
    if (!(plaintext instanceof Uint8Array)) {
      throw new ProductionPayloadBrokerHandlerError(
        PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.PAYLOAD_READ_FAILED,
      );
    }
    if (plaintext.byteLength > this.#options.maximumPayloadBytes) {
      throw new ProductionPayloadBrokerHandlerError(
        PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.INPUT_REJECTED,
      );
    }
    return new Uint8Array(plaintext);
  }

  private async writeOutputInternal(
    request: PayloadBrokerOutputWriteRequest,
    plaintext: Uint8Array,
    contentType: string,
  ): Promise<PayloadBrokerOutputReceipt> {
    if (
      !(plaintext instanceof Uint8Array) ||
      plaintext.byteLength > this.#options.maximumPayloadBytes
    ) {
      throw new ProductionPayloadBrokerHandlerError(
        PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.OUTPUT_TOO_LARGE,
      );
    }
    if (!this.#options.allowedContentTypes.some((candidate) => candidate === contentType)) {
      throw new ProductionPayloadBrokerHandlerError(
        PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.CONTENT_TYPE_UNSUPPORTED,
      );
    }
    if (request.payload.contentType !== contentType) {
      throw new ProductionPayloadBrokerHandlerError(
        PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.CONTENT_TYPE_MISMATCH,
      );
    }

    const authority = this.authorityFor(request);
    const receipt = await this.#options.results.lookupFrozen({
      handleRef: request.payload.handleRef,
      invocationId: request.payload.invocationId,
      authority,
      now: this.#options.clock.now(),
    });
    if (!receipt) {
      throw new ProductionPayloadBrokerHandlerError(
        PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.INVOCATION_NOT_FOUND,
      );
    }
    this.assertReceiptAttempt(receipt, request, authority);
    if (plaintext.byteLength > receipt.resourceCeiling.maxOutputBytes) {
      throw new ProductionPayloadBrokerHandlerError(
        PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.OUTPUT_TOO_LARGE,
      );
    }

    let protectedPayload: PayloadRecord;
    try {
      protectedPayload = await this.#options.protector.protect({
        ownerId: receipt.ownerId,
        agentId: receipt.agentId,
        ref: this.#options.ids.next("capability-invocation-output"),
        dataClassification: receipt.dataClassification,
        contentType,
        plaintext: new Uint8Array(plaintext),
        createdAt: this.#options.clock.now(),
      });
    } catch {
      throw new ProductionPayloadBrokerHandlerError(
        PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.PROTECTION_FAILED,
      );
    }
    if (!samePayloadIdentity(protectedPayload, receipt.dataClassification, contentType)) {
      throw new ProductionPayloadBrokerHandlerError(
        PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.PROTECTION_FAILED,
      );
    }

    let observed: Awaited<ReturnType<CapabilityInvocationResultPort["observeOutput"]>>;
    try {
      observed = await this.#options.results.observeOutput({
        handleRef: request.payload.handleRef,
        invocationId: request.payload.invocationId,
        authority,
        now: this.#options.clock.now(),
        payload: protectedPayload,
        plaintextByteLength: plaintext.byteLength,
      });
    } catch {
      throw new ProductionPayloadBrokerHandlerError(
        PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.OBSERVATION_REJECTED,
      );
    }
    return { outputRef: observed.ref, replayed: observed.replayed };
  }
}
