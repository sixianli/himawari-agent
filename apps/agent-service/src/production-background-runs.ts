import { createHash } from "node:crypto";
import {
  type AuthorityFence,
  type BackgroundRunRecord,
  type ClockPort,
  claimFromRunExecutionLease,
  type DataClassification,
  type FinishBackgroundRunInput,
  type RunBackgroundOutcome,
  type RunDispatchPort,
  type RunExecutionLease,
  type RunLifecyclePort,
} from "@himawari-agent/application";
import type {
  BackgroundCommandResult,
  ProductionBackgroundCommands,
} from "./production-background-commands.js";

type RunId = RunExecutionLease["runId"];

const CLASSIFICATIONS = ["public", "private", "sensitive", "restricted"] as const;
const RENEWAL_INTERVAL_MS = 10_000;
const LEASE_DURATION_MS = 30_000;
const FINISH_ATTEMPTS = 5;
const FINISH_RETRY_MS = 2_000;
const RELEASE_RETRY_MS = 2_000;

export interface ProductionBackgroundRunsOptions {
  readonly ownerId: RunExecutionLease["ownerId"];
  readonly agentId: RunExecutionLease["agentId"];
  readonly commands: ProductionBackgroundCommands;
  readonly dispatch: Pick<RunDispatchPort, "renew">;
  readonly runs: Pick<RunLifecyclePort, "finishBackgroundRun" | "listBackgroundRuns">;
  readonly resources?: {
    stopRun(runId: RunId, reason: "run_finished" | "run_cancelled"): Promise<{ released: boolean }>;
  };
  readonly storeNotice: (input: {
    readonly ref: string;
    readonly text: string;
    readonly dataClassification: DataClassification;
  }) => Promise<void>;
  readonly authority: () => AuthorityFence;
  readonly assertActive: () => Promise<void>;
  readonly clock: ClockPort;
  readonly onFailure?: (runId: RunId, error: unknown) => void;
  readonly renewalIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly finishRetryMs?: number;
  readonly releaseRetryMs?: number;
}

export class ProductionBackgroundRuns {
  readonly #options: ProductionBackgroundRunsOptions;
  readonly #held = new Map<string, Promise<void>>();

  constructor(options: ProductionBackgroundRunsOptions) {
    this.#options = options;
  }

  held(runId: RunId) {
    return this.#options.commands.held(runId);
  }

  async stop(runId: RunId): Promise<void> {
    await this.#options.commands.stopRun(runId);
  }

