import { describe, expect, it, vi } from "vitest";
import { createRunId } from "@himawari-agent/domain";
import type {
  AutomaticReviewRequest,
  ModelDescriptor,
  ModelInvocationEvent,
} from "../src/ports/index.js";
import { ModelActionReviewer } from "../src/services/model-action-reviewer.js";

const now = "2026-09-19T12:00:00.000Z";
const request: AutomaticReviewRequest = {
  schemaVersion: "automatic-review.v1",
  reviewId: "review:one",
  runId: createRunId("run:one"),
  inputRef: "payload:request",
  intentFingerprint: "intent.v2.sha256:" + "a".repeat(64),
  configurationVersion: "config:1",
  modelRef: "model:review",
  policyVersion: "policy:1",
  deadlineAt: "2026-09-19T12:00:30.000Z",
  approvalExpiresAt: "2026-09-19T12:05:00.000Z",
};
const descriptor: ModelDescriptor = {
  ref: request.modelRef,
  provider: "fixture",
  model: "fixture-model",
  version: "1",
  routingClass: "specialist",
  priority: 1,
  disclosure: "trusted_remote",
  capabilities: ["text"],
  allowedDataClassifications: ["private"],
  secretRequirement: null,
};
const decision = {
  schemaVersion: request.schemaVersion,
  reviewId: request.reviewId,
  intentFingerprint: request.intentFingerprint,
  configurationVersion: request.configurationVersion,
  modelRef: request.modelRef,
  policyVersion: request.policyVersion,
  decision: "approve",
  reasonCode: "WITHIN_DELEGATION",
};
function fixture(
  options: {
    events?: readonly ModelInvocationEvent[];
    text?: string;
    descriptor?: ModelDescriptor;
    authorizationDenied?: boolean;
    classification?: "private" | "restricted";
    maxOutputBytes?: number;
  } = {},
) {
  const calls: unknown[] = [];
  const events = options.events ?? [
    { type: "model.started", invocationId: request.reviewId, occurredAt: now },
    {
      type: "model.output",
      invocationId: request.reviewId,
      sequence: 1,
      payloadRef: "payload:output",
      occurredAt: now,
    },
    {
      type: "model.completed",
      invocationId: request.reviewId,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicros: 1,
      latencyMs: 1,
      occurredAt: now,
    },
  ];
  const authorize = vi.fn(async () => {
    if (options.authorizationDenied) throw Error("private disclosure denial");
    return {
      dataClassification: options.classification ?? "private",
      allowedDisclosureRef: "delegation:1",
      secretHandleRefs: [],
    };
  });
  const reviewer = new ModelActionReviewer({
    model: {
      listAvailable: async () => [options.descriptor ?? descriptor],
      invoke: async function* (input) {
        calls.push(input);
        yield* events;
      },
    },
    descriptor,
    configurationVersion: request.configurationVersion,
    authorize,
    readOutput: async () => options.text ?? JSON.stringify(decision),
    clock: { now: () => now },
    ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
  });
  return { reviewer, calls, authorize };
}
describe("automatic reviewer through the governed ModelPort", () => {
  it("uses the original review identity, protected references and cancellation without selecting another model", async () => {
    const f = fixture();
    const controller = new AbortController();
    expect(await f.reviewer.review(request, controller.signal)).toEqual(decision);
    expect(f.calls).toEqual([
      expect.objectContaining({
        invocationId: request.reviewId,
        runId: request.runId,
        modelRef: request.modelRef,
        inputRef: request.inputRef,
        allowedDisclosureRef: "delegation:1",
        signal: expect.any(AbortSignal),
      }),
    ]);
  });
  it.each([
    "model",
    "configuration",
    "expired",
    "aborted",
    "disclosure",
    "classification",
  ] as const)("does not invoke a model after %s rejection", async (mode) => {
    const f = fixture({
      authorizationDenied: mode === "disclosure",
      ...(mode === "classification" ? { classification: "restricted" as const } : {}),
    });
    const controller = new AbortController();
    if (mode === "aborted") controller.abort();
    const value = {
      ...request,
      ...(mode === "model" ? { modelRef: "other" } : {}),
      ...(mode === "configuration" ? { configurationVersion: "other" } : {}),
      ...(mode === "expired" ? { deadlineAt: now } : {}),
    };
    await expect(f.reviewer.review(value, controller.signal)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it.each([
    "mismatched",
    "sequence",
    "missing-completion",
    "provider-failed",
    "invalid-json",
    "oversized",
  ] as const)("rejects %s output rather than accepting partial success", async (mode) => {
    const output: ModelInvocationEvent = {
      type: "model.output",
      invocationId: mode === "mismatched" ? "other" : request.reviewId,
      sequence: mode === "sequence" ? 2 : 1,
      payloadRef: "payload:output",
      occurredAt: now,
    };
    const terminal: ModelInvocationEvent =
      mode === "provider-failed"
        ? {
            type: "model.failed",
            invocationId: request.reviewId,
            errorCode: "PRIVATE_DIAGNOSTIC",
            retryable: true,
            latencyMs: 1,
            occurredAt: now,
          }
        : {
            type: "model.completed",
            invocationId: request.reviewId,
            inputTokens: 1,
            outputTokens: 1,
            costMicros: 1,
            latencyMs: 1,
            occurredAt: now,
          };
    const f = fixture({
      events: mode === "missing-completion" ? [output] : [output, terminal],
      ...(mode === "invalid-json" ? { text: "approve" } : {}),
      ...(mode === "oversized" ? { maxOutputBytes: 8 } : {}),
    });
    await expect(f.reviewer.review(request, new AbortController().signal)).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  });
});

it("rejects descriptor changes behind the same model reference", async () => {
  const f = fixture({ descriptor: { ...descriptor, version: "2" } });
  await expect(f.reviewer.review(request, new AbortController().signal)).rejects.toThrow(
    "AUTOMATIC_REVIEW_MODEL_CHANGED",
  );
  expect(f.authorize).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
});
it.each([false, true])(
  "handles repeated output sequences without accepting changed content (%s)",
  async (changed) => {
    const output: ModelInvocationEvent = {
      type: "model.output",
      invocationId: request.reviewId,
      sequence: 1,
      payloadRef: "payload:output",
      occurredAt: now,
    };
    const terminal: ModelInvocationEvent = {
      type: "model.completed",
      invocationId: request.reviewId,
      inputTokens: 1,
      outputTokens: 1,
      costMicros: 1,
      latencyMs: 1,
      occurredAt: now,
    };
    const f = fixture({
      events: [
        output,
        { ...output, payloadRef: changed ? "payload:changed" : output.payloadRef },
        terminal,
      ],
    });
    if (changed)
      await expect(f.reviewer.review(request, new AbortController().signal)).rejects.toThrow(
        "AUTOMATIC_REVIEW_MODEL_OUTPUT_CHANGED",
      );
    else expect(await f.reviewer.review(request, new AbortController().signal)).toEqual(decision);
  },
);
it.each(["deadline", "caller"] as const)(
  "forwards %s cancellation to the active model stream",
  async (reason) => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let observed: AbortSignal | undefined;
      let enter: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const reviewer = new ModelActionReviewer({
        descriptor,
        configurationVersion: request.configurationVersion,
        clock: { now: () => now },
        authorize: async () => ({
          dataClassification: "private",
          allowedDisclosureRef: "delegation:1",
          secretHandleRefs: [],
        }),
        readOutput: async () => "",
        model: {
          listAvailable: async () => [descriptor],
          invoke: async function* (input) {
            observed = input.signal;
            enter();
            await new Promise<void>((resolve) => {
              input.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            yield* [] as ModelInvocationEvent[];
          },
        },
      });
      const rejected = expect(reviewer.review(request, controller.signal)).rejects.toThrow();
      await entered;
      if (reason === "deadline") await vi.advanceTimersByTimeAsync(30_000);
      else controller.abort();
      await rejected;
      expect(observed?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);
