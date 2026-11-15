import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MessageId } from "../i18n/message-ids.js";
import type {
  CalibrationGroupSummary,
  ObservationCheckItem,
  ObservationDay,
  ProactiveModel,
  ProactiveWeekly,
  ProactiveWeeklyAccess,
} from "../proactive.js";
import { AccountLogin } from "./account-login.js";
import { Glyph, type GlyphName } from "./glyphs.js";
import { McpUsageLines } from "./mcp-connections-settings.js";
import { ModalDialog } from "./overlays.js";
import { ActionButton } from "./primitives.js";

type Message = (id: MessageId, values?: Record<string, string | number>) => string;
type Group = CalibrationGroupSummary["group"];
type Rating = CalibrationGroupSummary["applicable"][number];
type DayStatus = ObservationDay["status"];
type Phase = "unset" | "waiting" | "observing" | "reported";
type InfoKey =
  | "obs"
  | "type"
  | "stats"
  | "muse"
  | "implicit"
  | "prereview"
  | "row:proactive_pushed"
  | "row:proactive_silent";
interface Info {
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly list: readonly string[];
  readonly version: string | null;
}
interface OpenInfo {
  readonly key: InfoKey;
  readonly anchor: HTMLElement;
}

const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 9 * 3_600_000;
const OBSERVATION_DAYS = 7;
const LATEST_FUTURE_START_DAYS = 30;
const PHONE_QUERY = "(max-width: 640px)";
const MAIN_GROUPS: readonly Group[] = [
  "proactive_pushed",
  "proactive_silent",
  "memory_skipped",
  "memory_kept",
  "consolidation",
];
const OWN_RATE_LABELS: readonly Group[] = [...MAIN_GROUPS, "memory_capture_failed"];
const DESCRIBED_GROUPS: readonly Group[] = ["proactive_pushed", "proactive_silent"];
const MUSE_BUCKETS = [
  "both",
  "museOnly",
  "himawariOnly",
  "bothSilent",
  "noHimawariRecord",
] as const;
const STATUS_GLYPH: Readonly<Record<DayStatus, GlyphName>> = {
  pass: "passed",
  fail: "failed",
  blocked: "paused",
  pending: "refresh",
  no_check: "alert",
  upcoming: "clock",
};
const CHECK_GLYPH: Readonly<Record<ObservationCheckItem["status"], GlyphName>> = {
  pass: "passed",
  fail: "failed",
  blocked: "paused",
  pending: "refresh",
  not_applicable: "clock",
};

const dayStart = (day: string) => Date.parse(`${day}T00:00:00.000Z`);
const addDays = (day: string, days: number) =>
  new Date(dayStart(day) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) =>
  Math.round((dayStart(to) - dayStart(from)) / DAY_MS);
const jstToday = (now: number) => new Date(now + JST_OFFSET_MS).toISOString().slice(0, 10);

function formatter(locale: string) {
  const language = locale.startsWith("en") ? "en" : locale.startsWith("ja") ? "ja" : "zh";
  const percent = new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const count = new Intl.NumberFormat(locale);
  const shortDay = new Intl.DateTimeFormat(locale, {
    month: language === "en" ? "short" : "numeric",
    day: "numeric",
    timeZone: "UTC",
  });
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const clock = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Tokyo",
  });
  const day = (value: string) => {
    if (language !== "zh") return shortDay.format(new Date(dayStart(value)));
    const [, month, date] = value.split("-").map(Number);
    return `${month} 月 ${date} 日`;
  };
  return {
    day,
    weekday: (value: string) => weekday.format(new Date(dayStart(value))),
    clock: (value: string) => clock.format(new Date(value)),
    moment: (value: string) =>
      `${day(jstToday(Date.parse(value)))} ${clock.format(new Date(value))}`,
    percent: (value: number) => percent.format(value),
    count: (value: number) => count.format(value),
  };
}
type Format = ReturnType<typeof formatter>;

