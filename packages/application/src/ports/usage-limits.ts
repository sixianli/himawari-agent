export type UsageLimitUnit =
  | "micro_usd"
  | "milliseconds"
  | "images"
  | "records"
  | "points"
  | "bytes"
  | "percent";

export type UsageLimitOnReach =
  | "stop_model_calls_resume_next_day"
  | "stop_listening_and_notify"
  | "transcribe_on_device"
  | "store_without_understanding"
  | "stop_low_value_types_first"
  | "keep_visits_only"
  | "process_on_device_only"
  | "drop_oldest_low_value_and_notify"
  | "lower_listening_quality_and_notify"
  | "existing_proactive_behavior";

export interface UsageLimitDefinition {
  readonly unit: UsageLimitUnit;
  readonly period: "owner_day";
  readonly counter: "server" | "device" | "proactive";
  readonly defaultLimit: number | null;
  readonly minimum: number;
  readonly maximum: number;
  readonly adjustable: boolean;
  readonly onReach: UsageLimitOnReach;
}

function limit(
  unit: UsageLimitUnit,
  counter: UsageLimitDefinition["counter"],
  defaultLimit: number | null,
  range: readonly [number, number],
  onReach: UsageLimitOnReach,
  adjustable = true,
): UsageLimitDefinition {
  return Object.freeze({
    unit,
    period: "owner_day",
    counter,
    defaultLimit,
    minimum: range[0],
    maximum: range[1],
    adjustable,
    onReach,
  });
}

const HOUR_MS = 3_600_000;
const GIBIBYTE = 1_073_741_824;
const MEBIBYTE = 1_048_576;

export const USAGE_LIMITS = Object.freeze({
  "perception.model_cost.daily": limit(
    "micro_usd",
    "server",
    1_000_000,
    [0, 1_000_000_000],
    "stop_model_calls_resume_next_day",
  ),
  "perception.audio.daily": limit(
    "milliseconds",
    "server",
    16 * HOUR_MS,
    [0, 24 * HOUR_MS],
    "stop_listening_and_notify",
  ),
  "perception.server_asr.daily": limit(
    "milliseconds",
    "server",
    4 * HOUR_MS,
    [0, 24 * HOUR_MS],
    "transcribe_on_device",
  ),
  "perception.images.daily": limit(
    "images",
    "server",
    500,
    [0, 100_000],
    "store_without_understanding",
  ),
  "perception.records.daily": limit(
    "records",
    "server",
    20_000,
    [0, 1_000_000],
    "stop_low_value_types_first",
  ),
  "perception.track.daily": limit("points", "server", 20_000, [0, 1_000_000], "keep_visits_only"),
  "perception.media.daily_bytes": limit(
    "bytes",
    "server",
    2 * GIBIBYTE,
    [0, 64 * GIBIBYTE],
    "process_on_device_only",
  ),
  "device.queue.bytes": limit(
    "bytes",
    "device",
    500 * MEBIBYTE,
    [MEBIBYTE, 64 * GIBIBYTE],
    "drop_oldest_low_value_and_notify",
  ),
  "device.battery.listening": limit(
    "percent",
    "device",
    null,
    [0, 100],
    "lower_listening_quality_and_notify",
    false,
  ),
  "proactive.dailyCostMicros": limit(
    "micro_usd",
    "proactive",
    null,
    [0, 1_000_000_000],
    "existing_proactive_behavior",
    false,
  ),
} as const satisfies Record<string, UsageLimitDefinition>);

export type UsageLimitKey = keyof typeof USAGE_LIMITS;
export const USAGE_LIMIT_KEYS = Object.freeze(Object.keys(USAGE_LIMITS) as UsageLimitKey[]);

export function isUsageLimitKey(value: unknown): value is UsageLimitKey {
  return typeof value === "string" && Object.hasOwn(USAGE_LIMITS, value);
}

export type UsageLimitState = "ok" | "near" | "stopped";

export interface UsageLimitView {
  readonly key: UsageLimitKey;
  readonly unit: UsageLimitUnit;
  readonly limit: number | null;
  readonly defaultLimit: number | null;
  readonly minimum: number;
  readonly maximum: number;
  readonly adjustable: boolean;
  readonly used: number;
  readonly devices: readonly { readonly deviceId: string; readonly used: number }[];
  readonly resetsAt: string;
  readonly onReach: UsageLimitOnReach;
  readonly state: UsageLimitState;
}

export function usageLimitState(
  used: number,
  limitValue: number | null,
  warnPermille: number,
): UsageLimitState {
  if (limitValue === null) return "ok";
  if (used >= limitValue) return "stopped";
  return used * 1000 >= limitValue * warnPermille ? "near" : "ok";
}
