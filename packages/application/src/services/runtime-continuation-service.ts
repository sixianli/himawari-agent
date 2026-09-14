import type {
  ClockPort,
  IdGeneratorPort,
  PayloadProtectorPort,
  PayloadStorePort,
  RunPayloadArtifactPort,
  RuntimeContinuationPort,
  RuntimeRequest,
} from "../ports/index.js";

/** Runtime-specific bytes remain opaque; product scope and storage stay in Core. */
interface RuntimeContinuationDependencies {
  readonly artifacts: RunPayloadArtifactPort;
  readonly payloads: Pick<PayloadStorePort, "get">;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly assertActive: (request: RuntimeRequest) => Promise<void>;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

export class RuntimeContinuationService implements RuntimeContinuationPort {
  private readonly dependencies: RuntimeContinuationDependencies;
  constructor(dependencies: RuntimeContinuationDependencies) {
    this.dependencies = dependencies;
  }

  async save(request: RuntimeRequest, value: unknown): Promise<string> {
    await this.dependencies.assertActive(request);
    const ref = this.dependencies.ids.next("runtime-continuation");
    const payload = await this.dependencies.protector.protect({
      ownerId: request.ownerId,
      agentId: request.agentId,
      ref,
      dataClassification: request.dataClassification,
      contentType: "application/json",
      plaintext: new TextEncoder().encode(JSON.stringify({ scope: this.scope(request), value })),
      createdAt: this.dependencies.clock.now(),
    });
    await this.dependencies.assertActive(request);
    const saved = await this.dependencies.artifacts.commit({
      runId: request.runId,
      purpose: "trace",
      operationKey: `runtime-continuation:${ref}`,
      payload,
    });
    return saved.ref;
  }

  async load(request: RuntimeRequest, ref: string): Promise<unknown> {
    await this.dependencies.assertActive(request);
    const artifact = await this.dependencies.artifacts.lookup({
      runId: request.runId,
      purpose: "trace",
      operationKey: `runtime-continuation:${ref}`,
    });
    if (
      !artifact ||
      artifact.payloadRef !== ref ||
      artifact.ownerId !== request.ownerId ||
      artifact.agentId !== request.agentId
    )
      throw new Error("RUNTIME_CONTINUATION_SCOPE_INVALID");
    const payload = await this.dependencies.payloads.get(ref);
    if (
      !payload ||
      payload.contentType !== "application/json" ||
      payload.dataClassification !== request.dataClassification
    )
      throw new Error("RUNTIME_CONTINUATION_PAYLOAD_INVALID");
    const bytes = await this.dependencies.protector.unprotect({
      ownerId: request.ownerId,
      agentId: request.agentId,
      payload,
    });
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
      scope: unknown;
      value: unknown;
    };
    if (canonical(decoded.scope) !== canonical(this.scope(request)))
      throw new Error("RUNTIME_CONTINUATION_CONTEXT_CHANGED");
    await this.dependencies.assertActive(request);
    return decoded.value;
  }

  private scope(request: RuntimeRequest) {
    const { continuationRef: _continuation, executionLease, ...semantic } = request;
    // A fresh consumer/lease may resume; deployment authority and all task inputs may not change.
    return {
      ...semantic,
      authority: {
        deploymentId: executionLease.deploymentId,
        authorityEpoch: executionLease.authorityEpoch,
        fencingToken: executionLease.fencingToken,
      },
    };
  }
}
