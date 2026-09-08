import type {
  CapabilityInvocationRequest,
  PayloadRef,
  SandboxJobIdentity,
  SandboxJobReceipt,
} from "@himawari-agent/application";
import type { CapabilityPayloadBoundary } from "@himawari-agent/platform-node";
import {
  type PayloadBrokerInvocationIdentity,
  PayloadUdsClient,
  type PayloadUdsClientOptions,
} from "@himawari-agent/platform-node";

export interface ProductionPayloadBrokerClientOptions extends PayloadUdsClientOptions {}

export class ProductionPayloadBrokerClient implements CapabilityPayloadBoundary {
  readonly adapterIdentity = "production-payload-broker-client";
  readonly schemaVersion = "payload-broker.v1";
  private readonly options: ProductionPayloadBrokerClientOptions;
  private readonly client: PayloadUdsClient;

  constructor(options: ProductionPayloadBrokerClientOptions) {
    this.options = options;
    this.client = new PayloadUdsClient(options);
  }

  isReady(): boolean {
    return this.client.isReady();
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  disconnect(): void {
    this.client.disconnect();
  }

  async readInput(request: CapabilityInvocationRequest): Promise<Uint8Array> {
    return this.client.readInput(this.identity(request));
  }

  async writeOutput(
    request: CapabilityInvocationRequest,
    plaintext: Uint8Array,
    contentType: string,
  ): Promise<PayloadRef> {
    const receipt = await this.client.writeOutput(this.identity(request), plaintext, contentType);
    return receipt.outputRef;
  }

  async readSandboxJob(request: CapabilityInvocationRequest, identity: SandboxJobIdentity) {
    return this.client.sandboxJob(this.identity(request), identity);
  }
  async readSandboxScope(request: CapabilityInvocationRequest, identity: SandboxJobIdentity) {
    const result = await this.client.sandboxJob(this.identity(request), identity, null, true);
    if (!result.resolvedScope) throw new Error("SANDBOX_SCOPE_UNAVAILABLE");
    return result.resolvedScope;
  }
  async appendSandboxJob(request: CapabilityInvocationRequest, observation: SandboxJobReceipt) {
    return this.client.sandboxJob(this.identity(request), observation.identity, observation);
  }

  private identity(request: CapabilityInvocationRequest): PayloadBrokerInvocationIdentity {
    return {
      handleRef: request.capabilityHandleRef,
      invocationId: request.invocationId,
      workerInstanceId: this.options.workerInstanceId,
      workerBootId: this.options.workerBootId,
      authorityEpoch: this.options.authorityEpoch,
      fencingToken: this.options.fencingToken,
    };
  }
}
