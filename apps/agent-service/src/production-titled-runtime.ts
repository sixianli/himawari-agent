import type { AgentRuntimePort, RuntimeRequest } from "@himawari-agent/application";

interface BackgroundStart {
  start(request: RuntimeRequest): Promise<void>;
}

export interface ProductionTitledRuntimeOptions {
  readonly runtime: AgentRuntimePort;
  readonly prepareQueuedSandboxExecutions?: (request: RuntimeRequest) => Promise<void>;
  readonly titles?: BackgroundStart;
  readonly memoryCapture?: BackgroundStart;
  readonly memoryEpisodes?: BackgroundStart & {
    recordCompaction(request: RuntimeRequest, proposalRef: string): Promise<void>;
  };
  readonly memoryConsolidation?: BackgroundStart;
  readonly memoryPaused: () => Promise<boolean>;
}

const ADMISSION_BARRIER_EVENTS = new Set([
  "runtime.completed",
  "runtime.suspended",
  "runtime.result_unknown",
]);

export function createProductionTitledRuntime(
  options: ProductionTitledRuntimeOptions,
): AgentRuntimePort {
  const { runtime, titles, memoryCapture, memoryEpisodes, memoryConsolidation, memoryPaused } =
    options;
  return {
    cancel: (runId) => runtime.cancel(runId),
    async *run(request: RuntimeRequest) {
      await options.prepareQueuedSandboxExecutions?.(request);
      let requested = false;
      let titleAdmission: Promise<void> | undefined;
      let memoryAdmission: Promise<void> | undefined;
      for await (const event of runtime.run(request)) {
        if (!requested && event.type === "runtime.message" && event.role === "assistant") {
          requested = true;
          titleAdmission = titles?.start(request);
          if (memoryCapture)
            memoryAdmission = memoryCapture
              .start(request)
              .then(() => memoryPaused())
              .then(async (paused) => {
                if (paused) return;
                await memoryEpisodes?.start(request);
                await memoryConsolidation?.start(request);
              });
        }
        if (event.type === "runtime.compaction_proposed" && memoryEpisodes)
          void memoryPaused().then((paused) =>
            paused ? undefined : memoryEpisodes.recordCompaction(request, event.proposalRef),
          );
        if (ADMISSION_BARRIER_EVENTS.has(event.type)) {
          await titleAdmission;
          await memoryAdmission;
        }
        yield event;
      }
    },
  };
}
