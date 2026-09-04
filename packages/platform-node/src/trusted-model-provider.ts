import {
  ApplicationPortError,
  assertMachineSecretFree,
  type ClockPort,
  type ModelDescriptor,
  type ModelInvocationAdmissionResolver,
  type ModelInvocationEvent,
  type ModelInvocationPermit,
  type ModelInvocationPricing,
  type ModelInvocationRequest,
  type ModelInvocationUsage,
  type ModelPort,
  PORT_ERROR_CODES,
  type SecretPort,
} from "@himawari-agent/application";
import type { AgentId, OwnerId } from "@himawari-agent/domain";

export interface SecretMaterialSource {
  resolve(secretRef: string, secretVersion: string): Promise<string>;
}

export interface TrustedModelTransportInput {
  readonly descriptor: ModelDescriptor;
  readonly request: ModelInvocationRequest;
  readonly secretValues: readonly string[];
}

export interface TrustedModelTransport {
  invoke(input: TrustedModelTransportInput): AsyncIterable<ModelInvocationEvent>;
}

export interface TrustedModelProviderAdapterDependencies {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly descriptors: readonly ModelDescriptor[];
  readonly handles: SecretPort;
  readonly secretSource: SecretMaterialSource;
  readonly transport: TrustedModelTransport;
  readonly clock: ClockPort;
  /** Resolves a gate already bound to the current Run execution lease. */
  readonly admission?: ModelInvocationAdmissionResolver;
  /** Supplies frozen descriptor pricing and a conservative reservation estimate. */
  readonly admissionCost: (descriptor: ModelDescriptor) => {
    readonly pricing: ModelInvocationPricing;
    readonly estimatedCostMicros: number;
  };
}

export interface SecretResolutionRecord {
  readonly modelRef: string;
  readonly secretRef: string;
  readonly secretVersion: string;
  readonly purpose: string;
}

function modelUsage(
  event: Extract<ModelInvocationEvent, { readonly type: "model.completed" }>,
): ModelInvocationUsage | undefined {
  const inputTokens = event.inputTokens;
  const outputTokens = event.outputTokens;
  const cacheReadTokens = event.cacheReadTokens;
  const cacheWriteTokens = event.cacheWriteTokens;
  if (cacheReadTokens === undefined || cacheWriteTokens === undefined) return undefined;
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0 ||
    !Number.isSafeInteger(cacheReadTokens) ||
    cacheReadTokens < 0 ||
    !Number.isSafeInteger(cacheWriteTokens) ||
    cacheWriteTokens < 0 ||
    cacheReadTokens > inputTokens ||
    cacheWriteTokens > inputTokens - cacheReadTokens
  ) {
    return undefined;
  }
  return Object.freeze({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });
}

export class TrustedModelProviderAdapter implements ModelPort {
  private readonly dependencies: TrustedModelProviderAdapterDependencies;
  private readonly records: SecretResolutionRecord[] = [];

  constructor(dependencies: TrustedModelProviderAdapterDependencies) {
    this.dependencies = dependencies;
  }

  async listAvailable(): Promise<readonly ModelDescriptor[]> {
    return structuredClone(this.dependencies.descriptors);
  }

