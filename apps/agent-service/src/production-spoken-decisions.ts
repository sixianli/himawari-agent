import {
  ApplicationPortError,
  type ClockPort,
  type DecisionLedgerPort,
  PORT_ERROR_CODES,
  type RealEvalRunRecord,
  type ThreadSpokenMessagesPort,
} from "@himawari-agent/application";
import { DEFAULT_MINIMUM_SAMPLES } from "@himawari-agent/calibration";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
import { inboxSummaryRef } from "./production-inbox.js";
import { MEMORY_SAVED_EVENT_KIND } from "./production-memory-inbox.js";

export const PRODUCTION_SPOKEN_DECISION_OPERATIONS = Object.freeze([
  "decision.spoken.read",
  "decision.spoken.rate",
  "decision.stats.read",
] as const);

type SpokenSnapshot = Extract<GatewayV2Snapshot, { type: "decision.spoken.snapshot" }>;
type StatsSnapshot = Extract<GatewayV2Snapshot, { type: "decision.stats.snapshot" }>;
type StatsQuery = Extract<GatewayV2Query, { type: "decision.stats.read" }>;
type Recall = NonNullable<StatsSnapshot["payload"]["recall"]>;

const DAY_MS = 24 * 3_600_000;
const SPAN_DAYS: Readonly<Record<StatsQuery["payload"]["span"], number>> = {
  week: 7,
  four_weeks: 28,
};
const REASON_LIMIT = 1000;
const SUMMARY_LIMIT = 4000;
const RUNS_READ = 20;

function clip(value: string | null, limit: number): string | null {
  if (value === null) return null;
  const text = [...value.trim()].slice(0, limit).join("");
  return text.length > 0 ? text : null;
}

function recallOf(run: RealEvalRunRecord): Recall | null {
  if (run.outcome === "failed") return null;
  const scores = run.summary["scores"] as
    | { readonly fixed?: { readonly successes?: unknown; readonly samples?: unknown } }
    | undefined;
  const correct = scores?.fixed?.successes;
  const asked = scores?.fixed?.samples;
  if (
    typeof correct !== "number" ||
    typeof asked !== "number" ||
    !Number.isSafeInteger(correct) ||
    !Number.isSafeInteger(asked) ||
    asked < 1 ||
    correct < 0 ||
    correct > asked
  )
    return null;
  return { at: run.finishedAt, correct, asked };
}

export function spokenMessagesReader(
  ledger: Pick<DecisionLedgerPort, "spokenMessages">,
): ThreadSpokenMessagesPort {
  return {
    async spoken({ ownerId, agentId, messages }) {
      const candidates = messages.filter((message) => message.role === "agent");
      if (candidates.length === 0) return new Set();
      const since = candidates.reduce(
        (earliest, message) => (message.committedAt < earliest ? message.committedAt : earliest),
        candidates[0]?.committedAt ?? "",
      );
      const found = await ledger.spokenMessages({
        ownerId: ownerId as never,
        agentId: agentId as never,
        messageIds: candidates.map((message) => message.id),
        since,
      });
      return new Set(found);
    },
  };
}

export interface ProductionSpokenDecisionsOptions {
  readonly scope: { readonly ownerId: string; readonly agentId: string };
  readonly ledger: Pick<DecisionLedgerPort, "readSpoken" | "spokenStats" | "rateMany">;
  readonly readText: (ref: string) => Promise<string | null>;
  readonly recallRuns?: (limit: number) => Promise<readonly RealEvalRunRecord[]>;
  readonly minimumSamples?: number;
  readonly clock: ClockPort;
}

export class ProductionSpokenDecisions {
  readonly #options: ProductionSpokenDecisionsOptions;

  constructor(options: ProductionSpokenDecisionsOptions) {
    this.#options = options;
  }

