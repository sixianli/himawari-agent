import {
  PORT_ERROR_CODES,
  ApplicationPortError,
  assertMachineSecretFree,
  type ClockPort,
  type ModelDescriptor,
  type ModelInvocationEvent,
  type ModelInvocationRequest,
  type ModelPort,
  type SecretPort,
} from "@himawari-agent/application";

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
  readonly descriptors: readonly ModelDescriptor[];
  readonly handles: SecretPort;
  readonly secretSource: SecretMaterialSource;
  readonly transport: TrustedModelTransport;
  readonly clock: ClockPort;
}

export interface SecretResolutionRecord {
  readonly modelRef: string;
  readonly secretRef: string;
  readonly secretVersion: string;
  readonly purpose: string;
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

    const secretValues = await this.resolveSecrets(descriptor, request);
    try {
      for await (const event of this.dependencies.transport.invoke({
        descriptor,
        request,
        secretValues,
      })) {
        yield Object.freeze({ ...event, invocationId: request.invocationId });
        if (event.type === "model.completed" || event.type === "model.failed") break;
      }
    } catch {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Trusted model transport failed",
        { invocationId: request.invocationId, modelRef: request.modelRef },
      );
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
