import { validateToolArguments } from "@earendil-works/pi-ai";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { GovernedCodingOperationsPort } from "@himawari-agent/application/runtime-port";
import {
  createGovernedPiCodingTools,
  type GovernedPiCodingToolDefinition,
  type GovernedPiCodingToolName,
} from "./governed-coding-tools.js";
import { createPiOperationsFromGovernedHostPort } from "./governed-host-operations.js";
import { jsonToolArguments } from "./json-tool-arguments.js";

export async function executeSandboxedPiCodingTool(input: {
  readonly name: GovernedPiCodingToolName;
  readonly toolCallId: string;
  readonly cwd: string;
  readonly parameters: unknown;
  readonly operations: GovernedCodingOperationsPort;
  readonly signal?: AbortSignal;
}) {
  let tool: GovernedPiCodingToolDefinition;
  switch (input.name) {
    case "find":
      tool = createFindToolDefinition(input.cwd);
      break;
    case "grep":
      tool = createGrepToolDefinition(input.cwd);
      break;
    case "ls":
      tool = createLsToolDefinition(input.cwd);
      break;
    default: {
      const [definition] = createGovernedPiCodingTools({
        cwd: input.cwd,
        enabled: [input.name],
        operations: createPiOperationsFromGovernedHostPort(input.operations),
      });
      if (!definition) throw new Error("PI_TOOL_DEFINITION_MISSING");
      tool = definition;
    }
  }
  input.signal?.throwIfAborted();
  if (!input.parameters || typeof input.parameters !== "object" || Array.isArray(input.parameters))
    throw new Error("PI_TOOL_ARGUMENTS_INVALID");
  const parameters = validateToolArguments(tool, {
    type: "toolCall",
    id: input.toolCallId,
    name: input.name,
    arguments: jsonToolArguments(input.parameters),
  });
  let lastDetails: unknown;
  let lastOutput = "";
  try {
    const result = await tool.execute(
      input.toolCallId,
      parameters,
      input.signal,
      (update) => {
        lastDetails = update.details;
        const [part] = update.content;
        lastOutput = part?.type === "text" ? part.text : "";
      },
      {} as never,
    );
    const written = parameters as { content?: unknown; path?: unknown };
    const content =
      input.name === "write" &&
      typeof written.content === "string" &&
      typeof written.path === "string"
        ? [
            {
              type: "text" as const,
              text: `Successfully wrote ${new TextEncoder().encode(written.content).byteLength} bytes to ${written.path}`,
            },
          ]
        : result.content;
    return { ...result, content, isError: result.isError === true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "PI_TOOL_FAILED";
    return {
      content: [
        {
          type: "text" as const,
          text:
            message === "PI_COMMAND_OUTPUT_LIMIT" ? commandOutputLimitText(lastOutput) : message,
        },
      ],
      details: lastDetails,
      isError: true,
    };
  }
}

function commandOutputLimitText(outputTail: string): string {
  return outputTail
    ? `${outputTail}\n\n输出超过命令输出上限，命令已被结束；上面只保留了输出结尾。`
    : "输出超过命令输出上限，命令已被结束。";
}
