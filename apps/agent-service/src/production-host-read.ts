import type { HostDirectoryGrant, HostReadOnlyPort } from "@himawari-agent/application";
import { containsToolOutputSecret, scanMachineSecrets } from "@himawari-agent/sensitive-capture";
import {
  executeHostReadOnlyTool,
  fitPiResultOutput,
  type HostReadOnlyToolName,
  PI_RESULT_OUTPUT_ENVELOPE_RESERVE,
  truncationMetadata,
} from "@himawari-agent/runtime-pi";

export interface ProductionHostReadOnlyInput {
  readonly tool: HostReadOnlyToolName;
  readonly toolCallId: string;
  readonly grant: HostDirectoryGrant;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly relativePath: string;
  readonly readBytesLimit: number;
  readonly maximumOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface ProductionHostReadOnlyResult {
  readonly modelContent: string;
  readonly isError: boolean;
  readonly errorCode: string | null;
}

export interface ProductionHostReadOnly {
  execute(input: ProductionHostReadOnlyInput): Promise<ProductionHostReadOnlyResult>;
}

function envelopeDetails(details: unknown): unknown {
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  const record = { ...(details as Record<string, unknown>) };
  if (record["truncation"] !== undefined)
    record["truncation"] = truncationMetadata(record["truncation"]);
  return record;
}

export function createProductionHostReadOnly(port: HostReadOnlyPort): ProductionHostReadOnly {
  return {
    async execute(input) {
      const executed = await executeHostReadOnlyTool({
        port,
        grant: input.grant,
        tool: input.tool,
        toolCallId: input.toolCallId,
        parameters: input.parameters,
        relativePath: input.relativePath,
        readBytesLimit: input.readBytesLimit,
        contentBytesLimit: Math.max(
          1,
          input.maximumOutputBytes - PI_RESULT_OUTPUT_ENVELOPE_RESERVE,
        ),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const content = [{ type: "text", text: executed.content }];
      const details = envelopeDetails(executed.details);
      const output = JSON.stringify({
        schemaVersion: "pi-result.v1",
        tool: input.tool,
        content,
        details,
        fullOutput: null,
        isError: executed.isError,
        commandExitCode: null,
        verifiedWrite: null,
        source: {
          workspace: input.grant.displayPath,
          toolCallId: input.toolCallId,
          directoryGrantRef: input.grant.id,
          directoryGrantRevision: input.grant.revision,
          parameters: input.parameters,
        },
      });
      if (
        scanMachineSecrets(output).length ||
        containsToolOutputSecret(JSON.stringify({ content, details }))
      )
        return {
          modelContent: "PI_RESULT_SECRET_REJECTED",
          isError: true,
          errorCode: "PI_RESULT_SECRET_REJECTED",
        };
      if (Buffer.byteLength(output) > input.maximumOutputBytes) {
        const fitted = fitPiResultOutput(output, input.maximumOutputBytes);
        if (fitted === null)
          return {
            modelContent: "PI_RESULT_OUTPUT_LIMIT",
            isError: true,
            errorCode: "PI_RESULT_OUTPUT_LIMIT",
          };
        return { modelContent: fitted, isError: executed.isError, errorCode: executed.errorCode };
      }
      return { modelContent: output, isError: executed.isError, errorCode: executed.errorCode };
    },
  };
}