  get #scope() {
    const { ownerId, agentId } = this.#options.scope;
    return { ownerId: ownerId as never, agentId: agentId as never };
  }

  async #text(ref: string | null): Promise<string | null> {
    if (ref === null) return null;
    return this.#options.readText(ref).catch(() => null);
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type === "decision.spoken.read") return this.#spoken(query.payload.messageId, query);
    if (query.type === "decision.stats.read") return this.#stats(query);
    throw new Error("SPOKEN_DECISION_OPERATION_NOT_INSTALLED");
  }

  async #spoken(messageId: string, query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    const records = await this.#options.ledger.readSpoken({ ...this.#scope, messageId });
    if (records.length === 0)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "SPOKEN_DECISION_NOT_FOUND");
    const decisions: SpokenSnapshot["payload"]["decisions"][number][] = [];
    for (const record of records) {
      const summaryRef = inboxSummaryRef(record.subjectRef);
      const startedAt = Date.parse(record.decidedAt) - Math.max(0, record.durationMs);
      decisions.push({
        decisionId: record.id,
        decidedAt: record.decidedAt,
        pushed: record.verdict === "pushed",
        reason: clip(await this.#text(record.reasonRef), REASON_LIMIT),
        cause: {
          kind: record.scenario,
          at: new Date(startedAt).toISOString(),
          summary: clip(await this.#text(summaryRef), SUMMARY_LIMIT),
          memoryId:
            record.scenario === MEMORY_SAVED_EVENT_KIND ? (record.sourceIds[0] ?? null) : null,
        },
      });
    }
    const ratings = new Set(records.map((record) => record.rating));
    const rating =
      ratings.size === 1 && (ratings.has("useful") || ratings.has("unneeded"))
        ? (records[0]?.rating as "useful" | "unneeded")
        : null;
    return {
      ...query,
      kind: "snapshot",
      type: "decision.spoken.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: { messageId, rating, decisions },
    } as GatewayV2Snapshot;
  }

  async #stats(query: StatsQuery): Promise<GatewayV2Snapshot> {
    const now = this.#options.clock.now();
    const span = SPAN_DAYS[query.payload.span] * DAY_MS;
    const end = Date.parse(now);
    const window = async (to: number) => {
      const start = new Date(to - span).toISOString();
      const stop = new Date(to).toISOString();
      const stats = await this.#options.ledger.spokenStats({ ...this.#scope, start, end: stop });
      return { start, end: stop, ...stats };
    };
    const current = await window(end);
    const previous = await window(end - span);
    const runs = this.#options.recallRuns
      ? await this.#options.recallRuns(RUNS_READ).catch(() => [])
      : [];
    const recalls = runs.flatMap((run) => {
      const recall = recallOf(run);
      return recall ? [recall] : [];
    });
    return {
      ...query,
      kind: "snapshot",
      type: "decision.stats.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        span: query.payload.span,
        minimumSamples: this.#options.minimumSamples ?? DEFAULT_MINIMUM_SAMPLES,
        current,
        previous,
        recall: recalls[0] ?? null,
        previousRecall: recalls[1] ?? null,
        generatedAt: now,
      },
    } as GatewayV2Snapshot;
  }

  async execute(command: GatewayV2Command): Promise<{ resultRef: string; replayed: boolean }> {
    const { ownerId, agentId } = this.#options.scope;
    if (
      command.actor.actorType !== "owner" ||
      command.scope.ownerId !== ownerId ||
      command.scope.agentId !== agentId
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "SPOKEN_DECISION_OWNER_REQUIRED",
      );
    if (command.type !== "decision.spoken.rate")
      throw new Error("SPOKEN_DECISION_OPERATION_NOT_INSTALLED");
    const { messageId, rating } = command.payload;
    const records = await this.#options.ledger.readSpoken({ ...this.#scope, messageId });
    if (records.length === 0)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "SPOKEN_DECISION_NOT_FOUND");
    const unchanged = records.every((record) => record.rating === rating);
    if (!unchanged)
      await this.#options.ledger.rateMany({
        ...this.#scope,
        ratings: records.map((record) => ({ decisionId: record.id, rating })),
        now: this.#options.clock.now(),
      });
    return { resultRef: `${messageId}:${rating ?? "none"}`, replayed: unchanged };
  }
}
