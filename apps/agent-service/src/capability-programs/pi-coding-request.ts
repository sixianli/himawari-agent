import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  firstRejectedPathComponent,
  piRunnerInputSchema,
} from "@himawari-agent/execution-contracts";
import {
  COMMAND_OUTPUT_CEILING_MULTIPLIER,
  createPiFilePublicationJournal,
  createSandboxedCodingOperations,
  formatForegroundPiResult,
  isPiHostPublication,
  publishPreparedPiOperation,
} from "@himawari-agent/platform-node";

export const PI_RUNNER_INPUT_LIMIT_BYTES = 128 * 1024;

export interface PiRunnerIdentity {
  readonly hostId: string;
  readonly workerInstanceId: string;
  readonly runtimeRoot?: string;
}

export function piRunnerBinaryDirectory(runtimeRoot: string): string {
  return path.join(runtimeRoot, "pi-tools", "bin");
}

export function applyPiRunnerEnvironment(runtimeRoot: string): void {
  const binaryDirectory = piRunnerBinaryDirectory(runtimeRoot);
  process.env["PI_OFFLINE"] = "1";
  process.env["PI_CODING_AGENT_DIR"] = path.dirname(binaryDirectory);
  process.env["PATH"] = binaryDirectory;
}

export async function runPiCodingRequest(
  bytes: Uint8Array,
  identity: PiRunnerIdentity,
  writeStdout: (bytes: string | Uint8Array) => void,
): Promise<number> {
  const { hostId, workerInstanceId } = identity;
  if (bytes.byteLength > PI_RUNNER_INPUT_LIMIT_BYTES) throw new Error("PI_RUNNER_INPUT_LIMIT");
  const input = piRunnerInputSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (
    input.scope.hostId !== hostId ||
    input.workerInstanceId !== workerInstanceId ||
    (identity.runtimeRoot !== undefined && input.runtimeRoot !== identity.runtimeRoot) ||
    input.scope.operation !== input.tool ||
    input.scope.profileRef !== "authorized-project.v1" ||
    input.scope.expiresAt <= new Date().toISOString() ||
    process.cwd() !== input.workspace ||
    process.env["HOME"] !== input.privateDirectory ||
    process.env["TMPDIR"] !== input.privateDirectory
  )
    throw new Error("PI_RUNNER_SCOPE_INVALID");
  const binaryDirectory = piRunnerBinaryDirectory(input.runtimeRoot);
  for (const name of input.tool === "grep"
    ? ["rg"]
    : input.tool === "find"
      ? ["fd"]
      : input.tool === "bash"
        ? ["bash"]
        : []) {
    const filename = path.join(binaryDirectory, name);
    const metadata = await lstat(filename);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      !(metadata.mode & 0o111) ||
      (await realpath(filename)) !== filename
    )
      throw new Error("PI_RUNNER_BINARY_UNAVAILABLE");
  }
  applyPiRunnerEnvironment(input.runtimeRoot);
  const parameters: unknown = JSON.parse(input.parametersJson);
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters))
    throw new Error("PI_ARGUMENTS_INVALID");
  const args = parameters as Record<string, unknown>;
  const target =
    typeof args["path"] === "string" ? path.resolve(input.workspace, args["path"]) : undefined;
  if (
    target &&
    target !== input.workspace &&
    (!target.startsWith(`${input.workspace}/`) ||
      firstRejectedPathComponent(target.split("/")) !== undefined)
  )
    throw new Error("PI_PATH_OUTSIDE_SCOPE");
  if (input.scope.fileTarget && !["read", "write", "edit"].includes(input.tool))
    throw new Error("PI_FIXED_FILE_CONTRACT_INVALID");
  const directoryRead =
    input.tool === "read" && target
      ? await lstat(target).then(
          (info) => info.isDirectory(),
          () => false,
        )
      : false;
  const tool = input.tool;
  const writeForeground = async (result: Parameters<typeof formatForegroundPiResult>[0]) => {
    const { output, exitCode } = await formatForegroundPiResult(result);
    writeStdout(output);
    return exitCode;
  };
  if (directoryRead) {
    const { fitPiResultOutput } = await import("@himawari-agent/runtime-pi");
    return writeForeground({
      tool: input.tool,
      result: {
        content: [
          {
            type: "text",
            text: "目标路径是目录，不是文件。查看目录内容请用 ls；找到具体文件后，再对那个文件路径调用 read。",
          },
        ],
        isError: true,
      },
      commandExitCode: null,
      verifiedWrite: null,
      privateDirectory: input.privateDirectory,
      maxOutputBytes: input.maxOutputBytes,
      fitOutput: fitPiResultOutput,
      closing: {},
      source: {
        workspace: input.workspace,
        toolCallId: input.scope.toolCallId,
        directoryGrantRef: input.scope.directoryGrant.ref,
        directoryGrantRevision: input.scope.directoryGrant.revision,
        parameters,
      },
    });
  }
  if (isPiHostPublication(input) || tool === "save_copy" || tool === "move_directory") {
    const { fitPiResultOutput } = await import("@himawari-agent/runtime-pi");
    const { output, exitCode } = await publishPreparedPiOperation({
      hostId,
      tool: input.tool,
      executionMode: input.executionMode,
      scope: input.scope,
      workspace: input.workspace,
      privateDirectory: input.privateDirectory,
      commandPath: binaryDirectory,
      maxOutputBytes: input.maxOutputBytes,
      fitOutput: fitPiResultOutput,
      parametersJson: input.parametersJson,
    });
    writeStdout(output);
    return exitCode;
  }
  let verifiedWrite: { path: string; contentDigest: string; byteLength: number } | null = null;
  let verificationStarted = false;
  let commitStarted = false;
  const publication =
    input.scope.fileTarget && ["write", "edit"].includes(input.tool)
      ? createPiFilePublicationJournal(input)
      : undefined;
  const operations = await createSandboxedCodingOperations({
    onCommitStarting: async () => {
      commitStarted = true;
      await publication?.commitStarting();
    },
    ...(publication ? { onPreparedWrite: publication.prepared } : {}),
    onVerifiedWrite: async (proof) => {
      if (verificationStarted) throw new Error("PI_MULTIPLE_WRITES_UNSUPPORTED");
      verificationStarted = true;
      await publication?.verified(proof);
      verifiedWrite = proof;
    },
    grant: {
      id: input.scope.directoryGrant.ref,
      revision: input.scope.directoryGrant.revision,
      hostId,
      canonicalRootId: input.scope.directoryGrant.canonicalRootId,
      displayPath: input.workspace,
      operations: input.scope.workspaceCopy
        ? (["read", "create", "update", "move", "trash", "restore", "permanent_delete"] as const)
        : input.scope.directoryGrant.operations,
      authorizationRef: input.scope.directoryGrant.authorizationRef,
      expiresAt: input.scope.expiresAt,
      revokedAt: null,
      dataClassification: "private",
      disclosure: "worker",
      pathPolicy: "same_filesystem_no_links",
      mountPolicy: "fixed_device",
    },
    ...(["read", "edit", "write"].includes(input.tool) && target ? { targetPath: target } : {}),
    ...(input.scope.fileTarget ? { expectedTarget: input.scope.fileTarget } : {}),
    shell: path.join(binaryDirectory, "bash"),
    privateDirectory: input.privateDirectory,
    commandPath: [binaryDirectory, "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    maxCommandOutputBytes: input.maxOutputBytes * COMMAND_OUTPUT_CEILING_MULTIPLIER,
  });
  const { executeSandboxedPiCodingTool, fitPiResultOutput } = await import(
    "@himawari-agent/runtime-pi"
  );
  let commandExitCode: number | null = null;
  const commandOutput: Buffer[] = [];
  let commandBytes = 0;
  let emittedBytes = 0;
  const streamOutput = (final: boolean) => {
    if (input.executionMode === "foreground") return;
    const all = Buffer.concat(commandOutput);
    const end = final ? all.length : all.lastIndexOf(10) + 1;
    if (end > emittedBytes) writeStdout(all.subarray(emittedBytes, end));
    emittedBytes = Math.max(emittedBytes, end);
  };
  const result = await executeSandboxedPiCodingTool({
    name: tool,
    toolCallId: input.scope.toolCallId,
    cwd: input.workspace,
    parameters,
    operations: {
      ...operations,
      async executeCommand(command) {
        const completed = await operations.executeCommand({
          ...command,
          onData: (bytes) => {
            command.onData(bytes);
            if (input.executionMode !== "foreground") {
              commandBytes += bytes.length;
              if (commandBytes > input.maxOutputBytes) throw new Error("PI_RESULT_OUTPUT_LIMIT");
              commandOutput.push(Buffer.from(bytes));
              streamOutput(false);
            }
          },
        });
        commandExitCode = completed.exitCode;
        return completed;
      },
    },
  });
  if (input.executionMode !== "foreground") {
    streamOutput(true);
    return commandExitCode ?? (result.isError ? 1 : 0);
  }
  return writeForeground({
    tool: input.tool,
    result,
    commandExitCode,
    verifiedWrite,
    privateDirectory: input.privateDirectory,
    maxOutputBytes: input.maxOutputBytes,
    fitOutput: fitPiResultOutput,
    closing:
      ["write", "edit"].includes(input.tool) && result.isError && !commitStarted
        ? { writeNotStarted: true }
        : {},
    source: {
      workspace: input.workspace,
      toolCallId: input.scope.toolCallId,
      directoryGrantRef: input.scope.directoryGrant.ref,
      directoryGrantRevision: input.scope.directoryGrant.revision,
      parameters,
    },
  });
}
