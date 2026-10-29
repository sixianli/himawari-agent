import { performance } from "node:perf_hooks";
import type { RuntimeRequest } from "@himawari-agent/application";
import { stableErrorCode } from "@himawari-agent/platform-node";

const SANDBOXED_TOOLS = new Set(["bash", "write", "edit"]);
const MAXIMUM_REMEMBERED_RUNS = 256;

export interface ToolCallSandboxPrewarmOptions {
  readonly enabledTools: readonly string[];
  readonly prewarm: (request: RuntimeRequest) => Promise<boolean>;
  readonly report: (event: Readonly<Record<string, string | number | boolean>>) => void;
  readonly now?: () => number;
}

export function toolCallSandboxPrewarm(
  options: ToolCallSandboxPrewarmOptions,
): (request: RuntimeRequest, toolName: string) => void {
  const now = options.now ?? (() => performance.now());
  const started = new Set<string>();
  return (request, toolName) => {
    if (!SANDBOXED_TOOLS.has(toolName) || !options.enabledTools.includes(toolName)) return;
    if (started.has(request.runId)) return;
    started.add(request.runId);
    if (started.size > MAXIMUM_REMEMBERED_RUNS) {
      const oldest = started.values().next().value;
      if (oldest !== undefined) started.delete(oldest);
    }
    const startedAt = now();
    let pending: Promise<boolean>;
    try {
      pending = options.prewarm(request);
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (requested) =>
        options.report({
          event: "sandbox.srt_prewarm.requested",
          runId: request.runId,
          tool: toolName,
          requested,
          durationMs: Math.round(now() - startedAt),
        }),
      (error: unknown) =>
        options.report({
          event: "sandbox.srt_prewarm.failed",
          runId: request.runId,
          tool: toolName,
          code: stableErrorCode(error),
          durationMs: Math.round(now() - startedAt),
        }),
    );
  };
}
