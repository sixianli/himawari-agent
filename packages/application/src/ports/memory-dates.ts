import {
  MEMORY_DATE_ONGOING,
  MEMORY_DATE_RANGE,
  MEMORY_DATE_RECORDED,
  MEMORY_DATE_UPCOMING,
  renderPrompt,
} from "@himawari-agent/prompt-catalog";
import type { ProductMemoryRecord } from "./memory-projection.js";

export interface MemoryDates {
  readonly recordedAt: string;
  readonly validFrom: string | null;
  readonly validTo: string | null;
}

const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function isDateText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (PLAIN_DATE.test(value)) return !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
  return ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value));
}

export function memoryDatesOf(memory: ProductMemoryRecord): MemoryDates {
  const validFrom = memory.attributes?.validFrom ?? null;
  const validTo = memory.attributes?.validTo ?? null;
  return Object.freeze({
    recordedAt: isDateText(memory.recordedAt) ? memory.recordedAt : memory.updatedAt,
    validFrom: isDateText(validFrom) ? validFrom : null,
    validTo: isDateText(validTo) ? validTo : null,
  });
}

export function memoryLocalDate(value: string, timeZone: string): string {
  if (PLAIN_DATE.test(value)) return value;
  const instant = new Date(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function memoryDateNote(dates: MemoryDates, timeZone: string): string {
  if (dates.validFrom === null && dates.validTo === null)
    return renderPrompt(MEMORY_DATE_RECORDED, {
      date: memoryLocalDate(dates.recordedAt, timeZone),
    });
  const from = memoryLocalDate(dates.validFrom ?? dates.recordedAt, timeZone);
  if (dates.validTo !== null)
    return renderPrompt(MEMORY_DATE_RANGE, { from, to: memoryLocalDate(dates.validTo, timeZone) });
  return from > memoryLocalDate(dates.recordedAt, timeZone)
    ? renderPrompt(MEMORY_DATE_UPCOMING, { from })
    : renderPrompt(MEMORY_DATE_ONGOING, { from });
}

export function isMemoryDates(value: unknown): value is MemoryDates {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    isDateText(record["recordedAt"]) &&
    (record["validFrom"] === null || isDateText(record["validFrom"])) &&
    (record["validTo"] === null || isDateText(record["validTo"]))
  );
}
