import { Worker } from "node:worker_threads";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createGovernedPiCodingTools } from "./governed-coding-tools.ts";
import { createPiOperationsFromGovernedHostPort } from "./governed-host-operations.ts";

/** Only write/edit definitions, bound to an immutable in-memory snapshot. No
 * filesystem mutation, search process or model call is available through this adapter.
 * Pi owns argument normalization, edit matching, line endings and result shaping. */
export type PiFilePreparationInput = {
  readonly tool: "write" | "edit";
  readonly toolCallId: string;
  readonly cwd: string;
  readonly targetPath: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly before: Uint8Array | null;
  readonly signal?: AbortSignal;
};

/** Internal computation, executed only by the bounded preparation worker. */
export async function computePiFileMutation(input: PiFilePreparationInput) {
  input = { ...input, parameters: structuredClone(input.parameters) };
  const before = input.before === null ? null : new Uint8Array(input.before);
  let candidate: string | undefined;
  const check = (path: string) => {
    input.signal?.throwIfAborted();
    if (path !== input.targetPath) throw new Error("PI_FIXED_TARGET_CHANGED");
  };
  const forbidden = async (): Promise<never> => {
    throw new Error("PI_PREPARATION_OPERATION_DENIED");
  };
  const [tool] = createGovernedPiCodingTools({
    cwd: input.cwd,
    enabled: [input.tool],
    operations: createPiOperationsFromGovernedHostPort({
      async access(path) {
        check(path);
        if (before === null) throw new Error("PI_FILE_MISSING");
      },
      async readFile(path) {
        check(path);
        if (before === null) throw new Error("PI_FILE_MISSING");
        return new Uint8Array(before);
      },
      async makeDirectory() {
        input.signal?.throwIfAborted();
      },
      async writeFile(path, content) {
        check(path);
        if (candidate !== undefined) throw new Error("PI_MULTIPLE_WRITES_UNSUPPORTED");
        if (Buffer.byteLength(content) > 16 * 1024 * 1024) throw new Error("PI_WRITE_LIMIT");
        candidate = content;
      },
      executeCommand: forbidden,
    }),
  });
  if (!tool) throw new Error("PI_TOOL_DEFINITION_MISSING");
  const normalized = tool.prepareArguments
    ? tool.prepareArguments(structuredClone(input.parameters))
    : structuredClone(input.parameters);
  const parameters = validateToolArguments(tool, {
    type: "toolCall",
    id: input.toolCallId,
    name: input.tool,
    arguments: normalized as Record<string, unknown>,
  });
  const result = await tool.execute(
    input.toolCallId,
    parameters,
    input.signal,
    undefined,
    {} as never,
  );
  input.signal?.throwIfAborted();
  if (candidate === undefined) throw new Error("PI_PREPARATION_INCOMPLETE");
  return {
    bytes: new TextEncoder().encode(candidate),
    result: {
      ...result,
      ...(input.tool === "write"
        ? {
            content: [
              {
                type: "text" as const,
                text: `Successfully wrote ${Buffer.byteLength(candidate)} bytes to ${String(input.parameters["path"])}`,
              },
            ],
          }
        : {}),
      isError: false,
    },
  };
}

/** The worker isolates synchronous Pi matching/diff work from the Agent loop.
 * Heap limits are V8 limits, not an OS RSS/sandbox qualification. Buffers and
 * published candidates have separate byte limits. A wall bound no greater than
 * the requested CPU allowance conservatively bounds this single JS computation.
 */
export async function preparePiFileMutation(
  input: PiFilePreparationInput & {
    readonly limits: {
      readonly maxWallTimeMs: number;
      readonly maxCpuTimeMs: number;
      readonly maxMemoryBytes: number;
    };
  },
): Promise<Awaited<ReturnType<typeof computePiFileMutation>>> {
  input.signal?.throwIfAborted();
  const milliseconds = Math.min(input.limits.maxWallTimeMs, input.limits.maxCpuTimeMs);
  const memoryMb = Math.floor(input.limits.maxMemoryBytes / 1048576);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 2147483647)
    throw new Error("PI_PREPARATION_TIME_LIMIT");
  if (!Number.isSafeInteger(memoryMb) || memoryMb < 32)
    throw new Error("PI_PREPARATION_MEMORY_LIMIT");
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const { signal, limits: _limits, ...data } = input;
  const worker = new Worker(
    new URL(`./prepare-file-mutation-worker.${extension}`, import.meta.url),
    {
      workerData: data,
      // Do not inherit parent heap flags, which override resourceLimits.
      execArgv: [],
      resourceLimits: {
        maxOldGenerationSizeMb: Math.floor(memoryMb * 0.75),
        maxYoungGenerationSizeMb: Math.floor(memoryMb * 0.125),
        codeRangeSizeMb: Math.floor(memoryMb * 0.0625),
        stackSizeMb: Math.floor(memoryMb * 0.0625),
      },
    },
  );
  return awaitPiPreparationWorker(worker, milliseconds, signal);
}

/** Internal lifecycle seam: tests use a real busy worker to observe stop proof. */
export function awaitPiPreparationWorker(
  worker: Worker,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof computePiFileMutation>>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: Awaited<ReturnType<typeof computePiFileMutation>>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // Resolve only after the computation can no longer run.
      void worker.terminate().then(() => {
        if (error) reject(error);
        else if (result) resolve(result);
        else reject(new Error("PI_PREPARATION_INCOMPLETE"));
      }, reject);
    };
    const abort = () => finish(new Error("PI_PREPARATION_CANCELLED"));
    const timer = setTimeout(() => finish(new Error("PI_PREPARATION_TIME_LIMIT")), milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("error", (error) => finish(error));
    worker.once("exit", () => finish(new Error("PI_PREPARATION_WORKER_EXITED")));
    worker.on("message", (message) => {
      if (message.kind === "started") return;
      if (message.ok) finish(undefined, message.value);
      else finish(new Error(message.error));
    });
    if (signal?.aborted) abort();
  });
}
