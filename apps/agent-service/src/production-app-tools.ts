import { createHash } from "node:crypto";
import type {
  JsonObject,
  ProductConfiguration,
  RuntimeToolDescriptor,
  RuntimeToolInvocation,
} from "@himawari-agent/application";
import type { AppTool, ProductionAppConnections } from "@himawari-agent/platform-node";
import {
  TOOL_APP_ACTION,
  TOOL_APP_ACTION_ACTION,
  TOOL_APP_ACTION_APP,
  TOOL_APP_ACTION_ARGUMENTS,
  TOOL_APP_ACTION_CODE,
  TOOL_APP_ACTION_TOOL,
  TOOL_RESULT_APP_ACTION_DESCRIBE,
  TOOL_RESULT_APP_ACTION_FAILED,
  TOOL_RESULT_APP_ACTION_INVALID,
  TOOL_RESULT_APP_ACTION_NO_APP,
  TOOL_RESULT_APP_ACTION_NOT_CONNECTED,
  TOOL_RESULT_APP_ACTION_RESULT,
  TOOL_RESULT_APP_ACTION_UNKNOWN,
  TOOL_RESULT_APP_CODE_ERROR,
  TOOL_RESULT_APP_CODE_NOT_REPEATABLE,
  TOOL_RESULT_APP_CODE_RESULT,
  TOOL_RESULT_APP_CODE_TIMEOUT,
  TOOL_RESULT_APP_CODE_UNAVAILABLE,
} from "@himawari-agent/prompt-catalog";
import { UserComputerClient } from "@himawari-agent/runtime-sandbox/computers";
import {
  APP_CODE_RUNNER_ARGV,
  type AppCodeRecordedCall,
  type AppCodeRunnerAnswer,
  appToolSignature,
  parseRunnerAnswer,
} from "./app-code-runner.js";

export const APP_ACTION_CAPABILITY_REF = "app.action";
export const APP_ACTION_EXTERNAL_ORIGIN = "app_action";
export const APP_ACTIONS = ["describe", "call", "run"] as const;

const ARGUMENT_KEYS = new Set(["action", "app", "tool", "arguments", "code"]);
const SUMMARY_LIMIT = 300;
const TEXT_LIMIT = 30_000;

export type AppConnectionsForTools = Pick<
  ProductionAppConnections,
  "list" | "definition" | "tools" | "call"
>;

export interface AppCallAccess {
  readonly app: string;
  readonly title: string;
  readonly tool: string;
  readonly arguments: JsonObject;
}

export interface AppActionHooks {
  readonly authorize: (access: AppCallAccess, step?: string) => Promise<void>;
  readonly markExternalContent: () => Promise<void>;
  readonly recall?: (key: string) => Promise<unknown>;
  readonly record?: (key: string, value: unknown) => Promise<void>;
}

export interface AppCodeComputerResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly truncated: boolean;
}

export interface AppCodeComputer {
  exec(input: {
    readonly ownerId: string;
    readonly argv: readonly string[];
    readonly stdin: Uint8Array;
    readonly allowedDomains: readonly string[];
    readonly deadlineAt: string;
    readonly maxOutputBytes: number;
  }): Promise<AppCodeComputerResult>;
}

export class AppToolError extends Error {
  readonly code: string;
  readonly note: string;
  constructor(code: string, note: string) {
    super(code);
    this.name = "AppToolError";
    this.code = code;
    this.note = note;
  }
}

const invalid = () => new AppToolError("APP_ACTION_INVALID", TOOL_RESULT_APP_ACTION_INVALID.text);
const unknown = () => new AppToolError("APP_ACTION_UNKNOWN", TOOL_RESULT_APP_ACTION_UNKNOWN.text);
const notConnected = () =>
  new AppToolError("APP_ACTION_NOT_CONNECTED", TOOL_RESULT_APP_ACTION_NOT_CONNECTED.text);
const failed = () => new AppToolError("APP_ACTION_FAILED", TOOL_RESULT_APP_ACTION_FAILED.text);

export function appToolDescriptors(): readonly RuntimeToolDescriptor[] {
  return [
    {
      name: "app_action",
      capabilityRef: APP_ACTION_CAPABILITY_REF,
      capabilityHandleRef: null,
      description: TOOL_APP_ACTION.text,
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [...APP_ACTIONS],
            description: TOOL_APP_ACTION_ACTION.text,
          },
          app: { type: "string", description: TOOL_APP_ACTION_APP.text },
          tool: { type: "string", description: TOOL_APP_ACTION_TOOL.text },
          arguments: { type: "object", description: TOOL_APP_ACTION_ARGUMENTS.text },
          code: { type: "string", description: TOOL_APP_ACTION_CODE.text },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  ];
}