  async cancel(runId: RunId): Promise<boolean> {
    if (!this.#held.has(runId)) return false;
    await this.#options.commands.cancelRun(runId);
    return true;
  }

  holding(runId: RunId): boolean {
    return this.#held.has(runId);
  }

  adopt(lease: RunExecutionLease): void {
    if (this.#held.has(lease.runId)) return;
    const work = this.#hold(lease)
      .catch((error: unknown) => this.#options.onFailure?.(lease.runId, error))
      .finally(() => this.#held.delete(lease.runId));
    this.#held.set(lease.runId, work);
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.#held.values()]);
  }

  async recover(): Promise<number> {
    const records = (await this.#options.runs.listBackgroundRuns?.()) ?? [];
    let finished = 0;
    for (const record of records) {
      if (this.#held.has(record.runId) || record.leaseLive) continue;
      try {
        if (await this.#recoverOne(record)) finished += 1;
      } catch (error) {
        this.#options.onFailure?.(record.runId, error);
      }
    }
    return finished;
  }

  async #recoverOne(record: BackgroundRunRecord): Promise<boolean> {
    if (record.runStatus === "running" && !record.resourcesReleased) {
      const stopped = await this.#options.resources?.stopRun(record.runId, "run_finished");
      if (stopped && !stopped.released) return false;
    }
    const results = record.holds.map(
      (hold): BackgroundCommandResult =>
        this.#options.commands.result(hold.taskRef) ?? {
          taskRef: hold.taskRef,
          command: "",
          output: "",
          dataClassification: "private",
          outcome: "interrupted",
          notice: "",
          delivered: false,
        },
    );
    await this.#finish(record.runId, results, undefined);
    return true;
  }

  async #hold(lease: RunExecutionLease): Promise<void> {
    let current = lease;
    let renewalFailure: unknown;
    let renewing: Promise<void> | undefined;
    const interval = setInterval(() => {
      if (renewing || renewalFailure) return;
      renewing = (async () => {
        await this.#options.assertActive();
        const renewedAt = this.#options.clock.now();
        const renewed = await this.#options.dispatch.renew({
          runId: current.runId,
          expectedLeaseRevision: current.revision,
          executionLeaseId: current.executionLeaseId,
          renewedAt,
          expiresAt: new Date(
            Date.parse(renewedAt) + (this.#options.leaseDurationMs ?? LEASE_DURATION_MS),
          ).toISOString(),
        });
        if (renewed.releasedAt !== null || renewed.executionLeaseId !== current.executionLeaseId)
          throw new Error("BACKGROUND_RUN_LEASE_LOST");
        current = renewed;
      })()
        .catch((error: unknown) => {
          renewalFailure = error;
          void this.#options.commands.stopRun(current.runId);
        })
        .finally(() => {
          renewing = undefined;
        });
    }, this.#options.renewalIntervalMs ?? RENEWAL_INTERVAL_MS);
    interval.unref?.();
    try {
      const settled = await this.#options.commands.settled(lease.runId);
      const held = new Set(this.#options.commands.held(lease.runId).map((hold) => hold.taskRef));
      const results = settled.filter((result) => held.has(result.taskRef) || !result.delivered);
      if (renewing) await renewing;
      if (renewalFailure) throw renewalFailure;
      await this.#release(lease.runId, () => renewalFailure);
      clearInterval(interval);
      if (renewing) await renewing;
      if (renewalFailure) throw renewalFailure;
      await this.#finish(lease.runId, results, current);
    } finally {
      clearInterval(interval);
    }
  }

  async #release(runId: RunId, failure: () => unknown): Promise<void> {
    const resources = this.#options.resources;
    if (!resources) return;
    for (;;) {
      if ((await resources.stopRun(runId, "run_finished")).released) return;
      const lost = failure();
      if (lost) throw lost;
      await new Promise((resolve) =>
        setTimeout(resolve, this.#options.releaseRetryMs ?? RELEASE_RETRY_MS),
      );
    }
  }

  async #finish(
    runId: RunId,
    results: readonly BackgroundCommandResult[],
    lease: RunExecutionLease | undefined,
  ): Promise<void> {
    const finish = this.#options.runs.finishBackgroundRun;
    if (!finish || results.length === 0) return;
    const identity = createHash("sha256")
      .update(JSON.stringify(["background-notice", runId]))
      .digest("hex")
      .slice(0, 32);
    const dataClassification = CLASSIFICATIONS[
      Math.max(1, ...results.map((result) => CLASSIFICATIONS.indexOf(result.dataClassification)))
    ] as DataClassification;
    const contentRef = `background-notice:${identity}`;
    await this.#options.storeNotice({
      ref: contentRef,
      text: noticeText(results),
      dataClassification,
    });
    const outputRefs = new Map<string, string>();
    for (const result of results) {
      if (!result.output) continue;
      const ref = `background-output:${createHash("sha256")
        .update(JSON.stringify([runId, result.taskRef]))
        .digest("hex")
        .slice(0, 32)}`;
      await this.#options.storeNotice({
        ref,
        text: result.output,
        dataClassification: result.dataClassification,
      });
      outputRefs.set(result.taskRef, ref);
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < FINISH_ATTEMPTS; attempt += 1) {
      try {
        await this.#options.assertActive();
        await finish({
          ownerId: this.#options.ownerId,
          agentId: this.#options.agentId,
          runId,
          idempotencyKey:
            `background-finish:${identity}` as FinishBackgroundRunInput["idempotencyKey"],
          authority: lease
            ? { leaseId: lease.authorityLeaseId, fencingToken: lease.fencingToken }
            : this.#options.authority(),
          ...(lease ? { executionLease: claimFromRunExecutionLease(lease) } : {}),
          outcomes: results.map((result) => {
            const outputRef = outputRefs.get(result.taskRef);
            return {
              taskRef: result.taskRef,
              outcome: result.outcome,
              ...(outputRef ? { outputRef } : {}),
            };
          }),
          notice: {
            triggerId: `trigger:${identity}`,
            runId: `run:${identity}` as RunId,
            turnId: `turn:${identity}`,
            messageId: `message:${identity}`,
            contentRef,
            dataClassification,
          },
        });
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) =>
          setTimeout(resolve, this.#options.finishRetryMs ?? FINISH_RETRY_MS),
        );
      }
    }
    throw lastError;
  }
}

const OUTCOME_TEXT: Readonly<Record<RunBackgroundOutcome, string>> = {
  completed: "已运行结束",
  failed: "运行失败",
  stopped: "已被停止",
  timed_out: "超过时间上限，已被停止",
  interrupted: "Himawari 重启，命令被中断，结果没有拿到",
};

function noticeText(results: readonly BackgroundCommandResult[]): string {
  return [
    "【系统通知，不是用户发的消息】你在这个对话里早些时候转入后台的命令有了结果。请根据下面的结果，用一两句话主动告诉用户发生了什么、接下来建议做什么；用户可能在此期间聊了别的，结合对话上下文回答。",
    ...results.map((result) =>
      result.outcome === "interrupted"
        ? `任务 ${result.taskRef}：${OUTCOME_TEXT.interrupted}。不要假装知道结果；它可能只执行了一部分，重新执行前先核实已经产生的效果。`
        : [`任务 ${result.taskRef}：${OUTCOME_TEXT[result.outcome]}。`, result.notice].join("\n"),
    ),
  ].join("\n\n");
}
