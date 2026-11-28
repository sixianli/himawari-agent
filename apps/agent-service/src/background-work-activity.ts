import { createHash } from "node:crypto";
import {
  BACKGROUND_WORK_ACTIVITY_ATTRIBUTES_TYPE,
  type BackgroundWorkActivityPhase,
} from "@himawari-agent/application";
import type { ThreadBackgroundWork } from "@himawari-agent/gateway-contracts";

export { BACKGROUND_WORK_ACTIVITY_ATTRIBUTES_TYPE };

export type BackgroundWorkSubthread = ThreadBackgroundWork["matters"][number]["subthreads"][number];

export interface BackgroundWorkEntry {
  readonly matter: string;
  readonly subthread: BackgroundWorkSubthread;
}

export interface BackgroundWorkContentState {
  readonly phase: BackgroundWorkActivityPhase;
  readonly step: number;
  readonly stepCount: number;
  readonly completedCount: number;
  readonly activity: string | null;
  readonly updatedAt: string;
}

const LIVE_ACTIVITIES: ReadonlySet<BackgroundWorkSubthread["activity"]> = new Set([
  "queued",
  "running",
  "waiting_answer",
  "waiting_result",
  "over_budget",
]);

const OWNER_ACTIVITIES: ReadonlySet<BackgroundWorkSubthread["activity"]> = new Set([
  "waiting_answer",
  "over_budget",
]);

export const BACKGROUND_ACTIVITY_TEXT_BYTES = 240;

export function backgroundWorkEntries(work: ThreadBackgroundWork): readonly BackgroundWorkEntry[] {
  return work.matters.flatMap(({ matter, subthreads }) =>
    subthreads.map((subthread) => ({ matter, subthread })),
  );
}

export function isBackgroundWorkFinished(subthread: BackgroundWorkSubthread): boolean {
  return subthread.status !== "open" || subthread.activity === "finished";
}

export function isBackgroundWorkLive(subthread: BackgroundWorkSubthread): boolean {
  return subthread.status === "open" && LIVE_ACTIVITIES.has(subthread.activity);
}

export function backgroundWorkContentState(
  subthread: BackgroundWorkSubthread,
  clip: (text: string, bytes: number) => string,
): BackgroundWorkContentState {
  const stepCount = subthread.tasks.length;
  const completedCount = subthread.tasks.filter(({ status }) => status === "completed").length;
  const current =
    subthread.tasks.find(({ status }) => status === "in_progress") ??
    subthread.tasks.find(({ status }) => status === "pending");
  const text = (current?.activeForm ?? current?.subject ?? subthread.progress ?? "").trim();
  const finished = isBackgroundWorkFinished(subthread);
  return {
    phase: finished
      ? "finished"
      : OWNER_ACTIVITIES.has(subthread.activity)
        ? "waiting_for_owner"
        : "working",
    step: stepCount === 0 ? 0 : Math.min(completedCount + 1, stepCount),
    stepCount,
    completedCount: finished && stepCount > 0 ? stepCount : completedCount,
    activity: finished || text === "" ? null : clip(text, BACKGROUND_ACTIVITY_TEXT_BYTES),
    updatedAt: subthread.updatedAt,
  };
}

export function backgroundWorkStateDigest(state: BackgroundWorkContentState): string {
  const { updatedAt: _updatedAt, ...rest } = state;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}
