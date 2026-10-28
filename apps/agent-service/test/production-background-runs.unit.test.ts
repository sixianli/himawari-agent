import type {
  BackgroundRunRecord,
  FinishBackgroundRunInput,
  RunExecutionLease,
  RuntimeToolExecutionResult,
  RuntimeToolInvocation,
} from "@himawari-agent/application";
import { describe, expect, it, vi } from "vitest";
import { ProductionBackgroundCommands } from "../src/production-background-commands.js";
import { ProductionBackgroundRuns } from "../src/production-background-runs.js";

const ownerId = "owner-background" as RunExecutionLease["ownerId"];
const agentId = "agent-background" as RunExecutionLease["agentId"];
const runId = "run-background" as RunExecutionLease["runId"];

const bash = {
  runId,
  toolCallId: "call-tests",
  capabilityRef: "project.coding.bash",
  capabilityHandleRef: null,
  arguments: { command: "npm test" },
  dataClassification: "private",
  executionDeadlineAt: "2099-01-01T00:00:00.000Z",
} as unknown as RuntimeToolInvocation;

const lease = {
  runId,
  ownerId,
  agentId,
  executionLeaseId: "execution-background" as RunExecutionLease["executionLeaseId"],
  revision: 1,
  authorityLeaseId: "authority-lease" as RunExecutionLease["authorityLeaseId"],
  fencingToken: 3,
  deploymentId: "deployment-background" as RunExecutionLease["deploymentId"],
  authorityEpoch: 1,
  consumerId: "agent-service",
  claimedAt: "2026-10-27T00:00:00.000Z",
  expiresAt: "2026-10-27T00:00:30.000Z",
  releasedAt: null,
} as unknown as RunExecutionLease;

function controlled() {
  let resolve: (value: RuntimeToolExecutionResult) => void = () => undefined;
  const result = new Promise<RuntimeToolExecutionResult>((done) => {
    resolve = done;
  });
  const execute = vi.fn((signal: AbortSignal) => {
    signal.addEventListener("abort", () =>
      resolve({
        outcome: "result_unknown",
        resultRef: null,
        errorCode: "WORKER_AUTHORITY_WITHDRAWN",
        externalActionId: null,
        modelContent: "已请求停止。",
      }),
    );
    return result;
  });
  return { execute, resolve };
}

function harness(records: BackgroundRunRecord[] = []) {
  const commands = new ProductionBackgroundCommands({
    limits: { waitMs: 10, maximumMs: 60_000 },
    now: () => new Date().toISOString(),
  });
  const finished: FinishBackgroundRunInput[] = [];
  const notices: { ref: string; text: string }[] = [];
  const order: string[] = [];
  const failures: unknown[] = [];
  const renew = vi.fn(async () => ({ ...lease, replayed: false }));
  const stopRun = vi.fn(async () => {
    order.push("stop");
    return { released: true };
  });
  const runs = new ProductionBackgroundRuns({
    ownerId,
    agentId,
    commands,
    dispatch: { renew },
    runs: {
      finishBackgroundRun: async (input) => {
        order.push("finish");
        finished.push(input);
        return { finished: true, noticeRunId: input.notice.runId };
      },
      listBackgroundRuns: async () => records,
    },
    resources: { stopRun },
    storeNotice: async (input) => {
      notices.push(input);
    },
    authority: () => ({
      leaseId: "authority-current" as RunExecutionLease["authorityLeaseId"],
      fencingToken: 4,
    }),
    assertActive: async () => undefined,
    clock: { now: () => new Date().toISOString() },
    onFailure: (_runId, error) => failures.push(error),
    renewalIntervalMs: 5,
    finishRetryMs: 1,
  });
  const receipt = async () => ({ ref: "receipt" });
  return { commands, runs, finished, notices, order, failures, renew, stopRun, receipt };
}

function done(modelContent: string): RuntimeToolExecutionResult {
  return {
    outcome: "succeeded",
    resultRef: "payload-result",
    errorCode: null,
    externalActionId: null,
    modelContent,
  };
}

