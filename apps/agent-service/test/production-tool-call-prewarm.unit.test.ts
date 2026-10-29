import type { RuntimeRequest } from "@himawari-agent/application";
import { describe, expect, it } from "vitest";
import { toolCallSandboxPrewarm } from "../src/production-tool-call-prewarm.js";

const runRequest = (runId: string) => ({ runId }) as RuntimeRequest;
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("prewarming the sandbox when the model starts a tool call", () => {
  it("prewarms once per Run, only for enabled sandboxed tools, and reports the result", async () => {
    const prewarmed: string[] = [];
    const reports: Readonly<Record<string, unknown>>[] = [];
    let clock = 0;
    const started = toolCallSandboxPrewarm({
      enabledTools: ["bash", "write"],
      prewarm: async (request) => {
        prewarmed.push(request.runId);
        clock += 40;
        return true;
      },
      report: (event) => reports.push(event),
      now: () => clock,
    });

    started(runRequest("run:a"), "web_search");
    started(runRequest("run:a"), "edit");
    started(runRequest("run:a"), "read");
    expect(prewarmed).toEqual([]);

    started(runRequest("run:a"), "write");
    started(runRequest("run:a"), "bash");
    started(runRequest("run:b"), "bash");
    await settle();

    expect(prewarmed).toEqual(["run:a", "run:b"]);
    expect(reports).toEqual([
      {
        event: "sandbox.srt_prewarm.requested",
        runId: "run:a",
        tool: "write",
        requested: true,
        durationMs: 80,
      },
      {
        event: "sandbox.srt_prewarm.requested",
        runId: "run:b",
        tool: "bash",
        requested: true,
        durationMs: 40,
      },
    ]);
  });

  it("reports a failed prewarm without throwing into the model stream", async () => {
    const reports: Readonly<Record<string, unknown>>[] = [];
    const started = toolCallSandboxPrewarm({
      enabledTools: ["bash"],
      prewarm: () => {
        throw new Error("SANDBOX_TASK_ENVIRONMENT_UNAVAILABLE");
      },
      report: (event) => reports.push(event),
      now: () => 0,
    });

    expect(() => started(runRequest("run:c"), "bash")).not.toThrow();
    await settle();

    expect(reports).toEqual([
      {
        event: "sandbox.srt_prewarm.failed",
        runId: "run:c",
        tool: "bash",
        code: expect.any(String),
        durationMs: 0,
      },
    ]);
  });
});
