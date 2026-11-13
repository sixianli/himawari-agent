import { createHash } from "node:crypto";
import {
  DEFAULT_TOOL_REFUSALS,
  type ToolRefusalConfiguration,
} from "@himawari-agent/application/runtime-port";

export interface PiToolProgressState {
  readonly version: "pi-tool-progress.v1";
  readonly recent: readonly string[];
  readonly lastResult: string | null;
  readonly consecutive: number;
  readonly stopped: boolean;
  readonly fileConflicts?: number;
  readonly refusalsInARow?: number;
  readonly refusals?: number;
}

export type PiToolRefusalLimits = ToolRefusalConfiguration;

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
    .join(",")}}`;
}

const digest = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
const validHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export class PiToolProgressGuard {
  private recent: string[] = [];
  private lastResult: string | null = null;
  private consecutive = 0;
  private stopped = false;
  private fileConflicts = 0;
  private refusalsInARow = 0;
  private refusals = 0;
  private readonly limits: PiToolRefusalLimits;

  constructor(state?: PiToolProgressState, limits: PiToolRefusalLimits = DEFAULT_TOOL_REFUSALS) {
    if (
      !Number.isSafeInteger(limits.consecutive) ||
      !Number.isSafeInteger(limits.total) ||
      limits.consecutive < 1 ||
      limits.total < 1
    )
      throw new Error("PI_TOOL_REFUSAL_LIMITS_INVALID");
    this.limits = limits;
    if (state === undefined) return;
    if (
      state.version !== "pi-tool-progress.v1" ||
      !Array.isArray(state.recent) ||
      state.recent.length > 16 ||
      !state.recent.every(validHash) ||
      !(state.lastResult === null || validHash(state.lastResult)) ||
      !Number.isSafeInteger(state.consecutive) ||
      state.consecutive < 0 ||
      state.consecutive > 4 ||
      typeof state.stopped !== "boolean" ||
      (state.fileConflicts !== undefined &&
        (!Number.isSafeInteger(state.fileConflicts) ||
          state.fileConflicts < 0 ||
          state.fileConflicts > 4)) ||
      (state.refusalsInARow !== undefined && !count(state.refusalsInARow)) ||
      (state.refusals !== undefined && !count(state.refusals))
    )
      throw new Error("PI_TOOL_PROGRESS_STATE_INVALID");
    this.recent = [...state.recent];
    this.lastResult = state.lastResult;
    this.consecutive = state.consecutive;
    this.fileConflicts = state.fileConflicts ?? 0;
    this.refusalsInARow = state.refusalsInARow ?? 0;
    this.refusals = state.refusals ?? 0;
    this.stopped = state.stopped || this.fileConflicts >= 4 || this.refusalLimitReached();
  }

  get blocked(): boolean {
    return this.stopped;
  }

  private refusalLimitReached(): boolean {
    return this.refusalsInARow >= this.limits.consecutive || this.refusals >= this.limits.total;
  }

  observe(
    name: string,
    input: unknown,
    output: unknown,
    isError: boolean,
    errorCode?: string,
    refused = false,
  ): void {
    if (this.stopped) return;
    this.refusalsInARow = refused ? this.refusalsInARow + 1 : 0;
    if (refused) this.refusals += 1;
    if (isError && ["write", "edit"].includes(name) && errorCode === "FILE_VERSION_CONFLICT")
      this.fileConflicts++;
    const call = digest([name, input]);
    const result = digest([call, output, isError]);
    this.consecutive = result === this.lastResult ? this.consecutive + 1 : 1;
    this.lastResult = result;
    this.recent.push(call);
    if (this.recent.length > 16) this.recent.shift();
    this.stopped =
      this.refusalLimitReached() ||
      this.fileConflicts >= 4 ||
      this.consecutive >= 4 ||
      (this.recent.length >= 12 && new Set(this.recent.slice(-12)).size <= 2) ||
      (this.recent.length === 16 && new Set(this.recent).size <= 4);
  }

  snapshot(): PiToolProgressState {
    return {
      version: "pi-tool-progress.v1",
      recent: [...this.recent],
      lastResult: this.lastResult,
      consecutive: this.consecutive,
      stopped: this.stopped,
      fileConflicts: this.fileConflicts,
      refusalsInARow: this.refusalsInARow,
      refusals: this.refusals,
    };
  }
}
