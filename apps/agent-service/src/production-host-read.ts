import {
  type HostDirectoryGrant,
  type HostReadOnlyPort,
  scanMachineSecrets,
} from "@himawari-agent/application";
import { executeHostReadOnlyTool, type HostReadOnlyToolName } from "@himawari-agent/runtime-pi";

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
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const output = JSON.stringify({
        schemaVersion: "pi-result.v1",
        tool: input.tool,
        content: [{ type: "text", text: executed.content }],
        details: executed.details ?? {},
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
      if (scanMachineSecrets(output).length)
        return {
          modelContent: "PI_RESULT_SECRET_REJECTED",
          isError: true,
          errorCode: "PI_RESULT_SECRET_REJECTED",
        };
      if (Buffer.byteLength(output) > input.maximumOutputBytes)
        return {
          modelContent: "PI_RESULT_OUTPUT_LIMIT",
          isError: true,
          errorCode: "PI_RESULT_OUTPUT_LIMIT",
        };
      return { modelContent: output, isError: executed.isError, errorCode: executed.errorCode };
    },
  };
}
