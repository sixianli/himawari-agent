import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { scanMachineSecrets } from "@himawari-agent/application";
import { piRunnerInputSchema } from "@himawari-agent/execution-contracts";
import {
  createPiFilePublicationJournal,
  createSandboxedCodingOperations,
  isPiHostPublication,
  publishPreparedPiOperation,
} from "@himawari-agent/platform-node";
import { writeForegroundPiResult } from "./pi-foreground-result.js";

// Installed program only. Worker launches it under SRT with fixed host identities.
// Import Pi only after its process-local offline and private-directory settings.
const [hostId, workerInstanceId, ...extra] = process.argv.slice(2);
try {
  if (!hostId || !workerInstanceId || extra.length) throw new Error("PI_RUNNER_IDENTITY_INVALID");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 128 * 1024) throw new Error("PI_RUNNER_INPUT_LIMIT");
    chunks.push(bytes);
  }
  const input = piRunnerInputSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))),
  );
  if (
    input.scope.hostId !== hostId ||
    input.workerInstanceId !== workerInstanceId ||
    input.scope.operation !== input.tool ||
    input.scope.profileRef !== "authorized-project.v1" ||
    input.scope.expiresAt <= new Date().toISOString() ||
    process.cwd() !== input.workspace ||
    process.env["HOME"] !== input.privateDirectory ||
    process.env["TMPDIR"] !== input.privateDirectory
  )
    throw new Error("PI_RUNNER_SCOPE_INVALID");
  const binaryDirectory = path.join(input.runtimeRoot, "pi-tools", "bin");
  // runtimeDigest covers these regular files. No PATH fallback or downloaded
  // tool cache may substitute an executable outside that immutable installation.
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
  process.env["PI_OFFLINE"] = "1";
  process.env["PI_CODING_AGENT_DIR"] = path.dirname(binaryDirectory);
  process.env["PATH"] = binaryDirectory;
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
      target
        .split("/")
        .some((part) => part === ".git" || part === ".env" || part.startsWith(".himawari-")))
  )
    throw new Error("PI_PATH_OUTSIDE_SCOPE");
  if (input.scope.fileTarget && !["read", "write", "edit"].includes(input.tool))
    throw new Error("PI_FIXED_FILE_CONTRACT_INVALID");
  const tool = input.tool;
  if (isPiHostPublication(input) || tool === "save_copy" || tool === "move_directory") {
    const { output, exitCode } = await publishPreparedPiOperation({
      hostId,
      tool: input.tool,
      executionMode: input.executionMode,
      scope: input.scope,
      workspace: input.workspace,
      privateDirectory: input.privateDirectory,
      commandPath: binaryDirectory,
      maxOutputBytes: input.maxOutputBytes,
      parametersJson: input.parametersJson,
    });
    process.stdout.write(output);
    if (exitCode !== 0) process.exitCode = exitCode;
  } else {
    let verifiedWrite: { path: string; contentDigest: string; byteLength: number } | null = null;
    let verificationStarted = false;
    const publication =
      input.scope.fileTarget && ["write", "edit"].includes(input.tool)
        ? createPiFilePublicationJournal(input)
        : undefined;
    const operations = await createSandboxedCodingOperations({
      onCommitStarting: async () => {
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
      commandPath: binaryDirectory,
      maxOutputBytes: input.maxOutputBytes,
    });
    const { executeSandboxedPiCodingTool } = await import("@himawari-agent/runtime-pi");
    let commandExitCode: number | null = null;
    const commandOutput: Buffer[] = [];
    let commandBytes = 0;
    let emittedBytes = 0;
    const streamOutput = (final: boolean) => {
      if (input.executionMode === "foreground") return;
      const all = Buffer.concat(commandOutput);
      const text = all.toString("utf8");
      if (
        scanMachineSecrets(text).length ||
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)
      )
        throw new Error("PI_RESULT_SECRET_REJECTED");
      const end = final ? all.length : all.lastIndexOf(10) + 1;
      if (end > emittedBytes) process.stdout.write(all.subarray(emittedBytes, end));
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
      process.exitCode = commandExitCode ?? (result.isError ? 1 : 0);
    } else {
      await writeForegroundPiResult({
        tool: input.tool,
        result,
        commandExitCode,
        verifiedWrite,
        privateDirectory: input.privateDirectory,
        maxOutputBytes: input.maxOutputBytes,
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
  }
} catch {
  process.stderr.write("PI_RUNNER_EXECUTION_FAILED\n");
  process.exitCode = 1;
}
