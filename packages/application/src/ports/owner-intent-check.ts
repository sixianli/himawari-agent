export const OWNER_INTENT_VERDICTS = Object.freeze(["explicit", "not_explicit", "unsure"] as const);
export type OwnerIntentVerdict = (typeof OWNER_INTENT_VERDICTS)[number];

export interface OwnerIntentCheckRequest {
  readonly ownerWords: readonly string[];
  readonly action: {
    readonly tool: string;
    readonly capabilityRef: string;
    readonly operation: string;
    readonly parameters: unknown;
  };
}

export interface OwnerIntentCheckPort {
  check(request: OwnerIntentCheckRequest, signal: AbortSignal): Promise<unknown>;
}

export interface OwnerIntentAnswer {
  readonly verdict: OwnerIntentVerdict;
  readonly confidence: number;
  readonly quote: string | null;
}
