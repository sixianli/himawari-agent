import type {
  ExecutionBackendCapabilities,
  ExecutionEnvelope,
  ExecutionEnvironmentIdentity,
  ExecutionEnvironmentLocator,
  ExecutionEnvironmentStopProof,
} from "@himawari-agent/execution-contracts";

export type {
  ExecutionBackendCapabilities,
  ExecutionEnvelope,
  ExecutionEnvironmentIdentity,
  ExecutionEnvironmentLocator,
  ExecutionEnvironmentStopProof,
} from "@himawari-agent/execution-contracts";

export interface ExecutionBackendEnvironmentRequest {
  readonly identity: ExecutionEnvironmentIdentity;
  readonly createIntentId: string;
  readonly locator: ExecutionEnvironmentLocator | null;
}

export interface ExecutionBackendObservation {
  readonly state: "running" | "stopped" | "not_found" | "unknown";
  readonly locator: ExecutionEnvironmentLocator | null;
  readonly observedAt: string;
}

export interface ExecutionBackendPort {
  capabilities(): Promise<ExecutionBackendCapabilities>;
  create(input: {
    readonly identity: ExecutionEnvironmentIdentity;
    readonly createIntentId: string;
    readonly envelope: ExecutionEnvelope;
    readonly policyDigest: string;
    readonly imageDigest: string;
    readonly runnerDigest: string;
    readonly deadlineAt: string;
  }): Promise<ExecutionEnvironmentLocator>;
  execute(
    input: ExecutionBackendEnvironmentRequest & {
      readonly stopFence: number;
      readonly invocationId: string;
      readonly argumentsRef: string;
      readonly deadlineAt: string;
      readonly credential?: { readonly secretRef: string; readonly approvalRef: string };
    },
  ): Promise<{ readonly outputRef: string; readonly observedAt: string }>;
  inspect(input: ExecutionBackendEnvironmentRequest): Promise<ExecutionBackendObservation>;
  stop(
    input: ExecutionBackendEnvironmentRequest & {
      readonly stopIntentId: string;
      readonly stopFence: number;
    },
  ): Promise<{ readonly accepted: true }>;
  verifyStopped(
    input: ExecutionBackendEnvironmentRequest & {
      readonly stopIntentId: string;
      readonly stopFence: number;
    },
  ): Promise<ExecutionEnvironmentStopProof>;
  destroy(input: ExecutionBackendEnvironmentRequest): Promise<void>;
}