interface Request {
  readonly action: (typeof APP_ACTIONS)[number];
  readonly app?: string;
  readonly tool?: string;
  readonly arguments: JsonObject;
  readonly code?: string;
}

function parse(input: JsonObject): Request {
  if (Object.keys(input).some((key) => !ARGUMENT_KEYS.has(key))) throw invalid();
  const { action, app, tool } = input;
  const values = input["arguments"];
  if (!APP_ACTIONS.includes(action as Request["action"])) throw invalid();
  if (app !== undefined && typeof app !== "string") throw invalid();
  if (tool !== undefined && typeof tool !== "string") throw invalid();
  if (
    values !== undefined &&
    (values === null || typeof values !== "object" || Array.isArray(values))
  )
    throw invalid();
  if (action === "call" && (app === undefined || tool === undefined)) throw invalid();
  const code = input["code"];
  if (code !== undefined && typeof code !== "string") throw invalid();
  if ((action === "run") !== (code !== undefined)) throw invalid();
  if (
    action === "run" &&
    (code === "" || app !== undefined || tool !== undefined || values !== undefined)
  )
    throw invalid();
  return {
    action: action as Request["action"],
    ...(app === undefined ? {} : { app }),
    ...(tool === undefined ? {} : { tool }),
    arguments: (values ?? {}) as JsonObject,
    ...(code === undefined ? {} : { code }),
  };
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function content(items: readonly unknown[]): readonly unknown[] {
  let budget = TEXT_LIMIT;
  return items.map((item) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const type = typeof entry["type"] === "string" ? entry["type"] : "unknown";
    const resource = entry["resource"] as Record<string, unknown> | undefined;
    const text =
      typeof entry["text"] === "string"
        ? entry["text"]
        : typeof resource?.["text"] === "string"
          ? resource["text"]
          : undefined;
    if (text === undefined) return { type };
    const kept = clip(text, Math.max(budget, 0));
    budget -= kept.length;
    return { type, text: kept };
  });
}

interface AppDefinition {
  readonly name: string;
  readonly title: string;
  readonly trustsReadOnlyLabels: boolean;
}

export class ProductionAppTools {
  readonly #connections: AppConnectionsForTools;
  readonly #code: { readonly computer: AppCodeComputer; readonly ownerId: string } | undefined;

  constructor(options: {
    readonly connections: AppConnectionsForTools;
    readonly code?: { readonly computer: AppCodeComputer; readonly ownerId: string };
  }) {
    this.#connections = options.connections;
    this.#code = options.code;
  }

  async run(call: RuntimeToolInvocation, hooks: AppActionHooks): Promise<unknown> {
    const request = parse(call.arguments);
    if (request.action === "describe") return this.#describe(request, hooks);
    if (request.action === "run") return this.#runCode(call, request.code ?? "", hooks);
    return this.#call(request as Request & { app: string; tool: string }, hooks);
  }

