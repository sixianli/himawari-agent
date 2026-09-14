import {
  type BashOperations,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type EditOperations,
  type FindOperations,
  type GrepOperations,
  type LsOperations,
  type ReadOperations,
  type ToolDefinition,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";

export type GovernedPiCodingToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

/**
 * Product-owned Operations implementations enforce workspace/host authority;
 * Pi continues to own schemas, argument normalization, rendering and result
 * shaping for its built-in coding tools.
 */
export interface GovernedPiCodingToolOperations {
  readonly read?: ReadOperations;
  readonly bash?: BashOperations;
  readonly edit?: EditOperations;
  readonly write?: WriteOperations;
  readonly grep?: GrepOperations;
  readonly find?: FindOperations;
  readonly ls?: LsOperations;
}

export type GovernedPiCodingToolsOptions = {
  readonly cwd: string;
  readonly enabled: readonly GovernedPiCodingToolName[];
} & (
  | { readonly operations: GovernedPiCodingToolOperations; readonly operationsForCall?: never }
  | {
      readonly operations?: never;
      readonly operationsForCall: (call: {
        readonly toolCallId: string;
        readonly toolName: GovernedPiCodingToolName;
        readonly signal: AbortSignal | undefined;
      }) => Promise<GovernedPiCodingToolOperations> | GovernedPiCodingToolOperations;
    }
);

export type GovernedPiCodingToolDefinition =
  | ReturnType<typeof createReadToolDefinition>
  | ReturnType<typeof createBashToolDefinition>
  | ReturnType<typeof createEditToolDefinition>
  | ReturnType<typeof createWriteToolDefinition>
  | ReturnType<typeof createGrepToolDefinition>
  | ReturnType<typeof createFindToolDefinition>
  | ReturnType<typeof createLsToolDefinition>;

function operation<K extends GovernedPiCodingToolName>(
  name: K,
  operations: GovernedPiCodingToolOperations,
): NonNullable<GovernedPiCodingToolOperations[K]> {
  const selected = operations[name];
  if (selected === undefined) throw new TypeError(`PI_GOVERNED_OPERATIONS_REQUIRED:${name}`);
  return selected;
}

export function createGovernedPiCodingTools(
  options: GovernedPiCodingToolsOptions,
): readonly GovernedPiCodingToolDefinition[] {
  if (options.cwd.trim().length === 0) throw new TypeError("Pi coding tool cwd must be non-empty");
  if (new Set(options.enabled).size !== options.enabled.length) {
    throw new TypeError("Pi coding tool names must be unique");
  }
  if (options.operationsForCall) {
    if (options.operations !== undefined) throw new TypeError("PI_GOVERNED_AMBIGUOUS_OPERATIONS");
    const cwd = options.cwd;
    const operationsForCall = options.operationsForCall;
    const forbidden = async (): Promise<never> => {
      throw new Error("PI_UNBOUND_OPERATIONS");
    };
    // Reuse Pi definitions, but resolve Operations inside each execute call.
    // The factory is a trusted product closure; model parameters are not passed
    // as authority. No shared mutable 'current tool call' exists.
    return Object.freeze(
      options.enabled.map((toolName) => {
        const stub = new Proxy({}, { get: () => forbidden });
        const [definition] = createGovernedPiCodingTools({
          cwd,
          enabled: [toolName],
          operations: { [toolName]: stub },
        });
        if (!definition) throw new Error("PI_TOOL_DEFINITION_MISSING");
        const execute: ToolDefinition["execute"] = async (
          toolCallId,
          parameters,
          signal,
          onUpdate,
          context,
        ) => {
          signal?.throwIfAborted();
          if (!toolCallId.trim()) throw new Error("PI_TOOL_CALL_ID_REQUIRED");
          const operations = await operationsForCall(
            Object.freeze({ toolCallId, toolName, signal }),
          );
          signal?.throwIfAborted();
          const [bound] = createGovernedPiCodingTools({
            cwd,
            enabled: [toolName],
            operations,
          });
          if (!bound) throw new Error("PI_TOOL_DEFINITION_MISSING");
          return bound.execute(toolCallId, parameters as never, signal, onUpdate as never, context);
        };
        return { ...definition, execute } as GovernedPiCodingToolDefinition;
      }),
    );
  }
  return Object.freeze(
    options.enabled.map((name): GovernedPiCodingToolDefinition => {
      switch (name) {
        case "read":
          return createReadToolDefinition(options.cwd, {
            operations: operation("read", options.operations),
          });
        case "bash":
          return createBashToolDefinition(options.cwd, {
            operations: operation("bash", options.operations),
            exposeSessionEnvironment: false,
          });
        case "edit":
          return createEditToolDefinition(options.cwd, {
            operations: operation("edit", options.operations),
          });
        case "write":
          return createWriteToolDefinition(options.cwd, {
            operations: operation("write", options.operations),
          });
        case "grep":
          return createGrepToolDefinition(options.cwd, {
            operations: operation("grep", options.operations),
          });
        case "find":
          return createFindToolDefinition(options.cwd, {
            operations: operation("find", options.operations),
          });
        case "ls":
          return createLsToolDefinition(options.cwd, {
            operations: operation("ls", options.operations),
          });
      }
      throw new TypeError(`Unknown governed Pi coding tool: ${name}`);
    }),
  );
}
