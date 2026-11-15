export interface ThinkWorthRequest {
  readonly sourceKind: string;
  readonly sourceDescription: string;
  readonly summary: string;
  readonly externalContent: boolean;
}

export interface ThinkWorthAnswer {
  readonly worthPermille: number;
}

export interface ThinkWorthPort {
  decide(request: ThinkWorthRequest, signal: AbortSignal): Promise<ThinkWorthAnswer>;
}
