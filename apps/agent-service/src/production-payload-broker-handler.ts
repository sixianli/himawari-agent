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
  SandboxExecutionEvidencePort,
  SandboxExecutionFacts,
  SandboxExecutionJournalPort,
  SandboxExecutionPlan,
  SandboxExecutionPreparationPort,
  SandboxExecutionReconciliationService,
  SandboxExecutionRecord,
  SandboxJobJournalPort,
} from "@himawari-agent/application";
import type {
  SandboxResourceOutputPage,
  SandboxResourceOutputQuery,
} from "@himawari-agent/execution-contracts";
import {
  type PayloadBrokerInputReadRequest,
  type PayloadBrokerOutputWriteRequest,
  type PayloadBrokerSandboxExecutionRequest,
  type PayloadBrokerSandboxExecutionResult,
  type PayloadBrokerSandboxJobRequest,
  type PayloadBrokerSandboxJobResult,
  payloadSandboxExecutionRequestSchema,
  payloadSandboxJobRequestSchema,
  type SandboxExecutionPlanV2,
  type SandboxJobControlBinding,
  type SandboxResourceObservation,
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
  /** v2 uses the existing durable invocation authority and journal. Evidence is
   * authenticated by the Agent's reader; no Worker-supplied verdict is accepted. */
  readonly sandboxExecutions?: {
    readonly hostId: string;
    readonly journal: SandboxExecutionJournalPort;
    readonly preparations?: SandboxExecutionPreparationPort;
    readonly registerControl?: (
      plan: SandboxExecutionPlanV2,
      control: SandboxJobControlBinding,
    ) => Promise<boolean>;
    readonly observeControl?: (
      record: SandboxExecutionRecord,
    ) => Promise<SandboxResourceObservation>;
    readonly verifyPreparation?: (
      plan: SandboxExecutionPlanV2,
      facts: SandboxExecutionFacts,
    ) => Promise<void>;
    readonly verifyStart: (plan: SandboxExecutionPlanV2) => Promise<void>;
    readonly resolveScope: (
      plan: SandboxExecutionPlanV2,
    ) => Promise<NonNullable<PayloadBrokerSandboxExecutionResult["payload"]["resolvedScope"]>>;
    readonly readOutput?: (
      record: SandboxExecutionRecord,
      query: SandboxResourceOutputQuery,
    ) => Promise<SandboxResourceOutputPage | null>;
    readonly evidence?: SandboxExecutionEvidencePort;
    readonly reconciliation?: Pick<SandboxExecutionReconciliationService, "reconcile">;
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

  async sandboxExecution(
    value: PayloadBrokerSandboxExecutionRequest,
  ): Promise<
    Pick<
      PayloadBrokerSandboxExecutionResult["payload"],
      "record" | "applied" | "resolvedScope" | "output"
    >
  > {
    try {
      const wire = ({ plan, facts, startedAt, operationRevision }: SandboxExecutionRecord) => ({
        phase: "bound" as const,
        plan,
        facts,
        startedAt,
        operationRevision,
      });
      const request = payloadSandboxExecutionRequestSchema.parse(value);
      const configured = this.#options.sandboxExecutions;
      if (!configured) throw new Error("unavailable");
      const authority = this.authorityFor(request);
      const control = request.payload.command;
      if (control.kind === "reconcile" || control.kind === "stop") {
        const previous = await configured.journal.read(request.payload.identity);
        if (
          !configured.reconciliation ||
          !previous ||
          previous.plan.identity.hostId !== configured.hostId ||
          previous.plan.handleRef !== request.payload.handleRef ||
          previous.plan.identity.invocationId !== request.payload.invocationId ||
          (control.kind === "stop" &&
            control.resourceRef !== previous.facts.environment.resourceRef)
        )
          throw new Error("reconciliation binding mismatch");
        // This risk-reduction path uses today's authenticated peer and Agent
        // authority, not the original invocation's frozen Worker boot. It has
        // no input/output disclosure, preparation or launch capability.
        const mutation = await configured.reconciliation.reconcile({
          identity: previous.plan.identity,
          expectedSequence: control.expectedSequence,
          authority,
          action: control.kind === "stop" ? "stop" : "inspect",
        });
        return { ...mutation, record: wire(mutation.record), resolvedScope: null, output: null };
      }
      const lookup = {
        handleRef: request.payload.handleRef,
        invocationId: request.payload.invocationId,
        authority,
        now: this.#options.clock.now(),
      };
      const receipt = await this.#options.results.lookupFrozen(lookup);
      if (!receipt) throw new Error("receipt missing");
      this.assertReceiptAttempt(receipt, request, authority);
      const admission = configured.preparations
        ? await configured.preparations.readAdmission(request.payload.identity)
        : undefined;
      const bound =
        admission?.phase === "bound"
          ? admission.record
          : admission?.phase === "reserved"
            ? undefined
            : await configured.journal.read(request.payload.identity);
      const record =
        admission?.phase === "reserved"
          ? {
              phase: "reserved" as const,
              plan: admission.plan,
              reservation: admission.reservation,
              startedAt: null,
              operationRevision: 0,
            }
          : bound
            ? wire(bound)
            : undefined;
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
        throw new Error("execution binding mismatch");
      const current = async (live: boolean) => {
        const next = this.authorityFor(request);
        if (!sameAuthority(next, authority)) throw new Error("authority changed");
        const input = { ...lookup, authority: next, now: this.#options.clock.now() };
        const found = live
          ? await this.#options.receipts.read(input)
          : await this.#options.results.lookupFrozen(input);
        if (!found) throw new Error("receipt unavailable");
        this.assertReceiptAttempt(found, request, authority);
      };
      let command = request.payload.command;
      if (
        "resourceRef" in command &&
        command.resourceRef !==
          (record.phase === "bound"
            ? record.facts.environment.resourceRef
            : record.reservation.resourceRef)
      )
        throw new Error("resource mismatch");
      if (
        command.kind !== "bind" &&
        "expectedSequence" in command &&
        command.expectedSequence !==
          (record.phase === "bound" ? record.facts.resource.sequence : record.reservation.sequence)
      )
        throw new Error("resource sequence changed");
      if (command.kind === "resolve") {
        await current(true);
        const resolvedScope = await configured.resolveScope(record.plan);
        await current(true);
        return { record, applied: false, resolvedScope, output: null };
      }
      if (command.kind === "register_control") {
        if (record.phase !== "reserved" || !configured.registerControl)
          throw new Error("control registration unavailable");
        await current(true);
        await configured.verifyStart(record.plan);
        await configured.registerControl(record.plan, command.control);
        await current(true);
        return { record, applied: false, resolvedScope: null, output: null };
      }
      if (command.kind === "bind") {
        if (!configured.preparations || !configured.verifyPreparation)
          throw new Error("preparation unavailable");
        await current(true);
        await configured.verifyStart(record.plan);
        await configured.verifyPreparation(record.plan, command.facts);
        await current(true);
        const mutation = await configured.preparations.bindAndStart({
          identity: record.plan.identity,
          expectedSequence: 1,
          facts: command.facts,
          authority,
          now: this.#options.clock.now(),
        });
        return { ...mutation, record: wire(mutation.record), resolvedScope: null, output: null };
      }
      if (record.phase === "reserved") {
        if (command.kind !== "read" && command.kind !== "inspect")
          throw new Error("runtime not bound");
        await current(false);
        return { record, applied: false, resolvedScope: null, output: null };
      }
      if (command.kind === "start") {
        await current(true);
        await configured.verifyStart(record.plan);
        await current(true);
        const mutation = await configured.journal.start({
          identity: record.plan.identity,
          expectedSequence: command.expectedSequence,
          policyDigest: command.policyDigest,
          authority,
          now: this.#options.clock.now(),
        });
        return { ...mutation, record: wire(mutation.record), resolvedScope: null, output: null };
      }
      if (command.kind === "observe_control") {
        if (!configured.observeControl || !bound)
          throw new Error("control observation unavailable");
        await current(false);
        const resource = await configured.observeControl(bound);
        command = {
          kind: "append",
          expectedSequence: command.expectedSequence,
          expectedOperationRevision: record.operationRevision,
          facts: { ...record.facts, resource },
        };
      }
      if (command.kind === "append" || command.kind === "operation") {
        const now = this.#options.clock.now();
        const verification = configured.evidence
          ? await configured.evidence.verify({ plan: record.plan, facts: command.facts, now })
          : null;
        await current(false);
        // This endpoint records observations only. It never grants disclosure,
        // continuation or a new operation, even when evidence verifies cleanup.
        const input = {
          identity: record.plan.identity,
          expectedSequence: command.expectedSequence,
          expectedOperationRevision: command.expectedOperationRevision,
          facts: command.facts,
          authority,
          now: this.#options.clock.now(),
          context: {
            now: this.#options.clock.now(),
            environment: record.facts.environment,
            operationContract: record.plan.operationContract,
            verification,
            currentResourceSequence: command.facts.resource.sequence,
            runState: "terminated" as const,
            currentAuthority: false,
            currentFence: false,
            userDisclosureAllowed: false,
            modelDisclosureAllowed: false,
            conflictingWorkspaceRisk: true,
            pendingApprovalOrReconciliation: true,
            resultAlreadyDelivered: false,
          },
        };
        const mutation =
          command.kind === "append"
            ? await configured.journal.append(input)
            : await configured.journal.recordOperation(input);
        return { ...mutation, record: wire(mutation.record), resolvedScope: null, output: null };
      }
      if (command.kind === "output") {
        if (!bound || !configured.readOutput) throw new Error("output reader unavailable");
        await current(false);
        const output = await configured.readOutput(bound, {
          resourceRef: command.resourceRef,
          cursor: command.cursor,
          limit: command.limit,
        });
        await current(false);
        return { record, applied: false, resolvedScope: null, output };
      }
      if (command.kind === "read" || command.kind === "inspect") {
        await current(false);
        return { record, applied: false, resolvedScope: null, output: null };
      }
      // Resource control requires a real supervisor. A journal row is never a
      // successful stop or a source of invented output cursors.
      throw new Error("resource supervisor unavailable");
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
      | PayloadBrokerSandboxJobRequest
      | PayloadBrokerSandboxExecutionRequest,
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
      | PayloadBrokerSandboxJobRequest
      | PayloadBrokerSandboxExecutionRequest,
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
