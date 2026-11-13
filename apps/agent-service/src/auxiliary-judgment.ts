export interface AuxiliaryJudgmentRequest<Verdict> {
  readonly ask: (attempt: number) => Promise<string>;
  readonly parse: (output: string) => Verdict;
  readonly attempts?: number;
}

const DEFAULT_ATTEMPTS = 2;

export async function judgeWithModel<Verdict>(
  request: AuxiliaryJudgmentRequest<Verdict>,
): Promise<Verdict> {
  const attempts = Math.max(1, request.attempts ?? DEFAULT_ATTEMPTS);
  let failure: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return request.parse(await request.ask(attempt));
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

export async function judgeOrDefault<Verdict>(
  request: AuxiliaryJudgmentRequest<Verdict>,
  fallback: Verdict,
  onFailure?: (error: unknown) => void,
): Promise<Verdict> {
  try {
    return await judgeWithModel(request);
  } catch (error) {
    onFailure?.(error);
    return fallback;
  }
}
