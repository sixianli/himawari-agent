import { performance } from "node:perf_hooks";

export interface StageTiming {
  mark(stage: string): void;
  finish(stage?: string): void;
}

export function stageTiming(
  event: string,
  fields: Readonly<Record<string, string | number | null | undefined>>,
  write: (line: string) => void = (line) => console.error(line),
  now: () => number = () => performance.now(),
): StageTiming {
  const started = now();
  let last = started;
  let finished = false;
  const stages: Record<string, number> = {};
  const mark = (stage: string) => {
    const current = now();
    stages[stage] = (stages[stage] ?? 0) + Math.round(current - last);
    last = current;
  };
  return {
    mark,
    finish(stage) {
      if (finished) return;
      if (stage !== undefined) mark(stage);
      finished = true;
      write(
        JSON.stringify({
          event,
          ...fields,
          stages,
          totalMs: Math.round(now() - started),
          at: new Date().toISOString(),
        }),
      );
    },
  };
}
