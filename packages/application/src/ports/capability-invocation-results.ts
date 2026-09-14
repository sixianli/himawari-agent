import type {
  FrozenCapabilityInvocationReceipt,
  ReadCapabilityInvocationInput,
} from "./capability-invocations.js";
import type { PayloadRecord } from "./observability.js";
import type {
  RunPayloadArtifact,
  RunPayloadArtifactCommitResult,
} from "./run-payload-artifacts.js";

/**
 * A protected output observation is a fact about one already-consumed
 * Capability attempt. It is deliberately separate from Run success state:
 * observing bytes must not transition a Run, checkpoint a Worker result, or
 * publish a successful execution event.
 */
export interface ObserveCapabilityInvocationOutputInput extends ReadCapabilityInvocationInput {
  /** Protected bytes produced by the trusted Agent-side handler. */
  readonly payload: PayloadRecord;
  /** Plaintext length measured before protection for the frozen output limit. */
  readonly plaintextByteLength: number;
}

/**
 * Agent-side durable boundary for output facts belonging to a frozen
 * Capability invocation. Implementations are scoped to the trusted owner and
 * Agent, and must re-check the complete receipt and current authority inside
 * the same transaction that writes the Run-owned artifact.
 */
export interface CapabilityInvocationResultPort {
  /**
   * Returns frozen metadata for protection only. This is not a permission to
   * read input or to publish success; late observations may use it after the
   * invocation's deadline or terminal outcome while the Run still exists.
   */
  lookupFrozen(
    input: ReadCapabilityInvocationInput,
  ): Promise<FrozenCapabilityInvocationReceipt | undefined>;
  /**
   * Atomically validates the receipt/authority and records an observation in
   * the Run-owned artifact store. Existing equivalent observations replay;
   * conflicting bytes or identity fail closed.
   */
  observeOutput(
    input: ObserveCapabilityInvocationOutputInput,
  ): Promise<RunPayloadArtifactCommitResult>;
  /**
   * Reads an existing observation only after validating current authority with
   * the caller's trusted clock and the complete invocation attempt identity.
   */
  lookupOutput(input: ReadCapabilityInvocationInput): Promise<RunPayloadArtifact | undefined>;
}
