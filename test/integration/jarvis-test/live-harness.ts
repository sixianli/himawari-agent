import { spawn } from "node:child_process";
import { access, chmod, chown, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  GovernedCodingOperationsPort,
  ModelInvocationAdmissionResolver,
  ModelInvocationUsage,
  RuntimeEvent,
  RuntimeProjectionPort,
  RuntimeRequest,
  RuntimeToolDescriptor,
  RuntimeToolExecutionResult,
  RuntimeToolInvocation,
  RuntimeToolPort,
} from "@himawari-agent/application";
import { ContextProjectionService, type RunExecutionSource } from "@himawari-agent/application";
import { createRunId } from "@himawari-agent/domain";
import { executeSandboxedPiCodingTool, PiAgentRuntimeAdapter } from "@himawari-agent/runtime-pi";
import { testModelEgress } from "@himawari-agent/testing";
import { createProductionModelCompositionFromConfiguration } from "../../../apps/agent-service/src/production-model-composition.js";
import { createProductionRunPolicy } from "../../../apps/agent-service/src/production-run-policy.js";
import { ProductionRuntimeTools } from "../../../apps/agent-service/src/production-runtime-tools.js";
import {
  AI_GATEWAY_GENERATION_SNAPSHOT,
  AI_GATEWAY_PRIMARY_MODEL,
  createAiGatewayLiveConfiguration,
} from "../fixtures/openrouter-live-configuration.ts";
import type {
  CaseFailure,
  CasePermissions,
  CaseToolResult,
  JarvisCase,
  JarvisDataset,
} from "./cases.ts";
import { AGENT_ID, assembleContext, MEMORY_LIMIT, OWNER_ID } from "./context.ts";
import type { TrialContext } from "./grade.ts";
import { fileBytes, type Transcript, type TranscriptStep } from "./graders.ts";