  #asksOwner(definition: { readonly trustsReadOnlyLabels: boolean }, tool: AppTool): boolean {
    return !(definition.trustsReadOnlyLabels && tool.readOnly);
  }

  async #tools(app: string): Promise<readonly AppTool[]> {
    let tools: readonly AppTool[] | undefined;
    try {
      tools = await this.#connections.tools(app);
    } catch {
      throw failed();
    }
    if (!tools) throw notConnected();
    return tools;
  }

  async #describe(request: Request, hooks: AppActionHooks): Promise<unknown> {
    const listed = [...(await this.#connections.list())].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    if (listed.length === 0)
      throw new AppToolError("APP_ACTION_NO_APP", TOOL_RESULT_APP_ACTION_NO_APP.text);
    if (request.app !== undefined) {
      const definition = await this.#connections.definition(request.app);
      if (!definition) throw unknown();
      const tools = await this.#tools(request.app);
      const chosen =
        request.tool === undefined ? tools : tools.filter(({ name }) => name === request.tool);
      if (chosen.length === 0) throw unknown();
      await hooks.markExternalContent();
      return {
        note: TOOL_RESULT_APP_ACTION_DESCRIBE.text,
        apps: [
          {
            app: definition.name,
            title: definition.title,
            status: "connected",
            tools: chosen.map((tool) => ({
              name: tool.name,
              description: tool.description,
              asksOwner: this.#asksOwner(definition, tool),
              inputSchema: tool.inputSchema,
              code: appToolSignature(definition.name, tool.name, tool.inputSchema),
            })),
          },
        ],
      };
    }
    const apps = [];
    for (const connection of listed) {
      if (connection.status !== "connected") {
        apps.push({ app: connection.name, title: connection.title, status: connection.status });
        continue;
      }
      let tools: readonly AppTool[] | undefined;
      try {
        tools = await this.#connections.tools(connection.name);
      } catch {
        tools = undefined;
      }
      if (!tools) {
        apps.push({ app: connection.name, title: connection.title, status: "needs_reconnect" });
        continue;
      }
      const definition = await this.#connections.definition(connection.name);
      apps.push({
        app: connection.name,
        title: connection.title,
        status: "connected",
        tools: tools.map((tool) => ({
          name: tool.name,
          description: clip(tool.description, SUMMARY_LIMIT),
          asksOwner: definition === undefined || this.#asksOwner(definition, tool),
        })),
      });
    }
    if (apps.some((app) => "tools" in app)) await hooks.markExternalContent();
    return { note: TOOL_RESULT_APP_ACTION_DESCRIBE.text, apps };
  }

  async #call(
    request: Request & { readonly app: string; readonly tool: string },
    hooks: AppActionHooks,
  ): Promise<unknown> {
    const { definition, tool } = await this.#find(request.app, request.tool);
    const result = await this.#invoke(definition, tool, request.arguments, hooks);
    return {
      note: TOOL_RESULT_APP_ACTION_RESULT.text,
      app: definition.name,
      tool: tool.name,
      isError: result.isError,
      content: content(result.content),
    };
  }

  async #find(app: string, name: string) {
    const definition = await this.#connections.definition(app);
    if (!definition) throw unknown();
    const tool = (await this.#tools(app)).find((entry) => entry.name === name);
    if (!tool) throw unknown();
    return { definition, tool };
  }

  async #invoke(
    definition: AppDefinition,
    tool: AppTool,
    values: JsonObject,
    hooks: AppActionHooks,
    step?: string,
  ) {
    if (this.#asksOwner(definition, tool))
      await hooks.authorize(
        { app: definition.name, title: definition.title, tool: tool.name, arguments: values },
        step,
      );
    await hooks.markExternalContent();
    let result: Awaited<ReturnType<AppConnectionsForTools["call"]>>;
    try {
      result = await this.#connections.call(definition.name, tool.name, values);
    } catch {
      throw failed();
    }
    if (!result) throw notConnected();
    return result;
  }

  async #runCode(call: RuntimeToolInvocation, code: string, hooks: AppActionHooks) {
    const runner = this.#code;
    const { recall, record } = hooks;
    if (!runner || !recall || !record)
      throw new AppToolError("APP_CODE_UNAVAILABLE", TOOL_RESULT_APP_CODE_UNAVAILABLE.text);
    const deadlineAt = call.executionDeadlineAt;
    if (deadlineAt === undefined) throw timedOut();
    const calls: AppCodeRecordedCall[] = [];
    const summary = () =>
      calls.map(({ app, tool, error }) => ({ app, tool, isError: error !== undefined }));
    for (;;) {
      const answer = await this.#execute(runner, { code, calls, logLimit: TEXT_LIMIT }, deadlineAt);
      if (answer.status === "done")
        return {
          note: TOOL_RESULT_APP_CODE_RESULT.text,
          value: clipValue(answer.value),
          logs: clipLogs(answer.logs),
          calls: summary(),
        };
      if (answer.status === "error")
        return {
          note: TOOL_RESULT_APP_CODE_ERROR.text,
          error: clip(answer.message, SUMMARY_LIMIT * 4),
          logs: clipLogs(answer.logs),
          calls: summary(),
        };
      if (answer.status === "not_repeatable")
        throw new AppToolError("APP_CODE_NOT_REPEATABLE", TOOL_RESULT_APP_CODE_NOT_REPEATABLE.text);
      if (answer.seq !== calls.length) throw failed();
      const step = `app-code:${call.toolCallId}:${answer.seq}:${stepDigest(answer)}`;
      const recorded = (await recall(step)) as AppCodeRecordedCall | undefined;
      if (recorded) {
        calls.push(recorded);
        continue;
      }
      const started = `${step}:started`;
      if ((await recall(started)) !== undefined) throw failed();
      const outcome = await this.#codeCall(answer, hooks, step, () => record(started, true));
      await record(step, outcome);
      calls.push(outcome);
    }
  }

  async #codeCall(
    answer: Extract<AppCodeRunnerAnswer, { status: "call" }>,
    hooks: AppActionHooks,
    step: string,
    starting: () => Promise<void>,
  ): Promise<AppCodeRecordedCall> {
    const base = { app: answer.app, tool: answer.tool, arguments: answer.arguments };
    let found: { readonly definition: AppDefinition; readonly tool: AppTool };
    try {
      found = await this.#find(answer.app, answer.tool);
    } catch (error) {
      if (error instanceof AppToolError) return { ...base, error: `${error.code}: ${error.note}` };
      throw error;
    }
    const gated: AppActionHooks = {
      ...hooks,
      markExternalContent: async () => {
        await hooks.markExternalContent();
        await starting();
      },
    };
    const result = await this.#invoke(found.definition, found.tool, answer.arguments, gated, step);
    const text = joinedText(result.content);
    return result.isError
      ? { ...base, error: text || "the app reported an error" }
      : { ...base, text };
  }

  async #execute(
    runner: { readonly computer: AppCodeComputer; readonly ownerId: string },
    request: {
      readonly code: string;
      readonly calls: readonly AppCodeRecordedCall[];
      readonly logLimit: number;
    },
    deadlineAt: string,
  ): Promise<AppCodeRunnerAnswer> {
    let result: AppCodeComputerResult;
    try {
      result = await runner.computer.exec({
        ownerId: runner.ownerId,
        argv: APP_CODE_RUNNER_ARGV,
        stdin: new TextEncoder().encode(JSON.stringify(request)),
        allowedDomains: [],
        deadlineAt,
        maxOutputBytes: TEXT_LIMIT * 8,
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "COMPUTER_DEADLINE_PASSED")
        throw timedOut();
      throw new AppToolError("APP_CODE_UNAVAILABLE", TOOL_RESULT_APP_CODE_UNAVAILABLE.text);
    }
    if (result.exitCode === TIMEOUT_EXIT_CODE) throw timedOut();
    const answer = result.truncated
      ? undefined
      : parseRunnerAnswer(new TextDecoder().decode(result.stdout));
    if (!answer) throw new AppToolError("APP_CODE_FAILED", TOOL_RESULT_APP_CODE_ERROR.text);
    return answer;
  }
}

