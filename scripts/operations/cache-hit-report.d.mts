import type Database from "better-sqlite3";

export const MINIMUM_CACHEABLE_INPUT_TOKENS: number;
export const MINIMUM_REPORTED_REQUESTS: number;
export const GROUPINGS: readonly string[];

export type CacheHitGrouping = "purpose" | "model" | "day" | "purpose-model" | "turn";

export interface CacheHitRow {
  readonly group: string;
  readonly requests: number;
  readonly reported: number;
  readonly unreported: number;
  readonly tooShort: number;
  readonly measured: number;
  readonly hitRate: number | null;
  readonly followUps: number;
  readonly followUpHitRate: number | null;
}

export interface CacheHitOptions {
  readonly grouping?: CacheHitGrouping;
  readonly since?: string | null;
  readonly until?: string | null;
}

export function summarize(database: Database.Database, options?: CacheHitOptions): CacheHitRow[];
export function renderTable(rows: readonly CacheHitRow[]): string;
export function main(argv?: readonly string[], output?: { write(text: string): unknown }): void;
