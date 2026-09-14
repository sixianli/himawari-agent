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

/** Target-host entry only: the caller must already be inside the qualified
 * sandbox. Pi's search processes, path probes and output accumulator use local
 * I/O outside Operations. Never call this executor from the Agent process. */
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
    arguments: input.parameters as Record<string, unknown>,
  });
  let lastDetails: unknown;
  try {
    const result = await tool.execute(
      input.toolCallId,
      parameters,
      input.signal,
      (update) => {
        lastDetails = update.details;
      },
      {} as never,
    );
    // The pinned Pi write tool labels UTF-16 string length as bytes. Keep Pi's
    // execution and details, but report the UTF-8 length passed to governed I/O.
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
    return { ...result, content, isError: false };
  } catch (error) {
    // Pi reports a nonzero shell exit by throwing after shaping its output.
    // Preserve that protected result (including the last truncation metadata),
    // rather than silently discarding stderr or claiming empty success.
    return {
      content: [
        { type: "text" as const, text: error instanceof Error ? error.message : "PI_TOOL_FAILED" },
      ],
      details: lastDetails,
      isError: true,
    };
  }
}