export const SUBJECT_MODEL = {
  id: AI_GATEWAY_PRIMARY_MODEL,
  version: AI_GATEWAY_GENERATION_SNAPSHOT,
};
export const LIVE_SYSTEM_INSTRUCTION = "按用户请求执行已授权任务。";
const COMMAND_TIMEOUT_MS = 30_000;
const UNPRIVILEGED = 65_534;
const RUN_AS_ROOT = process.getuid?.() === 0;
const COMMAND_PATH = [path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(
  ":",
);
const CODING_TOOLS = ["read", "write", "edit", "bash", "find", "grep", "ls"] as const;
type CodingTool = (typeof CODING_TOOLS)[number];

export interface TrialUsage {
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  costReported: boolean;
}

export interface TrialResult {
  readonly transcript: Transcript;
  readonly context: TrialContext;
  readonly workspaceRoot: string;
  readonly events: readonly RuntimeEvent["type"][];
  readonly outcome: "completed" | "failed" | "cancelled" | "stopped_by_limit";
  readonly errorCode: string | null;
}

export interface TrialOptions {
  readonly dataset: JarvisDataset;
  readonly item: JarvisCase;
  readonly root: string;
  readonly trial: number;
  readonly secret: () => Promise<string>;
  readonly usage: TrialUsage;
  readonly overLimit: () => boolean;
  readonly fetch?: typeof globalThis.fetch;
}

async function chownTree(target: string): Promise<void> {
  await chown(target, UNPRIVILEGED, UNPRIVILEGED);
  for (const entry of await readdir(target, { withFileTypes: true }))
    if (entry.isDirectory()) await chownTree(path.join(target, entry.name));
    else await chown(path.join(target, entry.name), UNPRIVILEGED, UNPRIVILEGED);
}

export async function prepareWorkspace(item: JarvisCase, workspaceRoot: string): Promise<void> {
  await mkdir(workspaceRoot, { recursive: true });
  for (const file of item.files ?? []) {
    const target = path.join(workspaceRoot, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, fileBytes(file));
  }
  if (RUN_AS_ROOT) await chownTree(workspaceRoot);
  const restrict = async (relative: string, mode: number) => {
    const target = path.join(workspaceRoot, relative);
    if (RUN_AS_ROOT) await chown(target, 0, 0);
    await chmod(target, mode);
  };
  for (const relative of item.permissions?.readOnly ?? []) await restrict(relative, 0o555);
  for (const relative of item.permissions?.unreadable ?? []) await restrict(relative, 0o000);
}

async function reopenTree(directory: string): Promise<void> {
  try {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (entry.isDirectory()) await reopenTree(path.join(directory, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function removeWorkspace(workspaceRoot: string): Promise<void> {
  await reopenTree(workspaceRoot);
  await rm(workspaceRoot, { recursive: true, force: true });
}

function within(target: string, ancestor: string): boolean {
  const relative = path.relative(ancestor, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function permissionDenied(workspaceRoot: string, target: string, call: string): Error {
  return new Error(
    `EACCES: permission denied, ${call} '${path.relative(workspaceRoot, target) || "."}'`,
  );
}

function injected(failures: readonly CaseFailure[], tool: string, subject: string) {
  return failures.find((failure) => failure.tool === tool && subject.includes(failure.match));
}

function runCommand(input: {
  readonly command: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onData: (data: Uint8Array) => void;
}): Promise<{ readonly exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", input.command], {
      cwd: input.cwd,
      env: { PATH: COMMAND_PATH, HOME: input.cwd, LANG: "C.UTF-8" },
      ...(RUN_AS_ROOT ? { uid: UNPRIVILEGED, gid: UNPRIVILEGED } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(
      () => {
        child.kill("SIGKILL");
        reject(new Error("PI_COMMAND_TIMEOUT"));
      },
      Math.min(input.timeoutMs ?? COMMAND_TIMEOUT_MS, COMMAND_TIMEOUT_MS),
    );
    const abort = () => {
      child.kill("SIGKILL");
      reject(new Error("PI_COMMAND_ABORTED"));
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => input.onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => input.onData(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      resolve({ exitCode: code });
    });
  });
}

export function workspaceOperations(
  workspaceRoot: string,
  failures: readonly CaseFailure[],
  permissions: CasePermissions = {},
): GovernedCodingOperationsPort {
  const inside = (absolutePath: string) => {
    if (!within(absolutePath, workspaceRoot))
      throw new Error(`EACCES: path is outside the workspace: ${absolutePath}`);
    return absolutePath;
  };
  const readOnly = new Set(
    (permissions.readOnly ?? []).map((item) => path.join(workspaceRoot, item)),
  );
  const unreadable = (permissions.unreadable ?? []).map((item) => path.join(workspaceRoot, item));
  const readable = (absolutePath: string) => {
    const target = inside(absolutePath);
    if (unreadable.some((blocked) => within(target, blocked)))
      throw permissionDenied(workspaceRoot, target, "open");
    return target;
  };
  const writable = (absolutePath: string) => {
    const target = readable(absolutePath);
    if (readOnly.has(path.dirname(target))) throw permissionDenied(workspaceRoot, target, "open");
    return target;
  };
  return {
    access: async (absolutePath) => access(readable(absolutePath)),
    readFile: async (absolutePath) => readFile(readable(absolutePath)),
    writeFile: async (absolutePath, content) => writeFile(writable(absolutePath), content),
    makeDirectory: async (absolutePath) => {
      await mkdir(writable(absolutePath), { recursive: true });
    },
    executeCommand: async (input) => {
      const failure = injected(failures, "bash", input.command);
      if (!failure) return runCommand({ ...input, cwd: inside(input.cwd) });
      input.onData(new TextEncoder().encode(`${failure.output ?? failure.error ?? ""}\n`));
      return { exitCode: failure.exitCode ?? 1 };
    },
  };
}

export class FixtureRuntimeTools implements RuntimeToolPort {
  readonly steps: TranscriptStep[];
  readonly #descriptors: readonly RuntimeToolDescriptor[];
  readonly #workspaceRoot: string;
  readonly #failures: readonly CaseFailure[];
  readonly #toolResults: readonly CaseToolResult[];
  readonly #toolCalls = new Map<string, number>();
  readonly #unreadable: readonly string[];
  readonly #operations: GovernedCodingOperationsPort;

  constructor(input: {
    readonly descriptors: readonly RuntimeToolDescriptor[];
    readonly workspaceRoot: string;
    readonly failures: readonly CaseFailure[];
    readonly toolResults?: readonly CaseToolResult[];
    readonly permissions?: CasePermissions;
    readonly steps: TranscriptStep[];
  }) {
    this.#descriptors = input.descriptors;
    this.#workspaceRoot = input.workspaceRoot;
    this.#failures = input.failures;
    this.#toolResults = input.toolResults ?? [];
    this.#unreadable = (input.permissions?.unreadable ?? []).map((item) =>
      path.join(input.workspaceRoot, item),
    );
    this.#operations = workspaceOperations(input.workspaceRoot, input.failures, input.permissions);
    this.steps = input.steps;
  }

  async listAuthorized(): Promise<readonly RuntimeToolDescriptor[]> {
    return this.#descriptors;
  }

  async preflight() {
    return { allowed: true, permissionDecisionRef: "jarvis-fixture", reasonCode: "jarvis_fixture" };
  }

  async execute(
    invocation: RuntimeToolInvocation,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RuntimeToolExecutionResult> {
    const descriptor = this.#descriptors.find(
      ({ capabilityRef }) => capabilityRef === invocation.capabilityRef,
    );
    const name = descriptor?.name ?? invocation.capabilityRef;
    const args = invocation.arguments as Record<string, unknown>;
    const { text, isError } = await this.#run(name, invocation, options?.signal);
    this.steps.push({ kind: "tool", name, args, isError, output: text });
    return {
      outcome: isError ? "failed" : "succeeded",
      resultRef: null,
      errorCode: isError ? "JARVIS_FIXTURE_TOOL_FAILED" : null,
      externalActionId: null,
      modelContent: text,
    };
  }

  async #run(
    name: string,
    invocation: RuntimeToolInvocation,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly text: string; readonly isError: boolean }> {
    const failure =
      name === "bash"
        ? undefined
        : injected(this.#failures, name, JSON.stringify(invocation.arguments));
    if (failure) return { text: failure.error ?? failure.output ?? "failed", isError: true };
    const canned =
      name === "web_fetch" || name === "web_search"
        ? (this.#toolResults.find(({ tool }) => tool === name)?.outputs ?? [])
        : [];
    if (canned.length > 0) {
      const call = this.#toolCalls.get(name) ?? 0;
      this.#toolCalls.set(name, call + 1);
      return { text: canned[Math.min(call, canned.length - 1)] ?? "", isError: false };
    }
    if (name === "web_fetch" || name === "web_search")
      return { text: "评测环境没有联网，这个工具不可用。", isError: true };
    if (!(CODING_TOOLS as readonly string[]).includes(name))
      return { text: `未知工具 ${name}`, isError: true };
    const denied = this.#searchDenied(name, invocation.arguments as Record<string, unknown>);
    if (denied) return { text: denied, isError: true };
    const result = await executeSandboxedPiCodingTool({
      name: name as CodingTool,
      toolCallId: invocation.toolCallId,
      cwd: this.#workspaceRoot,
      parameters: invocation.arguments,
      operations: this.#operations,
      ...(signal ? { signal } : {}),
    });
    const text = result.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    return { text, isError: result.isError === true };
  }

  #searchDenied(name: string, args: Record<string, unknown>): string | null {
    if (name !== "grep" && name !== "find" && name !== "ls") return null;
    const target = path.resolve(
      this.#workspaceRoot,
      typeof args["path"] === "string" ? args["path"] : ".",
    );
    const blocked = this.#unreadable.find(
      (item) => within(target, item) || (name !== "ls" && within(item, target)),
    );
    if (!blocked) return null;
    const relative = path.relative(this.#workspaceRoot, blocked);
    return name === "ls"
      ? `EACCES: permission denied, scandir '${relative}'`
      : `${relative}: Permission denied (os error 13)`;
  }
}

function frozenLease(): RuntimeRequest["executionLease"] {
  return Object.freeze({
    executionLeaseId: "execution-jarvis-test",
    expectedLeaseRevision: 1,
    authorityLeaseId: "authority-jarvis-test",
    authorityFencingToken: 1,
    deploymentId: "deployment-ai-gateway-live-qualification",
    authorityEpoch: 1,
    fencingToken: 1,
    consumerId: "jarvis-test",
  }) as unknown as RuntimeRequest["executionLease"];
}

function countingAdmission(
  usage: TrialUsage,
  overLimit: () => boolean,
): ModelInvocationAdmissionResolver {
  return async (scope) => {
    if (!scope.executionLease) return undefined;
    const executionLease = scope.executionLease;
    return {
      context: {
        ownerId: scope.ownerId,
        agentId: scope.agentId,
        runId: scope.runId,
        executionLease,
      },
      begin: async (input) => {
        if (overLimit())
          return { disposition: "blocked", reasonCode: "jarvis_token_limit" } as never;
        return {
          disposition: "fresh",
          identity: Object.freeze({
            ownerId: scope.ownerId,
            agentId: scope.agentId,
            runId: scope.runId,
            logicalSlot: input.logicalSlot,
            sequence: input.ordinal,
            invocationId: `${scope.runId}:${input.logicalSlot}`,
            modelRef: input.modelRef,
            provider: input.provider,
            model: input.model,
            modelVersion: input.modelVersion,
            dataClassification: input.dataClassification,
            source: input.source,
            ordinal: input.ordinal,
            pricing: Object.freeze({ ...input.pricing }),
            pricingFingerprint: "jarvis-test",
            estimatedCostMicros: input.estimatedCostMicros,
            budgetAccountId: "jarvis-test",
            budgetOperationKey: input.logicalSlot,
            authority: Object.freeze({
              deploymentId: executionLease.deploymentId,
              authorityEpoch: executionLease.authorityEpoch,
              fencingToken: executionLease.fencingToken,
            }),
            authorityLease: Object.freeze({
              leaseId: executionLease.authorityLeaseId,
              fencingToken: executionLease.authorityFencingToken,
            }),
            executionLease,
            status: "reserved",
            reservedAt: new Date().toISOString(),
            startedAt: null,
            observedAt: null,
            settledAt: null,
            releasedAt: null,
            actualCostMicros: null,
            reasonCode: null,
          }) as never,
          permit: {
            assertActive: async () => undefined,
            markStarted: async () => undefined,
            releaseReserved: async () => undefined,
            markUnknown: async () => undefined,
            settle: async (settled: ModelInvocationUsage) => {
              usage.inputTokens +=
                settled.inputTokens + settled.cacheReadTokens + settled.cacheWriteTokens;
              usage.outputTokens += settled.outputTokens;
              if (settled.reportedCostMicros !== undefined) {
                usage.costMicros += settled.reportedCostMicros;
                usage.costReported = true;
              }
            },
          },
        };
      },
    };
  };
}

function recordAssistant(steps: TranscriptStep[], text: string): void {
  const last = steps[steps.length - 1];
  if (last?.kind === "assistant" && text.startsWith(last.text))
    steps[steps.length - 1] = { kind: "assistant", text };
  else if (!(last?.kind === "assistant" && last.text.startsWith(text)))
    steps.push({ kind: "assistant", text });
}

function recordingProjection(
  inner: RuntimeProjectionPort,
  steps: TranscriptStep[],
): RuntimeProjectionPort {
  return {
    resolveProjection: (input) => inner.resolveProjection(input),
    proposeCompaction: (input) => inner.proposeCompaction(input),
    capture: async (input) => {
      const value = input.value as { role?: unknown; content?: unknown } | null;
      if (input.kind === "message" && value?.role === "assistant" && Array.isArray(value.content)) {
        const text = value.content
          .flatMap((part: { type?: unknown; text?: unknown }) =>
            part.type === "text" && typeof part.text === "string" ? [part.text] : [],
          )
          .join("");
        if (text.trim().length > 0) recordAssistant(steps, text);
      }
      return inner.capture(input);
    },
    captureFinalAnswer: async (input) => {
      recordAssistant(steps, input.text);
      return inner.captureFinalAnswer(input);
    },
  };
}

function productionToolDescriptors(
  configuration: ReturnType<typeof liveConfiguration>,
): Promise<readonly RuntimeToolDescriptor[]> {
  const policy = configuration.runPolicy;
  const unused = {} as never;
  return new ProductionRuntimeTools({
    ...(policy.coding ? { coding: policy.coding } : {}),
    ...(policy.publicSearch ? { publicSearch: policy.publicSearch } : {}),
    ...(policy.publicFetch ? { publicFetch: policy.publicFetch } : {}),
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    capabilities: unused,
    invocations: unused,
    transport: unused,
    parents: unused,
    peer: unused,
    authority: unused,
    assertRunActive: async () => undefined,
    results: unused,
    artifacts: unused,
    payloads: unused,
    protector: unused,
    ceiling: unused,
    clock: unused,
    ids: unused,
  }).listAuthorized(createRunId("run-jarvis-tools"), []);
}

export function liveConfiguration(stateRoot: string, timeZone: string) {
  const route = {
    hostId: "host-jarvis-test",
    workerInstanceId: "worker-jarvis-test",
    capabilityVersion: "1",
    maximumBytes: 1_048_576,
  };
  return {
    ...createAiGatewayLiveConfiguration(stateRoot),
    runPolicy: {
      version: "jarvis-test-policy-v1",
      timeZone,
      systemInstruction: LIVE_SYSTEM_INSTRUCTION,
      memoryLimit: MEMORY_LIMIT,
      coding: {
        ...route,
        grantId: "grant-jarvis-test",
        capabilityRef: "host.coding",
        enabledTools: [...CODING_TOOLS],
        approval: "workspace_auto" as const,
      },
      publicSearch: { ...route, capabilityRef: "web.search", scopeSource: "private_temp" as const },
      publicFetch: { ...route, capabilityRef: "web.fetch", scopeSource: "private_temp" as const },
    },
  };
}

export async function runTrial(options: TrialOptions): Promise<TrialResult> {
  const { dataset, item } = options;
  const trialRoot = path.join(options.root, `${item.id}-trial-${options.trial}`);
  const stateRoot = path.join(trialRoot, "state");
  const workspaceRoot = path.join(trialRoot, "workspace");
  await mkdir(stateRoot, { recursive: true });
  await chmod(options.root, 0o711);
  await chmod(trialRoot, 0o711);
  await prepareWorkspace(item, workspaceRoot);
  const runId = createRunId(`run-jarvis-${item.id}-${options.trial}`);
  const { formed, material, adapters, clock, sessionId } = await assembleContext(
    dataset,
    item,
    stateRoot,
    runId,
  );
  const configuration = liveConfiguration(stateRoot, dataset.timeZone);
  const source: RunExecutionSource = {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runId,
    sessionId,
    threadId: null,
    triggerId: `trigger-jarvis-${item.id}` as RunExecutionSource["triggerId"],
    sourceType: "user_message",
    sourceId: "owner-message",
    payloadRef: `trigger-${item.id}`,
    dataClassification: "private",
    occurredAt: dataset.today,
  };
  const instructions: string[] = [];
  const policy = await createProductionRunPolicy({
    configuration,
    artifacts: adapters.runPayloadArtifacts,
    protector: {
      protect: async (input) => {
        instructions.push(new TextDecoder().decode(input.plaintext));
        return adapters.payloadProtector.protect(input);
      },
      unprotect: (input) => adapters.payloadProtector.unprotect(input),
      rewrap: (input) => adapters.payloadProtector.rewrap(input),
    },
    handles: { listRunExecutionHandles: async () => [] },
    clock,
    ids: adapters.ids,
    workspaceRoot: async () => workspaceRoot,
  })(source);
  const models = createProductionModelCompositionFromConfiguration({
    egress: testModelEgress(),
    configuration,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    handles: adapters.secret,
    secretSource: {
      kind: "environment",
      productionSuitable: true,
      resolve: options.secret,
    } as never,
    payloads: adapters.payload,
    protector: adapters.payloadProtector,
    ids: adapters.ids,
    clock,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const steps: TranscriptStep[] = [];
  const tools = new FixtureRuntimeTools({
    descriptors: await productionToolDescriptors(configuration),
    workspaceRoot,
    failures: item.failures ?? [],
    ...(item.toolResults ? { toolResults: item.toolResults } : {}),
    ...(item.permissions ? { permissions: item.permissions } : {}),
    steps,
  });
  const projection = recordingProjection(
    new ContextProjectionService({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threads: { readCommittedMessagesByIds: async () => [] },
      checkpoints: adapters.runCheckpoints,
      payloads: adapters.payload,
      artifacts: adapters.runPayloadArtifacts,
      protector: adapters.payloadProtector,
      clock,
      ids: adapters.ids,
    }),
    steps,
  );
  const runtime = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection,
    tools,
    models: models.composition.piModels,
    cwd: workspaceRoot,
    timeZone: dataset.timeZone,
    agentDir: path.join(trialRoot, "pi-agent"),
    admission: countingAdmission(options.usage, options.overLimit),
    now: () => clock.now(),
    logicalSlot: (_request, ordinal) => `agent-stream:${ordinal}`,
  });
  const events: RuntimeEvent["type"][] = [];
  let outcome: TrialResult["outcome"] = "failed";
  let errorCode: string | null = null;
  try {
    for await (const event of runtime.run({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId,
      executionLease: frozenLease(),
      sessionId,
      threadId: null,
      modelRef: policy.modelRef,
      systemInstructionRef: policy.systemInstructionRef,
      contextEnvelopeRef: formed.contextEnvelopeRef,
      workerResultRefs: [],
      capabilityHandleRefs: policy.capabilityHandleRefs,
      budget: {},
      correlationId:
        `correlation-jarvis-${item.id}-${options.trial}` as RuntimeRequest["correlationId"],
      dataClassification: "private",
    })) {
      events.push(event.type);
      if (event.type === "runtime.completed") outcome = "completed";
      if (event.type === "runtime.cancelled") outcome = "cancelled";
      if (event.type === "runtime.failed") errorCode = event.errorCode;
    }
  } catch (error) {
    errorCode = error instanceof Error ? error.message : "JARVIS_TRIAL_FAILED";
  } finally {
    await models.composition.close();
  }
  if (outcome !== "completed" && options.overLimit()) outcome = "stopped_by_limit";
  return {
    transcript: { steps },
    context: { systemInstruction: instructions.join("\n"), material },
    workspaceRoot,
    events,
    outcome,
    errorCode,
  };
}
