import type {
  JsonObject,
  RuntimeToolDescriptor,
  RuntimeToolInvocation,
} from "@himawari-agent/application";
import type { AppTool, ProductionAppConnections } from "@himawari-agent/platform-node";
import {
  TOOL_APP_ACTION,
  TOOL_APP_ACTION_ACTION,
  TOOL_APP_ACTION_APP,
  TOOL_APP_ACTION_ARGUMENTS,
  TOOL_APP_ACTION_TOOL,
  TOOL_RESULT_APP_ACTION_DESCRIBE,
  TOOL_RESULT_APP_ACTION_FAILED,
  TOOL_RESULT_APP_ACTION_INVALID,
  TOOL_RESULT_APP_ACTION_NO_APP,
  TOOL_RESULT_APP_ACTION_NOT_CONNECTED,
  TOOL_RESULT_APP_ACTION_RESULT,
  TOOL_RESULT_APP_ACTION_UNKNOWN,
} from "@himawari-agent/prompt-catalog";

export const APP_ACTION_CAPABILITY_REF = "app.action";
export const APP_ACTION_EXTERNAL_ORIGIN = "app_action";
export const APP_ACTIONS = ["describe", "call"] as const;

const ARGUMENT_KEYS = new Set(["action", "app", "tool", "arguments"]);
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
  readonly authorize: (access: AppCallAccess) => Promise<void>;
  readonly markExternalContent: () => Promise<void>;
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
  return {
    action: action as Request["action"],
    ...(app === undefined ? {} : { app }),
    ...(tool === undefined ? {} : { tool }),
    arguments: (values ?? {}) as JsonObject,
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

export class ProductionAppTools {
  readonly #connections: AppConnectionsForTools;

  constructor(options: { readonly connections: AppConnectionsForTools }) {
    this.#connections = options.connections;
  }

  async run(call: RuntimeToolInvocation, hooks: AppActionHooks): Promise<unknown> {
    const request = parse(call.arguments);
    return request.action === "describe"
      ? this.#describe(request, hooks)
      : this.#call(request as Request & { app: string; tool: string }, hooks);
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
    const definition = await this.#connections.definition(request.app);
    if (!definition) throw unknown();
    const tool = (await this.#tools(request.app)).find(({ name }) => name === request.tool);
    if (!tool) throw unknown();
    if (this.#asksOwner(definition, tool))
      await hooks.authorize({
        app: definition.name,
        title: definition.title,
        tool: tool.name,
        arguments: request.arguments,
      });
    await hooks.markExternalContent();
    let result: Awaited<ReturnType<AppConnectionsForTools["call"]>>;
    try {
      result = await this.#connections.call(request.app, tool.name, request.arguments);
    } catch {
      throw failed();
    }
    if (!result) throw notConnected();
    return {
      note: TOOL_RESULT_APP_ACTION_RESULT.text,
      app: definition.name,
      tool: tool.name,
      isError: result.isError,
      content: content(result.content),
    };
  }
}
