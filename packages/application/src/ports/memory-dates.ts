import {
  MEMORY_DATE_ONGOING,
  MEMORY_DATE_RANGE,
  MEMORY_DATE_RECORDED,
  renderPrompt,
} from "@himawari-agent/prompt-catalog";
import type { ProductMemoryRecord } from "./memory-projection.js";

export interface MemoryDates {
  readonly recordedAt: string;
  readonly validFrom: string | null;
  readonly validTo: string | null;
}

const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/u;

export function memoryDatesOf(memory: ProductMemoryRecord): MemoryDates {
  return Object.freeze({
    recordedAt: memory.recordedAt ?? memory.updatedAt,
    validFrom: memory.attributes?.validFrom ?? null,
    validTo: memory.attributes?.validTo ?? null,
  });
}

function localDate(value: string, timeZone: string): string {
  if (PLAIN_DATE.test(value)) return value;
  const instant = new Date(value);
  if (Number.isNaN(instant.valueOf())) return value;
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
    return renderPrompt(MEMORY_DATE_RECORDED, { date: localDate(dates.recordedAt, timeZone) });
  const from = localDate(dates.validFrom ?? dates.recordedAt, timeZone);
  return dates.validTo === null
    ? renderPrompt(MEMORY_DATE_ONGOING, { from })
    : renderPrompt(MEMORY_DATE_RANGE, { from, to: localDate(dates.validTo, timeZone) });
}

export function isMemoryDates(value: unknown): value is MemoryDates {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const optionalText = (field: unknown) =>
    field === null || (typeof field === "string" && field.length > 0);
  return (
    Object.keys(record).length === 3 &&
    typeof record["recordedAt"] === "string" &&
    record["recordedAt"].length > 0 &&
    optionalText(record["validFrom"]) &&
    optionalText(record["validTo"])
  );
}
