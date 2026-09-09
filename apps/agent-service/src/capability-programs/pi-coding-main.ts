import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { scanMachineSecrets } from "@himawari-agent/application";
import { piRunnerInputSchema } from "@himawari-agent/execution-contracts";
import { createSandboxedCodingOperations, exportPiOutputFile } from "@himawari-agent/platform-node";

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
  const operations = await createSandboxedCodingOperations({
    grant: {
      id: input.scope.directoryGrant.ref,
      revision: input.scope.directoryGrant.revision,
      hostId,
      canonicalRootId: input.scope.directoryGrant.canonicalRootId,
      displayPath: input.workspace,
      operations: input.scope.directoryGrant.operations,
      authorizationRef: input.scope.directoryGrant.authorizationRef,
      expiresAt: input.scope.expiresAt,
      revokedAt: null,
      dataClassification: "private",
      disclosure: "worker",
      pathPolicy: "same_filesystem_no_links",
      mountPolicy: "fixed_device",
    },
    ...(["read", "edit", "write"].includes(input.tool) && target ? { targetPath: target } : {}),
    shell: path.join(binaryDirectory, "bash"),
    privateDirectory: input.privateDirectory,
    binaryDirectory,
    maxOutputBytes: input.maxOutputBytes,
  });
  const { executeSandboxedPiCodingTool } = await import("@himawari-agent/runtime-pi");
  let commandExitCode: number | null = null;
  const result = await executeSandboxedPiCodingTool({
    name: input.tool,
    toolCallId: input.scope.toolCallId,
    cwd: input.workspace,
    parameters,
    operations: {
      ...operations,
      async executeCommand(command) {
        const completed = await operations.executeCommand(command);
        commandExitCode = completed.exitCode;
        return completed;
      },
    },
  });
  const details =
    result.details && typeof result.details === "object"
      ? ({ ...result.details } as Record<string, unknown>)
      : {};
  const fullPath = details["fullOutputPath"];
  delete details["fullOutputPath"];
  const fullOutput =
    typeof fullPath === "string"
      ? await exportPiOutputFile(fullPath, input.privateDirectory, input.maxOutputBytes)
      : null;
  const content = result.content.map((part) =>
    part.type === "text" && typeof fullPath === "string"
      ? { ...part, text: part.text.replaceAll(fullPath, "本次受保护结果的 fullOutput 字段") }
      : part,
  );
  const output = JSON.stringify({
    schemaVersion: "pi-result.v1",
    tool: input.tool,
    content,
    details,
    fullOutput,
    isError: result.isError,
    commandExitCode,
    source: {
      toolCallId: input.scope.toolCallId,
      directoryGrantRef: input.scope.directoryGrant.ref,
      directoryGrantRevision: input.scope.directoryGrant.revision,
      parameters,
    },
  });
  if (scanMachineSecrets(output).length) throw new Error("PI_RESULT_SECRET_REJECTED");
  if (Buffer.byteLength(output) > input.maxOutputBytes) throw new Error("PI_RESULT_OUTPUT_LIMIT");
  process.stdout.write(output);
  if (result.isError)
    process.exitCode =
      commandExitCode && commandExitCode > 0 && commandExitCode < 256 ? commandExitCode : 1;
} catch {
  process.stderr.write("PI_RUNNER_EXECUTION_FAILED\n");
  process.exitCode = 1;
}