const TIMEOUT_EXIT_CODE = 124;

const timedOut = () => new AppToolError("APP_CODE_TIMEOUT", TOOL_RESULT_APP_CODE_TIMEOUT.text);

function stepDigest(answer: {
  readonly app: string;
  readonly tool: string;
  readonly arguments: JsonObject;
}) {
  return createHash("sha256")
    .update(JSON.stringify([answer.app, answer.tool, canonical(answer.arguments)]))
    .digest("hex")
    .slice(0, 32);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

function joinedText(items: readonly unknown[]): string {
  return items
    .map((item) => {
      const entry = (item ?? {}) as Record<string, unknown>;
      const resource = entry["resource"] as Record<string, unknown> | undefined;
      return typeof entry["text"] === "string"
        ? entry["text"]
        : typeof resource?.["text"] === "string"
          ? resource["text"]
          : "";
    })
    .filter((text) => text !== "")
    .join("\n");
}

function clipValue(value: unknown): unknown {
  const text = JSON.stringify(value) ?? "null";
  return text.length > TEXT_LIMIT ? clip(text, TEXT_LIMIT) : value;
}

function clipLogs(lines: readonly string[]): readonly string[] {
  let budget = TEXT_LIMIT;
  const kept: string[] = [];
  for (const line of lines) {
    if (budget <= 0) break;
    const piece = clip(line, budget);
    kept.push(piece);
    budget -= piece.length;
  }
  return kept;
}

export function configuredAppCode(
  configuration: Pick<ProductConfiguration, "ownerId" | "runPolicy">,
): { readonly computer: AppCodeComputer; readonly ownerId: string } | undefined {
  const computers = configuration.runPolicy?.userComputers;
  if (!computers) return undefined;
  return { computer: new UserComputerClient(computers.socketPath), ownerId: configuration.ownerId };
}
