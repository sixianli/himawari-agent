import type { GovernedCodingOperationsPort } from "@himawari-agent/application/runtime-port";
import type { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { createGovernedPiCodingTools } from "./governed-coding-tools.js";
import { createPiOperationsFromGovernedHostPort } from "./governed-host-operations.js";

/** Execute on the target Worker only; Pi owns offset/limit and truncation semantics. */
export async function executeGovernedPiRead(input: {
  readonly cwd: string;
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly operations: GovernedCodingOperationsPort;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const [definition] = createGovernedPiCodingTools({
    cwd: input.cwd,
    enabled: ["read"],
    operations: createPiOperationsFromGovernedHostPort(input.operations),
  });
  const read = definition as ReturnType<typeof createReadToolDefinition>;
  const result = await read.execute(
    "governed-file-read",
    {
      path: input.path,
      ...(input.offset === undefined ? {} : { offset: input.offset }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    },
    input.signal,
    undefined,
    {} as never,
  );
  if (result.content.some(({ type }) => type !== "text"))
    throw new Error("HOST_FILE_TEXT_REQUIRED");
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}
