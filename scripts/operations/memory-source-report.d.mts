export declare const SOURCE_STATES: readonly [
  "jump",
  "unavailable",
  "import",
  "owner",
  "deleted",
  "tidy",
];
export interface MemorySourceCounts {
  readonly total: number;
  readonly jump: number;
  readonly unavailable: number;
  readonly import: number;
  readonly owner: number;
  readonly deleted: number;
  readonly tidy: number;
}
export declare function countSources(database: unknown): MemorySourceCounts;
export declare function renderCounts(counts: MemorySourceCounts): string;
export declare function main(
  argv?: readonly string[],
  output?: { write(text: string): unknown },
): void;
