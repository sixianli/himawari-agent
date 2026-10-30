const CLASSIFICATION_RANK = { public: 0, private: 1, sensitive: 2, restricted: 3 };

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "");
}

function containsAll(text, groups) {
  const haystack = normalize(text);
  return groups.every((alternatives) =>
    alternatives.some((needle) => haystack.includes(normalize(needle))),
  );
}

function matchExpected(expected, candidates) {
  return candidates.find((candidate) => containsAll(candidate.text, expected.keyFacts)) ?? null;
}

function fieldChecks(expected, candidate) {
  const rankExpected = CLASSIFICATION_RANK[expected.classification] ?? 1;
  const rankActual = CLASSIFICATION_RANK[candidate.classification] ?? 1;
  return {
    decision: candidate.decision === expected.decision,
    classification: candidate.classification === expected.classification,
    sensitiveDowngrade: rankExpected >= 2 && rankActual < rankExpected,
    dueAt:
      expected.dueAtPrefix === null || expected.dueAtPrefix === undefined
        ? null
        : typeof candidate.dueAt === "string" && candidate.dueAt.startsWith(expected.dueAtPrefix),
  };
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

export function scoreItem(item, candidates) {
  if (!item.expect.remember) {
    const forbidden = item.expect.forbiddenText ?? [];
    const leaked = candidates.some((candidate) =>
      forbidden.some((secret) => normalize(candidate.text).includes(normalize(secret))),
    );
    return {
      id: item.id,
      group: item.group,
      kind: "negative",
      falseMemory: candidates.length > 0,
      leaked,
    };
  }
  const matches = item.expect.memories.map((expected) => {
    const candidate = matchExpected(expected, candidates);
    return {
      expected,
      candidate,
      fields: candidate === null ? null : fieldChecks(expected, candidate),
    };
  });
  return {
    id: item.id,
    group: item.group,
    kind: "positive",
    allMatched: matches.every(({ candidate }) => candidate !== null),
    expectedCount: matches.length,
    matchedCount: matches.filter(({ candidate }) => candidate !== null).length,
    extraCandidates: Math.max(
      0,
      candidates.length - matches.filter(({ candidate }) => candidate !== null).length,
    ),
    matches,
  };
}

export function scoreRun(dataset, results) {
  const byId = new Map(results.map((result) => [result.id, result.candidates ?? []]));
  const scored = dataset.items.map((item) => scoreItem(item, byId.get(item.id) ?? []));
  const positives = scored.filter(({ kind }) => kind === "positive");
  const negatives = scored.filter(({ kind }) => kind === "negative");
  const matched = positives.flatMap(({ matches }) =>
    matches.filter(({ candidate }) => candidate !== null),
  );
  const dueExpected = matched.filter(({ fields }) => fields.dueAt !== null);
  const embedded = positives.filter(({ group }) => group === "embedded");
  return {
    items: scored,
    positives: positives.length,
    negatives: negatives.length,
    recall: ratio(positives.filter(({ allMatched }) => allMatched).length, positives.length),
    memoryRecall: ratio(
      positives.reduce((sum, { matchedCount }) => sum + matchedCount, 0),
      positives.reduce((sum, { expectedCount }) => sum + expectedCount, 0),
    ),
    embeddedRecall: ratio(embedded.filter(({ allMatched }) => allMatched).length, embedded.length),
    falseMemoryRate: ratio(
      negatives.filter(({ falseMemory }) => falseMemory).length,
      negatives.length,
    ),
    secretLeaks: negatives.filter(({ leaked }) => leaked).length,
    sensitiveDowngrades: matched.filter(({ fields }) => fields.sensitiveDowngrade).length,
    decisionAccuracy: ratio(matched.filter(({ fields }) => fields.decision).length, matched.length),
    classificationAccuracy: ratio(
      matched.filter(({ fields }) => fields.classification).length,
      matched.length,
    ),
    dueAtAccuracy: ratio(
      dueExpected.filter(({ fields }) => fields.dueAt === true).length,
      dueExpected.length,
    ),
    extraCandidates: positives.reduce((sum, { extraCandidates }) => sum + extraCandidates, 0),
  };
}

export function scoreStable(dataset, runs) {
  const perRun = runs.map((results) => scoreRun(dataset, results));
  const ids = dataset.items.map(({ id }) => id);
  const correct = (run, id) => {
    const item = run.items.find((entry) => entry.id === id);
    return item.kind === "positive" ? item.allMatched : !item.falseMemory;
  };
  const stable = ids.filter((id) => perRun.every((run) => correct(run, id))).length;
  return { runs: perRun, passAll: ratio(stable, ids.length) };
}

export function validateDataset(dataset) {
  const errors = [];
  const ids = new Set();
  for (const item of dataset.items) {
    if (ids.has(item.id)) errors.push(`${item.id}: duplicate id`);
    ids.add(item.id);
    if (typeof item.message !== "string" || item.message.length === 0)
      errors.push(`${item.id}: empty message`);
    if (item.expect.remember && item.expect.memories.length === 0)
      errors.push(`${item.id}: positive without memories`);
    if (!item.expect.remember && item.expect.memories.length !== 0)
      errors.push(`${item.id}: negative with memories`);
    const existingIds = new Set(item.existingMemories.map(({ id }) => id));
    for (const expected of item.expect.memories) {
      if (!Array.isArray(expected.keyFacts) || expected.keyFacts.length === 0)
        errors.push(`${item.id}: no keyFacts`);
      if (!["create", "update", "supersede", "unchanged"].includes(expected.decision))
        errors.push(`${item.id}: bad decision`);
      if (expected.decision !== "create" && !existingIds.has(expected.existingMemoryId))
        errors.push(
          `${item.id}: ${expected.decision} points at a memory that is not in existingMemories`,
        );
    }
    for (const secret of item.expect.forbiddenText ?? [])
      if (!normalize(item.message).includes(normalize(secret)))
        errors.push(`${item.id}: forbidden text not in message`);
  }
  return errors;
}
