import { readFileSync } from "node:fs";
import {
  ApplicationPortError,
  type DecisionLedgerPort,
  daysDue,
  dayWindow,
  type EarlierDayCounts,
  earliestStartDay,
  evaluateObservationDay,
  jstToday,
  type LedgerObservationPort,
  latestByDay,
  type ObservationScope,
  PORT_ERROR_CODES,
  type ProactiveSchedule,
  summarizeObservation,
} from "@himawari-agent/application";
import {
  addDays,
  DEFAULT_MINIMUM_SAMPLES,
  type GroupSummary,
  jstDayStart,
  type MuseSummary,
  resolveWindow,
  summarizeDecisions,
  summarizeMuse,
} from "@himawari-agent/calibration";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";

export const PRODUCTION_OBSERVATION_OPERATIONS = Object.freeze([
  "proactive.weekly.read",
  "proactive.observation.start",
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
  readonly ledger: Pick<DecisionLedgerPort, "readCalibrationRows">;
  readonly clock: { now(): string };
  readonly schedule: ProactiveSchedule;
  readonly serviceRevision: string;
  readonly tickMs?: number;
  readonly onFailure?: (error: unknown) => void;
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
      const facts = await observation.readDayFacts({ ...scope, ...window });
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
    const summary = start
      ? summarizeObservation({ start, checks: await observation.listChecks(scope), now })
      : null;
    return {
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
        },
        generatedAt: now,
      },
    };
  }

  async execute(command: GatewayV2Command): Promise<{ resultRef: string; replayed: boolean }> {
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