describe("ProductionBackgroundRuns", () => {
  it("[BG-3] keeps the lease alive, then stops the sandbox and starts the notice turn", async () => {
    const h = harness();
    const command = controlled();
    await h.commands.run(bash, undefined, command.execute, h.receipt);
    expect(h.runs.held(runId)).toHaveLength(1);
    h.runs.adopt(lease);
    expect(h.runs.holding(runId)).toBe(true);
    await vi.waitFor(() => expect(h.renew).toHaveBeenCalled());
    command.resolve(done("Tests 42 passed"));
    await h.runs.drain();
    expect(h.failures).toEqual([]);
    expect(h.order).toEqual(["stop", "finish"]);
    expect(h.finished[0]).toMatchObject({
      runId,
      authority: { leaseId: lease.authorityLeaseId, fencingToken: lease.fencingToken },
      executionLease: { executionLeaseId: lease.executionLeaseId },
      outcomes: [{ outcome: "completed" }],
      notice: { dataClassification: "private" },
    });
    expect(h.notices[0]?.text).toContain("系统通知");
    expect(h.notices[0]?.text).toContain("Tests 42 passed");
    expect(h.notices[0]?.ref).toBe(h.finished[0]?.notice.contentRef);
    expect(h.runs.holding(runId)).toBe(false);
  });

  it("[BG-3] reports a stop the owner asked for", async () => {
    const h = harness();
    const command = controlled();
    await h.commands.run(bash, undefined, command.execute, h.receipt);
    h.runs.adopt(lease);
    expect(await h.runs.cancel(runId)).toBe(true);
    await h.runs.drain();
    expect(h.finished[0]?.outcomes).toEqual([expect.objectContaining({ outcome: "stopped" })]);
    expect(h.notices[0]?.text).toContain("已被停止");
    expect(await h.runs.cancel(runId)).toBe(false);
  });

  it("[BG-3] stops the command and leaves recovery to restart when the lease is lost", async () => {
    const h = harness();
    h.renew.mockRejectedValue(new Error("lease gone"));
    const command = controlled();
    await h.commands.run(bash, undefined, command.execute, h.receipt);
    h.runs.adopt(lease);
    await h.runs.drain();
    expect(h.finished).toEqual([]);
    expect(h.failures).toHaveLength(1);
  });

  it("[BG-4] marks commands interrupted after a restart and finishes without a lease", async () => {
    const h = harness([
      {
        runId,
        threadId: "thread-background",
        holds: [
          {
            taskRef: "background-command:cccccccccccccccccccccccc",
            startedAt: "2026-10-27T00:00:00.000Z",
            deadlineAt: "2026-10-27T00:30:00.000Z",
          },
        ],
        runStatus: "running",
        leaseLive: false,
        resourcesReleased: false,
      },
      {
        runId: "run-still-held" as RunExecutionLease["runId"],
        threadId: "thread-background",
        holds: [],
        runStatus: "running",
        leaseLive: true,
        resourcesReleased: true,
      },
    ]);
    expect(await h.runs.recover()).toBe(1);
    expect(h.stopRun).toHaveBeenCalledWith(runId, "run_finished");
    expect(h.finished).toHaveLength(1);
    expect(h.finished[0]).toMatchObject({
      authority: { fencingToken: 4 },
      outcomes: [
        { taskRef: "background-command:cccccccccccccccccccccccc", outcome: "interrupted" },
      ],
    });
    expect(h.finished[0]?.executionLease).toBeUndefined();
    expect(h.notices[0]?.text).toContain("重启");
  });

  it("[BG-4] waits for the sandbox to be released before finishing an interrupted Run", async () => {
    const h = harness([
      {
        runId,
        threadId: "thread-background",
        holds: [
          {
            taskRef: "background-command:dddddddddddddddddddddddd",
            startedAt: "2026-10-27T00:00:00.000Z",
            deadlineAt: "2026-10-27T00:30:00.000Z",
          },
        ],
        runStatus: "running",
        leaseLive: false,
        resourcesReleased: false,
      },
    ]);
    h.stopRun.mockResolvedValueOnce({ released: false });
    expect(await h.runs.recover()).toBe(0);
    expect(h.finished).toEqual([]);
  });
});
