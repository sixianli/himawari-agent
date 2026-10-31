import { PAYLOAD_UDS_ERROR_CODES } from "@himawari-agent/platform-node";

export const BROKER_POLL_GRACE_MS = 10_000;

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  PAYLOAD_UDS_ERROR_CODES.TRANSPORT_UNAVAILABLE,
  PAYLOAD_UDS_ERROR_CODES.DEADLINE_EXCEEDED,
]);

export function isTransientBrokerFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    TRANSIENT_CODES.has(error.code)
  );
}

export class BrokerPollTolerance {
  private firstFailureAt: number | null = null;
  private readonly now: () => number;
  private readonly graceMs: number;

  constructor(now: () => number = Date.now, graceMs: number = BROKER_POLL_GRACE_MS) {
    this.now = now;
    this.graceMs = graceMs;
  }

  succeeded(): void {
    this.firstFailureAt = null;
  }

  failed(error: unknown): "retry_first" | "retry" | "cancel" {
    if (!isTransientBrokerFailure(error)) return "cancel";
    const at = this.now();
    if (this.firstFailureAt === null) {
      this.firstFailureAt = at;
      return "retry_first";
    }
    return at - this.firstFailureAt >= this.graceMs ? "cancel" : "retry";
  }
}