function usePhone() {
  const [phone, setPhone] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(PHONE_QUERY).matches === true,
  );
  useEffect(() => {
    const media = window.matchMedia?.(PHONE_QUERY);
    if (!media) return;
    const change = () => setPhone(media.matches);
    change();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return phone;
}

function phaseOf(data: ProactiveWeekly, now: number): Phase {
  const { startDay } = data.observation;
  if (!startDay) return "unset";
  if (jstToday(now) < startDay) return "waiting";
  return data.report.complete ? "reported" : "observing";
}

function duration(minutes: number, message: Message) {
  return minutes >= 60
    ? message("weekly.duration.hours", { h: Math.floor(minutes / 60), m: minutes % 60 })
    : message("weekly.duration.minutes", { m: minutes });
}

function implicitDelay(delayMs: number, message: Message, format: Format) {
  const minutes = delayMs / 60_000;
  if (minutes < 1) return message("weekly.implicit.underMinute");
  if (minutes < 120)
    return message("weekly.implicit.minutes", { n: format.count(Math.round(minutes)) });
  const hours = minutes / 60;
  return hours < 48
    ? message("weekly.implicit.hours", { n: format.count(Math.round(hours)) })
    : message("weekly.implicit.days", { n: format.count(Math.round(hours / 24)) });
}

const fact = (item: ObservationCheckItem, key: string) => item.facts[key];
const numberFact = (item: ObservationCheckItem, key: string) => {
  const value = fact(item, key);
  return typeof value === "number" ? value : 0;
};
const textFact = (item: ObservationCheckItem, key: string) => {
  const value = fact(item, key);
  return typeof value === "string" ? value : null;
};

export function checkSentence(
  item: ObservationCheckItem,
  message: Message,
  format: Format,
): string {
  const at = (key: string) => {
    const value = textFact(item, key);
    return value ? format.clock(value) : "";
  };
  const reason = `${item.code}:${item.reason}`;
  switch (reason) {
    case "service_running:all_hours":
      return message("weekly.check.serviceAllHours");
    case "service_running:one_hour_missing":
      return message("weekly.check.serviceOneHour");
    case "service_running:hours_missing":
      return message("weekly.check.serviceMissing", {
        hours: numberFact(item, "missingHours"),
        longest: numberFact(item, "longestGapHours"),
      });
    case "proactive_writing:on_time": {
      const cleared = textFact(item, "clearedAt");
      return `${message("weekly.check.gmailOnTime", {
        rows: numberFact(item, "rows"),
        gap: duration(numberFact(item, "longestGapMinutes"), message),
      })}${cleared ? message("weekly.check.gmailClearedSince", { time: format.moment(cleared) }) : ""}`;
    }
    case "proactive_writing:gap_too_long": {
      const cleared = textFact(item, "clearedAt");
      return `${message("weekly.check.gmailGap", {
        rows: numberFact(item, "rows"),
        gap: duration(numberFact(item, "longestGapMinutes"), message),
        limit: duration(numberFact(item, "limitMinutes"), message),
      })}${cleared ? message("weekly.check.gmailClearedSince", { time: format.moment(cleared) }) : ""}`;
    }
    case "proactive_writing:switched_off":
      return message("weekly.check.gmailOff", { time: at("since") });
    case "proactive_writing:source_not_connected":
      return message("weekly.check.gmailDisconnected", { time: at("since") });
    case "proactive_writing:not_configured":
      return message("weekly.check.gmailNotConfigured");
    case "proactive_writing:interval_too_long":
      return message("weekly.check.gmailSlow", { minutes: numberFact(item, "intervalMinutes") });
    case "proactive_writing:records_cleared": {
      const cleared = textFact(item, "clearedAt");
      return message("weekly.check.gmailCleared", { time: cleared ? format.moment(cleared) : "" });
    }
    case "memory_capture:running":
      return message("weekly.check.memoryOn");
    case "memory_capture:paused":
      return message("weekly.check.memoryPaused", { time: at("since") });
    case "consolidation_recorded:rows_match":
      return message("weekly.check.tidyMatch", {
        changes: numberFact(item, "changes"),
        rows: numberFact(item, "rows"),
      });
    case "consolidation_recorded:rows_mismatch":
      return message("weekly.check.tidyMismatch", {
        changes: numberFact(item, "changes"),
        rows: numberFact(item, "rows"),
      });
    case "consolidation_recorded:run_failed":
      return message("weekly.check.tidyFailed");
    case "consolidation_recorded:run_stuck":
      return message("weekly.check.tidyStuck", { time: at("startedAt") });
    case "consolidation_recorded:run_in_progress":
      return message("weekly.check.tidyRunning", { time: at("startedAt") });
    case "consolidation_recorded:no_run":
      return message("weekly.check.tidyNone");
    case "rows_kept:nothing_missing":
      return message("weekly.check.rowsKept");
    case "rows_kept:cleared_by_owner":
      return message("weekly.check.rowsCleared", { rows: numberFact(item, "explainedRows") });
    case "rows_kept:rows_missing": {
      const day = textFact(item, "day");
      return message("weekly.check.rowsMissing", {
        day: day && /^\d{4}-\d{2}-\d{2}$/u.test(day) ? format.day(day) : "",
        kind: textFact(item, "kind") ?? "other",
        before: numberFact(item, "before"),
        after: numberFact(item, "after"),
      });
    }
    case "time_format:well_formed":
      return message("weekly.check.timeOk");
    case "time_format:malformed":
      return message("weekly.check.timeBad", { rows: numberFact(item, "rows") });
    default:
      return message("weekly.check.other", { s: item.status });
  }
}

function InfoButton({
  infoKey,
  open,
  label,
  onToggle,
}: {
  infoKey: InfoKey;
  open: OpenInfo | null;
  label: string;
  onToggle: (key: InfoKey, anchor: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      className="weekly-info"
      data-info={infoKey}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open?.key === infoKey}
      onClick={(event) => onToggle(infoKey, event.currentTarget)}
    >
      <Glyph name="info" />
    </button>
  );
}

function InfoBody({ info }: { info: Info }) {
  return (
    <div className="weekly-info-text">
      {info.paragraphs.map((text) => (
        <p key={text}>{text}</p>
      ))}
      {info.list.length ? (
        <ul>
          {info.list.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      ) : null}
      {info.version ? <p className="weekly-version">{info.version}</p> : null}
    </div>
  );
}

function InfoPopover({
  info,
  anchor,
  onClose,
}: {
  info: Info;
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const place = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const rect = anchor.getBoundingClientRect();
    const width = element.offsetWidth;
    const room = document.documentElement.clientWidth || window.innerWidth;
    element.style.top = `${Math.round(rect.bottom + 4)}px`;
    element.style.left = `${Math.round(Math.max(8, Math.min(rect.left - 12, room - width - 8)))}px`;
  }, [anchor]);
  useLayoutEffect(() => {
    place();
    ref.current?.focus({ preventScroll: true });
  }, [place]);
  useEffect(() => {
    const outside = (event: Event) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-info]")) return;
      onClose();
    };
    const pressKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onClose();
      anchor.focus();
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", pressKey);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", pressKey);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor, onClose, place]);
  return (
    <div ref={ref} className="weekly-popover" role="dialog" aria-label={info.title} tabIndex={-1}>
      <h3>{info.title}</h3>
      <InfoBody info={info} />
    </div>
  );
}

function Sheet({
  title,
  message,
  onClose,
  children,
}: {
  title: string;
  message: Message;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <ModalDialog
      open
      closeOnBackdrop
      title={title}
      closeLabel={message("common.close")}
      onClose={onClose}
    >
      <div className="weekly-sheet">
        {children}
        <ActionButton variant="secondary" className="weekly-sheet-close" onClick={onClose}>
          {message("common.close")}
        </ActionButton>
      </div>
    </ModalDialog>
  );
}

function CardHead({
  title,
  infoKey,
  level = 2,
  info,
}: {
  title: string;
  infoKey: InfoKey | null;
  level?: 2 | 3;
  info: (key: InfoKey) => ReactNode;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className="weekly-head">
      <Heading>{title}</Heading>
      {infoKey ? info(infoKey) : null}
    </div>
  );
}

function signedPercent(value: number): string {
  const text = `${(value * 100).toFixed(1)}%`;
  return value > 0 ? `+${text}` : text;
}

function signedFree(value: number | null, format: Format): string {
  return value === null ? "-" : format.percent(value);
}

