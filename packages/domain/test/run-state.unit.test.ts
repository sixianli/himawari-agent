import { describe, expect, it } from "vitest";
import {
  DOMAIN_ERROR_CODES,
  DomainError,
  RUN_STATUSES,
  type Run,
  type RunStatus,
  createAgent,
  createAgentId,
  createIdempotencyKey,
  createOwner,
  createOwnerId,
  createRun,
  createRunId,
  createSession,
  createSessionId,
  createTrigger,
  createTriggerId,
  transitionRun,
} from "../src/index.js";

const legalTransitions: ReadonlyArray<readonly [RunStatus, RunStatus]> = [
  ["accepted", "building_context"],
  ["accepted", "failed"],
  ["accepted", "cancelled"],
  ["building_context", "running"],
  ["building_context", "failed"],
  ["building_context", "cancelled"],
  ["running", "awaiting_approval"],
  ["running", "reconciling_external_result"],
  ["running", "completed"],
  ["running", "failed"],
  ["running", "cancelled"],
  ["awaiting_approval", "running"],
  ["awaiting_approval", "failed"],
  ["awaiting_approval", "cancelled"],
  ["reconciling_external_result", "completed"],
  ["reconciling_external_result", "failed"],
  ["reconciling_external_result", "cancelled"],
];

const paths: Readonly<Record<RunStatus, ReadonlyArray<RunStatus>>> = {
  accepted: [],
  building_context: ["building_context"],
  running: ["building_context", "running"],
  awaiting_approval: ["building_context", "running", "awaiting_approval"],
  reconciling_external_result: ["building_context", "running", "reconciling_external_result"],
  completed: ["building_context", "running", "completed"],
  failed: ["failed"],
  cancelled: ["cancelled"],
};

function createAcceptedRun(): Run {
  const owner = createOwner(createOwnerId("owner-01"));
  const agent = createAgent({ id: createAgentId("agent-01"), owner });
  const session = createSession({ id: createSessionId("session-01"), agent });
  const trigger = createTrigger({
    id: createTriggerId("trigger-01"),
    idempotencyKey: createIdempotencyKey("message-01"),
    agent,
  });
  return createRun({ id: createRunId("run-01"), session, trigger });
}

function createRunAt(status: RunStatus): Run {
  return paths[status].reduce(transitionRun, createAcceptedRun());
}

function expectTransitionError(run: Run, next: RunStatus, code: string): void {
  try {
    transitionRun(run, next);
    throw new Error("Expected a DomainError");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

describe("Run state machine", () => {
  it.each(legalTransitions)("allows %s -> %s", (current, next) => {
    const run = createRunAt(current);
    const transitioned = transitionRun(run, next);

    expect(transitioned.status).toBe(next);
    expect(run.status).toBe(current);
    expect(transitioned).not.toBe(run);
    expect(Object.isFrozen(transitioned)).toBe(true);
  });

  const legalKeys = new Set(legalTransitions.map(([current, next]) => `${current}:${next}`));
  const illegalTransitions = RUN_STATUSES.flatMap((current) =>
    RUN_STATUSES.filter((next) => !legalKeys.has(`${current}:${next}`)).map(
      (next) => [current, next] as const,
    ),
  );

  it.each(illegalTransitions)("rejects %s -> %s", (current, next) => {
    const terminal = ["completed", "failed", "cancelled"].includes(current);
    expectTransitionError(
      createRunAt(current),
      next,
      terminal
        ? DOMAIN_ERROR_CODES.RUN_ALREADY_TERMINAL
        : DOMAIN_ERROR_CODES.INVALID_RUN_TRANSITION,
    );
  });

  it("supports repeated approval waits through running", () => {
    let run = createAcceptedRun();
    for (const status of [
      "building_context",
      "running",
      "awaiting_approval",
      "running",
      "awaiting_approval",
    ] as const) {
      run = transitionRun(run, status);
    }

    expect(run.status).toBe("awaiting_approval");
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "keeps terminal state %s immutable",
    (terminal) => {
      const run = createRunAt(terminal);
      for (const next of RUN_STATUSES) {
        expectTransitionError(run, next, DOMAIN_ERROR_CODES.RUN_ALREADY_TERMINAL);
      }
      expect(run.status).toBe(terminal);
    },
  );
});
