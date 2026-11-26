import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  TOOL_BUILTIN_BASH,
  TOOL_BUILTIN_BASH_COMPUTER,
  TOOL_BUILTIN_BASH_TIMEOUT,
  TOOL_BUILTIN_READ,
  TOOL_BUILTIN_READ_GUIDELINE,
  TOOL_BUILTIN_READONLY_SUFFIX,
  TOOL_BUILTIN_WRITE_SUFFIX,
} from "@himawari-agent/prompt-catalog";

type BuiltinText = Pick<ToolDefinition, "name" | "description" | "parameters" | "promptGuidelines">;

export interface HimawariBuiltinToolText {
  readonly description: string;
  readonly parameters: ToolDefinition["parameters"];
  readonly promptGuidelines: readonly string[] | undefined;
}

function withTimeoutDescription(parameters: ToolDefinition["parameters"]) {
  const properties = (parameters as { properties?: Record<string, unknown> }).properties;
  const timeout = properties?.["timeout"];
  if (!properties || typeof timeout !== "object" || timeout === null)
    throw new Error("PI_BASH_TIMEOUT_PARAMETER_MISSING");
  return {
    ...parameters,
    properties: {
      ...properties,
      timeout: { ...timeout, description: TOOL_BUILTIN_BASH_TIMEOUT.text },
    },
  } as ToolDefinition["parameters"];
}

export function himawariBuiltinToolText(
  builtin: BuiltinText,
  options: { readonly toolsRunInComputer?: boolean } = {},
): HimawariBuiltinToolText {
  switch (builtin.name) {
    case "read":
      return {
        description: TOOL_BUILTIN_READ.text,
        parameters: builtin.parameters,
        promptGuidelines: [TOOL_BUILTIN_READ_GUIDELINE.text],
      };
    case "bash":
      return {
        description: options.toolsRunInComputer
          ? TOOL_BUILTIN_BASH_COMPUTER.text
          : TOOL_BUILTIN_BASH.text,
        parameters: withTimeoutDescription(builtin.parameters),
        promptGuidelines: undefined,
      };
    case "ls":
    case "find":
    case "grep":
      return {
        description: `${builtin.description}\n${TOOL_BUILTIN_READONLY_SUFFIX.text}`,
        parameters: builtin.parameters,
        promptGuidelines: builtin.promptGuidelines,
      };
    default:
      return {
        description: `${builtin.description}\n${TOOL_BUILTIN_WRITE_SUFFIX.text}`,
        parameters: builtin.parameters,
        promptGuidelines: builtin.promptGuidelines,
      };
  }
}