  async *invoke(request: ModelInvocationRequest): AsyncIterable<ModelInvocationEvent> {
    assertMachineSecretFree(JSON.stringify(request));
    const descriptor = this.dependencies.descriptors.find(({ ref }) => ref === request.modelRef);
    if (!descriptor) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Model ${request.modelRef} not found`,
        { modelRef: request.modelRef },
      );
    }

    const gate = await this.dependencies.admission?.({
      ownerId: this.dependencies.ownerId,
      agentId: this.dependencies.agentId,
      runId: request.runId,
    });
    if (
      !gate ||
      gate.context.ownerId !== this.dependencies.ownerId ||
      gate.context.agentId !== this.dependencies.agentId ||
      gate.context.runId !== request.runId
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Model invocation admission is unavailable",
        { invocationId: request.invocationId, modelRef: request.modelRef },
      );
    }

    const admissionCost = this.dependencies.admissionCost(descriptor);
    let permit: ModelInvocationPermit | undefined;
    let started = false;
    let releaseAttempted = false;
    let reservationReleased = false;
    const releaseBeforeStart = async (): Promise<boolean> => {
      if (started || permit === undefined) return true;
      if (releaseAttempted) return reservationReleased;
      releaseAttempted = true;
      try {
        await permit.releaseReserved();
        reservationReleased = true;
      } catch {
        // A rejected release can mean markStarted crossed the durable boundary.
        // Preserve that uncertainty rather than presenting the reservation as
        // safely cancelled.
        await permit.markUnknown("transport_unresolved").catch(() => undefined);
      }
      return reservationReleased;
    };
    let secretValues: readonly string[];
    try {
      permit = await gate.begin({
        modelRef: descriptor.ref,
        provider: descriptor.provider,
        model: descriptor.model,
        modelVersion: descriptor.version,
        dataClassification: request.dataClassification,
        operationKey: request.invocationId,
        source: "model-port",
        ordinal: 1,
        estimatedCostMicros: admissionCost.estimatedCostMicros,
        pricing: admissionCost.pricing,
      });
      await permit.assertActive();
      secretValues = await this.resolveSecrets(descriptor, request);
      await permit.assertActive();
      await permit.markStarted();
      started = true;
    } catch (error) {
      if (!(await releaseBeforeStart())) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "Model invocation reservation accounting failed",
          { invocationId: request.invocationId, modelRef: request.modelRef },
        );
      }
      throw error;
    }
    const activePermit = permit;
    if (activePermit === undefined) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Model invocation admission returned no permit",
        { invocationId: request.invocationId, modelRef: request.modelRef },
      );
    }
    let settled = false;
    const markUnknown = async (
      reasonCode: "provider_unresolved" | "transport_unresolved" | "cancel_unresolved",
    ): Promise<void> => {
      if (settled) return;
      await activePermit.markUnknown(reasonCode);
      settled = true;
    };
    try {
      for await (const event of this.dependencies.transport.invoke({
        descriptor,
        request,
        secretValues,
      })) {
        if (event.invocationId !== request.invocationId) {
          await markUnknown("provider_unresolved");
          throw new ApplicationPortError(
            PORT_ERROR_CODES.INVALID_OPERATION,
            "Trusted model transport returned a mismatched invocation",
            { invocationId: request.invocationId, modelRef: request.modelRef },
          );
        }
        if (event.type === "model.completed") {
          const usage = modelUsage(event);
          if (usage === undefined) {
            await markUnknown("provider_unresolved");
            yield Object.freeze({
              type: "model.failed" as const,
              invocationId: request.invocationId,
              errorCode: "MODEL_PROVIDER_USAGE_UNAVAILABLE",
              retryable: false,
              latencyMs: event.latencyMs,
              occurredAt: event.occurredAt,
            });
            break;
          } else {
            try {
              await activePermit.settle(usage);
            } catch {
              await markUnknown("transport_unresolved").catch(() => undefined);
              throw new ApplicationPortError(
                PORT_ERROR_CODES.INVALID_OPERATION,
                "Model budget settlement failed",
                { invocationId: request.invocationId, modelRef: request.modelRef },
              );
            }
            settled = true;
          }
        } else if (event.type === "model.failed") {
          await markUnknown("provider_unresolved");
        }
        yield Object.freeze({ ...event, invocationId: request.invocationId });
        if (event.type === "model.completed" || event.type === "model.failed") break;
      }
    } catch (error) {
      await markUnknown("transport_unresolved").catch(() => undefined);
      if (error instanceof ApplicationPortError) throw error;
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Trusted model transport failed",
        { invocationId: request.invocationId, modelRef: request.modelRef },
      );
    } finally {
      await markUnknown("transport_unresolved").catch(() => undefined);
    }
  }

  resolutionLog(): readonly SecretResolutionRecord[] {
    return structuredClone(this.records);
  }

  private async resolveSecrets(
    descriptor: ModelDescriptor,
    request: ModelInvocationRequest,
  ): Promise<readonly string[]> {
    const requirement = descriptor.secretRequirement;
    if (!requirement) {
      if (request.secretHandleRefs.length > 0) {
        throw this.invalidHandle(request, "Model invocation supplied an undeclared secret handle");
      }
      return Object.freeze([]);
    }
    if (request.secretHandleRefs.length !== 1) {
      throw this.invalidHandle(request, "Model invocation requires exactly one secret handle");
    }

    const handleRef = request.secretHandleRefs[0];
    if (!handleRef) {
      throw this.invalidHandle(request, "Model invocation requires a secret handle");
    }
    const handle = await this.dependencies.handles.inspectHandle(handleRef);
    if (
      !handle ||
      handle.runId !== request.runId ||
      handle.scopeRef !== request.invocationId ||
      handle.secretRef !== requirement.secretRef ||
      handle.secretVersion !== requirement.secretVersion ||
      handle.purpose !== requirement.purpose ||
      handle.revokedAt !== null ||
      this.dependencies.clock.now() >= handle.expiresAt
    ) {
      throw this.invalidHandle(request, "Model invocation secret handle is invalid or expired");
    }

    this.records.push(
      Object.freeze({
        modelRef: descriptor.ref,
        secretRef: requirement.secretRef,
        secretVersion: requirement.secretVersion,
        purpose: requirement.purpose,
      }),
    );
    let secretValue: string;
    try {
      secretValue = await this.dependencies.secretSource.resolve(
        requirement.secretRef,
        requirement.secretVersion,
      );
    } catch {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        "Required model credential could not be resolved",
        {
          modelRef: descriptor.ref,
          secretRef: requirement.secretRef,
          secretVersion: requirement.secretVersion,
        },
      );
    }
    return Object.freeze([secretValue]);
  }

  private invalidHandle(request: ModelInvocationRequest, message: string): ApplicationPortError {
    return new ApplicationPortError(PORT_ERROR_CODES.HANDLE_REVOKED, message, {
      invocationId: request.invocationId,
      modelRef: request.modelRef,
    });
  }
}
