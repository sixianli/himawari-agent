import type {
  ThreadExecutionRecord,
  ThreadGatewaySnapshot,
} from "@himawari-agent/gateway-contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ChatHistory } from "../src/components/chat-history.js";

type Detail = Extract<ThreadGatewaySnapshot, { type: "thread.detail_snapshot" }>;
function render(
  status: Detail["payload"]["runs"][number]["status"],
  kind: "message" | "tool",
  phase: ThreadExecutionRecord["phase"],
) {
  const detail: Detail = {
    schemaVersion: "gateway.thread.v3",
    kind: "snapshot",
    type: "thread.detail_snapshot",
    messageId: "snapshot:one",
    correlationId: "query:one",
    causationId: null,
    scope: { ownerId: "owner:test", agentId: "agent:test" },
    authority: { deploymentId: "deployment:test", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType: "system", actorId: "system:test" },
    payload: {
      thread: {
        threadId: "thread:test",
        revision: 1,
        status: "active",
        titleRef: null,
        titleSource: null,
        titleRevision: 0,
        pinOrder: null,
        answerLocale: "zh-CN",
        messageWatermark: 0,
        createdAt: "2026-09-11T00:00:00Z",
        updatedAt: "2026-09-11T00:00:12Z",
      },
      snapshotRef: "snapshot:one",
      generatedAt: "2026-09-11T00:00:12Z",
      nextSequence: null,
      messages: [],
      runs: [
        {
          runId: "run:cancel",
          revision: 1,
          status,
          createdAt: "2026-09-11T00:00:00Z",
          updatedAt: "2026-09-11T00:00:12Z",
        },
      ],
    },
  };
  const records: ThreadExecutionRecord[] = [
    {
      id: "event:partial",
      itemId: "output:one",
      sequence: 1,
      kind,
      phase,
      name: kind === "tool" ? "write" : "",
      text: "保留的部分回答",
      input: "",
      output: "",
      occurredAt: "2026-09-11T00:00:02Z",
    },
  ];
  return renderToStaticMarkup(
    createElement(ChatHistory, {
      detail,
      contentByRef: {},
      execution: { "run:cancel": records },
      connection: "connected",
      message: (id) => id,
      onFork: () => {},
      renderApproval: () => null,
    }),
  );
}
it("stops the partial output label when a Run is cancelled, while preserving its text", () => {
  const html = render("cancelled", "message", "updated");
  expect(html).toContain("保留的部分回答");
  expect(html).toContain("chat.phase.stopped");
  expect(html).not.toContain("chat.phase.updated");
});
it("does not infer a tool result or completed output from a terminal Run", () => {
  expect(render("cancelled", "tool", "started")).toContain("chat.recordUnavailable");
  expect(render("failed", "message", "updated")).toContain("chat.recordUnavailable");
  expect(render("completed", "message", "updated")).toContain("chat.recordUnavailable");
  expect(render("cancelled", "message", "completed")).toContain("chat.phase.completed");
});
it("keeps active partial outputs marked as streaming", () => {
  expect(render("running", "message", "updated")).toContain("chat.phase.updated");
});
