export interface RetrievalQuery {
  readonly id: string;
  readonly text: string;
  readonly expected: readonly string[];
  readonly kind: "direct" | "inferential" | "unrelated";
}

export interface RetrievalOutcome {
  readonly query: RetrievalQuery;
  readonly returned: readonly { readonly id: string; readonly score: number }[];
}

export interface RetrievalMetrics {
  readonly relevantQueries: number;
  readonly unrelatedQueries: number;
  readonly hitRate: number;
  readonly directHitRate: number;
  readonly inferentialHitRate: number;
  readonly recall: number;
  readonly precision: number;
  readonly unrelatedLeakRate: number;
  readonly unrelatedMemoriesBrought: number;
}

const ratio = (part: number, whole: number) =>
  whole === 0 ? 0 : Math.round((part / whole) * 1000) / 1000;

export function retrievalMetrics(outcomes: readonly RetrievalOutcome[]): RetrievalMetrics {
  const relevant = outcomes.filter(({ query }) => query.expected.length > 0);
  const unrelated = outcomes.filter(({ query }) => query.expected.length === 0);
  const hit = ({ query, returned }: RetrievalOutcome) =>
    returned.some(({ id }) => query.expected.includes(id));
  const ofKind = (kind: RetrievalQuery["kind"]) =>
    relevant.filter(({ query }) => query.kind === kind);
  const expectedTotal = relevant.reduce((sum, { query }) => sum + query.expected.length, 0);
  const expectedFound = relevant.reduce(
    (sum, { query, returned }) =>
      sum + query.expected.filter((id) => returned.some((item) => item.id === id)).length,
    0,
  );
  const returnedTotal = relevant.reduce((sum, { returned }) => sum + returned.length, 0);
  const returnedCorrect = relevant.reduce(
    (sum, { query, returned }) =>
      sum + returned.filter(({ id }) => query.expected.includes(id)).length,
    0,
  );
  return {
    relevantQueries: relevant.length,
    unrelatedQueries: unrelated.length,
    hitRate: ratio(relevant.filter(hit).length, relevant.length),
    directHitRate: ratio(ofKind("direct").filter(hit).length, ofKind("direct").length),
    inferentialHitRate: ratio(
      ofKind("inferential").filter(hit).length,
      ofKind("inferential").length,
    ),
    recall: ratio(expectedFound, expectedTotal),
    precision: ratio(returnedCorrect, returnedTotal),
    unrelatedLeakRate: ratio(
      unrelated.filter(({ returned }) => returned.length > 0).length,
      unrelated.length,
    ),
    unrelatedMemoriesBrought: unrelated.reduce((sum, { returned }) => sum + returned.length, 0),
  };
}
