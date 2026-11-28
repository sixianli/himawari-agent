export interface BenchmarkTurn {
  readonly speaker: "owner" | "other";
  readonly text: string;
  readonly at: string;
  readonly sessionId: string;
}

export interface BenchmarkQuestion {
  readonly id: string;
  readonly category: string;
  readonly question: string;
  readonly answer: string;
  readonly askedAt: string;
  readonly abstention: boolean;
  readonly evidenceSessionIds: readonly string[];
  readonly evidenceTexts: readonly string[];
}

export interface BenchmarkStore {
  readonly id: string;
  readonly ownerName: string | null;
  readonly turns: readonly BenchmarkTurn[];
}

export interface BenchmarkSample {
  readonly id: string;
  readonly benchmark: "locomo" | "longmemeval";
  readonly stores: readonly BenchmarkStore[];
  readonly transcript: string;
  readonly questions: readonly BenchmarkQuestion[];
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

export function parseLocomoDate(value: string): string {
  const match = /^(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/iu.exec(
    value.trim(),
  );
  if (!match) throw new Error(`BENCH_LOCOMO_DATE_INVALID ${value}`);
  const [, hour, minute, half, day, monthName, year] = match;
  const month = MONTHS.indexOf(String(monthName).toLowerCase());
  if (month < 0) throw new Error(`BENCH_LOCOMO_DATE_INVALID ${value}`);
  const hours = (Number(hour) % 12) + (String(half).toLowerCase() === "pm" ? 12 : 0);
  return new Date(Date.UTC(Number(year), month, Number(day), hours, Number(minute))).toISOString();
}

export function parseLongMemEvalDate(value: string): string {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})\s*\([A-Za-z]{3}\)\s*(\d{2}):(\d{2})$/u.exec(
    value.trim(),
  );
  if (!match) throw new Error(`BENCH_LONGMEMEVAL_DATE_INVALID ${value}`);
  const [, year, month, day, hour, minute] = match;
  return new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)),
  ).toISOString();
}

function secondsLater(at: string, seconds: number): string {
  return new Date(Date.parse(at) + seconds * 1000).toISOString();
}

interface LocomoTurn {
  readonly speaker: string;
  readonly dia_id?: string;
  readonly text?: string;
  readonly blip_caption?: string;
  readonly query?: string;
}

interface LocomoConversation {
  readonly sample_id: string;
  readonly conversation: Record<string, unknown> & {
    readonly speaker_a: string;
    readonly speaker_b: string;
  };
  readonly qa: readonly {
    readonly question: string;
    readonly answer?: string | number;
    readonly evidence?: readonly string[];
    readonly category: number;
  }[];
}

export const LOCOMO_CATEGORIES: Readonly<Record<number, string>> = Object.freeze({
  1: "multi-hop",
  2: "temporal",
  3: "open-domain",
  4: "single-hop",
});

function locomoText(turn: LocomoTurn): string {
  const text = turn.text ?? "";
  const photo =
    turn.query && turn.blip_caption
      ? `[Sharing image - query: ${turn.query}. The image shows: ${turn.blip_caption}]`
      : turn.query
        ? `[Sharing image - query for: ${turn.query}]`
        : turn.blip_caption
          ? `[Sharing image that shows: ${turn.blip_caption}]`
          : "";
  return [text, photo].filter((part) => part.length > 0).join(" ");
}