function ratioParts(
  group: CalibrationGroupSummary,
  minimumSamples: number,
  message: Message,
  format: Format,
) {
  if (group.rated < minimumSamples) return null;
  const labelled = OWN_RATE_LABELS.includes(group.group);
  const parts = group.applicable.flatMap((rating: Rating) => {
    const rate = group.rates[rating];
    if (!rate?.enough || rate.value === null || rate.low === null || rate.high === null) return [];
    return [
      {
        rating,
        label: message("weekly.rate", { k: `${labelled ? group.group : "other"}_${rating}` }),
        value: message("weekly.ratio", {
          pct: format.percent(rate.value),
          k: format.count(rate.successes),
          n: format.count(rate.samples),
        }),
        range: message("weekly.interval", {
          low: format.percent(rate.low),
          high: format.percent(rate.high),
        }),
      },
    ];
  });
  return parts.length ? parts : null;
}

const emptyGroup = (group: Group): CalibrationGroupSummary => ({
  group,
  total: 0,
  rated: 0,
  useful: 0,
  unneeded: 0,
  missed: 0,
  applicable: [],
  rates: { useful: null, unneeded: null, missed: null },
});

function GapLines({
  gap,
  message,
  format,
}: {
  gap: NonNullable<ProactiveWeekly["report"]["gap"]>;
  message: Message;
  format: Format;
}) {
  return (
    <>
      {gap.lines.map((line) => (
        <div key={line.line} className="weekly-gap-line">
          <b>{message("weekly.gap.line", { l: line.line })}</b>
          <span>{message("weekly.gap.mails", { n: format.count(line.mails) })}</span>
          {line.verdict === "insufficient" ? (
            <span>{message("weekly.gap.few", { n: line.mails })}</span>
          ) : (
            <>
              <span>
                {message("weekly.gap.rates", {
                  muse: signedFree(line.muse?.value ?? null, format),
                  himawari: signedFree(line.himawari?.value ?? null, format),
                })}
              </span>
              {line.difference !== null && line.low !== null && line.high !== null ? (
                <span>
                  {message("weekly.gap.diff", {
                    d: signedPercent(line.difference),
                    low: signedPercent(line.low),
                    high: signedPercent(line.high),
                  })}
                </span>
              ) : null}
              <span>
                {message("weekly.gap.verdict", {
                  v: line.verdict === "decided" ? line.direction : "none",
                })}
              </span>
            </>
          )}
        </div>
      ))}
    </>
  );
}

function MuseBucketTiles({
  muse,
  message,
  format,
  mark,
}: {
  muse: ProactiveWeekly["report"]["muse"];
  message: Message;
  format: Format;
  mark?: (typeof MUSE_BUCKETS)[number] | null;
}) {
  return (
    <div className="weekly-tiles" data-count="5">
      {MUSE_BUCKETS.map((bucket) => (
        <div key={bucket} className="weekly-tile" data-mark={mark === bucket || undefined}>
          <b>{format.count(muse.buckets[bucket])}</b>
          <span>{message("weekly.muse.bucket", { b: bucket })}</span>
        </div>
      ))}
    </div>
  );
}

