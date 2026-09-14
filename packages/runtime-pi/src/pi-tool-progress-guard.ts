import { createHash } from "node:crypto";

/**
 * Adapted from Cindy's result-aware ToolLoopGuard: four identical observations,
 * a 12-call/two-input window, and a 16-call/four-input window. Pi retains loop
 * ownership; this product guard only decides when further work must stop.
 * State contains hashes only and travels inside the protected approval snapshot.
 */
export interface PiToolProgressState {
  readonly version: "pi-tool-progress.v1";
  readonly recent: readonly string[];
  readonly lastResult: string | null;
  readonly consecutive: number;
  readonly stopped: boolean;
}

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

  constructor(state?: PiToolProgressState) {
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
      typeof state.stopped !== "boolean"
    )
      throw new Error("PI_TOOL_PROGRESS_STATE_INVALID");
    this.recent = [...state.recent];
    this.lastResult = state.lastResult;
    this.consecutive = state.consecutive;
    this.stopped = state.stopped;
  }

  get blocked(): boolean {
    return this.stopped;
  }

  observe(name: string, input: unknown, output: unknown, isError: boolean): void {
    if (this.stopped) return;
    const call = digest([name, input]);
    const result = digest([call, output, isError]);
    this.consecutive = result === this.lastResult ? this.consecutive + 1 : 1;
    this.lastResult = result;
    this.recent.push(call);
    if (this.recent.length > 16) this.recent.shift();
    this.stopped =
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
    };
  }
}