export function locomoSamples(raw: readonly LocomoConversation[]): BenchmarkSample[] {
  return raw.map((entry) => {
    const conversation = entry.conversation;
    const sessions = Object.keys(conversation)
      .flatMap((key) => {
        const match = /^session_(\d+)$/u.exec(key);
        return match ? [Number(match[1])] : [];
      })
      .sort((left, right) => left - right);
    const timeline: { speaker: string; text: string; at: string; sessionId: string }[] = [];
    const saidIn = new Map<string, string>();
    for (const number of sessions) {
      const turns = conversation[`session_${number}`] as readonly LocomoTurn[];
      const start = parseLocomoDate(String(conversation[`session_${number}_date_time`]));
      turns.forEach((turn, index) => {
        const text = locomoText(turn);
        if (turn.dia_id && text.length > 0) saidIn.set(turn.dia_id, text);
        if (text.length > 0)
          timeline.push({
            speaker: turn.speaker,
            text,
            at: secondsLater(start, index * 30),
            sessionId: `D${number}`,
          });
      });
    }
    const storeFor = (name: string): BenchmarkStore => ({
      id: `${entry.sample_id}:${name}`,
      ownerName: name,
      turns: timeline.map(({ speaker, text, at, sessionId }) => ({
        speaker: speaker === name ? "owner" : "other",
        text: speaker === name ? text : `${speaker}: ${text}`,
        at,
        sessionId,
      })),
    });
    const last = timeline.at(-1)?.at ?? new Date(0).toISOString();
    return {
      id: entry.sample_id,
      benchmark: "locomo",
      stores: [storeFor(conversation.speaker_a), storeFor(conversation.speaker_b)],
      transcript: timeline
        .map(
          ({ speaker, text, at }) => `[${at.slice(0, 16).replace("T", " ")}] ${speaker}: ${text}`,
        )
        .join("\n"),
      questions: entry.qa.flatMap((qa, index) => {
        const category = LOCOMO_CATEGORIES[qa.category];
        if (!category || qa.answer === undefined) return [];
        return [
          {
            id: `${entry.sample_id}:q${index}`,
            category,
            question: qa.question,
            answer: String(qa.answer),
            askedAt: last,
            abstention: false,
            evidenceSessionIds: [
              ...new Set(
                (qa.evidence ?? []).flatMap((evidence) => {
                  const match = /^D(\d+):/u.exec(evidence);
                  return match ? [`D${match[1]}`] : [];
                }),
              ),
            ],
            evidenceTexts: (qa.evidence ?? []).flatMap((evidence) => {
              const said = saidIn.get(evidence);
              return said ? [said] : [];
            }),
          },
        ];
      }),
    };
  });
}

interface LongMemEvalQuestion {
  readonly question_id: string;
  readonly question_type: string;
  readonly question: string;
  readonly answer: string | number;
  readonly question_date: string;
  readonly haystack_dates: readonly string[];
  readonly haystack_session_ids: readonly string[];
  readonly haystack_sessions: readonly (readonly {
    readonly role: "user" | "assistant";
    readonly content: string;
  }[])[];
  readonly answer_session_ids: readonly string[];
}

export function longMemEvalSamples(raw: readonly LongMemEvalQuestion[]): BenchmarkSample[] {
  return raw.map((entry) => {
    const sessions = entry.haystack_sessions
      .map((turns, index) => ({
        turns,
        id: String(entry.haystack_session_ids[index]),
        at: parseLongMemEvalDate(String(entry.haystack_dates[index])),
      }))
      .sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
    const turns: BenchmarkTurn[] = sessions.flatMap(({ turns: session, id, at }) =>
      session.map((turn, index) => ({
        speaker: turn.role === "user" ? ("owner" as const) : ("other" as const),
        text: turn.content,
        at: secondsLater(at, index * 30),
        sessionId: id,
      })),
    );
    return {
      id: entry.question_id,
      benchmark: "longmemeval",
      stores: [{ id: entry.question_id, ownerName: null, turns }],
      transcript: sessions
        .map(
          ({ id, at, turns: session }) =>
            `### Session ${id} (${at.slice(0, 16).replace("T", " ")})\n${session
              .map(({ role, content }) => `${role}: ${content}`)
              .join("\n")}`,
        )
        .join("\n\n"),
      questions: [
        {
          id: entry.question_id,
          category: entry.question_type,
          question: entry.question,
          answer: String(entry.answer),
          askedAt: parseLongMemEvalDate(entry.question_date),
          abstention: entry.question_id.endsWith("_abs"),
          evidenceSessionIds: entry.answer_session_ids.map(String),
          evidenceTexts: [],
        },
      ],
    };
  });
}