export function WeekGlance({
  report,
  message,
  locale,
  mark,
}: {
  report: ProactiveWeekly["report"];
  message: Message;
  locale: string;
  mark: (typeof MUSE_BUCKETS)[number] | null;
}) {
  const format = formatter(locale);
  const groups = new Map(report.groups.map((group) => [group.group, group]));
  return (
    <div className="mail-week">
      <p className="weekly-window">
        {message("weekly.window.range", {
          start: format.day(report.startDay),
          end: format.day(addDays(report.endDay, -1)),
        })}
      </p>
      {report.ratesWithheld ? (
        <p className="weekly-empty">{message("decision.email.weekWithheld")}</p>
      ) : null}
      <div className="mail-week-rows">
        {DESCRIBED_GROUPS.map((name) => {
          const group = groups.get(name) ?? emptyGroup(name);
          const parts = report.ratesWithheld
            ? null
            : ratioParts(group, report.minimumSamples, message, format);
          return (
            <div key={name} className="weekly-type-card" data-group={name}>
              <h3>{message("weekly.group", { g: name })}</h3>
              <div className="weekly-metric">
                <span>{message("weekly.type.column", { c: "total" })}</span>
                <span>{format.count(group.total)}</span>
              </div>
              <div className="weekly-metric">
                <span>{message("weekly.type.column", { c: "rated" })}</span>
                <span>{format.count(group.rated)}</span>
              </div>
              {report.ratesWithheld ? null : parts ? (
                parts.map((part) => (
                  <div key={part.rating} className="weekly-metric">
                    <span>{part.label}</span>
                    <span>
                      {part.value}
                      <small>{part.range}</small>
                    </span>
                  </div>
                ))
              ) : (
                <div className="weekly-metric" data-few>
                  <span>{message("weekly.type.column", { c: "ratio" })}</span>
                  <span>{message("weekly.few", { n: group.rated })}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <h3>{message("weekly.muse.title")}</h3>
      {report.muse.entries === 0 ? (
        <p className="weekly-empty">{message("weekly.muse.empty")}</p>
      ) : (
        <MuseBucketTiles muse={report.muse} message={message} format={format} mark={mark} />
      )}
      <h3>{message("weekly.gap.title")}</h3>
      {report.gap === null ? (
        <p className="weekly-empty">{message("weekly.gap.notFull")}</p>
      ) : report.gap.lines.every((line) => line.mails === 0) ? (
        <p className="weekly-empty">{message("weekly.gap.empty")}</p>
      ) : (
        <GapLines gap={report.gap} message={message} format={format} />
      )}
    </div>
  );
}

export function WeeklyReport({
  proactive,
  weekly,
  message,
  locale,
  onRate,
  onOpenMail,
}: {
  proactive: ProactiveModel;
  weekly: ProactiveWeeklyAccess;
  message: Message;
  locale: string;
  onRate: () => void;
  onOpenMail?: (messageId: string, endDay: string) => void;
}) {
  const access = useRef(weekly);
  access.current = weekly;
  const [data, setData] = useState<ProactiveWeekly | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [openInfo, setOpenInfo] = useState<OpenInfo | null>(null);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [otherOpen, setOtherOpen] = useState(false);
  const [markBusy, setMarkBusy] = useState<string | null>(null);
  const [markFailed, setMarkFailed] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmFailed, setConfirmFailed] = useState(false);
  const startLock = useRef(false);
  const [started, setStarted] = useState(false);
  const [reauthCsrfToken, setReauthCsrfToken] = useState("");
  const [reauthenticating, setReauthenticating] = useState<"built-in" | "cloudflare-access" | null>(
    null,
  );
  const phone = usePhone();
  const format = formatter(locale);
  useEffect(() => {
    void reload;
    let active = true;
    setFailed(false);
    access.current
      .read()
      .then((value) => {
        if (active) setData(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [reload]);
  const closeInfo = useCallback(() => setOpenInfo(null), []);
  const toggleInfo = useCallback(
    (key: InfoKey, anchor: HTMLElement) =>
      setOpenInfo((current) => (current?.key === key ? null : { key, anchor })),
    [],
  );
  const infoButton = (key: InfoKey) => (
    <InfoButton
      infoKey={key}
      open={openInfo}
      label={message("weekly.info")}
      onToggle={(next, anchor) => {
        setOpenDay(null);
        toggleInfo(next, anchor);
      }}
    />
  );

  if (!data)
    return (
      <div className="weekly-report">
        {failed ? (
          <p className="weekly-line" data-tone="bad" role="alert">
            <Glyph name="alert" />
            <span>{message("weekly.loadFailed")}</span>
            <button
              type="button"
              className="reminders-link"
              onClick={() => setReload((value) => value + 1)}
            >
              {message("loading.retry")}
            </button>
          </p>
        ) : (
          <div className="files-library-skeleton" aria-hidden="true">
            <i />
            <i />
          </div>
        )}
      </div>
    );

  const now = Date.now();
  const today = jstToday(now);
  const { observation, report } = data;
  const phase = phaseOf(data, now);
  const startDay = observation.startDay;
  const earliest = observation.earliestStartDay;
  const latest = addDays(today, LATEST_FUTURE_START_DAYS);
  const chosen = pick ?? (earliest && earliest > latest ? latest : earliest);
  const days = observation.days;
  const ofStatus = (status: DayStatus) => days.filter((day) => day.status === status);
  const dayList = (items: readonly ObservationDay[]) =>
    items.map((item) => format.day(item.day)).join(message("weekly.obs.join"));
  const failedDays = ofStatus("fail");
  const missingDays = ofStatus("no_check");
  const blockedDays = ofStatus("blocked");
  const dayLabel = (day: string) => {
    const index = startDay ? daysBetween(startDay, day) : -1;
    return index >= 0 && index < OBSERVATION_DAYS
      ? message("weekly.obs.dayN", { n: index + 1 })
      : format.day(day);
  };

  let line: { tone: "ok" | "warn" | "bad"; glyph: GlyphName; text: string } | null = null;
  if (startDay && phase !== "waiting") {
    const since = observation.streakSince;
    if (observation.accepted && since === startDay)
      line = { tone: "ok", glyph: "passed", text: message("weekly.obs.allPass") };
    else if (since && since !== startDay && observation.passStreak > 0) {
      const broke = addDays(since, -1);
      const brokeStatus = days.find((item) => item.day === broke)?.status ?? "other";
      line = {
        tone: observation.accepted ? "ok" : "warn",
        glyph: observation.accepted ? "passed" : "failed",
        text: message("weekly.obs.restart", {
          broke: message("weekly.obs.broke", { day: dayLabel(broke), s: brokeStatus }),
          since: format.day(since),
          n: Math.min(observation.passStreak, OBSERVATION_DAYS),
        }),
      };
    } else if (failedDays.length || missingDays.length) {
      const parts = [
        ...(failedDays.length
          ? [message("weekly.obs.failedOn", { days: dayList(failedDays) })]
          : []),
        ...(missingDays.length
          ? [message("weekly.obs.noCheckOn", { days: dayList(missingDays) })]
          : []),
      ];
      line = { tone: "bad", glyph: "alert", text: parts.join(message("weekly.obs.partJoin")) };
    } else if (blockedDays.length)
      line = {
        tone: "warn",
        glyph: "paused",
        text: message("weekly.obs.blockedOn", { days: dayList(blockedDays) }),
      };
  }

  const groupsByName = new Map(report.groups.map((group) => [group.group, group]));
  const otherGroups = report.groups.filter((group) => !MAIN_GROUPS.includes(group.group));
  const rows: { group: CalibrationGroupSummary; sub: boolean }[] = [
    ...MAIN_GROUPS.map((group) => ({
      group: groupsByName.get(group) ?? emptyGroup(group),
      sub: false,
    })),
    ...(otherOpen ? otherGroups.map((group) => ({ group, sub: true })) : []),
  ];
  const withheld = report.ratesWithheld;
  const showTable = phase !== "unset" && phase !== "waiting";

  const infoFor = (key: InfoKey): Info => {
    if (key === "obs") {
      const paragraphs: string[] = [];
      if (startDay && observation.firstReportDay)
        paragraphs.push(
          message("weekly.obs.dates", {
            start: format.day(startDay),
            report: format.day(observation.firstReportDay),
          }),
        );
      paragraphs.push(message("weekly.obs.explain"));
      if (!startDay && earliest)
        paragraphs.push(
          message("weekly.confirm.earliest", {
            earliest: format.day(earliest),
            boot: format.day(addDays(earliest, -1)),
          }),
          message("weekly.confirm.fixed"),
        );
      if (line && line.tone !== "ok") paragraphs.push(message("weekly.obs.badMore"));
      return {
        title: message("weekly.obs.title"),
        paragraphs,
        list: [],
        version: observation.startRevision
          ? message("weekly.obs.version", { v: observation.startRevision })
          : null,
      };
    }
    if (key === "type") {
      const how = [
        message("weekly.type.how0"),
        message("weekly.type.how1"),
        message("weekly.type.how2"),
        message("weekly.type.how3", { n: report.minimumSamples }),
        message("weekly.type.how4"),
      ];
      return {
        title: message("weekly.type.title"),
        paragraphs: !showTable
          ? [message("weekly.type.notStartedMore")]
          : withheld
            ? [message("weekly.type.notFullMore")]
            : [],
        list: showTable ? how : [],
        version: null,
      };
    }
    if (key === "stats")
      return {
        title: message("weekly.stats.title"),
        paragraphs: [message("weekly.stats.note")],
        list: [],
        version: null,
      };
    if (key === "implicit")
      return {
        title: message("weekly.implicit.title"),
        paragraphs: [message("weekly.implicit.def")],
        list: [],
        version: null,
      };
    if (key === "prereview")
      return {
        title: message("weekly.prereview.title"),
        paragraphs: [
          message("weekly.prereview.def"),
          message("weekly.prereview.gateDef", {
            agreement: format.percent(report.prereview.agreementPermille / 1000),
            confidence: format.percent(report.prereview.confidencePermille / 1000),
            n:
              report.prereview.minimumPairs === null
                ? "—"
                : format.count(report.prereview.minimumPairs),
          }),
          report.prereview.reductionEnabled
            ? message("weekly.prereview.reductionOn", {
                audit: format.percent(report.prereview.auditPermille / 1000),
              })
            : message("weekly.prereview.reductionOff"),
        ],
        list: [],
        version: null,
      };
    if (key === "muse")
      return {
        title: message("weekly.muse.title"),
        paragraphs: [message("weekly.muse.def")],
        list: [],
        version: null,
      };
    const group = key.slice(4);
    return {
      title: message("weekly.group", { g: group }),
      paragraphs: [message("weekly.groupInfo", { g: group })],
      list: [],
      version: null,
    };
  };

  const openCell = days.find((item) => item.day === openDay) ?? null;
  const prereviewGroups = report.prereview.groups.filter(
    (item) => item.prereviewed > 0 || item.paired > 0,
  );
  const cellIndex = (day: string) => (startDay ? daysBetween(startDay, day) : 0);
  const detailTitle = (item: ObservationDay) =>
    [
      message("weekly.obs.dayN", { n: cellIndex(item.day) + 1 }),
      format.day(item.day),
      message("weekly.obs.status", { s: item.status }),
    ].join(" · ");
  const checks = (item: ObservationDay) => (
    <ul className="weekly-checks">
      {item.status === "no_check" ? (
        <li data-status="fail">
          <Glyph name="alert" />
          <span>{message("weekly.check.noRecord")}</span>
        </li>
      ) : (
        item.checks
          .filter((check) => check.status !== "not_applicable")
          .map((check) => (
            <li key={`${check.code}:${check.reason}`} data-status={check.status}>
              <Glyph name={CHECK_GLYPH[check.status]} />
              <span>{checkSentence(check, message, format)}</span>
            </li>
          ))
      )}
    </ul>
  );

  const submitStart = async () => {
    if (!chosen || startLock.current) return;
    startLock.current = true;
    let succeeded = false;
    setConfirmBusy(true);
    setConfirmFailed(false);
    try {
      const { reference, csrfToken } = await weekly.recentAuthentication();
      if (!reference) {
        const method = await weekly.identityMethod();
        if (!method) throw new Error("IDENTITY_METHOD_UNKNOWN");
        setReauthCsrfToken(csrfToken);
        setReauthenticating(method);
        return;
      }
      await weekly.start(chosen, reference);
      succeeded = true;
      setStarted(true);
      setConfirming(false);
      setPick(null);
      setReload((value) => value + 1);
    } catch {
      setConfirmFailed(true);
    } finally {
      startLock.current = succeeded;
      setConfirmBusy(false);
    }
  };

  const toggleMark = async (caseId: string, marked: boolean) => {
    if (markBusy !== null) return;
    setMarkBusy(caseId);
    setMarkFailed(false);
    try {
      await weekly.markGapCase(caseId, report.endDay, !marked);
      setReload((value) => value + 1);
    } catch {
      setMarkFailed(true);
    } finally {
      setMarkBusy(null);
    }
  };

  const ratioCells = (group: CalibrationGroupSummary) =>
    ratioParts(group, report.minimumSamples, message, format);
  const rowName = (group: Group, level: "cell" | "card") =>
    DESCRIBED_GROUPS.includes(group) ? (
      level === "cell" ? (
        <span className="weekly-row-name">
          {message("weekly.group", { g: group })}
          {infoButton(`row:${group}` as InfoKey)}
        </span>
      ) : (
        <CardHead
          title={message("weekly.group", { g: group })}
          infoKey={`row:${group}` as InfoKey}
          level={3}
          info={infoButton}
        />
      )
    ) : level === "cell" ? (
      message("weekly.group", { g: group })
    ) : (
      <h3>{message("weekly.group", { g: group })}</h3>
    );
  const otherButton = otherGroups.length ? (
    <button
      type="button"
      className="weekly-link"
      aria-expanded={otherOpen}
      onClick={() => setOtherOpen(!otherOpen)}
    >
      {message("weekly.other", { n: otherGroups.length, open: otherOpen ? "yes" : "no" })}
    </button>
  ) : null;
  const column = (c: "type" | "total" | "rated" | "ratio") => message("weekly.type.column", { c });

  const metrics = proactive.overview?.metrics ?? null;
  const muse = report.muse;
  const pairing = muse.pairing;
  const info = openInfo ? infoFor(openInfo.key) : null;
  const windowText =
    phase === "unset"
      ? message("weekly.window.last7")
      : phase === "observing" && startDay
        ? message("weekly.window.sinceStart", { start: format.day(startDay) })
        : message("weekly.window.range", {
            start: format.day(report.startDay),
            end: format.day(addDays(report.endDay, -1)),
          });

  return (
    <div className="weekly-report">
      <p className="weekly-window">{windowText}</p>

      <section className="weekly-card" aria-label={message("weekly.obs.title")}>
        <CardHead title={message("weekly.obs.title")} infoKey="obs" info={infoButton} />
        {!startDay ? (
          earliest && chosen ? (
            <>
              <p className="weekly-sub">{message("weekly.obs.short")}</p>
              <div className="weekly-start">
                <span className="weekly-start-label" id="weekly-start-label">
                  {message("weekly.obs.startLabel")}
                </span>
                <fieldset className="weekly-stepper" aria-labelledby="weekly-start-label">
                  <button
                    type="button"
                    aria-label={message("weekly.obs.prevDay")}
                    disabled={chosen <= earliest}
                    onClick={() => setPick(addDays(chosen, -1))}
                  >
                    <Glyph name="back" />
                  </button>
                  <output>
                    {format.day(chosen)} · {format.weekday(chosen)}
                  </output>
                  <button
                    type="button"
                    aria-label={message("weekly.obs.nextDay")}
                    disabled={chosen >= latest}
                    onClick={() => setPick(addDays(chosen, 1))}
                  >
                    <Glyph name="chevron" />
                  </button>
                </fieldset>
                <ActionButton
                  disabled={started}
                  onClick={() => {
                    setConfirmFailed(false);
                    setReauthenticating(null);
                    setConfirming(true);
                  }}
                >
                  {message("weekly.obs.startButton")}
                </ActionButton>
              </div>
            </>
          ) : (
            <p className="weekly-empty">{message("weekly.obs.notReady")}</p>
          )
        ) : (
          <>
            <p className="weekly-headline">
              {phase === "waiting"
                ? message("weekly.obs.headWaiting")
                : phase === "reported"
                  ? message("weekly.obs.headFirst")
                  : message("weekly.obs.headNow", {
                      n: Math.min(OBSERVATION_DAYS, daysBetween(startDay, today) + 1),
                    })}
            </p>
            <div className="weekly-days">
              {days.map((item, index) => {
                const label = (
                  <>
                    <span className="weekly-day-n">
                      {message("weekly.obs.dayN", { n: index + 1 })}
                      {item.day === today ? (
                        <span className="weekly-today">{message("weekly.obs.today")}</span>
                      ) : null}
                    </span>
                    <span className="weekly-day-date">{format.day(item.day)}</span>
                    <span className="weekly-day-status">
                      <Glyph name={STATUS_GLYPH[item.status]} />
                      {message("weekly.obs.status", { s: item.status })}
                    </span>
                  </>
                );
                return item.status === "upcoming" ? (
                  <div key={item.day} className="weekly-day" data-status={item.status}>
                    {label}
                  </div>
                ) : (
                  <button
                    key={item.day}
                    type="button"
                    className="weekly-day"
                    data-status={item.status}
                    aria-expanded={openDay === item.day}
                    onClick={() => {
                      setOpenInfo(null);
                      setOpenDay(openDay === item.day ? null : item.day);
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {openCell && !phone ? (
              <section className="weekly-detail" aria-label={detailTitle(openCell)}>
                <h3>{detailTitle(openCell)}</h3>
                {checks(openCell)}
                <ActionButton variant="secondary" onClick={() => setOpenDay(null)}>
                  {message("weekly.obs.hide")}
                </ActionButton>
              </section>
            ) : null}
            {line ? (
              <p className="weekly-line" data-tone={line.tone}>
                <Glyph name={line.glyph} />
                <span>{line.text}</span>
              </p>
            ) : null}
          </>
        )}
      </section>

      <section className="weekly-card" aria-label={message("weekly.type.title")}>
        <CardHead title={message("weekly.type.title")} infoKey="type" info={infoButton} />
        {!showTable ? (
          <p className="weekly-empty">{message("weekly.type.notStarted")}</p>
        ) : (
          <>
            {withheld ? <p className="weekly-empty">{message("weekly.type.notFull")}</p> : null}
            <table className="weekly-table">
              <thead>
                <tr>
                  <th scope="col">{column("type")}</th>
                  <th scope="col" className="weekly-num">
                    {column("total")}
                  </th>
                  <th scope="col" className="weekly-num">
                    {column("rated")}
                  </th>
                  {withheld ? null : <th scope="col">{column("ratio")}</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ group, sub }) => {
                  const parts = withheld ? null : ratioCells(group);
                  return (
                    <tr key={group.group} data-sub={sub || undefined} data-group={group.group}>
                      <td>{rowName(group.group, "cell")}</td>
                      <td className="weekly-num">{format.count(group.total)}</td>
                      <td className="weekly-num">{format.count(group.rated)}</td>
                      {withheld ? null : parts ? (
                        <td>
                          <div className="weekly-ratios">
                            {parts.map((part) => (
                              <div key={part.rating} className="weekly-ratio">
                                <span className="weekly-ratio-label">{part.label}</span>
                                {part.value}
                                <small>{part.range}</small>
                              </div>
                            ))}
                          </div>
                        </td>
                      ) : (
                        <td className="weekly-few">{message("weekly.few", { n: group.rated })}</td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="weekly-type-cards">
              {rows.map(({ group }) => {
                const parts = withheld ? null : ratioCells(group);
                return (
                  <div key={group.group} className="weekly-type-card" data-group={group.group}>
                    {rowName(group.group, "card")}
                    <div className="weekly-metric">
                      <span>{column("total")}</span>
                      <span>{format.count(group.total)}</span>
                    </div>
                    <div className="weekly-metric">
                      <span>{column("rated")}</span>
                      <span>{format.count(group.rated)}</span>
                    </div>
                    {withheld ? null : parts ? (
                      parts.map((part) => (
                        <div key={part.rating} className="weekly-metric">
                          <span>{part.label}</span>
                          <span>
                            {part.value}
                            <small>{part.range}</small>
                          </span>
                        </div>
                      ))
                    ) : (
                      <div className="weekly-metric" data-few>
                        <span>{column("ratio")}</span>
                        <span>{message("weekly.few", { n: group.rated })}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {otherButton}
          </>
        )}
      </section>

      {metrics ? (
        <section className="weekly-card" aria-label={message("weekly.stats.title")}>
          <CardHead title={message("weekly.stats.title")} infoKey="stats" info={infoButton} />
          <div className="weekly-tiles" data-count="4">
            {(
              [
                ["proactive.metric.spoke", metrics.spoke],
                ["proactive.metric.hits", metrics.hits],
                ["proactive.metric.misfires", metrics.misfires],
                ["proactive.metric.missed", metrics.missed],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="weekly-tile">
                <b>{format.count(value)}</b>
                <span>{message(label)}</span>
                {label === "proactive.metric.missed" ? (
                  <small>
                    {message("proactive.metric.reviewed", {
                      count: format.count(metrics.reviewed),
                    })}
                  </small>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="weekly-card" aria-label={message("weekly.muse.title")}>
        <CardHead title={message("weekly.muse.title")} infoKey="muse" info={infoButton} />
        {muse.entries === 0 ? (
          <p className="weekly-empty">{message("weekly.muse.empty")}</p>
        ) : (
          <>
            <MuseBucketTiles muse={muse} message={message} format={format} />
            <p className="weekly-muse-foot">
              <span>
                {message("weekly.muse.unpaired")} <b>{format.count(muse.unpaired)}</b>
              </span>
              {pairing && showTable ? (
                <span>
                  {message("weekly.muse.rate")}{" "}
                  <b>
                    {pairing.enough && pairing.value !== null
                      ? message("weekly.ratio", {
                          pct: format.percent(pairing.value),
                          k: format.count(pairing.successes),
                          n: format.count(pairing.samples),
                        })
                      : message("weekly.few", { n: pairing.samples })}
                  </b>
                </span>
              ) : null}
            </p>
          </>
        )}
      </section>

      <section className="weekly-card" aria-label={message("weekly.gap.title")}>
        <CardHead title={message("weekly.gap.title")} infoKey={null} info={infoButton} />
        {report.gap === null ? (
          <p className="weekly-empty">{message("weekly.gap.notFull")}</p>
        ) : report.gap.lines.every((line) => line.mails === 0) ? (
          <p className="weekly-empty">{message("weekly.gap.empty")}</p>
        ) : (
          <>
            <GapLines gap={report.gap} message={message} format={format} />
            <p className="weekly-muse-foot">{message("weekly.gap.note")}</p>
          </>
        )}
      </section>

      <section className="weekly-card" aria-label={message("weekly.cases.title")}>
        <CardHead title={message("weekly.cases.title")} infoKey={null} info={infoButton} />
        {report.gapCases.length === 0 ? (
          <p className="weekly-empty">{message("weekly.cases.empty")}</p>
        ) : (
          <>
            <ul className="weekly-cases">
              {report.gapCases.map((item) => (
                <li key={item.id} className="weekly-case" data-case-id={item.id}>
                  <span className="weekly-case-attr">
                    {message("weekly.cases.attr", { a: item.attribution })}
                  </span>
                  <div>
                    <b>{message("weekly.cases.muse")}</b>
                    <p>
                      {item.museTextWithheld
                        ? message("weekly.cases.withheld")
                        : [item.museTitle, item.museText].filter(Boolean).join(" · ") ||
                          message("weekly.cases.noText")}
                    </p>
                  </div>
                  <div>
                    <b>{message("weekly.cases.himawari")}</b>
                    <p>{message("weekly.cases.outcome", { o: item.himawariOutcome })}</p>
                    <p>{item.himawariReason ?? message("weekly.cases.noReason")}</p>
                    <p>
                      {message("weekly.cases.memory", {
                        m: item.memoryHits,
                        r: item.relatedMessages,
                      })}
                    </p>
                    <p>{message("weekly.cases.rating", { r: item.ownerRating ?? "none" })}</p>
                  </div>
                  {onOpenMail && item.messageId !== null ? (
                    <button
                      type="button"
                      className="weekly-case-open"
                      data-open-mail={item.id}
                      onClick={() =>
                        item.messageId !== null && onOpenMail(item.messageId, report.endDay)
                      }
                    >
                      {message("decision.email.open")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="weekly-case-mark"
                    aria-pressed={item.marked}
                    disabled={markBusy !== null}
                    onClick={() => void toggleMark(item.id, item.marked)}
                  >
                    {message("weekly.cases.mark", { on: item.marked ? "yes" : "no" })}
                  </button>
                </li>
              ))}
            </ul>
            {markFailed ? (
              <p className="weekly-muse-foot" role="alert">
                {message("weekly.cases.markFailed")}
              </p>
            ) : null}
            <p className="weekly-muse-foot">{message("weekly.cases.note")}</p>
          </>
        )}
      </section>

      <section className="weekly-card" aria-label={message("weekly.implicit.title")}>
        <CardHead title={message("weekly.implicit.title")} infoKey="implicit" info={infoButton} />
        {!showTable ? (
          <p className="weekly-empty">{message("weekly.type.notStarted")}</p>
        ) : report.implicit.pushedDecisions === 0 ? (
          <>
            <p className="weekly-empty">{message("weekly.implicit.empty")}</p>
            {report.implicit.otherDecisionEvents > 0 ? (
              <p className="weekly-muse-foot">
                {message("weekly.implicit.other", {
                  n: format.count(report.implicit.otherDecisionEvents),
                })}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <div className="weekly-tiles" data-count="3">
              {report.implicit.signals.map((item) => (
                <div key={item.signal} className="weekly-tile">
                  <b>
                    {item.rate?.enough && item.rate.value !== null
                      ? message("weekly.ratio", {
                          pct: format.percent(item.rate.value),
                          k: format.count(item.decisions),
                          n: format.count(report.implicit.pushedDecisions),
                        })
                      : withheld
                        ? message("weekly.implicit.notFull")
                        : message("weekly.few", { n: report.implicit.pushedDecisions })}
                  </b>
                  <span>{message("weekly.implicit.signal", { s: item.signal })}</span>
                  <small>
                    {item.medianDelayMs === null
                      ? message("weekly.implicit.delayNone")
                      : message("weekly.implicit.delay", {
                          t: implicitDelay(item.medianDelayMs, message, format),
                        })}
                  </small>
                </div>
              ))}
            </div>
            {report.implicit.otherDecisionEvents > 0 ? (
              <p className="weekly-muse-foot">
                {message("weekly.implicit.other", {
                  n: format.count(report.implicit.otherDecisionEvents),
                })}
              </p>
            ) : null}
          </>
        )}
      </section>

      <section className="weekly-card" aria-label={message("weekly.prereview.title")}>
        <CardHead title={message("weekly.prereview.title")} infoKey="prereview" info={infoButton} />
        {prereviewGroups.length === 0 ? (
          <p className="weekly-empty">
            {message(
              report.prereview.otherVersions > 0
                ? "weekly.prereview.emptyCurrent"
                : "weekly.prereview.empty",
            )}
          </p>
        ) : (
          <div className="weekly-tiles" data-count="3">
            {prereviewGroups.map((item) => (
              <div key={item.group} className="weekly-tile" data-prereview-group={item.group}>
                <b>
                  {item.agreement?.enough && item.agreement.value !== null
                    ? message("weekly.ratio", {
                        pct: format.percent(item.agreement.value),
                        k: format.count(item.agreement.successes),
                        n: format.count(item.agreement.samples),
                      })
                    : !report.complete
                      ? message("weekly.implicit.notFull")
                      : message("weekly.few", { n: item.paired })}
                </b>
                <span>{message("weekly.group", { g: item.group })}</span>
                <small>
                  {message("weekly.prereview.counts", {
                    rated: format.count(item.prereviewed),
                    unsure: format.count(item.unsure),
                    paired: format.count(item.paired),
                  })}
                </small>
                {item.gate ? (
                  <small data-gate={item.gate.reason}>
                    {message("weekly.prereview.gate", { r: item.gate.reason })}
                  </small>
                ) : null}
                {item.hidden && item.hidden.samples > 0 ? (
                  <small>
                    {message("weekly.prereview.audit", {
                      k: format.count(item.hidden.successes),
                      n: format.count(item.hidden.samples),
                    })}
                  </small>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {report.prereview.otherVersions > 0 ? (
          <p className="weekly-muse-foot">
            {message("weekly.prereview.otherVersions", {
              n: format.count(report.prereview.otherVersions),
            })}
          </p>
        ) : null}
        <p className="weekly-muse-foot">
          {report.prereview.reductionEnabled
            ? message("weekly.prereview.reductionOn", {
                audit: format.percent(report.prereview.auditPermille / 1000),
              })
            : message("weekly.prereview.reductionOff")}
        </p>
      </section>

      {report.mcpConnections ? (
        <section className="weekly-card" aria-label={message("agents.weekly.title")}>
          <h3>{message("agents.weekly.title")}</h3>
          <p className="weekly-muse-foot">
            {message("agents.weekly.window", {
              from: report.mcpConnections.fromDay,
              to: report.mcpConnections.toDay,
            })}
          </p>
          {report.mcpConnections.connections.length === 0 ? (
            <p className="weekly-empty">{message("agents.weekly.empty")}</p>
          ) : (
            <ul className="weekly-agents">
              {report.mcpConnections.connections.map((connection) => (
                <li key={connection.id} data-connection={connection.id}>
                  <strong>{connection.name}</strong>{" "}
                  <span>{message(`agents.status.${connection.status}`)}</span>
                  <McpUsageLines usage={connection.usage} message={message} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {report.correction ? (
        <section
          className="weekly-card"
          aria-label={message("weekly.correction.title")}
          data-correction=""
        >
          <CardHead title={message("weekly.correction.title")} infoKey={null} info={infoButton} />
          <div className="weekly-tiles" data-count="3">
            <div className="weekly-tile" data-correction-tile="agreement">
              <b>
                {report.correction.agreement?.enough && report.correction.agreement.value !== null
                  ? message("weekly.ratio", {
                      pct: format.percent(report.correction.agreement.value),
                      k: format.count(report.correction.agreed),
                      n: format.count(report.correction.handled),
                    })
                  : message("weekly.few", { n: report.correction.handled })}
              </b>
              <span>
                {message("weekly.correction.agreed", {
                  n: format.count(report.correction.handled),
                  k: format.count(report.correction.agreed),
                })}
              </span>
            </div>
            <div className="weekly-tile" data-correction-tile="missed">
              <b>{format.count(report.correction.missed)}</b>
              <span>{message("weekly.correction.missed")}</span>
            </div>
            <div className="weekly-tile" data-correction-tile="open">
              <b>{format.count(report.correction.openMemories + report.correction.openRules)}</b>
              <span>{message("weekly.correction.open")}</span>
            </div>
          </div>
          <p className="weekly-muse-foot">{message("weekly.correction.note")}</p>
        </section>
      ) : null}

      <div className="weekly-foot">
        <button type="button" className="weekly-link" onClick={onRate}>
          {message("weekly.goRate")}
          <Glyph name="forward" />
        </button>
      </div>

      {info && openInfo && !phone ? (
        <InfoPopover info={info} anchor={openInfo.anchor} onClose={closeInfo} />
      ) : null}
      {info && phone ? (
        <Sheet title={info.title} message={message} onClose={closeInfo}>
          <InfoBody info={info} />
        </Sheet>
      ) : null}
      {openCell && phone ? (
        <Sheet title={detailTitle(openCell)} message={message} onClose={() => setOpenDay(null)}>
          {checks(openCell)}
        </Sheet>
      ) : null}
      {confirming && chosen && earliest ? (
        <ModalDialog
          open
          closeOnBackdrop
          title={message("weekly.confirm.title", { day: format.day(chosen) })}
          closeLabel={message("common.close")}
          onClose={() => setConfirming(false)}
        >
          <div className="weekly-sheet weekly-confirm">
            <p className="weekly-strong">{message("weekly.confirm.fixed")}</p>
            <p>
              {message("weekly.confirm.earliest", {
                earliest: format.day(earliest),
                boot: format.day(addDays(earliest, -1)),
              })}
            </p>
            {confirmFailed ? (
              <p className="weekly-error" role="alert">
                {message("weekly.confirm.failed")}
              </p>
            ) : null}
            {reauthenticating === "cloudflare-access" ? (
              <>
                <p className="weekly-strong">{message("weekly.confirm.reauthAccess")}</p>
                <div className="weekly-confirm-actions">
                  <ActionButton variant="secondary" onClick={() => setReauthenticating(null)}>
                    {message("weekly.confirm.cancel")}
                  </ActionButton>
                  <ActionButton onClick={() => window.location.assign("/cdn-cgi/access/logout")}>
                    {message("weekly.confirm.relogin")}
                  </ActionButton>
                </div>
              </>
            ) : reauthenticating ? (
              <>
                <p className="weekly-strong">{message("weekly.confirm.reauth")}</p>
                <AccountLogin
                  csrfToken={reauthCsrfToken}
                  onCancel={() => setReauthenticating(null)}
                  onComplete={() => {
                    setReauthenticating(null);
                    void submitStart();
                  }}
                />
              </>
            ) : (
              <div className="weekly-confirm-actions">
                <ActionButton variant="secondary" onClick={() => setConfirming(false)}>
                  {message("weekly.confirm.cancel")}
                </ActionButton>
                <ActionButton pending={confirmBusy} onClick={() => void submitStart()}>
                  {message("weekly.confirm.ok")}
                </ActionButton>
              </div>
            )}
          </div>
        </ModalDialog>
      ) : null}
    </div>
  );
}
