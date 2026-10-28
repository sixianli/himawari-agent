import type { RunSummary } from "./execution-view.js";

export type BackgroundCommandState =
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "timed_out"
  | "interrupted";

export interface BackgroundCommandView {
  readonly key: string;
  readonly runId: string;
  readonly turn: number;
  readonly label: string | undefined;
  readonly state: BackgroundCommandState;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly endedAt: string | null;
  readonly noticeRunId: string | null;
  readonly output: string | undefined;
  readonly outputPending: boolean;
  readonly run: RunSummary;
}

export function backgroundCommands(
  runs: readonly RunSummary[],
  contentByRef: Readonly<Record<string, string>>,
): readonly BackgroundCommandView[] {
  return runs.flatMap((run, index) =>
    run.backgroundCommands.map((command) => ({
      key: command.taskRef,
      runId: run.runId,
      turn: index + 1,
      label: command.commandRef ? contentByRef[command.commandRef] : undefined,
      state: command.endedAt === null ? "running" : (command.outcome ?? "completed"),
      startedAt: command.startedAt,
      deadlineAt: command.deadlineAt,
      endedAt: command.endedAt,
      noticeRunId: command.noticeRunId,
      output: command.outputRef ? contentByRef[command.outputRef] : undefined,
      outputPending: command.outputRef !== null && contentByRef[command.outputRef] === undefined,
      run,
    })),
  );
}

export function backgroundPayloadRefs(runs: readonly RunSummary[]): readonly string[] {
  return runs.flatMap((run) =>
    run.backgroundCommands.flatMap((command) =>
      [command.commandRef, command.outputRef].filter((ref): ref is string => ref !== null),
    ),
  );
}

export const runningBackgroundCommands = (commands: readonly BackgroundCommandView[]) =>
  commands.filter((command) => command.state === "running");