export function stratifiedLongMemEval<T extends { readonly question_type: string }>(
  raw: readonly T[],
  perType: number,
): T[] {
  const byType = new Map<string, T[]>();
  for (const entry of raw)
    byType.set(entry.question_type, [...(byType.get(entry.question_type) ?? []), entry]);
  return [...byType.keys()].sort().flatMap((type) => {
    const entries = byType.get(type) ?? [];
    const step = entries.length / Math.min(perType, entries.length);
    return Array.from(
      { length: Math.min(perType, entries.length) },
      (_, index) => entries[Math.floor(index * step)] as T,
    );
  });
}

export function longMemEvalJudgePrompt(question: BenchmarkQuestion, response: string): string {
  if (question.abstention)
    return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question.question}\n\nExplanation: ${question.answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  const head =
    "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.";
  const body = `\n\nQuestion: ${question.question}\n\nCorrect Answer: ${question.answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  switch (question.category) {
    case "temporal-reasoning":
      return `${head} In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. ${body}`;
    case "knowledge-update":
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.${body}`;
    case "single-session-preference":
      return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question.question}\n\nRubric: ${question.answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    default:
      return `${head} ${body}`;
  }
}

export function locomoJudgePrompt(question: BenchmarkQuestion, response: string): string {
  return `Label the generated answer as CORRECT or WRONG.

## Rules
1. **PARTIAL CREDIT**: If the generated answer includes AT LEAST ONE correct item from the gold answer's list, mark CORRECT. Getting 1 out of 2, 2 out of 4, etc. is always acceptable. Only mark WRONG if NONE of the gold answer items appear.
2. **PARAPHRASES COUNT**: Same concept in different words is CORRECT. "Chocolate raspberry tart" = "chocolate cake with raspberries". "Shelter meal service" = "volunteering at a homeless shelter". Emotions and sentiments in the same positive/negative family count as paraphrases: "proud" = "fulfilled" = "accomplished"; "huge success" = "relieved" = "thrilled" (all express positive achievement). Judge semantic meaning, not exact wording.
3. **EXTRA DETAIL IS FINE**: A longer answer that includes the gold answer's key facts plus additional information is CORRECT. Never penalize for being more detailed or specific. If the generated answer adds extra descriptive details beyond the gold answer while still referencing the same core entity or concept, mark CORRECT.
4. **DATE TOLERANCE**: Dates within 14 days of each other are CORRECT. Durations within 50% are CORRECT (e.g., "5 months" matches "six months"; "19 days" matches "two weeks"). Relative dates ("few days before November") match specific dates in the same window. A specific date (e.g., "February 2020") that is consistent with a vague reference (e.g., "a few years ago" relative to 2023) is CORRECT. Converting "last year" to the actual year (e.g., "2022" when conversations are in 2023) is CORRECT.

5. **SEMANTIC OVERLAP**: Judge whether the generated answer addresses the same topic and captures the core idea of the gold answer. Different wording, phrasing, or level of detail should not result in WRONG if the underlying concept matches. For EMOTIONS and FEELINGS questions, answers expressing sentiments in the same valence (positive/negative) about the same event are CORRECT — do not require the exact same emotion word.
6. **SAME REFERENT**: If the generated answer mentions or references the same named entity, character, person, or concept as the gold answer, mark CORRECT — even if the generated answer provides a different physical description or includes additional details. The key question is: does the generated answer identify the same core entity? If yes, it is CORRECT.
7. **FOCUS ON KNOWLEDGE, NOT WORDING**: The goal is to assess whether the system recalled the right fact. Minor differences in specificity, phrasing, or scope should not result in WRONG. Only mark WRONG when the generated answer demonstrates a genuinely different or incorrect understanding.

## ONLY mark WRONG if:
- The generated answer contains ZERO correct items from the gold answer
- The answer addresses a completely different topic

## Question
Question: ${question.question}
Gold answer: ${question.answer}
Generated answer: ${response}

Return JSON with "reasoning" (one sentence) and "label" (CORRECT or WRONG). Do NOT include both labels.`;
}

