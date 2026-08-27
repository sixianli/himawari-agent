import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type BashOperations,
  type EditOperations,
  type FindOperations,
  type GrepOperations,
  type LsOperations,
  type ReadOperations,
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

export interface GovernedPiCodingToolsOptions {
  readonly cwd: string;
  readonly enabled: readonly GovernedPiCodingToolName[];
  readonly operations: GovernedPiCodingToolOperations;
}

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
