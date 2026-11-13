import { readFileSync } from "node:fs";
import {
  ApplicationPortError,
  type CorrectionAgreementCounts,
  type DecisionLedgerPort,
  daysDue,
  dayWindow,
  type EarlierDayCounts,
  earliestStartDay,
  evaluateObservationDay,
  type GapCaseMarkPort,
  jstToday,
  type LedgerObservationPort,
  latestByDay,
  MAIL_TRACE_MUSE_LIMIT,
  type McpConnectionStorePort,
  type ObservationScope,
  PORT_ERROR_CODES,
  type ProactiveSchedule,
  type ProactiveSealPort,
  parseRuleRef,
  summarizeObservation,
} from "@himawari-agent/application";
import {
  addDays,
  DEFAULT_MINIMUM_SAMPLES,
  type GroupSummary,
  jstDayStart,
  type MuseSummary,
  mailComparisonBucket,
  pairEntriesByMail,
  proportion,
  resolveWindow,
  summarizeDecisions,
  summarizeGap,
  summarizeImplicit,
  summarizeMuse,
} from "@himawari-agent/calibration";
import { summarizeMcpUsage } from "@himawari-agent/calibration/mcp-connections";
import {
  DEFAULT_PREREVIEW_AGREEMENT_PERMILLE,
  DEFAULT_PREREVIEW_AUDIT_PERMILLE,
  DEFAULT_PREREVIEW_CONFIDENCE_PERMILLE,
  minimumPairsToPass,
  summarizePrereviewWeek,
} from "@himawari-agent/calibration/prereview";
import {
  type GatewayV2Command,
  type GatewayV2Query,
  type GatewayV2Snapshot,
  gatewayV2MessageSchema,
} from "@himawari-agent/gateway-contracts";
import { displayRuleId } from "./production-decision-chain.js";
import { buildGapCases, clean } from "./production-gap-cases.js";
import { type GapCaseSnapshot, maskForExport } from "./production-gap-export.js";
import { MCP_TOOL_KINDS } from "./production-mcp-connections-control.js";

export const PRODUCTION_OBSERVATION_OPERATIONS = Object.freeze([
  "proactive.weekly.read",
  "decision.email.read",
  "proactive.observation.start",
  "proactive.gapcase.mark",
] as const);

export const OBSERVATION_TICK_MS = 15 * 60 * 1000;
const RECOUNT_DAYS = 60;
const LATEST_FUTURE_START_DAYS = 30;
const REVISION = /^[0-9A-Za-z._-]{1,64}$/u;

export function readServiceRevision(
  location: URL = new URL("../build-info.json", import.meta.url),
): string {
  try {
    const { revision } = JSON.parse(readFileSync(location, "utf8")) as { revision?: unknown };
    return typeof revision === "string" && REVISION.test(revision) ? revision : "development";
  } catch {
    return "development";
  }
}

export interface ProductionObservationOptions {
  readonly scope: ObservationScope;
  readonly observation: LedgerObservationPort;
  readonly ledger: Pick<
    DecisionLedgerPort,
    "readCalibrationRows" | "readGapCandidates" | "readMailTrace" | "read"
  >;
  readonly marks?: GapCaseMarkPort;
  readonly seal?: ProactiveSealPort;
  readonly clock: { now(): string };
  readonly schedule: ProactiveSchedule;
  readonly serviceRevision: string;
  readonly tickMs?: number;
  readonly onFailure?: (error: unknown) => void;
  readonly mcpConnections?: Pick<McpConnectionStorePort, "list" | "usage">;
  readonly correction?: () => Promise<CorrectionAgreementCounts>;
  readonly prereview?: {
    readonly version?: { readonly modelRef: string; readonly promptId: string };
    readonly agreementPermille: number;
    readonly confidencePermille: number;
    readonly reductionEnabled: boolean;
    readonly auditPermille: number;
  };
}

function invalid(reason: string): never {
  throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, reason);
}

function withheld(groups: readonly GroupSummary[]): readonly GroupSummary[] {
  return groups.map((group) => ({
    ...group,
    rates: { useful: null, unneeded: null, missed: null },
  }));
}