export function judgePrompt(
  benchmark: BenchmarkSample["benchmark"],
  question: BenchmarkQuestion,
  response: string,
): string {
  return benchmark === "locomo"
    ? locomoJudgePrompt(question, response)
    : longMemEvalJudgePrompt(question, response);
}

export function parseJudgeVerdict(
  benchmark: BenchmarkSample["benchmark"],
  output: string,
): boolean | null {
  if (benchmark === "locomo") {
    const label = /"label"\s*:\s*"(CORRECT|WRONG)"/iu.exec(output)?.[1];
    if (label) return label.toUpperCase() === "CORRECT";
    const correct = /\bCORRECT\b/u.test(output);
    const wrong = /\bWRONG\b/u.test(output);
    return correct === wrong ? null : correct;
  }
  const answer = /\b(yes|no)\b/iu.exec(output.trim())?.[1];
  return answer ? answer.toLowerCase() === "yes" : null;
}

export interface QuestionOutcome {
  readonly sampleId: string;
  readonly questionId: string;
  readonly category: string;
  readonly arm: "memory" | "memory-conversation" | "memory-auto-turns" | "full-context";
  readonly correct: boolean | null;
  readonly response: string;
  readonly contextTokens: number;
  readonly answerMs: number;
  readonly evidenceRecalled: boolean | null;
  readonly evidenceStored: boolean | null;
  readonly evidenceLinesRecalled?: boolean | null;
  readonly toolCalls?: number;
  readonly recalledTurns?: boolean;
}

export interface ArmMetrics {
  readonly questions: number;
  readonly judged: number;
  readonly accuracy: number | null;
  readonly byCategory: Readonly<Record<string, { questions: number; accuracy: number | null }>>;
  readonly evidenceRecall: number | null;
  readonly evidenceStored: number | null;
  readonly evidenceLineRecall: number | null;
  readonly meanContextTokens: number | null;
  readonly medianAnswerMs: number | null;
}

function share(values: readonly boolean[]): number | null {
  return values.length === 0 ? null : values.filter(Boolean).length / values.length;
}

export function armMetrics(outcomes: readonly QuestionOutcome[]): ArmMetrics {
  const judged = outcomes.flatMap(({ correct }) => (correct === null ? [] : [correct]));
  const categories = [...new Set(outcomes.map(({ category }) => category))].sort();
  const times = outcomes.map(({ answerMs }) => answerMs).sort((left, right) => left - right);
  return {
    questions: outcomes.length,
    judged: judged.length,
    accuracy: share(judged),
    byCategory: Object.fromEntries(
      categories.map((category) => {
        const inCategory = outcomes.filter((outcome) => outcome.category === category);
        return [
          category,
          {
            questions: inCategory.length,
            accuracy: share(
              inCategory.flatMap(({ correct }) => (correct === null ? [] : [correct])),
            ),
          },
        ];
      }),
    ),
    evidenceRecall: share(
      outcomes.flatMap(({ evidenceRecalled }) =>
        evidenceRecalled === null ? [] : [evidenceRecalled],
      ),
    ),
    evidenceStored: share(
      outcomes.flatMap(({ evidenceStored }) => (evidenceStored === null ? [] : [evidenceStored])),
    ),
    evidenceLineRecall: share(
      outcomes.flatMap(({ evidenceLinesRecalled }) =>
        evidenceLinesRecalled === undefined || evidenceLinesRecalled === null
          ? []
          : [evidenceLinesRecalled],
      ),
    ),
    meanContextTokens:
      outcomes.length === 0
        ? null
        : outcomes.reduce((sum, { contextTokens }) => sum + contextTokens, 0) / outcomes.length,
    medianAnswerMs: times.length === 0 ? null : (times[Math.floor(times.length / 2)] ?? null),
  };
}