export class ProductionObservation {
  readonly #options: ProductionObservationOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #snapshotWritten = false;

  constructor(options: ProductionObservationOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.#options.tickMs ?? OBSERVATION_TICK_MS);
    this.#timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  tick(): Promise<void> {
    this.#running ??= this.#tick()
      .catch((error: unknown) => this.#options.onFailure?.(error))
      .finally(() => {
        this.#running = undefined;
      });
    return this.#running;
  }

  async #tick(): Promise<void> {
    const { observation, scope, serviceRevision } = this.#options;
    const now = this.#options.clock.now();
    if (!this.#snapshotWritten) {
      await observation.ensureSnapshot({ ...scope, at: now });
      this.#snapshotWritten = true;
    }
    await observation.beat({ ...scope, at: now, serviceRevision });
    await this.checkDueDays();
  }

  async checkDueDays(): Promise<number> {
    const { observation, scope, serviceRevision } = this.#options;
    const start = await observation.readStart(scope);
    if (!start) return 0;
    let written = 0;
    for (const day of daysDue({
      start,
      checks: await observation.listChecks(scope),
      now: this.#options.clock.now(),
    })) {
      const now = this.#options.clock.now();
      const window = dayWindow(day);
      const latest = [...latestByDay(await observation.listChecks(scope)).values()]
        .filter((check) => check.day < day && check.status !== "pending")
        .sort((left, right) => (left.day < right.day ? -1 : 1))
        .slice(-RECOUNT_DAYS);
      const recount = await observation.countDays({
        ...scope,
        days: latest.map((check) => dayWindow(check.day)),
      });
      const earlier: EarlierDayCounts[] = latest.map((check) => ({
        day: check.day,
        checkedAt: check.checkedAt,
        counts: check.counts,
        now: recount[check.day] ?? {},
      }));
      const facts = await observation.readDayFacts({ ...scope, ...window, until: now });
      const result = evaluateObservationDay({
        window,
        facts,
        schedule: this.#options.schedule,
        earlier,
        now,
      });
      await observation.appendCheck({
        id: `observation-check:${day}:${now}`,
        ...scope,
        day,
        checkedAt: now,
        serviceRevision,
        status: result.status,
        checks: result.checks,
        counts: result.counts,
      });
      written += 1;
    }
    return written;
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type === "decision.email.read") return this.#emailTrace(query);
    if (query.type !== "proactive.weekly.read")
      throw new Error("OBSERVATION_OPERATION_NOT_INSTALLED");
    const { observation, scope } = this.#options;
    const now = this.#options.clock.now();
    const start = await observation.readStart(scope);
    const firstBoot = await observation.firstHeartbeat(scope);
    const window = resolveWindow(
      query.payload.end
        ? { end: query.payload.end, days: 7 }
        : start
          ? { end: addDays(start.startDay, 7), days: 7 }
          : { now: new Date(now), days: 7 },
    );
    const complete = now >= window.end;
    const rows = await this.#options.ledger.readCalibrationRows({
      ...scope,
      start: window.start,
      end: window.end,
    });
    const groups = summarizeDecisions(rows.decisions, DEFAULT_MINIMUM_SAMPLES);
    const muse: MuseSummary = summarizeMuse(
      rows.entries,
      new Map(rows.mailJudgments),
      DEFAULT_MINIMUM_SAMPLES,
    );
    const gapCases = await this.#gapCases(window);
    const markedIds = new Set(
      (await this.#options.marks?.list(scope))?.map((mark) => mark.caseId) ?? [],
    );
    const gap = summarizeGap(rows.entries, new Map(rows.mailJudgments), DEFAULT_MINIMUM_SAMPLES);
    const implicit = summarizeImplicit(rows.decisions, rows.signals, DEFAULT_MINIMUM_SAMPLES);
    const prereviewSettings = this.#options.prereview ?? {
      agreementPermille: DEFAULT_PREREVIEW_AGREEMENT_PERMILLE,
      confidencePermille: DEFAULT_PREREVIEW_CONFIDENCE_PERMILLE,
      reductionEnabled: false,
      auditPermille: DEFAULT_PREREVIEW_AUDIT_PERMILLE,
    };
    const prereview = summarizePrereviewWeek(
      rows.prereviews,
      prereviewSettings,
      this.#options.prereview?.version,
    );
    const correction = this.#options.correction ? await this.#options.correction() : null;
    const summary = start
      ? summarizeObservation({ start, checks: await observation.listChecks(scope), now })
      : null;
    const mcpConnections = await this.#mcpConnections(window);
    const snapshot: GatewayV2Snapshot = {
      ...query,
      kind: "snapshot",
      type: "proactive.weekly.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        serviceRevision: this.#options.serviceRevision,
        observation: {
          startDay: start?.startDay ?? null,
          earliestStartDay: firstBoot ? earliestStartDay(firstBoot) : null,
          setAt: start?.setAt ?? null,
          startRevision: start?.serviceRevision ?? null,
          firstReportDay: summary?.firstReportDay ?? null,
          passStreak: summary?.passStreak ?? 0,
          streakSince: summary?.streakSince ?? null,
          accepted: summary?.accepted ?? false,
          days: (summary?.cells ?? []).map((cell) => ({
            day: cell.day,
            status: cell.status,
            checkedAt: cell.check?.checkedAt ?? null,
            serviceRevision: cell.check?.serviceRevision ?? null,
            checks: (cell.check?.checks ?? []).map((item) => ({ ...item })),
          })),
        },
        report: {
          start: window.start,
          end: window.end,
          startDay: window.startDate,
          endDay: window.endDate,
          complete,
          ratesWithheld: !complete,
          minimumSamples: DEFAULT_MINIMUM_SAMPLES,
          groups: (complete ? groups : withheld(groups)).map((group) => ({
            ...group,
            applicable: [...group.applicable],
          })),
          muse: {
            entries: muse.entries,
            reminded: muse.reminded,
            silent: muse.silent,
            unpaired: muse.unpaired,
            pairedMails: muse.pairedMails,
            timing: complete ? muse.timing : null,
            content: complete ? muse.content : null,
            pairing: complete ? muse.pairing : null,
            buckets: muse.buckets,
          },
          gapCases: gapCases.map((item) => ({ ...item, marked: markedIds.has(item.id) })),
          gap: complete
            ? {
                pairedMails: gap.pairedMails,
                ratedMails: gap.ratedMails,
                unratedMails: gap.unratedMails,
                lines: gap.lines.map((line) => ({
                  line: line.line,
                  mails: line.mails,
                  museReminded: line.muse.reminded,
                  himawariReminded: line.himawari.reminded,
                  muse: line.muse.rate,
                  himawari: line.himawari.rate,
                  difference: line.difference,
                  low: line.low,
                  high: line.high,
                  verdict: line.verdict,
                  direction: line.direction,
                })),
              }
            : null,
          implicit: {
            pushedDecisions: implicit.pushedDecisions,
            otherDecisionEvents: implicit.otherDecisionEvents,
            signals: implicit.signals.map((item) => ({
              signal: item.signal,
              decisions: item.decisions,
              events: item.events,
              medianDelayMs: item.medianDelayMs,
              rate: complete ? item.rate : null,
            })),
          },
          mcpConnections,
          prereview: {
            agreementPermille: prereviewSettings.agreementPermille,
            confidencePermille: prereviewSettings.confidencePermille,
            reductionEnabled: prereviewSettings.reductionEnabled,
            auditPermille: prereviewSettings.auditPermille,
            minimumPairs: minimumPairsToPass(prereviewSettings.agreementPermille),
            otherVersions: prereview.otherVersions,
            groups: prereview.groups.map((group) => ({
              group: group.group,
              prereviewed: group.prereviewed,
              unsure: group.unsure,
              paired: group.paired,
              agreement: complete ? group.agreement : null,
              kappa: complete ? group.kappa : null,
              balancedAccuracy: complete ? group.balancedAccuracy : null,
              ownerUseful: complete ? group.ownerUseful : null,
              hidden: complete ? group.hidden : null,
              confusion: group.confusion.map((cell) => ({ ...cell })),
              gate: complete ? { ...group.gate } : null,
            })),
          },
          correction: correction
            ? {
                ...correction,
                agreement: proportion(correction.agreed, correction.handled),
              }
            : null,
        },
        generatedAt: now,
      },
    };
    gatewayV2MessageSchema.parse(snapshot);
    return snapshot;
  }

  async #mcpConnections(window: { readonly startDate: string; readonly endDate: string }) {
    const store = this.#options.mcpConnections;
    if (!store) return null;
    const range = {
      fromDay: window.startDate,
      toDay: new Date(Date.parse(`${window.endDate}T00:00:00.000Z`) - 86_400_000)
        .toISOString()
        .slice(0, 10),
    };
    const connections = await store.list(this.#options.scope);
    const rows = await store.usage({ ...this.#options.scope, ...range });
    const usage = summarizeMcpUsage(
      connections.map(({ id }) => id),
      rows,
      MCP_TOOL_KINDS,
      range,
    );
    return {
      ...range,
      connections: connections.map((connection, index) => {
        const { connectionId: _connectionId, ...counts } = usage[index] as (typeof usage)[number];
        return {
          id: connection.id,
          name: connection.name,
          status: connection.status,
          lastSeenAt: connection.lastSeenAt,
          usage: { ...counts, readsByTool: counts.readsByTool.map((entry) => ({ ...entry })) },
        };
      }),
    };
  }

  async #emailTrace(
    query: Extract<GatewayV2Query, { type: "decision.email.read" }>,
  ): Promise<GatewayV2Snapshot> {
    const { ledger, scope, seal } = this.#options;
    const { messageId } = query.payload;
    const trace = await ledger.readMailTrace({ ...scope, messageId });
    const processed = trace.processed;
    const found = processed
      ? await ledger.read({ ...scope, decisionId: processed.decisionId })
      : undefined;
    const fields: ReadonlySet<string> = new Set(found?.inputFields ?? []);
    const inputs = found?.entry.inputs;
    const mailValues = (map: Readonly<Record<string, readonly string[]>> | undefined) =>
      map && Object.hasOwn(map, messageId) && Array.isArray(map[messageId]) ? map[messageId] : [];
    const tidy = (values: readonly string[]) =>
      [...new Set(values.map(displayRuleId).filter((id) => id.trim().length > 0))].sort();
    const forMail = (field: "floorHits" | "memoryByMail" | "relatedByMail") =>
      inputs && fields.has(field) ? tidy(mailValues(inputs[field])) : null;
    const rulesForMail =
      inputs && (fields.has("floorHits") || fields.has("ruleHits"))
        ? tidy([
            ...mailValues(inputs.floorHits),
            ...mailValues(inputs.ruleHits).map((ref) => parseRuleRef(ref).ruleId),
          ])
        : null;
    const related = forMail("relatedByMail");
    const open = async (ref: string | null, limit: number) => {
      if (ref === null || seal === undefined) return null;
      try {
        const text = await seal.open({ ...scope, ref });
        return text === undefined ? null : clean(text, limit) || null;
      } catch {
        return null;
      }
    };
    const entries = await Promise.all(
      trace.museEntries.slice(0, MAIL_TRACE_MUSE_LIMIT).map(async (entry) => ({
        entryId: entry.entryId,
        museAt: entry.museAt,
        reminded: entry.museReminded,
        kind: entry.kind as "proactive" | "scheduled" | null,
        state: entry.state as "delivered" | "suppressed" | "succeeded" | "failed" | null,
        title: entry.textWithheld ? null : await open(entry.titleRef, 300),
        text: entry.textWithheld ? null : await open(entry.textRef ?? entry.contentRef, 500),
        textWithheld: entry.textWithheld,
        timingOk: entry.timingOk,
        contentOk: entry.contentOk,
      })),
    );
    const museRows = trace.museEntries.map((entry) => ({
      museReminded: entry.museReminded,
      timingOk: entry.timingOk,
      contentOk: entry.contentOk,
      pairedMessageId: messageId,
    }));
    const paired = pairEntriesByMail(museRows).get(messageId);
    const comparison = !processed
      ? "noHimawariRecord"
      : !paired
        ? "noMuseEntry"
        : mailComparisonBucket(paired, {
            outcome: processed.outcome,
            ownerRating: processed.ownerRating,
          });
    const snapshot = {
      ...query,
      kind: "snapshot",
      type: "decision.email.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        messageId,
        mail: processed
          ? {
              decisionId: processed.decisionId,
              threadId: processed.threadId,
              outcome: processed.outcome,
              skipReason: processed.skipReason,
              processedAt: processed.processedAt,
              rating: processed.ownerRating,
              decidedAt: found?.entry.decidedAt ?? null,
              ruleIds: rulesForMail,
              memoryIds: forMail("memoryByMail"),
              relatedMessages: related === null ? null : related.length,
            }
          : null,
        muse: { entries, truncated: trace.museEntries.length > MAIL_TRACE_MUSE_LIMIT },
        comparison,
      },
    } as GatewayV2Snapshot;
    gatewayV2MessageSchema.parse(snapshot);
    return snapshot;
  }

  async #gapCases(
    window: { readonly start: string; readonly end: string },
    mask?: (text: string) => string,
  ) {
    const { ledger, scope, seal } = this.#options;
    return buildGapCases({
      scope,
      candidates: await ledger.readGapCandidates({
        ...scope,
        start: window.start,
        end: window.end,
      }),
      seal,
      ...(mask ? { mask } : {}),
    });
  }

  async #markGapCase(payload: { caseId: string; endDay: string; marked: boolean }) {
    const { marks, seal, scope } = this.#options;
    if (!marks || !seal) invalid("GAP_MARKS_UNAVAILABLE");
    if (!payload.marked) {
      const ref = await marks.unmark({ ...scope, caseId: payload.caseId });
      return { resultRef: `gap-case-unmark:${payload.caseId}`, replayed: ref === null };
    }
    const window = resolveWindow({ end: payload.endDay, days: 7 });
    const found = (await this.#gapCases(window, maskForExport)).find(
      (item) => item.id === payload.caseId,
    );
    if (!found) invalid("GAP_CASE_NOT_FOUND");
    const at = this.#options.clock.now();
    const snapshot: GapCaseSnapshot = { ...found, weekStart: window.start, weekEnd: window.end };
    const ref = await seal.seal({ ...scope, text: JSON.stringify(snapshot), at });
    const added = await marks
      .mark({ ...scope, caseId: payload.caseId, snapshotRef: ref, at })
      .catch(async (error: unknown) => {
        await seal.release({ ...scope, refs: [ref] });
        throw error;
      });
    if (!added) await seal.release({ ...scope, refs: [ref] });
    return { resultRef: `gap-case-mark:${payload.caseId}`, replayed: !added };
  }

  async execute(command: GatewayV2Command): Promise<{ resultRef: string; replayed: boolean }> {
    if (command.type === "proactive.gapcase.mark") return this.#markGapCase(command.payload);
    if (command.type !== "proactive.observation.start")
      throw new Error("OBSERVATION_OPERATION_NOT_INSTALLED");
    const { observation, scope, serviceRevision } = this.#options;
    const now = this.#options.clock.now();
    const firstBootAt = await observation.firstHeartbeat(scope);
    if (!firstBootAt) invalid("OBSERVATION_NOT_READY");
    const { startDay } = command.payload;
    if (startDay < earliestStartDay(firstBootAt)) invalid("OBSERVATION_START_TOO_EARLY");
    if (jstDayStart(startDay) > jstDayStart(addDays(jstToday(now), LATEST_FUTURE_START_DAYS)))
      invalid("OBSERVATION_START_TOO_LATE");
    await observation.setStart({ ...scope, startDay, setAt: now, serviceRevision, firstBootAt });
    return { resultRef: `observation-start:${startDay}`, replayed: false };
  }
}
